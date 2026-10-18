import crypto from 'node:crypto';

/**
 * Secret-at-rest vault (audit P0-06 / reliability sprint item 2).
 *
 * Observer credentials, device signing keys and other shared secrets must never
 * be readable directly from the database file. Values are sealed with
 * AES-256-GCM under a key that lives OUTSIDE the database:
 *
 *   YOUPI_SECRET_KEY (or OPENUPI_SECRET_KEY) — 64 hex chars, base64 or a passphrase
 *
 * Behaviour:
 * - `sealSecret()` throws in production when no key is configured (fail closed).
 * - `openSecret()` transparently returns legacy PLAINTEXT values unchanged, so an
 *   existing database keeps working and is upgraded in place by
 *   `migrateSecretsAtRest()`.
 * - Rotation: change YOUPI_SECRET_KEY and re-run `migrateSecretsAtRest()` with the
 *   old key supplied as YOUPI_SECRET_KEY_PREVIOUS; each value is opened with the
 *   previous key and re-sealed with the current one.
 */

const SEALED_PREFIX = 'enc:v1:';
const DEV_FALLBACK_PASSPHRASE = 'youpi-dev-only-secret-vault-key';

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

export function resolveSecretKeyMaterial() {
  return String(
    process.env.YOUPI_SECRET_KEY ||
    process.env.OPENUPI_SECRET_KEY ||
    ''
  ).trim();
}

export function resolvePreviousSecretKeyMaterial() {
  return String(process.env.YOUPI_SECRET_KEY_PREVIOUS || '').trim();
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Derives a 32-byte AES key from the configured material.
 * @param {string} material
 */
function deriveKey(material) {
  if (/^[0-9a-fA-F]{64}$/.test(material)) {
    return Buffer.from(material, 'hex');
  }
  const base64 = Buffer.from(material, 'base64');
  if (base64.length === 32 && base64.toString('base64').replace(/=+$/, '') === material.replace(/=+$/, '')) {
    return base64;
  }
  // Passphrase: derive with scrypt (fixed salt keeps the derivation reproducible
  // across processes; the key material itself is the secret).
  return crypto.scryptSync(material, 'youpi-openupi-secret-vault', 32);
}

/**
 * @param {'seal'|'open'} purpose
 * @returns {Buffer|null} null when no key is configured
 */
function activeKey(purpose) {
  const material = resolveSecretKeyMaterial();
  if (material) return deriveKey(material);
  if (isProduction()) {
    throw new Error(
      `Refusing to ${purpose} secrets: YOUPI_SECRET_KEY is not configured. Provision a secret-vault key before running in production.`
    );
  }
  // Development/test convenience only: a documented, non-production fallback so
  // local databases remain usable. Production always fails closed above.
  return deriveKey(DEV_FALLBACK_PASSPHRASE);
}

/**
 * Seals a secret for storage.
 * @param {string} plaintext
 * @returns {string} `enc:v1:<iv>:<tag>:<ciphertext>` (base64url parts)
 */
export function sealSecret(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return plaintext;
  if (isSealed(plaintext)) return plaintext;

  const key = activeKey('seal');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEALED_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

/**
 * Opens a stored secret. Plaintext (legacy) values pass through unchanged.
 * @param {string} stored
 * @param {{ allowPreviousKey?: boolean }} [options]
 * @returns {string}
 */
export function openSecret(stored, options = {}) {
  if (!stored || !isSealed(stored)) return stored;

  const parts = String(stored).slice(SEALED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed sealed secret: expected enc:v1:<iv>:<tag>:<ciphertext>.');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');

  const candidates = [activeKey('open')];
  const previous = resolvePreviousSecretKeyMaterial();
  if (options.allowPreviousKey !== false && previous) {
    candidates.push(deriveKey(previous));
  }

  let lastError = null;
  for (const key of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Unable to open sealed secret: ${lastError ? lastError.message : 'no key matched'}`);
}

/**
 * Re-seals every plaintext (legacy) or previous-key value returned by the
 * iterator, delegating persistence to the supplied callback.
 *
 * @param {Array<{ id: string, value: string }>} rows
 * @param {(id: string, sealedValue: string) => void} save
 * @returns {{ migrated: number, skipped: number }}
 */
export function migrateSecretRows(rows, save) {
  let migrated = 0;
  let skipped = 0;
  for (const row of rows || []) {
    if (!row || !row.value) {
      skipped++;
      continue;
    }
    let plaintext;
    try {
      plaintext = openSecret(row.value);
    } catch {
      skipped++;
      continue;
    }
    const sealed = sealSecret(plaintext);
    if (sealed === row.value) {
      skipped++;
      continue;
    }
    save(row.id, sealed);
    migrated++;
  }
  return { migrated, skipped };
}
