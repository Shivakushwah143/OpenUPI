import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { startAdminServer } from '../../../merchant-admin/src/index.js';
import { startCheckoutServer } from '../../../checkout-portal/src/index.js';
import { generateQrSvg } from '../../../checkout-portal/src/qr.js';
import { readTestConsoleConfig } from '../../../merchant-admin/src/test-console.js';
import { signObserverRequest } from '@youpi/common';

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const CONSOLE_TOKEN = 'staging_console_token_1234567890_secret';
const PUBLIC_CHECKOUT_ORIGIN = 'https://pay.169.58.29.37.sslip.io';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function request(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const bodyText = options.body === undefined
      ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        ...(bodyText !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, body, text: data });
      });
    });
    req.on('error', reject);
    if (bodyText !== null) req.write(bodyText);
    req.end();
  });
}

describe('Staging Payment Test Console', () => {
  let db;
  let payment;
  let admin;
  let checkout;
  let paymentBase;
  let adminBase;
  let checkoutBase;
  let sessionRepo;
  let queueEngine;

  const consoleEnv = {
    ...process.env,
    NODE_ENV: 'production', // staging runs production builds; the console is opt-in
    YOUPI_TEST_CONSOLE_ENABLED: '1',
    YOUPI_TEST_CONSOLE_TOKEN: CONSOLE_TOKEN,
    BASE_CHECKOUT_URL: PUBLIC_CHECKOUT_ORIGIN
  };

  before(async () => {
    db = new Database({ inMemory: true });
    payment = await startPaymentApi(6261, db);
    paymentBase = `http://127.0.0.1:${payment.port}`;
    sessionRepo = payment.app.context.sessionRepo;
    queueEngine = payment.app.context.queueEngine;

    admin = await startAdminServer(6161, {
      db,
      apiInternalUrl: paymentBase,
      env: consoleEnv
    });
    adminBase = `http://127.0.0.1:${admin.port}`;

    checkout = await startCheckoutServer(7261, { apiInternalUrl: paymentBase });
    checkoutBase = `http://127.0.0.1:${checkout.port}`;
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

  async function consoleLogin() {
    const res = await request(adminBase, '/api/test-console/session', {
      method: 'POST',
      body: { token: CONSOLE_TOKEN }
    });
    assert.equal(res.status, 200, res.text);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(raw, 'console login must set a session cookie');
    return raw.split(';')[0];
  }

  async function consoleHeaders() {
    const cookie = await consoleLogin();
    return { Cookie: cookie, 'X-Console-Request': '1' };
  }

  async function createConsolePayment(amount = '10.00') {
    const headers = await consoleHeaders();
    const res = await request(adminBase, '/api/test-console/payments', {
      method: 'POST',
      headers,
      body: { amount }
    });
    return { res, headers, json: res.body };
  }

  function merchantIdOfDefault() {
    return db.queryOne('SELECT id FROM merchants ORDER BY created_at ASC LIMIT 1').id;
  }

  function accountIdOfDefault() {
    return db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? ORDER BY created_at ASC LIMIT 1', [merchantIdOfDefault()]).id;
  }

  function merchantApiKey() {
    return db.queryOne('SELECT api_key FROM merchants WHERE id = ?', [merchantIdOfDefault()]).api_key;
  }

  async function pairAndroidDevice() {
    const qr = await request(paymentBase, '/api/v1/admin/sms-gateway/pair-qr', { headers: ADMIN_HEADERS });
    assert.equal(qr.status, 200, qr.text);
    const pair = await request(paymentBase, '/api/v1/observers/sms/pair', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { enrollmentToken: qr.body.enrollmentToken, deviceName: 'Staging Console Test Phone' }
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

  test('console is disabled unless explicitly enabled with a strong token', () => {
    assert.equal(readTestConsoleConfig({}).enabled, false);
    assert.equal(readTestConsoleConfig({ YOUPI_TEST_CONSOLE_ENABLED: '1' }).enabled, false);
    assert.equal(readTestConsoleConfig({ YOUPI_TEST_CONSOLE_ENABLED: '1', YOUPI_TEST_CONSOLE_TOKEN: 'short' }).enabled, false);
    assert.equal(readTestConsoleConfig({ YOUPI_TEST_CONSOLE_ENABLED: '1', YOUPI_TEST_CONSOLE_TOKEN: CONSOLE_TOKEN }).enabled, true);
  });

  test('console requires the access token and never exposes the merchant API key', async () => {
    const page = await request(adminBase, '/test-console');
    assert.equal(page.status, 200);
    assert.ok(page.headers['content-type'].includes('text/html'));
    assert.ok(page.text.includes('Payment Test Console'));

    const anonymous = await request(adminBase, '/api/test-console/payments', { method: 'POST', body: { amount: '10' } });
    assert.equal(anonymous.status, 401);

    const wrong = await request(adminBase, '/api/test-console/session', {
      method: 'POST',
      body: { token: 'not-the-console-token' }
    });
    assert.equal(wrong.status, 401);

    const cookie = await consoleLogin();
    const login = await request(adminBase, '/api/test-console/session', {
      method: 'POST',
      body: { token: CONSOLE_TOKEN }
    });
    const setCookie = String((login.headers['set-cookie'] || [])[0] || '');
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));

    const session = await request(adminBase, '/api/test-console/session', { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.ok(session.body.merchantName);

    const apiKey = merchantApiKey();
    assert.equal(page.text.includes(apiKey), false);
    assert.equal(JSON.stringify(session.body).includes(apiKey), false);
    assert.equal(String(login.headers['set-cookie']).includes(apiKey), false);
  });

  test('enforces the ₹1–₹100 test amount range server-side', async () => {
    const headers = await consoleHeaders();
    for (const amount of ['0.99', '100.01', '500', 'abc', '-10', '']) {
      const res = await request(adminBase, '/api/test-console/payments', {
        method: 'POST',
        headers,
        body: { amount }
      });
      assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} must be rejected`);
      assert.ok(['INVALID_AMOUNT', 'AMOUNT_OUT_OF_RANGE'].includes(res.body.error));
    }

    const missingMarker = await request(adminBase, '/api/test-console/payments', {
      method: 'POST',
      headers: { Cookie: headers.Cookie },
      body: { amount: '10' }
    });
    assert.equal(missingMarker.status, 403, 'CSRF marker is required for state-changing console calls');
  });

  test('creates a real scoped guest payment link through the merchant/payment API', async () => {
    const { res, json } = await createConsolePayment('10.00');
    assert.equal(res.status, 201, JSON.stringify(json));
    assert.ok(json.paymentId);
    assert.ok(json.orderId.startsWith('TC-'));
    assert.equal(json.amount, '10.00');
    assert.equal(json.status, 'ACTIVE');
    assert.equal(json.phase, 'AWAITING_PAYMENT');
    assert.equal(json.guestCheckout, true);
    assert.equal(json.payeeVpa, 'merchant@upi');

    assert.ok(json.checkoutUrl.startsWith(`${PUBLIC_CHECKOUT_ORIGIN}/checkout/`), json.checkoutUrl);
    const url = new URL(json.checkoutUrl);
    assert.equal(url.pathname, `/checkout/${json.paymentId}`);
    const token = url.searchParams.get('t');
    assert.ok(token && token.length >= 32, 'checkout token must be an unguessable capability');
    assert.notEqual(token, json.paymentId);

    const row = db.queryOne('SELECT amount_paise, status, metadata FROM payment_sessions WHERE id = ?', [json.paymentId]);
    assert.equal(row.amount_paise, 1000);
    assert.equal(row.status, 'ACTIVE');
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.guestCheckout, true);
    assert.equal(metadata.testConsole, true);

    // The merchant API key is attached server-side only.
    assert.equal(JSON.stringify(json).includes(merchantApiKey()), false);
  });

  test('guest checkout shows exact amount, receiving VPA, valid QR and mobile UPI option', async () => {
    const { json } = await createConsolePayment('10.00');
    const token = new URL(json.checkoutUrl).searchParams.get('t');

    const stateRes = await request(checkoutBase, `/api/v1/checkout/${json.paymentId}/state?t=${encodeURIComponent(token)}`);
    assert.equal(stateRes.status, 200, stateRes.text);
    const state = stateRes.body;
    assert.equal(state.status, 'ACTIVE');
    assert.equal(state.amount, '10.00');
    assert.equal(state.payeeVpa, 'merchant@upi');
    assert.equal(state.guestCheckout, true);
    assert.equal(state.paymentDetected, false);
    assert.ok(state.upiUri.startsWith('upi://pay?'));
    assert.ok(state.upiUri.includes('pa=merchant%40upi'));
    assert.ok(state.upiUri.includes('am=10.00'));
    assert.ok(state.upiUri.includes(`tn=${encodeURIComponent(json.orderId)}`));

    // The public checkout renders without merchant credentials.
    const page = await request(checkoutBase, `/checkout/${json.paymentId}?t=${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('10.00'));
    assert.ok(page.text.includes('Open UPI App to Pay'));
    assert.ok(page.text.includes('"guestCheckout":true'));
    assert.ok(page.text.includes('"testConsole":true'));
    assert.ok(page.text.includes('merchant@upi'));

    // The QR route must encode the SAME server-built UPI URI (exact VPA + amount).
    const qrRes = await request(checkoutBase, `/checkout/${json.paymentId}/qr.svg?t=${encodeURIComponent(token)}`);
    assert.equal(qrRes.status, 200);
    assert.ok(qrRes.headers['content-type'].includes('image/svg+xml'));
    assert.equal(qrRes.text, generateQrSvg(state.upiUri, 220));

    // Guest access is scoped to the checkout capability only.
    const noToken = await request(checkoutBase, `/api/v1/checkout/${json.paymentId}/state`);
    assert.equal(noToken.status, 401);
    const wrongToken = await request(checkoutBase, `/api/v1/checkout/${json.paymentId}/state?t=${'x'.repeat(64)}`);
    assert.equal(wrongToken.status, 401);
  });

  test('signed Android SMS yields PAYMENT_DETECTED (not SUCCESS) with measured latency; replay/duplicate are rejected', async () => {
    const { json } = await createConsolePayment('10.00');
    const token = new URL(json.checkoutUrl).searchParams.get('t');
    const device = await pairAndroidDevice();
    const utr = String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const smsBody = `Rs 10.00 credited to A/c X1234 via UPI. UTR ${utr}. -HDFC Bank`;

    const signed = signedAndroidSms(device, smsBody);
    const ingest = await new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/v1/observers/sms', paymentBase), {
        method: 'POST',
        headers: signed.headers
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
      req.write(signed.bodyString);
      req.end();
    });

    assert.equal(ingest.status, 200, JSON.stringify(ingest.body));
    assert.equal(ingest.body.accepted, true);
    assert.equal(ingest.body.attribution.attributed, true);
    assert.equal(ingest.body.attribution.paymentSessionId, json.paymentId);

    // SMS alone is evidence only: the session must NOT be SUCCESS.
    const afterSms = sessionRepo.findById(json.paymentId);
    assert.equal(afterSms.status, 'ACTIVE');
    assert.equal(afterSms.confirmationStatus, 'REPORTED');

    const consoleStatus = await request(adminBase, `/api/test-console/payments/${json.paymentId}`, { headers: await consoleHeaders() });
    assert.equal(consoleStatus.status, 200, consoleStatus.text);
    assert.equal(consoleStatus.body.phase, 'PAYMENT_DETECTED');
    assert.equal(consoleStatus.body.status, 'ACTIVE');
    assert.equal(consoleStatus.body.confirmationStatus, 'REPORTED');
    assert.ok(consoleStatus.body.latency, 'observation latency evidence must be exposed');
    assert.ok(Number.isFinite(Number(consoleStatus.body.latency.matchedMs)));
    assert.ok(Number.isFinite(Number(consoleStatus.body.latency.persistedMs)));
    assert.ok(Number(consoleStatus.body.latency.visibleMs) >= 0);

    const checkoutState = await request(checkoutBase, `/api/v1/checkout/${json.paymentId}/state?t=${encodeURIComponent(token)}`);
    assert.equal(checkoutState.status, 200);
    assert.equal(checkoutState.body.paymentDetected, true);
    assert.equal(checkoutState.body.status, 'ACTIVE');

    // Exact replay of a signed device request is refused (nonce/signature replay).
    const replay = await new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/v1/observers/sms', paymentBase), {
        method: 'POST',
        headers: signed.headers
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
      req.write(signed.bodyString);
      req.end();
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.reason, 'REPLAY_DETECTED');

    // A replayed SMS with a fresh signature is deduplicated, not re-attributed.
    const duplicate = signedAndroidSms(device, smsBody);
    const duplicateRes = await new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/v1/observers/sms', paymentBase), {
        method: 'POST',
        headers: duplicate.headers
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
      req.write(duplicate.bodyString);
      req.end();
    });
    assert.equal(duplicateRes.status, 200, JSON.stringify(duplicateRes.body));
    const observationCount = db.queryOne(
      'SELECT COUNT(*) AS n FROM payment_observations WHERE bank_reference_number = ?',
      [utr]
    ).n;
    assert.equal(Number(observationCount), 1, 'the same bank SMS must be persisted exactly once');
    assert.equal(sessionRepo.findById(json.paymentId).verificationLevel, 1);

    // Authoritative bank confirmation is the ONLY path to SUCCESS.
    const confirmationsBefore = db.queryOne('SELECT COUNT(*) AS n FROM bank_confirmations WHERE bank_reference = ?', [utr]).n;
    const confirmation = await request(paymentBase, '/api/v1/admin/bank-confirmations', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: {
        receivingAccountId: accountIdOfDefault(),
        bankReferenceNumber: utr,
        amountPaise: 1000,
        source: 'ACQUIRER'
      }
    });
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
    assert.equal(confirmation.body.confirmed, true);

    const finalStatus = await request(adminBase, `/api/test-console/payments/${json.paymentId}`, { headers: await consoleHeaders() });
    assert.equal(finalStatus.status, 200);
    assert.equal(finalStatus.body.phase, 'SUCCESS');
    assert.equal(finalStatus.body.confirmationStatus, 'BANK_CONFIRMED');

    const ledgerRows = db.queryOne('SELECT COUNT(*) AS n FROM bank_transaction_ledger WHERE bank_reference = ?', [utr]).n;
    assert.equal(Number(ledgerRows), 1, 'one bank credit may only ever be reserved once');
    assert.equal(Number(db.queryOne('SELECT COUNT(*) AS n FROM bank_confirmations WHERE bank_reference = ?', [utr]).n), Number(confirmationsBefore) + 1);

    // Re-confirming the same credit is idempotent (no double processing).
    const again = await request(paymentBase, '/api/v1/admin/bank-confirmations', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: {
        receivingAccountId: accountIdOfDefault(),
        bankReferenceNumber: utr,
        amountPaise: 1000,
        source: 'ACQUIRER'
      }
    });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    assert.equal(again.body.confirmed, false);
    assert.equal(sessionRepo.findById(json.paymentId).status, 'SUCCESS');
    assert.equal(Number(db.queryOne('SELECT COUNT(*) AS n FROM bank_transaction_ledger WHERE bank_reference = ?', [utr]).n), 1);
  });

  test('amount-only matching never crosses merchants or receiving accounts', async () => {
    const merchantRepo = payment.app.context.merchantRepo;
    const accountRepo = payment.app.context.accountRepo;
    const otherMerchant = merchantRepo.create({
      businessName: 'Other Merchant',
      slug: `other-${Date.now()}`,
      contactEmail: 'other@example.com',
      contactPhone: '9000000000',
      apiKey: `other_merchant_key_${Date.now()}`
    });
    const otherAccount = accountRepo.create({
      merchantId: otherMerchant.id,
      upiId: 'othermerchant@upi',
      payeeName: 'Other Merchant',
      isActive: true
    });

    // Default merchant has an ACTIVE ₹10 order...
    const sessionRepoLocal = sessionRepo;
    const target = sessionRepoLocal.create({
      merchantId: merchantIdOfDefault(),
      receivingAccountId: accountIdOfDefault(),
      orderId: `CROSS-${Date.now()}`,
      amountPaise: 1000n,
      method: 'UPI'
    });
    queueEngine.enqueueOrActivate(target.id, accountIdOfDefault());
    assert.equal(sessionRepoLocal.findById(target.id).status, 'ACTIVE');

    // ...and a ₹10 credit is observed on the OTHER merchant's account.
    const issued = await request(paymentBase, '/api/v1/admin/observers/credentials', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { merchantId: otherMerchant.id, label: 'cross-tenant probe' }
    });
    assert.equal(issued.status, 201, issued.text);

    const pathName = '/api/v1/pollers/events';
    const body = {
      source: 'GMAIL',
      receivingAccountId: otherAccount.id,
      sender: 'alerts@hdfc.bank.in',
      rawText: 'Rs 10.00 credited to A/c X9999 via UPI. UTR 654321098765. -HDFC Bank'
    };
    const rawBody = JSON.stringify(body);
    const signed = signObserverRequest({
      keyId: issued.body.keyId,
      secret: issued.body.secret,
      method: 'POST',
      path: pathName,
      rawBody
    });
    const observation = await new Promise((resolve, reject) => {
      const req = http.request(new URL(pathName, paymentBase), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signed }
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });

    assert.equal(observation.status, 200, JSON.stringify(observation.body));
    assert.equal(observation.body.attribution.attributed, false, 'cross-account amount-only matching must not attribute');

    const untouched = sessionRepoLocal.findById(target.id);
    assert.equal(untouched.status, 'ACTIVE');
    assert.equal(untouched.confirmationStatus, 'UNCONFIRMED');
    assert.equal(untouched.verificationLevel, 0);

    const orphanObservation = db.queryOne(
      'SELECT attributed_payment_id FROM payment_observations WHERE receiving_account_id = ? ORDER BY created_at DESC LIMIT 1',
      [otherAccount.id]
    );
    assert.equal(orphanObservation.attributed_payment_id, null);
  });

  test('expiry is enforced by the server and surfaced by the console', async () => {
    const { json } = await createConsolePayment('10.00');
    db.execute('UPDATE payment_sessions SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      json.paymentId
    ]);

    const headers = await consoleHeaders();
    const status = await request(adminBase, `/api/test-console/payments/${json.paymentId}`, { headers });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.phase, 'EXPIRED');
    assert.equal(sessionRepo.findById(json.paymentId).status, 'EXPIRED');
  });

  test('the staging Nginx template permits generated checkout routes and never proxies merchant-admin', () => {
    const configPath = path.resolve(__dirname, '../../../../deploy/nginx/youpi-staging.conf.example');
    const config = fs.readFileSync(configPath, 'utf8');

    // Generated guest routes: /checkout/:id, /checkout/:id/qr.svg, /api/v1/checkout/:id/state & /stream.
    assert.ok(/location \^~ \/checkout\//.test(config));
    assert.ok(/location \^~ \/api\//.test(config));
    assert.ok(config.includes('proxy_buffering off'));
    assert.ok(!/proxy_pass\s+http:\/\/[^;]*:6001/.test(config), 'merchant-admin must never be proxied');
    assert.ok(!/upstream\s+\w+\s*\{[^}]*:6001/.test(config), 'merchant-admin must not be an upstream');

    // Public hosts must deny admin/observer surfaces explicitly.
    assert.ok(config.includes('location ^~ /api/v1/admin/      { return 404; }'));
    assert.ok(config.includes('location ^~ /api/v1/pollers/    { return 404; }'));
    assert.ok(config.includes('location ^~ /api/v1/observers/  { return 404; }'));
  });
});
