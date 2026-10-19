import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toPaise, toRupeesString, constantTimeEquals } from '@youpi/common';
import { readOpenupiAdminConfig } from './config.js';
import { AdminAuth, clientAddress } from './auth.js';
import {
  PaymentApiClient,
  PaymentApiError,
  applyPublicCheckoutOrigin,
  derivePhase,
  paiseToAmount,
  probeService,
  qrUrlFor
} from './payment-api-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, 'views');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_FILES = Object.freeze({
  '/assets/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8' },
  '/assets/brand/logo.svg': { file: 'brand/logo.svg', type: 'image/svg+xml' },
  '/assets/brand/favicon.svg': { file: 'brand/favicon.svg', type: 'image/svg+xml' }
});

const MAX_BODY_BYTES = 8 * 1024;
const OBSERVER_CACHE_MS = 10_000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders
  });
  res.end(text);
}

function normalizeRow(row) {
  const phase = derivePhase(row);
  return {
    id: row.id,
    orderId: row.orderId,
    amountPaise: Number(row.amountPaise || 0),
    amount: paiseToAmount(row.amountPaise),
    status: row.status,
    phase,
    method: row.method || 'UPI',
    verificationLevel: Number(row.verificationLevel || 0),
    verificationTag: row.verificationTag || 'UNVERIFIED',
    createdAt: row.createdAt || null,
    completedAt: row.completedAt || null
  };
}

function normalizeObserverPayload(payload = {}) {
  const now = Date.now();
  const devices = Array.isArray(payload?.android?.devices) ? payload.android.devices : [];
  const mapped = devices.map(device => {
    const lastSeenAt = device.lastSeenAt || device.lastHeartbeatAt || null;
    const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
    const heartbeatAgeSeconds = lastSeenMs ? Math.max(0, Math.round((now - lastSeenMs) / 1000)) : null;
    return {
      id: device.id,
      name: device.name || device.deviceName || 'Android observer',
      model: device.model || device.deviceModel || null,
      status: device.status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED',
      lastSeenAt,
      lastObservationAt: device.lastObservationAt || null,
      heartbeatAgeSeconds
    };
  });
  return {
    android: {
      devices: mapped,
      totalDevices: Number(payload?.android?.totalDevices || mapped.length),
      connectedDevices: mapped.filter(device => device.status === 'CONNECTED').length
    },
    gmail: payload?.gmail || { status: 'STANDBY', isLoggedIn: false, emailsObserved: 0 },
    sms: payload?.sms || { status: 'STANDBY', isPaired: false, messagesObserved: 0 }
  };
}

export class OpenupiAdminServer {
  /**
   * @param {{
   *   config?: ReturnType<typeof readOpenupiAdminConfig>,
   *   auth?: AdminAuth,
   *   api?: PaymentApiClient,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number
   * }} [options]
   */
  constructor(options = {}) {
    this.config = options.config || readOpenupiAdminConfig(options.env || process.env);
    if (this.config.errors.length > 0) {
      throw new Error(`OpenUPI admin configuration refused to start (${this.config.errors.length} issue(s)):\n- ${this.config.errors.join('\n- ')}`);
    }

    this.now = options.now || Date.now;
    this.auth = options.auth || new AdminAuth({
      username: this.config.username,
      passwordHash: this.config.passwordHash,
      sessionSecret: this.config.sessionSecret,
      sessionTtlMs: this.config.sessionTtlMs,
      cookieName: this.config.cookieName,
      cookieSecure: this.config.cookieSecure,
      now: this.now
    });
    this.api = options.api || new PaymentApiClient({
      baseUrl: this.config.apiBaseUrl,
      adminApiKey: this.config.adminApiKey
    });
    this.fetchImpl = options.fetchImpl || fetch;
    this.checkoutOrigin = (() => {
      try { return new URL(this.config.checkoutBaseUrl).origin; } catch { return ''; }
    })();
    this.observerCache = { at: 0, value: null };
    this.merchantCache = { at: 0, value: null };
  }

  get csp() {
    const imgSources = ["'self'", 'data:'];
    if (this.checkoutOrigin) imgSources.push(this.checkoutOrigin);
    return [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src ${imgSources.join(' ')}`,
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ');
  }

  applySecurityHeaders(req, res) {
    res.setHeader('Content-Security-Policy', this.csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  }

  expectedOrigin(req) {
    if (this.config.publicOrigin) return this.config.publicOrigin;
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const scheme = forwarded === 'https' || req.socket?.encrypted ? 'https' : 'http';
    return `${scheme}://${req.headers.host || 'localhost'}`;
  }

  /**
   * Rejects cross-site state-changing requests. Browsers always attach Origin to a
   * fetch POST/DELETE, so a missing header is treated as untrusted rather than
   * silently allowed.
   */
  sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(String(origin)).origin === this.expectedOrigin(req);
    } catch {
      return false;
    }
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        try {
          const parsed = JSON.parse(text);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return reject(Object.assign(new Error('INVALID_BODY'), { status: 400 }));
          }
          resolve(parsed);
        } catch {
          reject(Object.assign(new Error('MALFORMED_JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  serveStatic(res, entry) {
    try {
      const body = fs.readFileSync(path.join(PUBLIC_DIR, entry.file));
      res.writeHead(200, {
        'Content-Type': entry.type,
        'Cache-Control': 'no-cache',
        'Content-Length': body.length
      });
      res.end(body);
    } catch {
      sendText(res, 404, 'Not found');
    }
  }

  serveView(res, view) {
    try {
      const body = fs.readFileSync(path.join(VIEWS_DIR, view), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch {
      sendText(res, 500, 'OpenUPI admin view unavailable');
    }
  }

  async merchantIdentity() {
    if (Date.now() - this.merchantCache.at < 60_000 && this.merchantCache.value) {
      return this.merchantCache.value;
    }
    const settings = await this.api.merchantSettings();
    const identity = {
      id: settings.merchantId || null,
      businessName: settings.businessName || 'Merchant',
      envMode: settings.envMode || null,
      checkoutUrl: settings.runtimeUrls?.checkoutUrl || null
    };
    this.merchantCache = { at: Date.now(), value: identity };
    return identity;
  }

  async observerSnapshot() {
    if (Date.now() - this.observerCache.at < OBSERVER_CACHE_MS && this.observerCache.value) {
      return this.observerCache.value;
    }
    const payload = normalizeObserverPayload(await this.api.observers());
    this.observerCache = { at: Date.now(), value: payload };
    return payload;
  }

  async handleSession(req, res, method) {
    if (method === 'GET') {
      const session = this.auth.getSession(req);
      if (!session) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, {
        authenticated: true,
        csrfToken: session.csrfToken,
        user: { username: session.username },
        expiresAt: new Date(session.expiresAt).toISOString()
      });
    }

    if (method === 'POST') {
      if (!this.sameOrigin(req)) {
        return sendJson(res, 403, { error: 'ORIGIN_MISMATCH', message: 'Cross-site login attempts are refused.' });
      }
      const ip = clientAddress(req, this.config.trustProxy);
      const limit = this.auth.loginRateLimited(ip);
      if (limit.limited) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, {
          error: 'RATE_LIMITED',
          message: 'Too many sign-in attempts. Try again later.',
          retryAfterSeconds: limit.retryAfterSeconds
        });
      }

      let body;
      try {
        body = await this.readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const ok = this.auth.verifyCredentials(body.username, body.password);
      if (!ok) {
        console.warn(`[OpenUPI Admin] Sign-in refused for ${ip}`);
        return sendJson(res, 401, {
          error: 'INVALID_CREDENTIALS',
          message: 'Invalid username or password.'
        });
      }

      this.auth.resetLoginRateLimit(ip);
      this.auth.prune();
      const { session, signedValue } = this.auth.createSession({ ip, username: this.config.username });
      res.setHeader('Set-Cookie', this.auth.cookie(signedValue, Math.floor(this.config.sessionTtlMs / 1000)));
      return sendJson(res, 200, {
        authenticated: true,
        csrfToken: session.csrfToken,
        user: { username: session.username },
        expiresAt: new Date(session.expiresAt).toISOString()
      });
    }

    if (method === 'DELETE') {
      const session = this.auth.getSession(req);
      if (!session) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      if (!this.sameOrigin(req) || !this.csrfValid(req, session)) {
        return sendJson(res, 403, { error: 'CSRF_REJECTED' });
      }
      this.auth.destroySession(req);
      res.setHeader('Set-Cookie', this.auth.clearCookie());
      return sendJson(res, 200, { authenticated: false });
    }

    return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  csrfValid(req, session) {
    const presented = String(req.headers['x-openupi-csrf'] || '');
    if (!presented) return false;
    return constantTimeEquals(presented, session.csrfToken);
  }

  async handleOverview(res) {
    const errors = [];
    const [settings, upi, payments, observers, apiHealth, checkoutHealth] = await Promise.allSettled([
      this.merchantIdentity(),
      this.api.upiSettings(),
      this.api.listPayments(20),
      this.observerSnapshot(),
      probeService('Payment API', `${this.config.apiBaseUrl}/health`, this.fetchImpl),
      probeService('Checkout portal', `${this.config.checkoutInternalUrl}/health`, this.fetchImpl)
    ]);

    const settle = (result, label) => {
      if (result.status === 'fulfilled') return result.value;
      errors.push(label);
      return null;
    };

    const merchant = settle(settings, 'merchant');
    const receiving = settle(upi, 'receivingAccount');
    const paymentsValue = settle(payments, 'transactions');
    const observersValue = settle(observers, 'observers');
    settle(apiHealth, 'paymentApi');
    settle(checkoutHealth, 'checkoutPortal');

    const transactions = (paymentsValue || []).slice(0, 8).map(normalizeRow);
    const all = (paymentsValue || []).map(normalizeRow);
    const stats = {
      recentCount: all.length,
      collectedPaise: all.filter(row => row.phase === 'SUCCESS').reduce((sum, row) => sum + row.amountPaise, 0),
      awaitingCount: all.filter(row => row.phase === 'AWAITING_PAYMENT').length,
      detectedCount: all.filter(row => row.phase === 'PAYMENT_DETECTED').length
    };

    return {
      merchant,
      receiving: receiving
        ? {
            upiId: receiving.upiId || null,
            payeeName: receiving.payeeName || null,
            isActive: Boolean(receiving.isActive),
            isMerchantEnabled: Boolean(receiving.isMerchantEnabled)
          }
        : null,
      stats,
      transactions,
      observers: observersValue,
      services: [
        apiHealth.status === 'fulfilled' ? apiHealth.value : { name: 'Payment API', status: 'DOWN', latencyMs: null },
        checkoutHealth.status === 'fulfilled' ? checkoutHealth.value : { name: 'Checkout portal', status: 'DOWN', latencyMs: null }
      ],
      serverTime: new Date(this.now()).toISOString(),
      degraded: errors.length > 0,
      errors
    };
  }

  async handleCreateLink(req, res, session) {
    if (!this.auth.acquireLinkSlot(session)) {
      return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Too many payment links created. Wait a minute.' });
    }

    let body;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }

    let amountPaise;
    try {
      amountPaise = toPaise(body.amount);
    } catch (err) {
      return sendJson(res, 400, { error: 'INVALID_AMOUNT', message: err.message });
    }

    if (amountPaise < this.config.paymentLinkMinPaise || amountPaise > this.config.paymentLinkMaxPaise) {
      return sendJson(res, 400, {
        error: 'AMOUNT_OUT_OF_RANGE',
        message: `Payment links are limited to ₹1.00 – ₹100.00 (received ₹${toRupeesString(amountPaise)}).`
      });
    }

    const note = String(body.note || '').trim().slice(0, 120);
    const orderId = `OU-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    let merchant = null;
    try {
      merchant = await this.merchantIdentity();
    } catch {
      // Creation still works against the default tenant; the link just has no label.
    }

    let created;
    try {
      created = await this.api.createPayment({
        merchantId: merchant?.id || undefined,
        orderId,
        amount: toRupeesString(amountPaise),
        currency: 'INR',
        method: 'UPI',
        // The checkout page requires an active slot to render the QR. Operator-created
        // links use the same guest-checkout path as the existing staging console
        // (scoped checkout capability embedded in the URL only).
        autoActivate: true,
        metadata: {
          source: 'openupi-admin',
          guestCheckout: true,
          testConsole: true,
          ...(note ? { label: note } : {})
        }
      });
    } catch (err) {
      if (err instanceof PaymentApiError) {
        console.warn(`[OpenUPI Admin] Payment creation failed: ${err.code}`);
        return sendJson(res, err.status, {
          error: err.code,
          message: err.code === 'PAYMENT_API_AUTH_FAILED'
            ? 'The server-side gateway credential was rejected. Check ADMIN_API_KEY on the VPS.'
            : 'The payment gateway did not create the link. Try again.'
        });
      }
      throw err;
    }

    if (!created?.paymentId) {
      return sendJson(res, 502, { error: 'PAYMENT_CREATION_FAILED', message: 'The gateway returned no payment id.' });
    }

    const checkoutUrl = applyPublicCheckoutOrigin(created.checkoutUrl, this.config.checkoutBaseUrl);
    let state = null;
    try {
      state = await this.api.checkoutState(created.paymentId);
    } catch {
      // Link is still shareable; the UI falls back to the creation response.
    }

    let expiresAt = null;
    if (state && Number.isFinite(Number(state.timeRemainingSeconds))) {
      expiresAt = new Date(this.now() + Number(state.timeRemainingSeconds) * 1000).toISOString();
    }

    return sendJson(res, 201, {
      paymentId: created.paymentId,
      orderId: created.orderId || orderId,
      amount: created.amount || toRupeesString(amountPaise),
      amountPaise: Number(amountPaise),
      currency: created.currency || 'INR',
      status: state?.status || created.status || 'ACTIVE',
      phase: derivePhase(state || { status: created.status }),
      checkoutUrl,
      qrUrl: qrUrlFor(checkoutUrl, created.paymentId),
      payeeVpa: state?.payeeVpa || null,
      payeeName: state?.payeeName || null,
      expiresAt,
      createdAt: new Date(this.now()).toISOString(),
      guestCheckout: true,
      note: note || null
    });
  }

  async route(req, res, url) {
    const pathname = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (pathname === '/health') {
      return sendJson(res, 200, { status: 'UP', service: 'openupi-admin', time: new Date(this.now()).toISOString() });
    }

    if (pathname === '/robots.txt') {
      return sendText(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(302, { Location: '/assets/brand/favicon.svg', 'Cache-Control': 'no-cache' });
      return res.end();
    }

    if (STATIC_FILES[pathname]) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return this.serveStatic(res, STATIC_FILES[pathname]);
    }

    if (pathname === '/' || pathname === '/login') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      const session = this.auth.getSession(req);
      if (pathname === '/login' && session) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return this.serveView(res, session ? 'dashboard.html' : 'login.html');
    }

    if (pathname === '/api/session') {
      return this.handleSession(req, res, method);
    }

    if (!pathname.startsWith('/api/')) {
      return sendText(res, 404, 'Not found');
    }

    // Gateway API namespaces are never proxied by this app — not even for an
    // authenticated operator. Public API traffic stays on the pay/pay-api hosts.
    if (pathname.startsWith('/api/v1/')) {
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }

    // Every remaining API route requires an authenticated server-side session.
    const session = this.auth.getSession(req);
    if (!session) {
      return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Sign in to the OpenUPI admin.' });
    }

    if (method !== 'GET') {
      if (!this.sameOrigin(req) || !this.csrfValid(req, session)) {
        return sendJson(res, 403, { error: 'CSRF_REJECTED', message: 'Request origin or CSRF token was rejected.' });
      }
    }

    if (pathname === '/api/overview' && method === 'GET') {
      const overview = await this.handleOverview(res);
      return sendJson(res, 200, overview);
    }

    if (pathname === '/api/payment-links' && method === 'POST') {
      return this.handleCreateLink(req, res, session);
    }

    const linkMatch = pathname.match(/^\/api\/payment-links\/([A-Za-z0-9-]+)$/);
    if (linkMatch && method === 'GET') {
      const status = await this.api.paymentStatus(linkMatch[1]);
      if (!status) return sendJson(res, 404, { error: 'PAYMENT_NOT_FOUND' });
      return sendJson(res, 200, {
        paymentId: status.paymentId,
        orderId: status.orderId,
        amount: status.amount,
        amountPaise: Number(status.amountPaise || 0),
        status: status.status,
        internalStatus: status.internalStatus,
        phase: derivePhase(status),
        confirmationStatus: status.confirmationStatus || null,
        paymentDetected: status.paymentDetected === true,
        verificationLevel: Number(status.verificationLevel || 0),
        verificationTag: status.verificationTag || 'UNVERIFIED',
        completedAt: status.completedAt || null
      });
    }

    const txMatch = pathname.match(/^\/api\/transactions\/([A-Za-z0-9-]+)$/);
    if (txMatch && method === 'GET') {
      const status = await this.api.paymentStatus(txMatch[1]);
      if (!status) return sendJson(res, 404, { error: 'PAYMENT_NOT_FOUND' });
      return sendJson(res, 200, {
        id: status.paymentId,
        orderId: status.orderId,
        amount: status.amount,
        amountPaise: Number(status.amountPaise || 0),
        status: status.status,
        phase: derivePhase(status),
        confirmationStatus: status.confirmationStatus || null,
        paymentDetected: status.paymentDetected === true,
        verificationLevel: Number(status.verificationLevel || 0),
        verificationTag: status.verificationTag || 'UNVERIFIED',
        method: status.method || 'UPI',
        completedAt: status.completedAt || null
      });
    }

    if (pathname === '/api/transactions' && method === 'GET') {
      const requested = Number(url.searchParams.get('limit') || 25);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 100) : 25;
      const rows = await this.api.listPayments(limit);
      return sendJson(res, 200, {
        transactions: rows.map(normalizeRow),
        count: rows.length
      });
    }

    if (pathname === '/api/observers' && method === 'GET') {
      const observers = await this.observerSnapshot();
      return sendJson(res, 200, { ...observers, serverTime: new Date(this.now()).toISOString() });
    }

    if (pathname === '/api/services' && method === 'GET') {
      const services = await Promise.all([
        probeService('Payment API', `${this.config.apiBaseUrl}/health`, this.fetchImpl),
        probeService('Checkout portal', `${this.config.checkoutInternalUrl}/health`, this.fetchImpl)
      ]);
      return sendJson(res, 200, { services, serverTime: new Date(this.now()).toISOString() });
    }

    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      this.applySecurityHeaders(req, res);
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        await this.route(req, res, url);
      } catch (err) {
        if (err instanceof PaymentApiError) {
          if (!res.headersSent) {
            sendJson(res, err.status, { error: err.code, message: 'The payment gateway is unavailable. Try again shortly.' });
          }
          return;
        }
        console.error('[OpenUPI Admin] Unhandled error:', err?.message || 'unknown');
        if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
        else res.end();
      }
    });
  }
}
