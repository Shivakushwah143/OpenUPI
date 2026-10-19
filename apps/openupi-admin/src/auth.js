import crypto from 'node:crypto';
import { verifyPasswordHash } from './config.js';

/**
 * Server-side session store for the OpenUPI admin.
 *
 * - Passwords are verified against a scrypt hash (constant time).
 * - Sessions live only in this process: a restart (or a password/admin-key
 *   rotation) invalidates every session. The cookie carries an opaque id plus an
 *   HMAC; no identity, role or credential material is stored client-side.
 * - Login attempts are throttled per client address.
 */
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LINK_MAX_PER_MINUTE = 20;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // Ignore malformed cookie values rather than failing the request.
    }
  }
  return out;
}

export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const realIp = String(req.headers['x-real-ip'] || '').trim();
    if (realIp) return realIp;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

export class AdminAuth {
  /**
   * @param {{
   *   username: string,
   *   passwordHash: string,
   *   sessionSecret: string,
   *   sessionTtlMs: number,
   *   cookieName?: string,
   *   cookieSecure?: boolean,
   *   now?: () => number
   * }} options
   */
  constructor(options) {
    this.username = options.username;
    this.passwordHash = options.passwordHash;
    this.sessionKey = sha256(options.sessionSecret);
    this.sessionTtlMs = options.sessionTtlMs;
    this.cookieName = options.cookieName || 'openupi_admin';
    this.cookieSecure = options.cookieSecure !== false;
    this.now = options.now || Date.now;
    /** @type {Map<string, {id: string, csrfToken: string, username: string, ip: string, createdAt: number, expiresAt: number}>} */
    this.sessions = new Map();
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.loginAttempts = new Map();
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.linkAttempts = new Map();
  }

  /** @param {string} username @param {string} password */
  verifyCredentials(username, password) {
    const userOk = safeEqual(String(username || '').trim().toLowerCase(), this.username.toLowerCase());
    const passwordOk = verifyPasswordHash(String(password || ''), this.passwordHash);
    // Evaluate both branches regardless of the username result.
    return userOk && passwordOk;
  }

  _sign(sessionId) {
    return crypto.createHmac('sha256', this.sessionKey).update(sessionId).digest('hex');
  }

  /** @param {{ ip?: string, username?: string }} meta */
  createSession(meta = {}) {
    const id = crypto.randomBytes(32).toString('hex');
    const session = {
      id,
      csrfToken: crypto.randomBytes(32).toString('hex'),
      username: meta.username || this.username,
      ip: meta.ip || 'unknown',
      createdAt: this.now(),
      expiresAt: this.now() + this.sessionTtlMs
    };
    this.sessions.set(id, session);
    return { session, signedValue: `${id}.${this._sign(id)}` };
  }

  prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [key, entry] of this.loginAttempts) {
      if (entry.resetAt <= now) this.loginAttempts.delete(key);
    }
    for (const [key, entry] of this.linkAttempts) {
      if (entry.resetAt <= now) this.linkAttempts.delete(key);
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  getSession(req) {
    const raw = parseCookies(req.headers.cookie)[this.cookieName];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return null;
    const id = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (!safeEqual(signature, this._sign(id))) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  destroySession(req) {
    const session = this.getSession(req);
    if (session) this.sessions.delete(session.id);
  }

  cookie(signedValue, maxAgeSeconds) {
    const parts = [
      `${this.cookieName}=${encodeURIComponent(signedValue)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Strict',
      `Max-Age=${maxAgeSeconds}`
    ];
    if (this.cookieSecure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie() {
    return this.cookie('', 0);
  }

  /** Fixed-window login throttle. @param {string} key */
  loginRateLimited(key) {
    const now = this.now();
    const entry = this.loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return { limited: false, retryAfterSeconds: 0 };
    }
    entry.count += 1;
    if (entry.count > LOGIN_MAX_ATTEMPTS) {
      return { limited: true, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { limited: false, retryAfterSeconds: 0 };
  }

  resetLoginRateLimit(key) {
    this.loginAttempts.delete(key);
  }

  /** Stops one authenticated session from hammering payment creation. */
  acquireLinkSlot(session) {
    const now = this.now();
    const key = `s:${session.id}`;
    const entry = this.linkAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.linkAttempts.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= LINK_MAX_PER_MINUTE;
  }
}
