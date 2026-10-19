/**
 * OpenUPI admin — real-browser interaction + responsive layout check.
 *
 * No Playwright/Puppeteer in this repo, so this drives the locally installed
 * Chrome over the DevTools Protocol with Node's global WebSocket. It:
 *
 *   1. boots an isolated in-memory payment API, checkout portal and OpenUPI admin,
 *   2. signs in through the real form,
 *   3. creates a ₹10 payment link through the UI,
 *   4. opens the guest checkout and verifies amount + UPI handoff,
 *   5. feeds a signed Android SMS and watches the admin move to PAYMENT_DETECTED,
 *   6. confirms the credit at the bank and watches SUCCESS arrive by polling,
 *   7. screenshots every view at 1440x900, 768x1024 and 390x844, asserting that
 *      nothing overflows the viewport and touch targets stay usable.
 *
 * Usage: node scripts/openupi-admin-browser-check.mjs [--out=dir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';
import { startOpenupiAdminServer } from '../apps/openupi-admin/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outArg = process.argv.slice(2).find(arg => arg.startsWith('--out='));
const outDir = path.resolve(repoRoot, outArg ? outArg.slice('--out='.length) : 'artifacts/openupi-admin');

const PASSWORD = 'openupi_browser_check_password_123';
const ADMIN_KEY = 'browser_check_admin_key_123';
const SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
];
const VIEWS = ['overview', 'links', 'transactions', 'observers'];

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.YOUPI_SECRET_KEY = SECRET_KEY;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const listener of this.listeners) listener(msg);
      }
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }
}

const OVERFLOW_PROBE = `(() => {
  const vw = window.innerWidth;
  const offenders = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right <= vw + 1 && rect.left >= -1) continue;
    let parent = el.parentElement;
    let inScroller = false;
    while (parent) {
      const ps = getComputedStyle(parent);
      if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { inScroller = true; break; }
      parent = parent.parentElement;
    }
    if (inScroller) continue;
    const key = el.tagName + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className : '');
    if (seen.has(key)) continue;
    seen.add(key);
    offenders.push({
      node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width)
    });
  }
  const smallTargets = [...document.querySelectorAll('.primary-btn, .secondary-btn, .ghost-btn, .icon-btn, .nav-item, .chip')]
    .filter(el => el.getClientRects().length)
    .map(el => ({ node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), h: Math.round(el.getBoundingClientRect().height) }))
    .filter(item => item.h < 38);
  return {
    innerWidth: vw,
    scrollWidth: document.documentElement.scrollWidth,
    overflowCount: Math.max(0, document.documentElement.scrollWidth - vw),
    offenderCount: offenders.length,
    offenders: offenders.slice(0, 8),
    smallTargets,
    title: document.title,
    navCurrent: document.querySelector('.nav-item[aria-current="page"]')?.textContent.trim() || null,
    documentHeight: document.documentElement.scrollHeight
  };
})()`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const checks = [];
  const failures = [];
  const consoleErrors = [];

  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  };

  const db = new Database({ inMemory: true });
  const payment = await startPaymentApi(6271, db);
  const paymentBase = `http://127.0.0.1:${payment.port}`;
  const checkout = await startCheckoutServer(7271, { apiInternalUrl: paymentBase });
  const checkoutBase = `http://127.0.0.1:${checkout.port}`;
  const admin = await startOpenupiAdminServer(6171, {
    env: {
      ...process.env,
      OPENUPI_ADMIN_PASSWORD: PASSWORD,
      OPENUPI_ADMIN_COOKIE_SECURE: '0',
      BASE_CHECKOUT_URL: checkoutBase,
      PAYMENT_API_INTERNAL_URL: paymentBase,
      OPENUPI_CHECKOUT_INTERNAL_URL: checkoutBase
    }
  });
  const adminBase = `http://127.0.0.1:${admin.port}`;

  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
    await admin.close(); await checkout.close(); await payment.close(); db.close();
    process.exit(2);
  }

  const debugPort = Number(process.env.CHECK_CDP_PORT || 9334);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openupi-check-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        wsUrl = (await res.json()).webSocketDebuggerUrl;
      } catch {
        // Chrome is still starting.
      }
    }
    if (!wsUrl) throw new Error('Chrome DevTools endpoint did not start');

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);

    cdp.onEvent(msg => {
      if (msg.method === 'Page.javascriptDialogOpening') {
        // A native alert/confirm would block the renderer and every later CDP call.
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId).catch(() => {});
        return;
      }
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push({
          kind: 'exception',
          text: msg.params?.exceptionDetails?.text || 'unknown',
          url: msg.params?.exceptionDetails?.url || ''
        });
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push({
          kind: 'log',
          text: msg.params.entry.text,
          url: msg.params.entry.url || ''
        });
      }
    });

    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
      }
      return result.result.value;
    };

    const waitForLoad = async () => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate('document.readyState') === 'complete') break;
        await sleep(100);
      }
      await sleep(400);
    };

    const screenshot = async name => {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return path.relative(repoRoot, file);
    };

    const setViewport = async viewport => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 800
      }, sessionId);
    };

    // ------------------------------------------------------------ sign in
    const desktop = VIEWPORTS[0];
    await setViewport(desktop);
    await cdp.send('Page.navigate', { url: `${adminBase}/login` }, sessionId);
    await waitForLoad();

    const loginProbe = await evaluate(`(() => ({
      title: document.title,
      hasForm: Boolean(document.querySelector('#signin-form')),
      hasLogo: Boolean(document.querySelector('img[src="/assets/brand/logo.svg"]'))
    }))()`);
    check('Login page is branded OpenUPI', loginProbe.title.includes('OpenUPI') && loginProbe.hasForm && loginProbe.hasLogo, JSON.stringify(loginProbe));
    await screenshot('login-desktop');

    await evaluate(`(() => {
      document.querySelector('#username').value = 'admin';
      document.querySelector('#password').value = ${JSON.stringify(PASSWORD)};
      document.querySelector('#signin-form').requestSubmit();
      return true;
    })()`);

    await waitFor(async () => (await evaluate('location.pathname')) === '/', { label: 'dashboard navigation' });
    await waitFor(async () => evaluate(`Boolean(document.querySelector('#linkForm'))`), { label: 'dashboard form' });
    const dashboardTitle = await evaluate('document.title');
    check('Dashboard loads after sign-in', dashboardTitle.includes('OpenUPI Admin'), dashboardTitle);

    await waitFor(async () => {
      const text = await evaluate(`document.querySelector('#payeeVpa')?.textContent || ''`);
      return text.includes('merchant@upi');
    }, { label: 'merchant identity' });
    check('Overview shows the receiving VPA', true, 'merchant@upi');

    // ------------------------------------------------------ create a link
    await evaluate(`document.querySelector('.nav-item[data-view="links"]').click()`);
    await waitFor(async () => !(await evaluate(`document.querySelector('[data-view-panel="links"]').hidden`)), { label: 'links view' });

    await evaluate(`(() => {
      const amount = document.querySelector('#amount');
      amount.value = '10';
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#note').value = 'Browser check';
      document.querySelector('#linkForm').requestSubmit();
      return true;
    })()`);

    const created = await waitFor(async () => {
      const value = await evaluate(`document.querySelector('#resultLink')?.value || ''`);
      return value.includes('/checkout/') ? value : null;
    }, { label: 'payment link creation' });
    check('Generates a checkout link in the browser', Boolean(created), created);
    await screenshot('link-awaiting-desktop');

    const awaitingPhase = await evaluate(`document.querySelector('#resultStatus').dataset.phase`);
    check('New link starts in AWAITING_PAYMENT', awaitingPhase === 'AWAITING_PAYMENT', awaitingPhase);

    const qrLoaded = await waitFor(async () => evaluate(`(() => {
      const img = document.querySelector('#resultQr');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`), { label: 'QR image' });
    check('QR image renders in the result card', qrLoaded === true);

    // ------------------------------------------------- guest checkout page
    // Render the shared link in the same browser at phone width, then return to
    // the admin. The link is a fresh capability, so a new link is created below
    // for the live verification flow.
    await setViewport(VIEWPORTS[2]);
    await cdp.send('Page.navigate', { url: created }, sessionId);
    await waitForLoad();
    await sleep(1200);
    const checkoutText = await evaluate('document.body.innerText');
    check('Guest checkout shows the exact amount', checkoutText.includes('10.00'));
    check('Guest checkout shows the receiving VPA', checkoutText.includes('merchant@upi'));
    check('Guest checkout exposes the UPI handoff', checkoutText.includes('Open UPI App to Pay'));
    await screenshot('checkout-mobile');

    // Release the receiving-account slot occupied by that first link so the next
    // link is ACTIVE (not QUEUED) for the verification flow.
    try {
      const firstPaymentId = new URL(created).pathname.split('/').pop();
      const firstSession = payment.app.context.sessionRepo.findById(firstPaymentId);
      payment.app.context.sessionRepo.transitionToTerminal(firstPaymentId, 'CANCELLED');
      if (firstSession?.receivingAccountId) {
        payment.app.context.queueEngine.promoteNext(firstSession.receivingAccountId);
      }
    } catch {
      // Already terminal or slot already released.
    }

    await setViewport(desktop);
    await cdp.send('Page.navigate', { url: `${adminBase}/#links` }, sessionId);
    await waitForLoad();
    await waitFor(async () => evaluate(`Boolean(document.querySelector('#linkForm'))`), { label: 'admin after checkout' });
    await evaluate(`(() => {
      const amount = document.querySelector('#amount');
      amount.value = '10';
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#linkForm').requestSubmit();
      return true;
    })()`);
    await waitFor(async () => (await evaluate(`document.querySelector('#resultLink')?.value || ''`)).includes('/checkout/'), { label: 'second payment link' });
    const orderId = await evaluate(`document.querySelector('#resultOrderId').textContent.replace('Order ', '')`);

    // ---------------------------------------- signed SMS → PAYMENT_DETECTED
    const pairQr = await fetch(`${paymentBase}/api/v1/admin/sms-gateway/pair-qr`, { headers: { 'X-Admin-Key': ADMIN_KEY } }).then(r => r.json());
    const device = await fetch(`${paymentBase}/api/v1/observers/sms/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ enrollmentToken: pairQr.enrollmentToken, deviceName: 'Browser Check Phone' })
    }).then(r => r.json());

    const utr = String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const smsBody = JSON.stringify({
      deviceId: device.deviceId,
      sender: 'HDFCBK',
      body: `Rs 10.00 credited to A/c X1234 via UPI. UTR ${utr}. -HDFC Bank`,
      timestamp: Date.now()
    });
    const timestamp = Date.now().toString();
    const signature = crypto.createHmac('sha256', device.signingKey).update(`${smsBody}:${timestamp}`).digest('hex');
    const ingest = await fetch(`${paymentBase}/api/v1/observers/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': device.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: smsBody
    });
    check('Signed Android SMS accepted', ingest.status === 200, `HTTP ${ingest.status}`);

    await waitFor(async () => (await evaluate(`document.querySelector('#resultStatus').dataset.phase`)) === 'PAYMENT_DETECTED', {
      timeoutMs: 15_000,
      label: 'PAYMENT_DETECTED in the UI'
    });
    check('UI updates to PAYMENT_DETECTED without a reload', true);
    await screenshot('link-detected-desktop');

    // ------------------------------------------- bank confirmation → SUCCESS
    const account = db.queryOne('SELECT id FROM payment_receiving_accounts ORDER BY created_at ASC LIMIT 1');
    const confirmation = await fetch(`${paymentBase}/api/v1/admin/bank-confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({
        receivingAccountId: account.id,
        bankReferenceNumber: utr,
        amountPaise: 1000,
        source: 'ACQUIRER'
      })
    });
    check('Bank confirmation accepted by the gateway', confirmation.status === 200, `HTTP ${confirmation.status}`);

    await waitFor(async () => (await evaluate(`document.querySelector('#resultStatus').dataset.phase`)) === 'SUCCESS', {
      timeoutMs: 15_000,
      label: 'SUCCESS in the UI'
    });
    check('UI shows SUCCESS only after bank confirmation', true);
    await screenshot('link-success-desktop');

    // ------------------------------------------------------- layout audit
    const layout = [];
    for (const viewport of VIEWPORTS) {
      await setViewport(viewport);

      // Login page (cookies cleared so the sign-in layout is measured).
      await cdp.send('Network.clearBrowserCookies', {}, sessionId);
      await cdp.send('Page.navigate', { url: `${adminBase}/login` }, sessionId);
      await waitForLoad();
      const loginLayout = await evaluate(OVERFLOW_PROBE);
      layout.push({ page: 'login', viewport: `${viewport.width}x${viewport.height}`, layout: loginLayout, file: await screenshot(`login-${viewport.name}`) });

      // Re-authenticate through the API so the session cookie is restored, then
      // keep the same UI interactions the operator would use.
      await evaluate(`fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: ${JSON.stringify(PASSWORD)} })
      }).then(r => r.status)`);
      await cdp.send('Page.navigate', { url: `${adminBase}/#overview` }, sessionId);
      await waitForLoad();
      await waitFor(async () => evaluate(`Boolean(document.querySelector('#linkForm'))`), { label: 'dashboard after viewport change' });

      for (const view of VIEWS) {
        if (view !== 'links') {
          await evaluate(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
          await sleep(900);
        } else {
          await evaluate(`document.querySelector('.nav-item[data-view="links"]').click()`);
          await sleep(400);
          await evaluate(`(() => { const amount = document.querySelector('#amount'); amount.value = '10'; document.querySelector('#linkForm').requestSubmit(); return true; })()`);
          await waitFor(async () => (await evaluate(`document.querySelector('#resultLink')?.value || ''`)).includes('/checkout/'), { label: 'link result for screenshot' });
          await sleep(500);
        }
        const layoutResult = await evaluate(OVERFLOW_PROBE);
        const file = await screenshot(`${view}-${viewport.name}`);
        layout.push({ page: view, viewport: `${viewport.width}x${viewport.height}`, layout: layoutResult, file });
        const ok = layoutResult.offenderCount === 0 && layoutResult.overflowCount === 0 && layoutResult.smallTargets.length === 0;
        check(
          `Layout ${view} @ ${viewport.width}px`,
          ok,
          `overflow=${layoutResult.overflowCount} offenders=${layoutResult.offenderCount} smallTargets=${layoutResult.smallTargets.length}`
        );
      }
    }

    // The checkout portal is a separate app with its own (pre-existing) asset
    // 404s. Only errors caused by the OpenUPI admin are failures here.
    const adminConsoleErrors = consoleErrors.filter(entry => {
      if (entry.url.includes('/favicon.ico')) return false;
      if (entry.url.startsWith(checkoutBase)) return false;
      return true;
    });
    check(
      'No browser console errors or uncaught exceptions',
      adminConsoleErrors.length === 0,
      adminConsoleErrors.slice(0, 3).map(entry => `${entry.kind} ${entry.text} ${entry.url}`).join(' | ')
    );

    const report = {
      generatedAt: new Date().toISOString(),
      adminUrl: adminBase,
      orderId,
      checks,
      layout,
      consoleErrors,
      adminConsoleErrors,
      failures
    };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

    console.log(`\nScreenshots + report: ${path.relative(repoRoot, outDir)}`);
    if (failures.length) {
      console.error(`FAIL — ${failures.length} check(s) failed:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS — ${checks.length} checks, ${layout.length} layout runs, no overflow or console errors.`);
    }
  } finally {
    // Close the browser FIRST: an open page keeps keep-alive sockets on the
    // admin server, and http.Server.close() waits for them before resolving.
    try { ws?.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
    await Promise.race([
      new Promise(resolve => chrome.once('exit', resolve)),
      sleep(4000)
    ]);

    const closeWithin = async (closeFn, ms = 5000) => {
      try { await Promise.race([closeFn(), sleep(ms)]); } catch { /* already closed */ }
    };
    await closeWithin(() => admin.close());
    await closeWithin(() => checkout.close());
    await closeWithin(() => payment.close());
    try { db.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}

// Chrome/CDP keep handles open on some platforms; exit explicitly once the
// report has been written and the local services are closed.
main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
