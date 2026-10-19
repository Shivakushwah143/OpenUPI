#!/usr/bin/env node
/**
 * Payment-detection latency benchmark (OpenUPI / YOUPI PG).
 *
 * Measures the controllable in-process API path end-to-end on the REAL HTTP
 * surface, with synthetic signed Android observations (never real bank data):
 *
 *   t0 ──► POST /api/v1/pollers/android/events (signed device observation)
 *      ├── ingest HTTP response            (server-side processing + transport)
 *      ├── SSE status_change delivered     (checkout realtime push)
 *      └── GET /api/v1/checkout/:id/state  (what a polling checkout sees:
 *                                           paymentDetected === true)
 *
 * Usage:
 *   node scripts/latency-bench.mjs --iterations=60 --probe-delay=0
 *   node scripts/latency-bench.mjs --iterations=60 --probe-delay=120 --out=/tmp/after.json
 *
 * `--probe-delay` starts stub observer services on 6002/6003/6099 (the ports
 * `checkUpiServerHealth` probes) answering `/api/browser/status` and `/health`
 * after that many ms. Without it the ports stay closed (services down).
 */
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Database } from '@youpi/db';
import { startServer } from '../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../apps/android-observer-app/driver.js';
import { generateHmac } from '@youpi/common';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? 'true' : v];
  })
);

const ITERATIONS = Number(args.iterations || 60);
const WARMUP = Number(args.warmup || 5);
const PROBE_DELAY = Number(args['probe-delay'] || 0);
const OUT = args.out || null;
const PORT = Number(args.port || 6311);
const LABEL = args.label || `probe-delay=${PROBE_DELAY}`;

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'bench_admin_api_key_123';
process.env.YOUPI_SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.WEBHOOK_WORKER_INTERVAL_MS = '60000';
process.env.YOUPI_DB_STATS = '1';

const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };

/** Observer-service stubs used to simulate live-but-slow observers. */
function startProbeStubs(delayMs) {
  const servers = [];
  for (const port of [6002, 6003, 6099]) {
    const srv = http.createServer((req, res) => {
      const slow = req.url.includes('/browser/status') || req.url === '/health';
      const body = JSON.stringify({
        status: 'UP',
        isPaired: true,
        isPolling: true,
        pollerActive: true,
        isLoggedIn: true,
        mode: 'BACKGROUND',
        lastSeenAt: new Date().toISOString()
      });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      }, slow ? delayMs : 0);
    });
    srv.listen(port);
    servers.push(srv);
  }
  return { close: () => Promise.all(servers.map(s => new Promise(r => s.close(r)))) };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    min: round(s[0]),
    max: round(s[s.length - 1])
  };
}

const round = v => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/** Opens the checkout SSE stream and resolves on connection + first status event. */
function openCheckoutStream(baseUrl, sessionId, token) {
  const url = `${baseUrl}/api/v1/checkout/${sessionId}/stream?t=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE handshake failed: HTTP ${res.statusCode}`));
        return;
      }
      let buffer = '';
      let connectedResolve;
      const connected = new Promise(r => { connectedResolve = r; });
      let statusResolve = null;
      const statusChange = new Promise(r => { statusResolve = r; });

      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        if (buffer.includes('event: connected') && connectedResolve) {
          const r = connectedResolve;
          connectedResolve = null;
          r(performance.now());
        }
        if (statusResolve && (buffer.includes('event: status_change') || buffer.includes('event: state_change'))) {
          const r = statusResolve;
          statusResolve = null;
          r(performance.now());
        }
      });
      res.on('error', () => {});
      resolve({
        connected,
        statusChange,
        close: () => { try { req.destroy(); } catch { /* ignore */ } }
      });
    });
    req.on('error', reject);
  });
}

/** Signed device observation via the real ingest route (mirrors the Android app). */
async function submitSignedObservation(baseUrl, device, bodyObj) {
  const bodyString = JSON.stringify(bodyObj);
  const timestamp = Date.now().toString();
  const signature = generateHmac(`${bodyString}:${timestamp}`, device.signingKey);
  const res = await fetch(`${baseUrl}/api/v1/pollers/android/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': device.deviceId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'X-Youpi-Trace': '1'
    },
    body: bodyString
  });
  return { status: res.status, body: await res.json(), trace: res.headers.get('x-youpi-trace') };
}

async function waitForCheckoutVisible(baseUrl, sessionId, token, t0, stateTraces, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const t = performance.now();
    const res = await fetch(`${baseUrl}/api/v1/checkout/${sessionId}/state`, {
      headers: { 'X-Checkout-Token': token, 'X-Youpi-Trace': '1' }
    });
    if (res.ok) {
      const body = await res.json();
      const trace = res.headers.get('x-youpi-trace');
      if (trace && stateTraces.length < 3) stateTraces.push({ ms: performance.now() - t, trace });
      if (body.paymentDetected === true) return performance.now() - t0;
    }
    await new Promise(r => setTimeout(r, 1));
  }
  return null;
}

async function main() {
  const stubs = PROBE_DELAY > 0 ? startProbeStubs(PROBE_DELAY) : null;
  const testDb = new Database({ inMemory: true });
  const api = await startServer(PORT, testDb);
  const baseUrl = `http://127.0.0.1:${api.port}`;

  const driver = new AndroidObserverDriver({ apiBaseUrl: baseUrl, deviceName: 'Bench Phone' });
  const qrRes = await fetch(`${baseUrl}/api/v1/admin/sms-gateway/pair-qr`, { headers: ADMIN_HEADERS });
  const qr = await qrRes.json();
  await driver.pair(qr.enrollmentToken);

  const ctx = api.app.context;
  const samples = { ingestResponse: [], sseStatusChange: [], checkoutVisible: [], stateRoundTrip: [] };
  const traceSamples = { ingest: [], state: [] };
  let failures = 0;

  // Extra DB queries executed per ingest (statement-level counter, workload differ)
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const session = ctx.sessionRepo.create({
      merchantId: MERCHANT_ID,
      receivingAccountId: ACCOUNT_ID,
      orderId: `BENCH-ORD-${i}`,
      amountPaise: 1000n,
      method: 'UPI'
    });
    ctx.queueEngine.enqueueOrActivate(session.id, ACCOUNT_ID);
    ctx.timingEngine.handlePaymentDone(session.id);
    const token = session.checkoutToken;

    const sse = await openCheckoutStream(baseUrl, session.id, token);
    await sse.connected;

    const utr = `BENCH${Date.now().toString().slice(-8)}${i}`;
    const t0 = performance.now();
    const obsPromise = submitSignedObservation(baseUrl, driver, {
      deviceId: driver.deviceId,
      receivingAccountId: ACCOUNT_ID,
      amount: '10.00',
      amountPaise: '1000',
      observedAt: new Date().toISOString(),
      bankReferenceNumber: utr,
      senderVpa: 'rahul@paytm',
      rawNotification: {
        title: 'Payment Received',
        text: '\u20b910 received from Rahul Sharma (rahul@paytm)',
        package: 'com.phonepe.app'
      }
    });
    const sseAt = await Promise.race([sse.statusChange, new Promise(r => setTimeout(() => r(null), 3000))]);
    const obs = await obsPromise;
    const tResp = performance.now();

    if (i >= WARMUP && obs.trace && traceSamples.ingest.length < 3) {
      traceSamples.ingest.push(obs.trace);
    }

    const visible = await waitForCheckoutVisible(baseUrl, session.id, token, t0, traceSamples.state);
    sse.close();

    if (i >= WARMUP) {
      if (obs.status !== 200 || !obs.body?.attribution?.attributed) {
        failures++;
      } else {
        samples.ingestResponse.push(tResp - t0);
        if (sseAt !== null) samples.sseStatusChange.push(sseAt - t0);
        if (visible !== null) samples.checkoutVisible.push(visible);
      }
    }

    // Free the single UPI slot for the next iteration.
    try {
      const cur = ctx.sessionRepo.findById(session.id);
      ctx.sessionRepo.transitionToTerminal(
        session.id,
        cur?.status === 'PROCESSING' ? 'FAILED' : 'EXPIRED'
      );
    } catch { /* already terminal */ }
  }

  // Checkout state round-trip cost on its own (no observation in flight).
  const probeSession = ctx.sessionRepo.create({
    merchantId: MERCHANT_ID, receivingAccountId: ACCOUNT_ID, orderId: 'BENCH-STATE', amountPaise: 1000n, method: 'UPI'
  });
  ctx.queueEngine.enqueueOrActivate(probeSession.id, ACCOUNT_ID);
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    await fetch(`${baseUrl}/api/v1/checkout/${probeSession.id}/state`, {
      headers: { 'X-Checkout-Token': probeSession.checkoutToken }
    });
    samples.stateRoundTrip.push(performance.now() - s);
  }

  const result = {
    label: LABEL,
    iterations: ITERATIONS,
    probeDelayMs: PROBE_DELAY,
    failures,
    ingestResponseMs: summarize(samples.ingestResponse),
    sseStatusChangeMs: summarize(samples.sseStatusChange),
    checkoutVisibleMs: summarize(samples.checkoutVisible),
    stateRoundTripMs: summarize(samples.stateRoundTrip),
    traceSamples
  };

  console.log(JSON.stringify(result, null, 2));
  if (OUT) {
    const fs = await import('node:fs');
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  }

  await api.close();
  testDb.close();
  if (stubs) await stubs.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
