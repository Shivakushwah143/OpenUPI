/**
 * Server-side client for the existing payment API.
 *
 * The operator credential (ADMIN_API_KEY) is attached here and only here. It is
 * never placed in a response body, a cookie or a rendered page. Browser JavaScript
 * only ever talks to the OpenUPI admin's own /api/* endpoints.
 */
export class PaymentApiError extends Error {
  constructor(code, status = 502, details = null) {
    super(code);
    this.name = 'PaymentApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const TERMINAL = new Set(['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED']);

/**
 * Maps the gateway's internal status + bank-confirmation evidence onto the phases
 * an operator understands. SUCCESS is only ever reported by the gateway itself.
 * @param {{status?: string, confirmationStatus?: string, verificationLevel?: number}} row
 */
export function derivePhase(row = {}) {
  const status = String(row.status || '').toUpperCase();
  const confirmation = String(row.confirmationStatus || '').toUpperCase();
  if (status === 'SUCCESS') return 'SUCCESS';
  if (TERMINAL.has(status)) return status;
  if (confirmation === 'REPORTED') return 'PAYMENT_DETECTED';
  // The list endpoint omits confirmationStatus; any recorded observation means the
  // pipeline saw the credit and is waiting for independent bank confirmation.
  if (!confirmation && Number(row.verificationLevel || 0) > 0) return 'PAYMENT_DETECTED';
  if (status === 'QUEUED') return 'QUEUED';
  if (status === 'INITIATED' || status === 'ACTIVE' || status === 'PROCESSING' || status === '') return 'AWAITING_PAYMENT';
  return status;
}

export function paiseToAmount(paise) {
  const value = BigInt(String(paise ?? 0));
  const rupees = value / 100n;
  const fraction = value % 100n;
  return `${rupees}.${fraction.toString().padStart(2, '0')}`;
}

/** Rewrites a gateway-issued checkout URL onto the public checkout host. */
export function applyPublicCheckoutOrigin(rawUrl, publicBase) {
  if (!rawUrl) return null;
  if (!publicBase) return rawUrl;
  try {
    const raw = new URL(rawUrl);
    const base = new URL(publicBase);
    return `${base.origin}${raw.pathname}${raw.search}`;
  } catch {
    return rawUrl;
  }
}

/** Derives the QR endpoint for a checkout URL, preserving its scoped token. */
export function qrUrlFor(checkoutUrl, paymentId) {
  if (!checkoutUrl) return null;
  try {
    const url = new URL(checkoutUrl);
    const qr = new URL(`/checkout/${encodeURIComponent(paymentId)}/qr.svg`, url.origin);
    qr.search = url.search;
    return qr.toString();
  } catch {
    return null;
  }
}

export class PaymentApiClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   adminApiKey: string,
   *   fetchImpl?: typeof fetch,
   *   timeoutMs?: number
   * }} options
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.adminApiKey = options.adminApiKey;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 8000;
  }

  /**
   * @param {string} pathname
   * @param {{ method?: string, body?: any, timeoutMs?: number, headers?: Record<string,string> }} [options]
   */
  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'X-Admin-Key': this.adminApiKey,
          // The admin app reaches the API over the private compose network. The
          // gateway's TLS guard honours the terminated public scheme, exactly as
          // the checkout portal and legacy admin already do.
          'X-Forwarded-Proto': 'https',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
      let body = null;
      const text = await res.text();
      if (text) {
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
    } catch (err) {
      if (err?.name === 'AbortError') throw new PaymentApiError('PAYMENT_API_TIMEOUT', 504);
      throw new PaymentApiError('PAYMENT_API_UNAVAILABLE', 502, { reason: err?.code || 'NETWORK' });
    } finally {
      clearTimeout(timer);
    }
  }

  async merchantSettings() {
    const res = await this.request('/api/v1/admin/merchant-settings');
    if (!res.ok) throw new PaymentApiError(res.status === 401 || res.status === 403 ? 'PAYMENT_API_AUTH_FAILED' : 'MERCHANT_SETTINGS_UNAVAILABLE', 502);
    return res.body;
  }

  async upiSettings() {
    const res = await this.request('/api/v1/admin/upi-settings');
    if (!res.ok) throw new PaymentApiError('UPI_SETTINGS_UNAVAILABLE', 502);
    return res.body;
  }

  async createPayment(payload) {
    const res = await this.request('/api/v1/payments', { method: 'POST', body: payload });
    if (!res.ok) {
      throw new PaymentApiError(
        res.status === 401 || res.status === 403 ? 'PAYMENT_API_AUTH_FAILED' : 'PAYMENT_CREATION_FAILED',
        502,
        { upstreamStatus: res.status, upstreamError: res.body?.error || null }
      );
    }
    return res.body;
  }

  async checkoutState(paymentId) {
    const res = await this.request(`/api/v1/checkout/${encodeURIComponent(paymentId)}/state`);
    if (!res.ok) throw new PaymentApiError('CHECKOUT_STATE_UNAVAILABLE', 502);
    return res.body;
  }

  async paymentStatus(paymentId) {
    const res = await this.request(`/api/v1/payments/${encodeURIComponent(paymentId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new PaymentApiError('PAYMENT_STATUS_UNAVAILABLE', 502);
    return res.body;
  }

  async listPayments(limit = 25, merchantId = null) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (merchantId) params.set('merchantId', merchantId);
    const res = await this.request(`/api/v1/admin/payments?${params.toString()}`);
    if (!res.ok) throw new PaymentApiError('PAYMENTS_UNAVAILABLE', 502);
    return Array.isArray(res.body?.payments) ? res.body.payments : [];
  }

  async observers() {
    const res = await this.request('/api/v1/admin/observers');
    if (!res.ok) throw new PaymentApiError('OBSERVERS_UNAVAILABLE', 502);
    return res.body;
  }
}

/** Probes an internal health endpoint and reports latency. */
export async function probeService(name, url, fetchImpl = fetch, timeoutMs = 2500) {
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return {
      name,
      status: res.ok ? 'UP' : 'DEGRADED',
      httpStatus: res.status,
      latencyMs: Date.now() - startedAt
    };
  } catch {
    return { name, status: 'DOWN', httpStatus: null, latencyMs: Date.now() - startedAt };
  }
}
