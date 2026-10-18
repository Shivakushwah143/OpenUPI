import crypto from 'node:crypto';

/**
 * Shared HMAC request-signing scheme for trusted server-to-server callers
 * (observers, merchant backends). Reuses the gateway's HMAC primitives so the
 * same algorithm is used to sign and to verify.
 *
 * Canonical string: METHOD \n PATH \n TIMESTAMP \n SHA256(rawBody)
 * Signature:       hex(HMAC-SHA256(canonical, secret))
 */
export const OBSERVER_AUTH_HEADERS = Object.freeze({
  key: 'x-observer-key',
  timestamp: 'x-observer-timestamp',
  nonce: 'x-observer-nonce',
  signature: 'x-observer-signature'
});

/** Default acceptance window for a signed request (ms). */
export const OBSERVER_SIGNATURE_MAX_DRIFT_MS = 120000;

/**
 * @param {string|Buffer} rawBody
 * @returns {string} hex sha256 of the exact request bytes
 */
export function hashRequestBody(rawBody) {
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Builds the canonical string that is signed.
 * @param {{ method: string, path: string, timestamp: number|string, rawBody?: string|Buffer }} input
 */
export function buildObserverCanonicalString(input) {
  const method = String(input.method || 'POST').toUpperCase();
  const path = String(input.path || '');
  const timestamp = String(input.timestamp ?? '');
  return `${method}\n${path}\n${timestamp}\n${hashRequestBody(input.rawBody)}`;
}

/**
 * Signs a request. Used by observer clients/SDKs and by tests.
 * @param {{
 *   secret: string,
 *   method: string,
 *   path: string,
 *   rawBody?: string|Buffer,
 *   timestamp?: number,
 *   nonce?: string
 * }} input
 * @returns {Record<string, string>} headers to attach to the request
 */
export function signObserverRequest(input) {
  if (!input || !input.secret) {
    throw new Error('Observer request signing requires a secret.');
  }
  const keyId = input.keyId || input.secret;
  const timestamp = input.timestamp !== undefined ? input.timestamp : Date.now();
  const nonce = input.nonce || crypto.randomUUID();
  const canonical = buildObserverCanonicalString({
    method: input.method,
    path: input.path,
    timestamp,
    rawBody: input.rawBody
  });
  const signature = crypto.createHmac('sha256', String(input.secret)).update(canonical, 'utf8').digest('hex');

  return {
    // The PUBLIC credential identifier travels in the header; the secret itself is
    // never transmitted (audit: dedicated observer credentials).
    [OBSERVER_AUTH_HEADERS.key]: String(keyId),
    [OBSERVER_AUTH_HEADERS.timestamp]: String(timestamp),
    [OBSERVER_AUTH_HEADERS.nonce]: String(nonce),
    [OBSERVER_AUTH_HEADERS.signature]: signature
  };
}

/**
 * Verifies a signed request. Callers still own credential lookup (i.e. which
 * secret/tenant a presented key belongs to) and replay storage.
 *
 * @param {{
 *   secret: string,
 *   headers: Record<string, any>,
 *   method: string,
 *   path: string,
 *   rawBody?: string|Buffer,
 *   maxDriftMs?: number,
 *   now?: number
 * }} input
 * @returns {{ ok: boolean, reason?: string, timestamp?: number, nonce?: string }}
 */
export function verifyObserverSignature(input) {
  const headers = input.headers || {};
  const presented = headers[OBSERVER_AUTH_HEADERS.signature];
  const timestampRaw = headers[OBSERVER_AUTH_HEADERS.timestamp];
  const nonce = headers[OBSERVER_AUTH_HEADERS.nonce];

  if (!input.secret) return { ok: false, reason: 'UNKNOWN_CREDENTIAL' };
  if (!presented || !timestampRaw || !nonce) return { ok: false, reason: 'MISSING_SIGNATURE_HEADERS' };

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'INVALID_TIMESTAMP' };

  const maxDrift = input.maxDriftMs !== undefined ? input.maxDriftMs : OBSERVER_SIGNATURE_MAX_DRIFT_MS;
  const now = input.now !== undefined ? input.now : Date.now();
  if (Math.abs(now - timestamp) > maxDrift) return { ok: false, reason: 'TIMESTAMP_DRIFT' };

  const canonical = buildObserverCanonicalString({
    method: input.method,
    path: input.path,
    timestamp: timestampRaw,
    rawBody: input.rawBody
  });
  const expected = crypto.createHmac('sha256', String(input.secret)).update(canonical, 'utf8').digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const presentedBuffer = Buffer.from(String(presented).trim(), 'hex');
  if (presentedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, presentedBuffer)) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }

  return { ok: true, timestamp, nonce: String(nonce) };
}

/** Splits a combined observer credential (`<keyId>.<secret>`) into its parts. */
export function parseObserverCredential(combined) {
  const value = String(combined || '').trim();
  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('Observer credential must be formatted as "<keyId>.<secret>".');
  }
  return { keyId: value.slice(0, separator), secret: value.slice(separator + 1) };
}

/** sha256 hex digest, used for storing opaque tokens (checkout credentials, pairing). */
export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** High-entropy opaque token (base64url). */
export function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time credential comparison (admin keys, shared secrets).
 * @param {string} a
 * @param {string} b
 */
export function constantTimeEquals(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Masks a secret for safe display: never returns usable key material.
 * @param {string} value
 */
export function maskSecret(value) {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 8) return '••••';
  return `${str.slice(0, 4)}••••${str.slice(-4)}`;
}

/** Keys whose values must never be returned by an API response. */
export const SENSITIVE_RESPONSE_KEYS = Object.freeze([
  'webhookSecret',
  'webhook_secret',
  'clientSecret',
  'refreshToken',
  'accessToken',
  'apiKey',
  'api_key',
  'signingKey',
  'signing_key',
  'deviceToken',
  'password',
  'password_hash',
  'encryptionKey',
  'masterKey',
  'tunnelCommand',
  'cloudflareTunnelCommand'
]);

/**
 * Deep-redacts sensitive fields from a response payload.
 * Sensitive keys are replaced by `<key>Masked` when a value exists.
 * @param {any} value
 * @returns {any}
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_RESPONSE_KEYS.includes(key)) {
      output[`${key}Configured`] = Boolean(entry);
      continue;
    }
    output[key] = redactSecrets(entry);
  }
  return output;
}
