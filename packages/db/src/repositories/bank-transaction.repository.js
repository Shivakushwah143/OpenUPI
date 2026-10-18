import crypto from 'node:crypto';

/**
 * Canonical bank-transaction ledger (Audit P1-02).
 *
 * One row per observed bank reference (UTR/RRN) per receiving account,
 * enforced by a partial UNIQUE index at the database layer. A bank reference
 * can be consumed (attributed/reserved) by AT MOST ONE payment session, while
 * additional observations of the SAME bank transaction from different channels
 * attach to the existing row instead of creating a second credit.
 *
 * All operations are atomic within a single SQLite transaction.
 */
export class BankTransactionRepository {
  /** @param {import('../database.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  findById(id) {
    return this.db.queryOne('SELECT * FROM bank_transaction_ledger WHERE id = ?', [id]);
  }

  findByReference(receivingAccountId, bankReference) {
    if (!receivingAccountId || !bankReference) return null;
    return this.db.queryOne(
      'SELECT * FROM bank_transaction_ledger WHERE receiving_account_id = ? AND bank_reference = ?',
      [receivingAccountId, bankReference]
    );
  }

  findBySession(sessionId) {
    if (!sessionId) return [];
    return this.db.query(
      'SELECT * FROM bank_transaction_ledger WHERE consumed_by_session_id = ?',
      [sessionId]
    );
  }

  /**
   * Atomically reserves/consumes a bank reference for a payment session.
   *
   * @param {{
   *   sessionId: string,
   *   receivingAccountId: string,
   *   merchantId: string,
   *   bankReference?: string | null,
   *   amountPaise: bigint | number,
   *   observedAt?: Date | string | null,
   *   observationId?: string | null,
   *   source?: string | null,
   *   provenance?: string
   * }} input
   * @returns {{ reserved: boolean, reason?: string, consumedBySessionId?: string | null, rowId?: string }}
   *   reserved=false reasons: DUPLICATE_TRANSACTION (already consumed by a different order),
   *   UTR_AMOUNT_CONFLICT (same reference with a different observed amount),
   *   CROSS_MERCHANT_REFERENCE (same reference stored under another tenant scope is not visible/reserved here).
   */
  reserve(input) {
    const {
      sessionId,
      receivingAccountId,
      merchantId,
      bankReference = null,
      amountPaise,
      observedAt = null,
      observationId = null,
      source = null,
      provenance = 'OBSERVED'
    } = input;

    if (!sessionId || !receivingAccountId) {
      return { reserved: false, reason: 'MISSING_SCOPE' };
    }

    if (!bankReference) {
      // No trustworthy bank reference: nothing to uniquely reserve.
      // Same-source duplicates are already handled via observation fingerprints.
      return { reserved: true };
    }

    const amount = Number(amountPaise);

    return this.db.transaction(() => {
      const existing = this.findByReference(receivingAccountId, bankReference);

      if (existing) {
        // Same bank reference, materially different amount -> cannot be the same credit.
        if (Number(existing.amount_paise) !== amount) {
          return { reserved: false, reason: 'UTR_AMOUNT_CONFLICT' };
        }
        if (existing.consumed_by_session_id && existing.consumed_by_session_id !== sessionId) {
          // Already credited another order — never credit a second order (P1-02).
          return {
            reserved: false,
            reason: 'DUPLICATE_TRANSACTION',
            consumedBySessionId: existing.consumed_by_session_id
          };
        }
        if (!existing.consumed_by_session_id) {
          const res = this.db.execute(
            `UPDATE bank_transaction_ledger
             SET consumed_by_session_id = ?
             WHERE id = ? AND (consumed_by_session_id IS NULL OR consumed_by_session_id = ?)`,
            [sessionId, existing.id, sessionId]
          );
          if (res.changes !== 1) {
            const current = this.findById(existing.id);
            if (current && current.consumed_by_session_id && current.consumed_by_session_id !== sessionId) {
              return { reserved: false, reason: 'DUPLICATE_TRANSACTION', consumedBySessionId: current.consumed_by_session_id };
            }
          }
        }
        return { reserved: true, rowId: existing.id, consumedBySessionId: existing.consumed_by_session_id || sessionId };
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        this.db.execute(
          `INSERT INTO bank_transaction_ledger (
             id, receiving_account_id, merchant_id, bank_reference, amount_paise,
             observed_at, first_observation_id, first_source, consumed_by_session_id, provenance, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, receivingAccountId, merchantId, bankReference, amount,
           observedAt ? new Date(observedAt).toISOString() : now,
           observationId, source, sessionId, provenance, now]
        );
      } catch (err) {
        // Unique index race (receiving_account_id, bank_reference): re-read and apply rules.
        const raced = this.findByReference(receivingAccountId, bankReference);
        if (!raced) throw err;
        if (Number(raced.amount_paise) !== amount) {
          return { reserved: false, reason: 'UTR_AMOUNT_CONFLICT' };
        }
        if (raced.consumed_by_session_id && raced.consumed_by_session_id !== sessionId) {
          return { reserved: false, reason: 'DUPLICATE_TRANSACTION', consumedBySessionId: raced.consumed_by_session_id };
        }
        if (!raced.consumed_by_session_id) {
          this.db.execute(
            'UPDATE bank_transaction_ledger SET consumed_by_session_id = ? WHERE id = ? AND consumed_by_session_id IS NULL',
            [sessionId, raced.id]
          );
        }
        return { reserved: true, rowId: raced.id, consumedBySessionId: raced.consumed_by_session_id || sessionId };
      }

      return { reserved: true, rowId: id, consumedBySessionId: sessionId };
    });
  }
}