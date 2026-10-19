#!/usr/bin/env node
/**
 * Staging Payment Test Console — end-to-end synthetic run.
 *
 * Uses the REAL HTTP APIs and a REAL (temporary) SQLite database:
 *   merchant-admin console (authenticated) → payment API → checkout portal
 *   → paired Android device (signed SMS) → verification pipeline → DB
 *   → console status / SSE → authoritative bank confirmation.
 *
 * No real bank message, no real money. Every run creates a temporary database
 * under the OS temp directory and deletes it afterwards.
 *
 * Usage:
 *   node scripts/test-console-e2e.mjs --iterations=30
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { startAdminServer } from '../apps/merchant-admin/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'e2e_admin_api_key_1234567890';
process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.WEBHOOK_WORKER_INTERVAL_MS = '60000';
process.env.YOUPI_LATENCY_TRACE = process.env.YOUPI_LATENCY_TRACE || '1';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? 'true' : v];
}));

const ITERATIONS = Math.max(1, Number(args.iterations || 20));
const CONSOLE_TOKEN = 'e2e_test_console_token_1234567890';
const PUBLIC_CHECKOUT_ORIGIN = 'https://pay.169.58.29.37.sslip.io';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-console-e2e-'));
const dbPath = path.join(tempDir, 'youpi-e2e.sqlite');

const round = v => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};
const summarize = values => {
  const s = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: s.length,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    min: round(s[0]),
    max: round(s[s.length - 1])
  };
};

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

/**
 * Opens the console SSE proxy. Resolves the handshake immediately with:
 *  - connected: promise that resolves when the stream is registered
 *  - event: promise that resolves on the first status_change
 *  - close(): tears the stream down
 */
function openConsoleSse(adminBase, cookie, paymentId) {
  return new Promise(resolveOpen => {
    let connectedResolve;
    let eventResolve;
    const connected = new Promise(r => { connectedResolve = r; });
    const event = new Promise(r => { eventResolve = r; });
    const req = http.get(new URL(`/api/test-console/payments/${paymentId}/events`, adminBase), {
      headers: { Accept: 'text/event-stream', Cookie: cookie }
    }, res => {
      if (res.statusCode !== 200) {
        connectedResolve(false);
        eventResolve(null);
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        if (buffer.includes('event: connected')) connectedResolve(true);
        if (buffer.includes('event: status_change')) eventResolve(performance.now());
      });
      res.on('end', () => { connectedResolve(false); eventResolve(null); });
    });
    req.on('error', () => { connectedResolve(false); eventResolve(null); });
    setTimeout(() => { connectedResolve(false); }, 2000).unref?.();
    setTimeout(() => { eventResolve(null); }, 5000).unref?.();
    resolveOpen({
      connected,
      event,
      close: () => { try { req.destroy(); } catch { /* ignore */ } }
    });
  });
}

async function waitForPhase(adminBase, cookie, paymentId, phase, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs;
  const started = performance.now();
  while (performance.now() < deadline) {
    const res = await request(adminBase, `/api/test-console/payments/${paymentId}`, { headers: { Cookie: cookie } });
    if (res.status === 200 && res.body.phase === phase) {
      return { found: true, at: performance.now(), elapsedMs: performance.now() - started, body: res.body };
    }
    await new Promise(r => setTimeout(r, 2));
  }
  return { found: false, at: null, elapsedMs: performance.now() - started, body: null };
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

async function main() {
  const db = new Database({ dbPath });
  const payment = await startPaymentApi(6361, db);
  const paymentBase = `http://127.0.0.1:${payment.port}`;
  const admin = await startAdminServer(6161, {
    db,
    apiInternalUrl: paymentBase,
    env: {
      ...process.env,
      YOUPI_TEST_CONSOLE_ENABLED: '1',
      YOUPI_TEST_CONSOLE_TOKEN: CONSOLE_TOKEN,
      BASE_CHECKOUT_URL: PUBLIC_CHECKOUT_ORIGIN
    }
  });
  const adminBase = `http://127.0.0.1:${admin.port}`;
  const checkout = await startCheckoutServer(7361, { apiInternalUrl: paymentBase });
  const checkoutBase = `http://127.0.0.1:${checkout.port}`;

  const login = await request(adminBase, '/api/test-console/session', {
    method: 'POST',
    body: { token: CONSOLE_TOKEN }
  });
  if (login.status !== 200) throw new Error(`Console login failed: ${login.status}`);
  const setCookie = login.headers['set-cookie'];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

  const qr = await request(paymentBase, '/api/v1/admin/sms-gateway/pair-qr', { headers: ADMIN_HEADERS });
  const pair = await request(paymentBase, '/api/v1/observers/sms/pair', {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: { enrollmentToken: qr.body.enrollmentToken, deviceName: 'E2E Synthetic Observer' }
  });
  if (pair.status !== 200) throw new Error(`Device pairing failed: ${pair.status} ${pair.text}`);
  const device = pair.body;

  const consoleVisible = [];
  const sseEvent = [];
  const ingestResponse = [];
  const serverMatched = [];
  const serverPersisted = [];
  const failures = [];
  let successChecks = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const created = await request(adminBase, '/api/test-console/payments', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Console-Request': '1' },
      body: { amount: '10.00' }
    });
    if (created.status !== 201 || created.body.phase !== 'AWAITING_PAYMENT') {
      failures.push({ iteration: i, stage: 'create', status: created.status, body: created.body });
      continue;
    }

    const paymentId = created.body.paymentId;
    const checkoutUrl = created.body.checkoutUrl;
    const token = new URL(checkoutUrl).searchParams.get('t');

    const state = await request(checkoutBase, `/api/v1/checkout/${paymentId}/state?t=${encodeURIComponent(token)}`);
    if (state.status !== 200 || state.body.amount !== '10.00' || state.body.payeeVpa !== 'merchant@upi') {
      failures.push({ iteration: i, stage: 'guest-checkout', status: state.status, body: state.body });
      continue;
    }

    const utr = String(Date.now()).slice(-6) + String(i + 1).padStart(6, '0');
    const smsBody = `Rs 10.00 credited to A/c X1234 via UPI. UTR ${utr}. -HDFCBK`;
    const signed = signedAndroidSms(device, smsBody);

    const sse = await openConsoleSse(adminBase, cookie, paymentId);
    const sseConnected = await sse.connected;
    const t0 = performance.now();
    const ingest = await new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/v1/observers/sms', paymentBase), {
        method: 'POST',
        headers: signed.headers
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}'), at: performance.now() }));
      });
      req.on('error', reject);
      req.write(signed.bodyString);
      req.end();
    });

    if (ingest.status !== 200 || ingest.body.attribution?.attributed !== true) {
      failures.push({ iteration: i, stage: 'ingest', status: ingest.status, body: ingest.body });
      continue;
    }

    const visible = await waitForPhase(adminBase, cookie, paymentId, 'PAYMENT_DETECTED');
    if (!visible.found) {
      failures.push({ iteration: i, stage: 'detected', body: visible.body, sseConnected });
      sse.close();
      continue;
    }
    if (visible.body.status === 'SUCCESS') {
      failures.push({ iteration: i, stage: 'unexpected-success-without-bank-proof' });
      sse.close();
      continue;
    }

    consoleVisible.push(visible.at - t0);
    ingestResponse.push(ingest.at - t0);
    const eventAt = await Promise.race([sse.event, new Promise(r => setTimeout(() => r(null), 200))]);
    if (sseConnected && Number.isFinite(eventAt)) sseEvent.push(eventAt - t0);
    sse.close();
    if (visible.body.latency) {
      serverMatched.push(Number(visible.body.latency.matchedMs));
      serverPersisted.push(Number(visible.body.latency.persistedMs));
    }

    const confirmation = await request(paymentBase, '/api/v1/admin/bank-confirmations', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: {
        receivingAccountId: ACCOUNT_ID,
        bankReferenceNumber: utr,
        amountPaise: 1000,
        source: 'ACQUIRER'
      }
    });
    if (confirmation.status !== 200 || confirmation.body.confirmed !== true) {
      failures.push({ iteration: i, stage: 'bank-confirmation', status: confirmation.status, body: confirmation.body });
      continue;
    }

    const settled = await waitForPhase(adminBase, cookie, paymentId, 'SUCCESS', 3000);
    if (!settled.found || settled.body.confirmationStatus !== 'BANK_CONFIRMED') {
      failures.push({ iteration: i, stage: 'settled', body: settled.body });
      continue;
    }
    successChecks++;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    completedSuccessfully: successChecks,
    failures,
    syntheticFlow: {
      consoleCreate: 'POST /api/test-console/payments (authenticated, server-side merchant key)',
      guestCheckout: 'GET /checkout/:id?t=… + GET /api/v1/checkout/:id/state?t=…',
      observation: 'POST /api/v1/observers/sms (HMAC-SHA256 signed Android device)',
      detected: 'console status: AWAITING_PAYMENT → PAYMENT_DETECTED (never SUCCESS on SMS alone)',
      settlement: 'POST /api/v1/admin/bank-confirmations (authoritative bank proof)'
    },
    latencyMs: {
      observationToIngestResponse: summarize(ingestResponse),
      observationToConsoleSseEvent: summarize(sseEvent),
      observationToConsoleVisible: summarize(consoleVisible),
      serverMatched: summarize(serverMatched),
      serverPersisted: summarize(serverPersisted)
    },
    target: { visibleP95AtMostMs: 500, met: (summarize(consoleVisible).p95 ?? Infinity) <= 500 }
  };

  console.log(JSON.stringify(result, null, 2));

  await checkout.close();
  await admin.close();
  await payment.close();
  db.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }

  if (failures.length > 0 || successChecks !== ITERATIONS) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
