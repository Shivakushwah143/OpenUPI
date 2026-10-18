import crypto from 'node:crypto';

/**
 * Durable reconciliation queue for bank credits that could not be attributed to
 * a live payment (late arrival after terminal state, or an unmatchable credit).
 *
 * A case is EVIDENCE of a real-world credit for an operator to review. It never
 * changes a payment's status and can never produce SUCCESS: settlement still
 * requires the authoritative bank-confirmation flow (or authenticated manual
 * reconciliation). This is what prevents a genuine late bank credit from being
 * silently dropped while terminal-state invariants stay intact.
 */
export class PaymentReviewRepository {
  /** @param {import('../database.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a review case. Idempotent per observation: a replayed observation
   * never creates a second case.
   * @param {{
   *   merchantId: string,
   *   receivingAccountId: string,
   *   paymentSessionId?: string | null,
   *   observationId?: string | null,
   *   amountPaise: bigint | number | string,
   *   bankReference?: string | null,
   *   source?: string | null,
   *   reason: string
   * }} input
   * @returns {{ case: any, created: boolean }}
   */
  create(input) {
    if (!input?.merchantId || !input?.receivingAccountId || !input?.reason) {
      throw new Error('Review case requires merchantId, receivingAccountId and reason.');
    }
    const existing = input.observationId
      ? this.db.queryOne('SELECT * FROM payment_review_cases WHERE observation_id = ?', [input.observationId])
      : null;
    if (existing) return { case: this.mapRow(existing), created: false };

    const id = crypto.randomUUID();
    this.db.execute(`
      INSERT INTO payment_review_cases
        (id, merchant_id, receiving_account_id, payment_session_id, observation_id,
         amount_paise, bank_reference, source, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `, [
      id,
      input.merchantId,
      input.receivingAccountId,
      input.paymentSessionId || null,
      input.observationId || null,
      Number(input.amountPaise),
      input.bankReference || null,
      input.source || null,
      input.reason,
      new Date().toISOString()
    ]);

    return { case: this.findById(id), created: true };
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_review_cases WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * @param {{ merchantId?: string | null, status?: string | null, limit?: number }} [options]
   */
  findAll(options = {}) {
    const clauses = [];
    const params = [];
    if (options.merchantId) { clauses.push('merchant_id = ?'); params.push(options.merchantId); }
    if (options.status) { clauses.push('status = ?'); params.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
    const rows = this.db.query(
      `SELECT * FROM payment_review_cases ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );
    return rows.map(r => this.mapRow(r));
  }

  /**
   * Closes a case with an operator note. Only an OPEN case can be resolved.
   * @returns {{ ok: boolean, code?: string, case?: any }}
   */
  resolve(id, { resolvedBy, note } = {}) {
    const existing = this.findById(id);
    if (!existing) return { ok: false, code: 'CASE_NOT_FOUND' };
    if (existing.status !== 'OPEN') return { ok: false, code: 'CASE_ALREADY_CLOSED', case: existing };

    const changes = this.db.execute(`
      UPDATE payment_review_cases
      SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, resolution_note = ?
      WHERE id = ? AND status = 'OPEN'
    `, [new Date().toISOString(), resolvedBy || 'operator', note || null, id]).changes;

    if (changes !== 1) return { ok: false, code: 'CASE_ALREADY_CLOSED', case: this.findById(id) };
    return { ok: true, case: this.findById(id) };
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      receivingAccountId: row.receiving_account_id,
      paymentSessionId: row.payment_session_id || null,
      observationId: row.observation_id || null,
      amountPaise: BigInt(row.amount_paise),
      amount: (Number(row.amount_paise) / 100).toFixed(2),
      bankReference: row.bank_reference || null,
      source: row.source || null,
      reason: row.reason,
      status: row.status,
      createdAt: new Date(row.created_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
      resolvedBy: row.resolved_by || null,
      resolutionNote: row.resolution_note || null
    };
  }
}
