import crypto from 'node:crypto';

/**
 * OpenUPI admin configuration.
 *
 * Everything privileged is read from the server environment exactly once and is
 * never serialised into HTML, JSON or logs. The admin app is a thin, authenticated
 * BFF in front of the existing payment API: it holds ADMIN_API_KEY server-side and
 * exposes only its own session-scoped endpoints to the browser.
 */

export const DEFAULT_PORT = 6200;
export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_SESSION_TTL_MINUTES = 8 * 60;

const stripTrailingSlash = value => String(value || '').trim().replace(/\/+$/, '');

/**
 * scrypt hash in a self-describing format:
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 * @param {string} password
 * @param {Buffer} [salt]
 */
export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(String(password), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * @param {string} password
 * @param {string} storedHash
 */
export function verifyPasswordHash(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(saltRaw, 'base64');
    const expected = Buffer.from(hashRaw, 'base64');
    const derived = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
export function readOpenupiAdminConfig(env = process.env) {
  const errors = [];
  const password = String(env.OPENUPI_ADMIN_PASSWORD || '');
  const passwordHash = String(env.OPENUPI_ADMIN_PASSWORD_HASH || '').trim();

  if (!passwordHash && password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Set OPENUPI_ADMIN_PASSWORD_HASH (preferred) or OPENUPI_ADMIN_PASSWORD (min ${MIN_PASSWORD_LENGTH} chars).`);
  }

  const adminApiKey = String(env.ADMIN_API_KEY || env.YOUPI_ADMIN_API_KEY || '').trim();
  if (!adminApiKey) {
    errors.push('ADMIN_API_KEY is required: the admin app authenticates to the payment API server-side.');
  }
  const legacyConsoleToken = String(env.YOUPI_TEST_CONSOLE_TOKEN || '').trim();
  void legacyConsoleToken; // never read for auth, never forwarded, never rendered

  const port = Number(env.OPENUPI_ADMIN_PORT || DEFAULT_PORT);
  const ttlMinutes = Number(env.OPENUPI_ADMIN_SESSION_TTL_MINUTES || DEFAULT_SESSION_TTL_MINUTES);
  const resolvedHash = passwordHash || (password ? hashPassword(password) : '');

  // Session signing key: an explicit secret, or one derived from material that only
  // the server holds. Rotating either the admin key or the password invalidates
  // every outstanding session (intended).
  const explicitSecret = String(env.OPENUPI_ADMIN_SESSION_SECRET || '').trim();
  const sessionSecret = explicitSecret || crypto
    .createHmac('sha256', adminApiKey || 'openupi-admin')
    .update(`openupi-admin-session-v1:${resolvedHash}`)
    .digest('hex');

  const publicOrigin = stripTrailingSlash(env.OPENUPI_ADMIN_PUBLIC_ORIGIN || '');
  const checkoutBaseUrl = stripTrailingSlash(env.BASE_CHECKOUT_URL || '');
  const apiBaseUrl = stripTrailingSlash(
    env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${env.PAYMENT_API_PORT || 6100}`
  );
  const checkoutInternalUrl = stripTrailingSlash(
    env.OPENUPI_CHECKOUT_INTERNAL_URL || `http://127.0.0.1:${env.CHECKOUT_PORTAL_PORT || 7000}`
  );

  return {
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    username: String(env.OPENUPI_ADMIN_USERNAME || 'admin').trim() || 'admin',
    passwordHash: resolvedHash,
    sessionSecret,
    sessionTtlMs: (Number.isFinite(ttlMinutes) ? ttlMinutes : DEFAULT_SESSION_TTL_MINUTES) * 60_000,
    cookieName: 'openupi_admin',
    // Secure cookies require HTTPS. Localhost/test runs opt out explicitly.
    cookieSecure: String(env.OPENUPI_ADMIN_COOKIE_SECURE || '1') !== '0',
    trustProxy: String(env.OPENUPI_ADMIN_TRUST_PROXY || '0') === '1',
    apiBaseUrl,
    checkoutInternalUrl,
    adminApiKey,
    checkoutBaseUrl,
    publicOrigin,
    // Capability boundaries the browser can never cross.
    paymentLinkMinPaise: 100n,
    paymentLinkMaxPaise: 10000n,
    errors
  };
}
