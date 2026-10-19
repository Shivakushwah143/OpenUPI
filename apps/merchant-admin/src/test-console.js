import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPaise, toRupeesString, constantTimeEquals, ConfirmationStatus } from '@youpi/common';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONSOLE_COOKIE = 'ypg_test_console';
export const CONSOLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const CONSOLE_MIN_AMOUNT_PAISE = 100n; // ₹1
export const CONSOLE_MAX_AMOUNT_PAISE = 10000n; // ₹100
const MIN_TOKEN_LENGTH = 24;

/**
 * Staging-only test console configuration. The console is DISABLED unless the
 * operator explicitly opts in AND supplies a strong access token. It is never
 * controlled by NODE_ENV: staging runs production builds.
 * @param {Record<string, string|undefined>} [env]
 */
export function readTestConsoleConfig(env = process.env) {
  const token = String(env.YOUPI_TEST_CONSOLE_TOKEN || '').trim();
  const explicitlyEnabled = String(env.YOUPI_TEST_CONSOLE_ENABLED || '') === '1';
  return {
    enabled: explicitlyEnabled && token.length >= MIN_TOKEN_LENGTH,
    requested: explicitlyEnabled,
    token,
    checkoutBaseUrl: String(env.BASE_CHECKOUT_URL || '').trim().replace(/\/+$/, '')
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch { /* ignore malformed cookie values */ }
  }
  return out;
}

function sessionKey(token) {
  return crypto.createHash('sha256').update(`youpi-test-console:${token}`).digest();
}

function signSession(token, expiresAt) {
  return crypto.createHmac('sha256', sessionKey(token)).update(`v1:${expiresAt}`).digest('hex');
}

function issueSessionValue(token) {
  const expiresAt = Date.now() + CONSOLE_SESSION_TTL_MS;
  return `${expiresAt}.${signSession(token, expiresAt)}`;
}

function isSessionValid(token, value) {
  if (!value || typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const expiresAt = Number(value.slice(0, dot));
  const signature = value.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  return constantTimeEquals(signSession(token, expiresAt), signature);
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) reject(new Error('PAYLOAD_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('MALFORMED_JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Maps the payment state machine + verification evidence onto the two phases the
 * staging console promises: AWAITING_PAYMENT → PAYMENT_DETECTED, and only then a
 * bank-confirmed SUCCESS. A reported observation never becomes SUCCESS here.
 * @param {any} state
 */
export function deriveConsolePhase(state = {}) {
  const status = String(state.status || '').toUpperCase();
  const confirmation = String(state.confirmationStatus || '').toUpperCase();

  if (status === 'SUCCESS') return 'SUCCESS';
  if (['FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED'].includes(status)) return status;
  if (state.paymentDetected === true || confirmation === ConfirmationStatus.REPORTED) return 'PAYMENT_DETECTED';
  if (status === 'QUEUED') return 'QUEUED';
  return 'AWAITING_PAYMENT';
}

function canonicalCheckoutUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  if (!baseUrl) return rawUrl;
  try {
    const raw = new URL(rawUrl);
    const base = new URL(baseUrl);
    return `${base.origin}${raw.pathname}${raw.search}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Minimal, authenticated staging console living inside the private merchant-admin
 * app. It never exposes the merchant credential to the browser: payment creation
 * and status reads are performed server-side with the tenant key.
 */
export class TestConsole {
  /**
   * @param {{
   *   db: any,
   *   merchantRepo: any,
   *   apiTarget: { hostname: string, port: number },
   *   apiInternalBaseUrl: string,
   *   config?: ReturnType<typeof readTestConsoleConfig>,
   *   env?: Record<string, string|undefined>
   * }} options
   */
  constructor(options) {
    this.db = options.db;
    this.merchantRepo = options.merchantRepo;
    this.apiTarget = options.apiTarget;
    this.apiInternalBaseUrl = String(options.apiInternalBaseUrl || '').replace(/\/+$/, '');
    this.config = options.config || readTestConsoleConfig(options.env || process.env);
    this.templatePath = path.join(__dirname, 'views', 'test-console.html');
    this.attempts = new Map(); // ip -> { count, resetAt }
  }

  get enabled() {
    return this.config.enabled === true;
  }

  /** Header navigation entry rendered into the admin dashboard when enabled. */
  navHtml() {
    if (!this.enabled) return '';
    return '<a class="main-nav-btn" href="/test-console" style="text-decoration:none;">'
      + '<span>🧪</span><span>Payment Test Console</span></a>';
  }

  _clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || 'unknown';
  }

  _rateLimited(req) {
    const ip = this._clientIp(req);
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    entry.count += 1;
    return entry.count > 10;
  }

  _authenticated(req) {
    if (!this.enabled) return false;
    const cookies = parseCookies(req.headers.cookie);
    return isSessionValid(this.config.token, cookies[CONSOLE_COOKIE]);
  }

  _merchant() {
    const merchant = this.merchantRepo.getDefault
      ? this.merchantRepo.getDefault()
      : (this.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || this.merchantRepo.findAll()[0]);
    if (!merchant || !merchant.apiKey) return null;
    const account = this.db.queryOne(
      'SELECT id, upi_id, payee_name FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1',
      [merchant.id]
    );
    return account ? { merchant, account } : null;
  }

  _apiHeaders(merchant) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': merchant.apiKey,
      // The console is only reachable over loopback/SSH tunnel; the gateway's TLS
      // guard honours the forwarded scheme exactly as the existing proxy does.
      'X-Forwarded-Proto': 'https'
    };
  }

  async _apiFetch(pathname, merchant, options = {}) {
    const res = await fetch(`${this.apiInternalBaseUrl}${pathname}`, {
      ...options,
      headers: { ...this._apiHeaders(merchant), ...(options.headers || {}) },
      signal: AbortSignal.timeout(options.timeoutMs || 8000)
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }

  _normalizeState(state, extra = {}) {
    const phase = deriveConsolePhase(state);
    return {
      paymentId: state.paymentId || state.id,
      orderId: state.orderId,
      amount: state.amount,
      amountPaise: state.amountPaise,
      currency: state.currency || 'INR',
      status: state.status,
      phase,
      confirmationStatus: state.confirmationStatus || ConfirmationStatus.UNCONFIRMED,
      paymentDetected: state.paymentDetected === true,
      payeeVpa: state.payeeVpa || null,
      payeeName: state.payeeName || null,
      upiUri: state.upiUri || null,
      expiresAt: state.expiresAt || null,
      timeRemainingSeconds: state.timeRemainingSeconds ?? null,
      latency: state.observationLatency || null,
      serverNow: state.serverNow || new Date().toISOString(),
      ...extra
    };
  }

  async handle(req, res, pathname) {
    if (!this.enabled) return false;

    if (pathname === '/test-console' && req.method === 'GET') {
      try {
        const html = fs.readFileSync(this.templatePath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Test console unavailable: ${err.message}`);
      }
      return true;
    }

    if (pathname === '/api/test-console/session' && req.method === 'GET') {
      const merchant = this._authenticated(req) ? this._merchant() : null;
      json(res, 200, {
        enabled: true,
        authenticated: this._authenticated(req),
        merchantName: merchant?.merchant?.businessName || null,
        payeeVpa: merchant?.account?.upi_id || null,
        checkoutHost: this.config.checkoutBaseUrl || null
      });
      return true;
    }

    if (pathname === '/api/test-console/session' && req.method === 'POST') {
      if (this._rateLimited(req)) {
        json(res, 429, { error: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' });
        return true;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        json(res, 400, { error: err.message });
        return true;
      }
      const presented = String(body.token || '');
      const valid = presented.length > 0 && constantTimeEquals(presented, this.config.token);
      if (!valid) {
        json(res, 401, { error: 'UNAUTHORIZED', message: 'Invalid console access token.' });
        return true;
      }
      this.attempts.delete(this._clientIp(req));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${CONSOLE_COOKIE}=${encodeURIComponent(issueSessionValue(this.config.token))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(CONSOLE_SESSION_TTL_MS / 1000)}`
      });
      res.end(JSON.stringify({ authenticated: true }));
      return true;
    }

    if (pathname === '/api/test-console/session' && req.method === 'DELETE') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${CONSOLE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
      });
      res.end(JSON.stringify({ authenticated: false }));
      return true;
    }

    // Every privileged console call requires the signed console session cookie
    // and an explicit same-origin request marker (CSRF defence).
    if (pathname.startsWith('/api/test-console/')) {
      if (!this._authenticated(req)) {
        json(res, 401, { error: 'UNAUTHORIZED', message: 'Console login required.' });
        return true;
      }
      if (req.method !== 'GET' && String(req.headers['x-console-request'] || '') !== '1') {
        json(res, 403, { error: 'FORBIDDEN', message: 'Missing console request marker.' });
        return true;
      }
    }

    if (pathname === '/api/test-console/payments' && req.method === 'POST') {
      const selected = this._merchant();
      if (!selected) {
        json(res, 503, { error: 'NO_ACTIVE_RECEIVING_ACCOUNT', message: 'Configure an active merchant receiving VPA first.' });
        return true;
      }

      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        json(res, 400, { error: err.message });
        return true;
      }

      let amountPaise;
      try {
        amountPaise = toPaise(body.amount);
      } catch (err) {
        json(res, 400, { error: 'INVALID_AMOUNT', message: err.message });
        return true;
      }
      if (amountPaise < CONSOLE_MIN_AMOUNT_PAISE || amountPaise > CONSOLE_MAX_AMOUNT_PAISE) {
        json(res, 400, {
          error: 'AMOUNT_OUT_OF_RANGE',
          message: 'Test payments are limited to ₹1.00 – ₹100.00.'
        });
        return true;
      }

      const orderId = `TC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const created = await this._apiFetch('/api/v1/payments', selected.merchant, {
        method: 'POST',
        body: JSON.stringify({
          orderId,
          amount: toRupeesString(amountPaise),
          currency: 'INR',
          autoActivate: true,
          metadata: {
            testConsole: true,
            guestCheckout: true,
            source: 'staging-payment-test-console'
          }
        })
      });

      if (created.status !== 201 || !created.body?.paymentId) {
        json(res, created.status === 201 ? 502 : created.status, {
          error: 'PAYMENT_CREATION_FAILED',
          message: created.body?.error || 'The payment API did not create the test session.'
        });
        return true;
      }

      const checkoutUrl = canonicalCheckoutUrl(created.body.checkoutUrl, this.config.checkoutBaseUrl);
      const stateResult = await this._apiFetch(
        `/api/v1/checkout/${encodeURIComponent(created.body.paymentId)}/state`,
        selected.merchant
      );

      json(res, 201, {
        ...this._normalizeState(stateResult.body || {}, {
          paymentId: created.body.paymentId,
          orderId: created.body.orderId,
          amount: created.body.amount,
          amountPaise: created.body.amountPaise,
          status: created.body.status || stateResult.body?.status,
          checkoutUrl
        }),
        // The scoped checkout credential is embedded in the link only. The
        // browser never receives the merchant API key.
        guestCheckout: true
      });
      return true;
    }

    const statusMatch = pathname.match(/^\/api\/test-console\/payments\/([A-Za-z0-9-]+)$/);
    if (statusMatch && req.method === 'GET') {
      const selected = this._merchant();
      if (!selected) {
        json(res, 503, { error: 'NO_ACTIVE_RECEIVING_ACCOUNT' });
        return true;
      }
      const paymentId = statusMatch[1];
      const stateResult = await this._apiFetch(
        `/api/v1/checkout/${encodeURIComponent(paymentId)}/state`,
        selected.merchant
      );
      if (stateResult.status !== 200) {
        json(res, stateResult.status, {
          error: stateResult.body?.error || 'PAYMENT_STATUS_UNAVAILABLE'
        });
        return true;
      }
      json(res, 200, this._normalizeState(stateResult.body));
      return true;
    }

    // Real-time updates use the payment API's existing per-session SSE stream.
    // The console session is validated here; the merchant credential is attached
    // server-side and never reaches the browser.
    const eventsMatch = pathname.match(/^\/api\/test-console\/payments\/([A-Za-z0-9-]+)\/events$/);
    if (eventsMatch && req.method === 'GET') {
      const selected = this._merchant();
      if (!selected) {
        json(res, 503, { error: 'NO_ACTIVE_RECEIVING_ACCOUNT' });
        return true;
      }
      const paymentId = eventsMatch[1];
      const upstream = http.request({
        hostname: this.apiTarget.hostname,
        port: this.apiTarget.port,
        path: `/api/v1/checkout/${encodeURIComponent(paymentId)}/stream`,
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'X-API-Key': selected.merchant.apiKey,
          'X-Forwarded-Proto': 'https'
        }
      }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, {
          'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff'
        });
        upstreamRes.pipe(res);
      });

      upstream.on('error', () => {
        if (!res.headersSent) json(res, 502, { error: 'SSE_UPSTREAM_UNAVAILABLE' });
      });
      req.on('close', () => upstream.destroy());
      upstream.end();
      return true;
    }

    json(res, 404, { error: 'TEST_CONSOLE_ROUTE_NOT_FOUND' });
    return true;
  }
}
