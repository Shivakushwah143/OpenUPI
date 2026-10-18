import crypto from 'node:crypto';
import { sealSecret, openSecret, hashSecret, generateOpaqueToken } from '@youpi/common';

/**
 * Dedicated observer credentials (observer hardening sprint item 1/2).
 *
 * Observation ingest authenticates with its OWN credential — never with a merchant
 * or admin API key. Only the secret (sealed with the secret vault) is stored; the
 * caller presents the public `key_id` in the request header and signs with the
 * secret, which never travels on the wire.
 *
 * Lifecycle: ACTIVE -> REVOKED. Rotation issues a NEW credential row (new key_id)
 * and revokes the previous one only when `revokePrevious` is requested, so a
 * rotation can be rolled out without an ingest outage.
 */
export class ObserverCredentialRepository {
  /** @param {import('../database.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {string} id */
  findById(id) {
    if (!id) return null;
    const row = this.db.queryOne('SELECT * FROM observer_credentials WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  /** @param {string} keyId Public credential identifier presented by the caller. */
  findByKeyId(keyId) {
    if (!keyId) return null;
    const row = this.db.queryOne('SELECT * FROM observer_credentials WHERE key_id = ?', [keyId]);
    return row ? this.mapRow(row) : null;
  }

  /** @param {string} merchantId */
  findByMerchant(merchantId) {
    if (!merchantId) return [];
    return this.db.query(
      'SELECT * FROM observer_credentials WHERE merchant_id = ? ORDER BY created_at DESC',
      [merchantId]
    ).map(r => this.mapRow(r));
  }

  /**
   * Issues a new observer credential.
   * @param {{ merchantId: string, label?: string }} input
   * @returns {{ id: string, keyId: string, secret: string, merchantId: string, label: string|null, createdAt: string }}
   */
  issue(input) {
    const id = `obsc_${crypto.randomUUID()}`;
    const keyId = `obs_${crypto.randomBytes(12).toString('hex')}`;
    const secret = generateOpaqueToken(32);
    const now = new Date().toISOString();

    this.db.execute(
      `INSERT INTO observer_credentials (id, merchant_id, key_id, label, secret_enc, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [id, input.merchantId, keyId, input.label || null, sealSecret(secret), now]
    );

    return { id, keyId, secret, merchantId: input.merchantId, label: input.label || null, createdAt: now };
  }

  /**
   * Rotates a credential: the previous one is revoked and a fresh key pair is
   * returned. The new secret is returned ONCE and never stored in clear text.
   * @param {string} credentialId
   */
  rotate(credentialId) {
    const existing = this.findById(credentialId);
    if (!existing) return null;

    return this.db.transaction(() => {
      const issued = this.issue({ merchantId: existing.merchantId, label: existing.label });
      this.db.execute(
        "UPDATE observer_credentials SET status = 'REVOKED', revoked_at = ?, rotated_at = NULL WHERE id = ?",
        [new Date().toISOString(), credentialId]
      );
      this.db.execute(
        'UPDATE observer_credentials SET rotated_at = ? WHERE id = ?',
        [new Date().toISOString(), issued.id]
      );
      return issued;
    });
  }

  /** @param {string} credentialId */
  revoke(credentialId) {
    const existing = this.findById(credentialId);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db.execute(
      "UPDATE observer_credentials SET status = 'REVOKED', revoked_at = ? WHERE id = ? AND status = 'ACTIVE'",
      [now, credentialId]
    );
    return this.findById(credentialId);
  }

  /** Records last successful use (never the secret). */
  touch(credentialId) {
    if (!credentialId) return;
    try {
      this.db.execute(
        "UPDATE observer_credentials SET last_used_at = datetime('now') WHERE id = ?",
        [credentialId]
      );
    } catch {}
  }

  /** Resolves the HMAC secret for a presented key id, or null when unusable. */
  resolveSecret(keyId) {
    const credential = this.findByKeyId(keyId);
    if (!credential || credential.status !== 'ACTIVE') return null;
    let secret;
    try {
      secret = openSecret(credential.secretEnc);
    } catch {
      // A credential sealed under a key we cannot open must never authenticate.
      return null;
    }
    if (!secret) return null;
    return { credential, secret };
  }

  /** Opaque fingerprint of the stored secret, for operator display only. */
  fingerprint(credential) {
    return hashSecret(credential.secretEnc).slice(0, 12);
  }

  /** @param {any} row */
  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      keyId: row.key_id,
      label: row.label,
      secretEnc: row.secret_enc,
      status: row.status,
      createdAt: row.created_at,
      rotatedAt: row.rotated_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at
    };
  }
}
