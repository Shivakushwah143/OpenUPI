import crypto from 'node:crypto';
import { HttpServer } from '../server.js';
import {
  constantTimeEquals,
  verifyObserverSignature,
  maskSecret,
  OBSERVER_AUTH_HEADERS
} from '@youpi/common';

/**
 * Server-enforced authentication & authorization for the payment API
 * (audit P0-02/P0-03/P0-04/P0-05/P0-07).
 *
 * Roles:
 * - ADMIN:    gateway operator — ADMIN_API_KEY via X-Admin-Key / Authorization: Bearer.
 * - MERCHANT: merchant backend — the merchant API key issued to that merchant
 *             (merchants.api_key). A caller-supplied x-merchant-id is NEVER identity:
 *             the tenant always comes from the presented credential.
 * - OBSERVER: signed server-to-server observation ingest (HMAC + timestamp + nonce).
 *
 * Enforcement is always attempted. When no ADMIN_API_KEY is configured, only
 * non-production (local/embedded) runs may proceed unverified; production startup
 * refuses to boot without it (fail closed).
 */

export const ADMIN_ROLE = 'ADMIN';
export const MERCHANT_ROLE = 'MERCHANT';
export const LOCAL_ROLE = 'LOCAL_UNVERIFIED';

/** Admin paths a merchant-role credential may use (own tenant scope only). */
export const MERCHANT_ALLOWED_ADMIN_PATHS = Object.freeze([
  '/api/v1/admin/merchant-settings',
  '/api/v1/admin/upi-settings',
  '/api/v1/admin/sms-gateway/pair-qr',
  '/api/v1/admin/sms-gateway/devices',
  '/api/v1/admin/tunnel/status'
]);

export function resolveAdminApiKey() {
  return String(process.env.ADMIN_API_KEY || process.env.YOUPI_ADMIN_API_KEY || '').trim();
}

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function extractCredential(req, headerName) {
  const direct = req.headers[headerName];
  if (direct) return String(direct).trim();
  const auth = req.headers['authorization'];
  if (auth && typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function findMerchantByApiKey(ctx, key) {
  if (!key || !ctx || !ctx.merchantRepo) return null;
  if (typeof ctx.merchantRepo.findByApiKey === 'function') {
    const found = ctx.merchantRepo.findByApiKey(key);
    if (found) return found;
  }
  return ctx.merchantRepo.findAll().find(m => m.apiKey && constantTimeEquals(m.apiKey, key)) || null;
}

/**
 * Identifies the caller from the credential it presents. Identity claims
 * (x-merchant-id, body.merchantId) are never used.
 * @returns {{ role: string, actorId: string, merchantId?: string, merchant?: any } | null}
 */
export function identifyPrincipal(req, ctx = {}) {
  const adminKey = resolveAdminApiKey();
  const presentedAdmin = extractCredential(req, 'x-admin-key');
  if (adminKey && presentedAdmin && constantTimeEquals(presentedAdmin, adminKey)) {
    return { role: ADMIN_ROLE, actorId: String(req.headers['x-admin-id'] || 'admin_api_key') };
  }

  const merchantKey = extractCredential(req, 'x-api-key');
  const merchant = findMerchantByApiKey(ctx, merchantKey);
  if (merchant) {
    return { role: MERCHANT_ROLE, actorId: `merchant:${merchant.id}`, merchantId: merchant.id, merchant };
  }

  return null;
}

/**
 * Guards an administrative request. Returns the principal, or null after having
 * written the HTTP error response (401 unauthenticated / 403 wrong role/tenant).
 * @param {{ ctx?: any, requireRole?: string, allowMerchant?: boolean, allowLocalUnverified?: boolean }} options
 */
export function requireAdmin(req, res, options = {}) {
  const adminKeyConfigured = Boolean(resolveAdminApiKey());
  const principal = identifyPrincipal(req, options.ctx || {});

  if (!principal) {
    if (adminKeyConfigured || options.allowLocalUnverified === false || isProduction()) {
      HttpServer.json(res, 401, {
        error: 'UNAUTHORIZED',
        message: 'Administrative credentials required. Provide X-Admin-Key (or Authorization: Bearer).'
      });
      return null;
    }
    return { role: LOCAL_ROLE, actorId: 'local_unverified' };
  }

  if (principal.role === MERCHANT_ROLE && options.allowMerchant !== true) {
    HttpServer.json(res, 403, {
      error: 'FORBIDDEN',
      message: 'This administrative operation requires the gateway operator credential.'
    });
    return null;
  }

  if (options.requireRole && principal.role !== options.requireRole) {
    HttpServer.json(res, 403, {
      error: 'FORBIDDEN',
      message: `This operation requires role '${options.requireRole}'.`
    });
    return null;
  }

  return principal;
}

/**
 * Resolves the merchant acting for a request from its credential (P0-07).
 * @returns {{ ok: boolean, merchant?: any, code?: string }}
 */
export function resolveAuthenticatedMerchant(req, ctx = {}) {
  const principal = identifyPrincipal(req, ctx);
  if (!principal) return { ok: false, code: 'UNAUTHENTICATED' };

  if (principal.role === ADMIN_ROLE) {
    const claimedId = req.headers['x-merchant-id'] || req.query?.merchantId;
    const merchant = claimedId
      ? ctx.merchantRepo?.findById(claimedId)
      : (ctx.merchantRepo?.getDefault ? ctx.merchantRepo.getDefault() : ctx.merchantRepo?.findAll()[0]);
    return merchant ? { ok: true, merchant } : { ok: false, code: 'MERCHANT_NOT_FOUND' };
  }

  const claimedId = req.headers['x-merchant-id'];
  if (claimedId && claimedId !== principal.merchantId) {
    return { ok: false, code: 'CROSS_TENANT' };
  }
  return { ok: true, merchant: principal.merchant };
}

/**
 * Looks up the merchant that owns the presented observer credential.
 * @returns {{ ok: boolean, merchant?: any, code?: string }}
 */
export function resolveObserverCredential(req, ctx = {}) {
  const key = extractCredential(req, 'x-observer-key');
  if (!key) return { ok: false, code: 'MISSING_CREDENTIAL' };
  const merchant = findMerchantByApiKey(ctx, key);
  if (!merchant) return { ok: false, code: 'UNKNOWN_CREDENTIAL' };
  return { ok: true, merchant };
}

/**
 * Verifies a signed request (HMAC + timestamp window) and consumes its nonce so a
 * captured request can never be replayed.
 * @returns {boolean} true when the request may proceed
 */
export function verifySignedRequest(input) {
  const { req, res, ctx, secret, scope, rawBody } = input;
  const path = req._youpiPath || String(req.url || '').split('?')[0];

  const result = verifyObserverSignature({
    secret,
    headers: req.headers,
    method: req.method,
    path,
    rawBody
  });

  if (!result.ok) {
    HttpServer.json(res, 401, {
      error: 'UNAUTHORIZED',
      reason: result.reason,
      message: 'A valid signed request is required (X-Observer-Key, X-Observer-Timestamp, X-Observer-Nonce, X-Observer-Signature).'
    });
    return false;
  }

  try {
    ctx.db.execute("DELETE FROM observer_request_nonces WHERE created_at < datetime('now', '-1 day')");
    ctx.db.execute('INSERT INTO observer_request_nonces (nonce, scope) VALUES (?, ?)', [
      `${scope}:${result.nonce}`,
      scope
    ]);
  } catch {
    HttpServer.json(res, 401, {
      error: 'UNAUTHORIZED',
      reason: 'REPLAY_DETECTED',
      message: 'This signed request was already processed (nonce replay).'
    });
    return false;
  }

  return true;
}

/**
 * Verifies a signed DEVICE request (Android/SMS observer), which uses the device
 * scheme `HMAC-SHA256(rawBody + ':' + timestamp)` with a 60s validity window.
 * Replay protection keys on the signature itself when the client sends no nonce,
 * so an identical captured request can never be replayed (audit P0-04).
 * @returns {boolean} true when the request may proceed
 */
export function verifySignedDeviceRequest(input) {
  const { req, res, ctx, secret, scope, rawBody } = input;
  const timestampRaw = req.headers['x-timestamp'] || req.headers['x-observer-timestamp'];
  const signature = req.headers['x-signature'] || req.headers['x-observer-signature'];
  const nonce = req.headers['x-nonce'] || req.headers['x-observer-nonce'] || signature;

  if (!timestampRaw || !signature) {
    HttpServer.json(res, 401, {
      error: 'UNAUTHORIZED',
      reason: 'MISSING_SIGNATURE_HEADERS',
      message: 'Signed device request required (X-Timestamp and X-Signature).'
    });
    return false;
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 60000) {
    HttpServer.json(res, 401, { error: 'Timestamp drift exceeded validity window (replay protection triggered).' });
    return false;
  }

  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(`${rawBody}:${timestampRaw}`, 'utf8')
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const presentedBuffer = Buffer.from(String(signature).trim(), 'hex');
  if (presentedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, presentedBuffer)) {
    HttpServer.json(res, 401, { error: 'Invalid cryptographic HMAC signature.' });
    return false;
  }

  try {
    ctx.db.execute("DELETE FROM observer_request_nonces WHERE created_at < datetime('now', '-1 day')");
    ctx.db.execute('INSERT INTO observer_request_nonces (nonce, scope) VALUES (?, ?)', [
      `${scope}:${String(nonce)}`,
      scope
    ]);
  } catch {
    HttpServer.json(res, 401, {
      error: 'UNAUTHORIZED',
      reason: 'REPLAY_DETECTED',
      message: 'This device request was already processed (replay detected).'
    });
    return false;
  }

  return true;
}

/** Issues a single-use, short-lived pairing challenge (audit P0-05); only the hash is stored. */
export function issuePairingToken(ctx, merchantId, ttlMs = 10 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  ctx.db.execute(
    'INSERT INTO observer_pairing_tokens (id, merchant_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), merchantId, tokenHash, expiresAt, new Date().toISOString()]
  );
  return { token, expiresAt };
}

/**
 * Redeems a pairing token exactly once. The bound tenant comes from the stored
 * challenge, never from the enrollment request body.
 * @returns {{ ok: boolean, merchantId?: string, code?: string }}
 */
export function redeemPairingToken(ctx, token) {
  if (!token) return { ok: false, code: 'MISSING_TOKEN' };
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = ctx.db.queryOne('SELECT * FROM observer_pairing_tokens WHERE token_hash = ?', [tokenHash]);
  if (!row) return { ok: false, code: 'INVALID_TOKEN' };
  if (row.used_at) return { ok: false, code: 'TOKEN_ALREADY_USED' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, code: 'TOKEN_EXPIRED' };

  const update = ctx.db.execute(
    'UPDATE observer_pairing_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL',
    [new Date().toISOString(), row.id]
  );
  if (update.changes !== 1) return { ok: false, code: 'TOKEN_ALREADY_USED' };
  return { ok: true, merchantId: row.merchant_id };
}

/** Removes credential material from tunnel logs before they leave the process. */
export function scrubSecretsFromLogLine(line) {
  return String(line || '')
    .replace(/(token[=:\s]+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]')
    .replace(/(--token\s+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]')
    .replace(/(secret[=:\s]+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]');
}

export { maskSecret, OBSERVER_AUTH_HEADERS };
