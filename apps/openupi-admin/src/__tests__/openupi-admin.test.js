import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startCheckoutServer } from '../../../checkout-portal/src/index.js';
import { generateQrSvg } from '../../../checkout-portal/src/qr.js';
import { startOpenupiAdminServer } from '../index.js';

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ADMIN_PASSWORD = 'openupi_admin_test_password_123';
const PUBLIC_CHECKOUT = 'https://pay.169.58.29.37.sslip.io';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

function request(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const bodyText = options.body === undefined
      ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = {
      ...(bodyText !== null ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' && !options.headers?.Origin
        ? { Origin: baseUrl }
        : {}),
      ...(options.headers || {})
    };
    const req = http.request(url, { method: options.method || 'GET', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch { /* text or html */ }
        resolve({ status: res.statusCode, headers: res.headers, body, text: data });
      });
    });
    req.on('error', reject);
    if (bodyText !== null) req.write(bodyText);
    req.end();
  });
}

describe('OpenUPI Admin', () => {
  let db;
  let payment;
  let admin;
  let checkout;
  let paymentBase;
  let adminBase;
  let checkoutBase;
  let sessionRepo;
  let queueEngine;

  before(async () => {
    db = new Database({ inMemory: true });
    payment = await startPaymentApi(6262, db);
    paymentBase = `http://127.0.0.1:${payment.port}`;
    sessionRepo = payment.app.context.sessionRepo;
    queueEngine = payment.app.context.queueEngine;

    checkout = await startCheckoutServer(7272, { apiInternalUrl: paymentBase });
    checkoutBase = `http://127.0.0.1:${checkout.port}`;

    // The admin app is a BFF: point it at this isolated payment API/checkout.
    const adminEnv = {
      ...process.env,
      OPENUPI_ADMIN_PASSWORD: ADMIN_PASSWORD,
      OPENUPI_ADMIN_COOKIE_SECURE: '0',
      BASE_CHECKOUT_URL: PUBLIC_CHECKOUT,
      PAYMENT_API_INTERNAL_URL: paymentBase,
      OPENUPI_CHECKOUT_INTERNAL_URL: checkoutBase
    };
    admin = await startOpenupiAdminServer(6272, { env: adminEnv });
    adminBase = `http://127.0.0.1:${admin.port}`;
  });

  after(async () => {
    await checkout.close();
    await admin.close();
    await payment.close();
    db.close();
  });

  beforeEach(() => {
    const rows = db.query('SELECT id, status FROM payment_sessions');
    for (const row of rows) {
      if (row.status === 'SUCCESS') continue;
      try { sessionRepo.transitionToTerminal(row.id, 'CANCELLED'); } catch { /* already terminal */ }
    }
    db.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL');
  });

  async function login() {
    const res = await request(adminBase, '/api/session', {
      method: 'POST',
      body: { username: 'admin', password: ADMIN_PASSWORD }
    });
    assert.equal(res.status, 200, res.text);
    const raw = String(Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'] || '');
    assert.ok(raw, 'login must set a session cookie');
    return { cookie: raw.split(';')[0], csrfToken: res.body.csrfToken, setCookie: raw };
  }

  async function authed() {
    const session = await login();
    return { headers: { Cookie: session.cookie, 'X-OpenUPI-CSRF': session.csrfToken }, session };
  }

  async function createLink(amount, note) {
    const auth = await authed();
    return request(adminBase, '/api/payment-links', {
      method: 'POST',
      headers: auth.headers,
      body: { amount, note }
    });
  }

  function merchantApiKey() {
    return db.queryOne('SELECT api_key FROM merchants ORDER BY created_at ASC LIMIT 1').api_key;
  }

  function defaultAccountId() {
    return db.queryOne('SELECT id FROM payment_receiving_accounts ORDER BY created_at ASC LIMIT 1').id;
  }

  async function pairAndroidDevice() {
    const qr = await request(paymentBase, '/api/v1/admin/sms-gateway/pair-qr', { headers: ADMIN_HEADERS });
    assert.equal(qr.status, 200, qr.text);
    const pair = await request(paymentBase, '/api/v1/observers/sms/pair', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { enrollmentToken: qr.body.enrollmentToken, deviceName: 'OpenUPI Test Phone' }
    });
    assert.equal(pair.status, 200, pair.text);
    return pair.body;
  }

  function signedAndroidSms(device, smsBody) {
    const bodyString = JSON.stringify({
      deviceId: device.deviceId,
      sender: 'HDFCBK',
      body: smsBody,
      timestamp: Date.now()
    });
    const timestamp = Date.now().toString();
    return {
      bodyString,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': device.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': crypto.createHmac('sha256', device.signingKey).update(`${bodyString}:${timestamp}`).digest('hex')
      }
    };
  }

  function postSigned(pathname, signed) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(pathname, paymentBase), {
        method: 'POST',
        headers: signed.headers
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body = {};
          try { body = JSON.parse(data || '{}'); } catch { /* text */ }
          resolve({ status: res.statusCode, body, text: data });
        });
      });
      req.on('error', reject);
      req.write(signed.bodyString);
      req.end();
    });
  }

  test('anonymous visitors only receive the OpenUPI sign-in page — no dashboard, no gateway proxy', async () => {
    const page = await request(adminBase, '/');
    assert.equal(page.status, 200);
    assert.ok(page.headers['content-type'].includes('text/html'));
    assert.ok(page.text.includes('OpenUPI'));
    assert.ok(page.text.includes('Sign in'));
    assert.equal(page.text.includes('Real-Time Receiving Account Slot Ownership'), false, 'legacy YOUPI dashboard must not be served');
    assert.equal(page.text.includes('Payment Test Console'), false);
    assert.equal(page.text.includes(merchantApiKey()), false);

    assert.ok(page.headers['content-security-policy'].includes("default-src 'none'"));
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cache-control'], 'no-store');

    // Every privileged surface is closed to anonymous callers and none of the
    // gateway's own routes are proxied by this app.
    for (const pathname of ['/api/overview', '/api/transactions', '/api/observers', '/api/services']) {
      const res = await request(adminBase, pathname);
      assert.equal(res.status, 401, `${pathname} must require a session`);
    }
    const create = await request(adminBase, '/api/payment-links', { method: 'POST', body: { amount: '10' } });
    assert.equal(create.status, 401);

    for (const pathname of ['/api/v1/admin/payments', '/api/v1/admin/sms-gateway/devices', '/api/v1/payments']) {
      const res = await request(adminBase, pathname);
      assert.equal(res.status, 404, `${pathname} must never be proxied`);
    }
    assert.equal((await request(adminBase, '/test-console')).status, 404);
    assert.equal((await request(adminBase, '/admin')).status, 404);

    const asset = await request(adminBase, '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.ok(asset.headers['content-type'].includes('javascript'));
    assert.equal(asset.text.includes(process.env.ADMIN_API_KEY), false);
    assert.equal(asset.text.includes(merchantApiKey()), false);

    const favicon = await request(adminBase, '/favicon.ico');
    assert.equal(favicon.status, 302);
    assert.equal(favicon.headers.location, '/assets/brand/favicon.svg');

    const robots = await request(adminBase, '/robots.txt');
    assert.equal(robots.status, 200);
    assert.ok(robots.text.includes('Disallow: /'));
  });

  test('sign-in verifies the password server-side and issues a hardened session cookie', async () => {
    const wrong = await request(adminBase, '/api/session', {
      method: 'POST',
      body: { username: 'admin', password: 'not-the-password' }
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);

    const crossSite = await request(adminBase, '/api/session', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
      body: { username: 'admin', password: ADMIN_PASSWORD }
    });
    assert.equal(crossSite.status, 403);

    const ok = await login();
    assert.ok(ok.setCookie.includes('HttpOnly'));
    assert.ok(ok.setCookie.includes('SameSite=Strict'));
    assert.ok(ok.setCookie.includes('openupi_admin='));
    assert.equal(ok.setCookie.includes(ADMIN_PASSWORD), false);
    assert.equal(JSON.stringify({ cookie: ok.cookie, csrfToken: ok.csrfToken }).includes(process.env.ADMIN_API_KEY), false);

    const tampered = `${ok.cookie.slice(0, -2)}00`;
    const rejected = await request(adminBase, '/api/overview', { headers: { Cookie: tampered } });
    assert.equal(rejected.status, 401, 'a forged cookie signature must be refused');

    const session = await request(adminBase, '/api/session', { headers: { Cookie: ok.cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.ok(session.body.csrfToken);

    const logout = await request(adminBase, '/api/session', {
      method: 'DELETE',
      headers: { Cookie: ok.cookie, 'X-OpenUPI-CSRF': ok.csrfToken }
    });
    assert.equal(logout.status, 200);
    const afterLogout = await request(adminBase, '/api/overview', { headers: { Cookie: ok.cookie } });
    assert.equal(afterLogout.status, 401, 'logout must invalidate the server-side session');
  });

  test('rendered dashboard is branded OpenUPI and never contains server credentials', async () => {
    const { headers } = await authed();
    const page = await request(adminBase, '/', { headers });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('<title>OpenUPI Admin</title>'));
    assert.ok(page.text.includes('Payment Links'));
    assert.ok(page.text.includes('/assets/brand/favicon.svg'));
    assert.equal(page.text.includes('{{'), false, 'no unresolved template placeholders');
    assert.equal(page.text.includes(process.env.ADMIN_API_KEY), false);
    assert.equal(page.text.includes(merchantApiKey()), false);
    assert.equal(page.text.includes('YOUPI_TEST_CONSOLE_TOKEN'), false);
    // The legacy advanced dashboard stays internal: nothing here links to it.
    assert.equal(/href="[^"]*(6001|test-console)/.test(page.text), false);
    assert.equal(page.text.includes('test-console'), false);
    assert.ok(fs.existsSync(path.join(repoRoot, 'apps/merchant-admin/src/views/admin.html')), 'legacy dashboard must be preserved');
  });

  test('payment links are limited to ₹1–₹100, CSRF-protected, and never return credentials', async () => {
    const auth = await authed();

    const noCsrf = await request(adminBase, '/api/payment-links', {
      method: 'POST',
      headers: { Cookie: auth.headers.Cookie },
      body: { amount: '10' }
    });
    assert.equal(noCsrf.status, 403, 'state-changing requests require the CSRF token');

    const wrongOrigin = await request(adminBase, '/api/payment-links', {
      method: 'POST',
      headers: { ...auth.headers, Origin: 'https://attacker.example' },
      body: { amount: '10' }
    });
    assert.equal(wrongOrigin.status, 403, 'cross-site payment creation must be refused');

    for (const amount of ['0.99', '100.01', '500', 'abc', '-10', '', '10.999']) {
      const res = await request(adminBase, '/api/payment-links', {
        method: 'POST',
        headers: auth.headers,
        body: { amount }
      });
      assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} must be rejected`);
      assert.ok(['INVALID_AMOUNT', 'AMOUNT_OUT_OF_RANGE'].includes(res.body.error));
    }

    const created = await request(adminBase, '/api/payment-links', {
      method: 'POST',
      headers: auth.headers,
      body: { amount: '10.00', note: 'Coffee' }
    });
    assert.equal(created.status, 201, created.text);
    const json = created.body;

    assert.ok(json.paymentId);
    assert.ok(json.orderId.startsWith('OU-'));
    assert.equal(json.amount, '10.00');
    assert.equal(json.amountPaise, 1000);
    assert.equal(json.phase, 'AWAITING_PAYMENT');
    assert.equal(json.guestCheckout, true);
    assert.equal(json.payeeVpa, 'merchant@upi');

    assert.ok(json.checkoutUrl.startsWith(`${PUBLIC_CHECKOUT}/checkout/`), json.checkoutUrl);
    const url = new URL(json.checkoutUrl);
    assert.equal(url.pathname, `/checkout/${json.paymentId}`);
    const token = url.searchParams.get('t');
    assert.ok(token && token.length >= 32, 'the shared link must carry a scoped checkout capability');
    assert.notEqual(token, json.paymentId);
    assert.equal(json.qrUrl, `${PUBLIC_CHECKOUT}/checkout/${json.paymentId}/qr.svg?t=${encodeURIComponent(token)}`);

    // Raw credentials and the unscoped token object never reach the browser.
    assert.equal('checkoutToken' in json, false);
    const serialized = JSON.stringify(json);
    assert.equal(serialized.includes(process.env.ADMIN_API_KEY), false);
    assert.equal(serialized.includes(merchantApiKey()), false);

    const row = db.queryOne('SELECT amount_paise, status, metadata FROM payment_sessions WHERE id = ?', [json.paymentId]);
    assert.equal(row.amount_paise, 1000);
    assert.equal(row.status, 'ACTIVE');
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.source, 'openupi-admin');
    assert.equal(metadata.guestCheckout, true);
    assert.equal(metadata.label, 'Coffee');

    const maximum = await createLink('100');
    assert.equal(maximum.status, 201, maximum.text);
    assert.equal(maximum.body.amount, '100.00');
  });

  test('guest checkout renders the exact amount, receiving VPA, UPI intent and QR', async () => {
    const created = await createLink('10.00');
    assert.equal(created.status, 201, created.text);
    const token = new URL(created.body.checkoutUrl).searchParams.get('t');

    const stateRes = await request(checkoutBase, `/api/v1/checkout/${created.body.paymentId}/state?t=${encodeURIComponent(token)}`);
    assert.equal(stateRes.status, 200, stateRes.text);
    const state = stateRes.body;
    assert.equal(state.status, 'ACTIVE');
    assert.equal(state.amount, '10.00');
    assert.equal(state.payeeVpa, 'merchant@upi');
    assert.equal(state.guestCheckout, true);
    assert.equal(state.paymentDetected, false);
    assert.ok(state.upiUri.startsWith('upi://pay?'));
    assert.ok(state.upiUri.includes('am=10.00'));

    const page = await request(checkoutBase, `/checkout/${created.body.paymentId}?t=${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('10.00'));
    assert.ok(page.text.includes('Open UPI App to Pay'));
    assert.ok(page.text.includes('merchant@upi'));

    const qr = await request(checkoutBase, `/checkout/${created.body.paymentId}/qr.svg?t=${encodeURIComponent(token)}`);
    assert.equal(qr.status, 200);
    assert.ok(qr.headers['content-type'].includes('image/svg+xml'));
    assert.equal(qr.text, generateQrSvg(state.upiUri, 220));

    const noToken = await request(checkoutBase, `/api/v1/checkout/${created.body.paymentId}/state`);
    assert.equal(noToken.status, 401);
  });

  test('signed Android SMS yields PAYMENT_DETECTED; only bank confirmation reaches SUCCESS', async () => {
    const created = await createLink('10.00');
    assert.equal(created.status, 201, created.text);
    const paymentId = created.body.paymentId;
    const device = await pairAndroidDevice();

    const utr = String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const signed = signedAndroidSms(device, `Rs 10.00 credited to A/c X1234 via UPI. UTR ${utr}. -HDFC Bank`);
    const ingest = await postSigned('/api/v1/observers/sms', signed);
    assert.equal(ingest.status, 200, JSON.stringify(ingest.body));
    assert.equal(ingest.body.attribution.paymentSessionId, paymentId);

    const auth = await authed();
    const detected = await request(adminBase, `/api/payment-links/${paymentId}`, { headers: auth.headers });
    assert.equal(detected.status, 200, detected.text);
    assert.equal(detected.body.phase, 'PAYMENT_DETECTED');
    assert.equal(detected.body.paymentDetected, true);
    assert.equal(detected.body.status, 'ACTIVE');
    assert.notEqual(detected.body.status, 'SUCCESS');

    const list = await request(adminBase, '/api/transactions?limit=10', { headers: auth.headers });
    assert.equal(list.status, 200);
    const listed = list.body.transactions.find(row => row.id === paymentId);
    assert.ok(listed, 'the new payment must appear in recent transactions');
    assert.equal(listed.phase, 'PAYMENT_DETECTED');
    assert.equal(listed.amount, '10.00');
    assert.equal('metadata' in listed, false);

    assert.equal(sessionRepo.findById(paymentId).status, 'ACTIVE', 'SMS evidence alone must never settle a payment');

    // Replaying the same signed request is refused.
    const replay = await postSigned('/api/v1/observers/sms', signed);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.reason, 'REPLAY_DETECTED');

    const confirmation = await request(paymentBase, '/api/v1/admin/bank-confirmations', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: {
        receivingAccountId: defaultAccountId(),
        bankReferenceNumber: utr,
        amountPaise: 1000,
        source: 'ACQUIRER'
      }
    });
    assert.equal(confirmation.status, 200, confirmation.text);
    assert.equal(confirmation.body.confirmed, true);

    const settled = await request(adminBase, `/api/payment-links/${paymentId}`, { headers: auth.headers });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.phase, 'SUCCESS');
    assert.equal(settled.body.confirmationStatus, 'BANK_CONFIRMED');
    assert.equal(queueEngine ? true : true, true);
  });

  test('overview and observers expose only derived operational data', async () => {
    const created = await createLink('5.00');
    assert.equal(created.status, 201, created.text);

    const { headers } = await authed();
    const overview = await request(adminBase, '/api/overview', { headers });
    assert.equal(overview.status, 200, overview.text);
    assert.equal(overview.body.merchant.businessName.length > 0, true);
    assert.equal(overview.body.receiving.upiId, 'merchant@upi');
    assert.ok(Array.isArray(overview.body.transactions));
    assert.ok(overview.body.stats.recentCount >= 1);
    assert.ok(Array.isArray(overview.body.services));
    assert.equal(JSON.stringify(overview.body).includes(process.env.ADMIN_API_KEY), false);

    const observers = await request(adminBase, '/api/observers', { headers });
    assert.equal(observers.status, 200, observers.text);
    assert.ok(Array.isArray(observers.body.android.devices));
    assert.equal(typeof observers.body.android.connectedDevices, 'number');
    assert.ok(observers.body.gmail);
    assert.ok(observers.body.sms);

    const page = await request(adminBase, '/', { headers });
    assert.ok(page.headers['content-security-policy'].includes("script-src 'self'"));
    assert.ok(page.headers['content-security-policy'].includes(PUBLIC_CHECKOUT));
    assert.equal(page.text.includes('<script>'), false, 'no inline scripts under the strict CSP');
  });

  test('login is throttled after repeated failures', async () => {
    let last;
    for (let i = 0; i < 7; i++) {
      last = await request(adminBase, '/api/session', {
        method: 'POST',
        body: { username: 'admin', password: `wrong-${i}` }
      });
    }
    assert.equal(last.status, 429, 'brute-force attempts must be rate limited');
    assert.ok(Number(last.headers['retry-after']) > 0);

    const blockedEvenWithCorrectPassword = await request(adminBase, '/api/session', {
      method: 'POST',
      body: { username: 'admin', password: ADMIN_PASSWORD }
    });
    assert.equal(blockedEvenWithCorrectPassword.status, 429);
  });

  test('Nginx template terminates TLS for the admin host and never proxies gateway APIs', () => {
    const configPath = path.join(repoRoot, 'deploy/nginx/openupi-admin.conf.example');
    assert.ok(fs.existsSync(configPath), 'admin Nginx template must exist');
    const config = fs.readFileSync(configPath, 'utf8');

    assert.ok(config.includes('admin.169.58.29.37.sslip.io'));
    assert.ok(/listen\s+443\s+ssl/.test(config));
    assert.ok(config.includes('ssl_certificate'));
    assert.ok(config.includes('/etc/letsencrypt/live/admin.169.58.29.37.sslip.io/fullchain.pem'));
    assert.ok(config.includes('Strict-Transport-Security'));
    assert.ok(config.includes('proxy_pass http://openupi_admin'));
    assert.ok(config.includes('limit_req zone=openupi_admin'));
    assert.ok(/location \^~ \/api\/v1\/\s*\{\s*return 404;/.test(config));
    assert.ok(!config.includes(':6001'), 'legacy merchant-admin must never be proxied');
    assert.ok(!config.includes('/api/v1/admin/'), 'gateway admin routes must not be proxied from this host');
    assert.ok(config.includes('X-Forwarded-Proto https'));
    assert.ok(config.includes('client_max_body_size 64k'));
    assert.ok(!/^\s*proxy_pass\s+http:\/\/[^;]*:(6100|7000)/m.test(config), 'only the admin app may be proxied');

    const zonesPath = path.join(repoRoot, 'deploy/nginx/openupi-admin-zones.conf.example');
    const zones = fs.readFileSync(zonesPath, 'utf8');
    assert.ok(zones.includes('limit_req_zone'));
    assert.ok(zones.includes('openupi_admin_login'));
  });

  test('deployment script backs up state, validates HTTPS/auth and never prints credentials', () => {
    const scriptPath = path.join(repoRoot, 'scripts/deploy-openupi-admin.sh');
    assert.ok(fs.existsSync(scriptPath));
    const script = fs.readFileSync(scriptPath, 'utf8');

    assert.ok(script.includes('set -euo pipefail'));
    assert.ok(script.includes('git rev-parse --abbrev-ref HEAD'));
    assert.ok(script.includes('EXPECTED_BRANCH'));
    assert.ok(script.includes('sqlite3'));
    assert.ok(script.includes('VACUUM INTO'));
    assert.ok(script.includes('docker image tag'));
    assert.ok(script.includes('nginx -t'));
    assert.ok(script.includes('curl -fsS'));
    assert.ok(script.includes('rollback'));
    assert.ok(!/echo\s+\$?\{?(ADMIN_API_KEY|MERCHANT_API_KEY|OPENUPI_ADMIN_PASSWORD)/.test(script));
    assert.ok(!script.includes('cat .env'), 'must never dump the staging env file');
    assert.ok(!script.includes('set -x'), 'xtrace would echo secrets');
  });
});
