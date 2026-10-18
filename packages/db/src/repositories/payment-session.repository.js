import crypto from 'node:crypto';
import {
  PaymentStatus,
  PaymentMethod,
  ConfirmationStatus,
  isTerminalStatus,
  allowedSourceStatuses,
  assertValidTransition
} from '@youpi/common';
import { BankTransactionRepository } from './bank-transaction.repository.js';

export class PaymentSessionRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
    this.bankTxn = new BankTransactionRepository(db);
  }

  /**
   * Enqueues a durable webhook outbox row inside the caller's transaction so
   * financial state and the outbound notification are persisted atomically
   * (audit P1-06: at-least-once, survives restarts).
   * @param {string} paymentId
   * @param {string} event
   */
  _enqueueOutbox(paymentId, event) {
    const now = new Date().toISOString();
    this.db.execute(`
      INSERT INTO payment_events_outbox (id, payment_id, event, flushed, created_at, updated_at)
      SELECT ?, ?, ?, 0, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_events_outbox WHERE payment_id = ? AND event = ? AND flushed = 0
      )
    `, [crypto.randomUUID(), paymentId, event, now, now, paymentId, event]);
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : (data.metadata || '{}');

    const sql = `
      INSERT INTO payment_sessions (
        id, merchant_id, customer_id, receiving_account_id, order_id,
        amount_paise, currency, method, status, queue_position,
        return_url, idempotency_key, device_id, verification_level, verification_sources,
        verification_tag, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'UNVERIFIED', ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.merchantId,
      data.customerId || null,
      data.receivingAccountId || null,
      data.orderId,
      Number(data.amountPaise),
      data.currency || 'INR',
      data.method || PaymentMethod.UPI,
      data.status || PaymentStatus.INITIATED,
      data.queuePosition || 0,
      data.returnUrl || null,
      data.idempotencyKey || null,
      data.deviceId || null,
      metadata,
      now,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByOrderId(merchantId, orderId) {
    const row = this.db.queryOne(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? AND order_id = ?',
      [merchantId, orderId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  findByCustomerId(customerId) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE customer_id = ? ORDER BY created_at DESC',
      [customerId]
    );
    return rows.map(r => this.mapRow(r));
  }

  findByMerchantId(merchantId, limit = 50) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantId, limit]
    );
    return rows.map(r => this.mapRow(r));
  }

  /**
   * Atomic slot acquisition transaction for UPI payments.
   * Invariant: Only ONE active or processing session per receiving account.
   * If slot is free, session transitions to ACTIVE with 5:00 window.
   * If slot is occupied, session transitions to QUEUED with sequence position.
   */
  acquireSlotAtomic(sessionId, receivingAccountId, durationMs = 300000) {
    return this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();

      // Check for current active or processing session on this receiving account
      let activeRow = this.db.queryOne(`
        SELECT id, status, expires_at, processing_expires_at
        FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN (?, ?)
        LIMIT 1
      `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

      if (activeRow) {
        const isReportedHold = activeRow.confirmation_status === ConfirmationStatus.REPORTED;
        const isStale = !isReportedHold && (
          (activeRow.status === PaymentStatus.ACTIVE && activeRow.expires_at && new Date(activeRow.expires_at) <= now) ||
          (activeRow.status === PaymentStatus.PROCESSING && activeRow.processing_expires_at && new Date(activeRow.processing_expires_at) <= now)
        );
        if (isStale) {
          const terminalStatus = activeRow.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
          const res = this.db.execute(`
            UPDATE payment_sessions
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND status = ?
          `, [terminalStatus, nowIso, nowIso, activeRow.id, activeRow.status]);
          if (res.changes > 0) {
            this._enqueueOutbox(activeRow.id, terminalStatus);
          }
          activeRow = null;
        }
      }

      // CRITICAL GUARD: If activeRow is THIS session itself, it's ALREADY ACTIVE! Do not demote to QUEUED!
      if (activeRow && activeRow.id === sessionId) {
        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: activeRow.expires_at ? new Date(activeRow.expires_at) : new Date(now.getTime() + durationMs)
        };
      }

      if (!activeRow) {
        // Slot is vacant! Grant ACTIVE slot (conditional CAS on a non-terminal source state)
        const expiresAt = new Date(now.getTime() + durationMs).toISOString();

        const activateRes = this.db.execute(`
          UPDATE payment_sessions
          SET status = ?, slot_acquired_at = ?, expires_at = ?, queue_position = 0, updated_at = ?
          WHERE id = ? AND status IN (?, ?, ?)
        `, [PaymentStatus.ACTIVE, nowIso, expiresAt, nowIso, sessionId,
            PaymentStatus.INITIATED, PaymentStatus.QUEUED, PaymentStatus.ACTIVE]);

        if (activateRes.changes === 0) {
          // CAS lost: session reached a different state concurrently — return actual state.
          const cur = this.findById(sessionId);
          return {
            status: cur ? cur.status : PaymentStatus.INITIATED,
            queuePosition: cur ? (cur.queuePosition || 0) : 0,
            expiresAt: cur ? cur.expiresAt : null
          };
        }

        // Mark receiving account as busy
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 1, current_active_session_id = ?, updated_at = ?
          WHERE id = ?
        `, [sessionId, nowIso, receivingAccountId]);

        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: new Date(expiresAt)
        };
      } else {
        // Slot is busy! Place in QUEUED
        const existingSession = this.findById(sessionId);
        let queuePosition = existingSession?.queuePosition;
        if (!queuePosition || queuePosition <= 0) {
          const posRow = this.db.queryOne(`
            SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos
            FROM payment_sessions
            WHERE receiving_account_id = ? AND status = ?
          `, [receivingAccountId, PaymentStatus.QUEUED]);

          queuePosition = posRow ? posRow.next_pos : 1;
        }

        this.db.execute(`
          UPDATE payment_sessions
          SET status = ?, queue_position = ?, updated_at = ?
          WHERE id = ? AND status IN (?, ?)
        `, [PaymentStatus.QUEUED, queuePosition, nowIso, sessionId, PaymentStatus.INITIATED, PaymentStatus.QUEUED]);

        return {
          status: PaymentStatus.QUEUED,
          queuePosition,
          expiresAt: null
        };
      }
    });
  }

  /**
   * Transitions an ACTIVE session to PROCESSING upon customer clicking Payment Done.
   * Starts independent 30-second verification timer.
   */
  transitionToProcessing(sessionId, durationMs = 30000) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      // Idempotency: if already processing, return existing
      if (session.status === PaymentStatus.PROCESSING) {
        return session;
      }

      if (session.status !== PaymentStatus.ACTIVE) {
        throw new Error(`Cannot transition to PROCESSING from status: ${session.status}`);
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const processingExpiresAt = new Date(now.getTime() + durationMs).toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, processing_started_at = ?, processing_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, [PaymentStatus.PROCESSING, nowIso, processingExpiresAt, nowIso, sessionId, PaymentStatus.ACTIVE]);

      return this.findById(sessionId);
    });
  }

  /**
   * Transitions session to a non-success terminal state (FAILED, EXPIRED, CANCELLED).
   * A SUCCESS target is always refused here — see confirmPaymentSuccess().
   *
   * Enforcement (audit P0-08):
   * - Target must be permitted by the declared state graph from the CURRENT state.
   * - Atomic compare-and-swap: `WHERE id = ? AND status = <current>` with an
   *   affected-rows check; lost races throw instead of silently overwriting.
   * - Terminal states are final: re-entering them or moving between terminal
   *   states is refused (idempotent no-op only when the same terminal target).
   * - SUCCESS is NOT reachable from ordinary observer intake — use
   *   confirmPaymentSuccess() (counter confirmation / authenticated manual
   *   bank reconciliation) instead.
   * - Financial change and webhook outbox row commit in the same transaction.
   *
   * Atomically releases receiving account slot.
   */
  transitionToTerminal(sessionId, targetStatus, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      // Terminal states are final: only an identical repeated target is a no-op.
      if (isTerminalStatus(session.status)) {
        if (session.status === targetStatus) {
          return session; // already in target terminal state, idempotent
        }
        throw new Error(
          `Illegal payment state transition: Cannot move from '${session.status}' to '${targetStatus}'. Terminal states cannot be reopened.`
        );
      }

      // SUCCESS is never reachable through the generic terminal transition.
      // It requires confirmPaymentSuccess() (independent bank-credit verification
      // or authenticated counter confirmation) — audit P0-08 / Gate B.
      if (targetStatus === PaymentStatus.SUCCESS) {
        throw new Error(
          'Illegal payment state transition: SUCCESS cannot be reached via transitionToTerminal(). ' +
          'Use confirmPaymentSuccess() with independent bank-credit verification or counter confirmation.'
        );
      }

      // Declared state graph must permit this transition (throws otherwise).
      assertValidTransition(session.status, targetStatus);

      const now = new Date().toISOString();
      const attributedObsId = options.attributedObservationId || session.attributedObservationId || null;

      let metadata = session.metadata || {};
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }
      if (options.reason) {
        metadata = { ...metadata, cancelledReason: options.reason };
      }
      if (options.replacedByDeviceId) {
        metadata = { ...metadata, replacedByDeviceId: options.replacedByDeviceId };
      }
      if (options.replacedBySessionId) {
        metadata = { ...metadata, replacedBySessionId: options.replacedBySessionId };
      }

      const updateRes = this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, completed_at = ?, attributed_observation_id = ?, metadata = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, [targetStatus, now, attributedObsId, JSON.stringify(metadata), now, sessionId, session.status]);

      if (updateRes.changes !== 1) {
        throw new Error(
          `Concurrent payment state update detected for session ${sessionId}: expected status '${session.status}'.`
        );
      }

      // Durable outbox row in the SAME transaction as the financial state change.
      this._enqueueOutbox(sessionId, targetStatus);

      // Release slot on receiving account if this session owned it
      if (session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
        `, [now, session.receivingAccountId, sessionId]);
      }

      return this.findById(sessionId);
    });
  }

  /**
   * Confirms a payment as SUCCESS (the ONLY path that may produce SUCCESS).
   *
   * Allowed callers:
   * - Physical counter confirmation (cash/card) — `allowFromStatuses: [ACTIVE, PROCESSING]`.
   * - Independent bank-credit verification of an observed UTR (BANK_CONFIRMED).
   * - Authenticated manual bank reconciliation (`allowFromTerminal: true` is a
   *   documented, audited reconciliation adjustment for FAILED/EXPIRED sessions;
   *   observer intake never calls this method).
   *
   * Atomic CAS with affected-rows check; ledger reservation for an operator-
   * supplied UTR happens inside the same transaction; SUCCESS outbox row is
   * written atomically with the state change.
   *
   * @param {string} sessionId
   * @param {{
   *   confirmationStatus?: string,
   *   operatorId?: string,
   *   confirmationNote?: string,
   *   attributedObservationId?: string | null,
   *   bankReferenceNumber?: string | null,
   *   allowFromStatuses?: string[],
   *   allowFromTerminal?: boolean
   * }} [options]
   * @returns {{ session: any, confirmed: boolean, alreadyConfirmed: boolean }}
   */
  confirmPaymentSuccess(sessionId, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      if (session.status === PaymentStatus.SUCCESS) {
        return { session, confirmed: false, alreadyConfirmed: true };
      }

      // Declared graph: SUCCESS is reachable from PROCESSING only.
      const declaredSuccessSources = allowedSourceStatuses(PaymentStatus.SUCCESS);
      let sourceStatuses;
      if (options.allowFromStatuses) {
        // Explicit, audited caller scope (e.g. physical counter sessions start ACTIVE).
        // Terminal statuses stay opt-in via allowFromTerminal.
        sourceStatuses = options.allowFromStatuses.filter(
          s => !isTerminalStatus(s) || options.allowFromTerminal === true
        );
      } else if (options.allowFromTerminal) {
        sourceStatuses = [...declaredSuccessSources,
          PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED,
          PaymentStatus.INITIATED, PaymentStatus.QUEUED, PaymentStatus.ACTIVE];
      } else {
        sourceStatuses = declaredSuccessSources;
      }

      if (!sourceStatuses.includes(session.status)) {
        throw new Error(
          `Illegal payment state transition: Cannot move from '${session.status}' to 'SUCCESS' via confirmation.`
        );
      }

      // Operator-supplied UTR must be reserved inside the same transaction so a
      // bank reference can never credit a second order.
      if (options.bankReferenceNumber && session.receivingAccountId) {
        const reservation = this.bankTxn.reserve({
          sessionId: session.id,
          receivingAccountId: session.receivingAccountId,
          merchantId: session.merchantId,
          bankReference: options.bankReferenceNumber,
          amountPaise: session.amountPaise,
          observedAt: new Date(),
          observationId: options.attributedObservationId || null,
          source: 'MANUAL_RECONCILIATION',
          provenance: 'MANUAL_RECONCILIATION'
        });
        if (!reservation.reserved) {
          throw new Error(
            `LEDGER_CONFLICT:${reservation.reason}` +
            (reservation.consumedBySessionId ? ` consumed_by=${reservation.consumedBySessionId}` : '')
          );
        }
      }

      const now = new Date().toISOString();
      const confirmationStatus = options.confirmationStatus || ConfirmationStatus.MANUAL_RECONCILIATION;

      const updateRes = this.db.execute(`
        UPDATE payment_sessions
        SET status = ?,
            confirmation_status = ?,
            confirmed_at = ?,
            confirmed_by = ?,
            confirmation_note = ?,
            completed_at = ?,
            attributed_observation_id = COALESCE(?, attributed_observation_id),
            updated_at = ?
        WHERE id = ? AND status = ?
      `, [
        PaymentStatus.SUCCESS,
        confirmationStatus,
        now,
        options.operatorId || null,
        options.confirmationNote || null,
        now,
        options.attributedObservationId || null,
        now,
        sessionId,
        session.status
      ]);

      if (updateRes.changes !== 1) {
        throw new Error(
          `Concurrent payment state update detected for session ${sessionId}: expected status '${session.status}'.`
        );
      }

      this._enqueueOutbox(sessionId, PaymentStatus.SUCCESS);

      if (session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
        `, [now, session.receivingAccountId, sessionId]);
      }

      return { session: this.findById(sessionId), confirmed: true, alreadyConfirmed: false };
    });
  }

  findCurrentActiveOrProcessing(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale =
      row.confirmation_status !== ConfirmationStatus.REPORTED && (
      (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now));
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findCurrentActiveOrProcessingForMerchant(merchantId) {
    if (!merchantId) return null;
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE merchant_id = ? AND status IN (?, ?)
      ORDER BY created_at DESC
      LIMIT 1
    `, [merchantId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale =
      row.confirmation_status !== ConfirmationStatus.REPORTED && (
      (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now));
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForCustomer(customerId, excludeSessionId = null) {
    if (!customerId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?)
    `;
    const params = [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale =
      row.confirmation_status !== ConfirmationStatus.REPORTED && (
      (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now));
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForDevice(deviceId, excludeSessionId = null) {
    if (!deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE device_id = ? AND status IN (?, ?, ?)
    `;
    const params = [deviceId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale =
      row.confirmation_status !== ConfirmationStatus.REPORTED && (
      (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now));
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findConflictingActiveSession({ customerId = null, deviceId = null, excludeSessionId = null }) {
    if (!customerId && !deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE status IN (?, ?, ?)
    `;
    const params = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    if (customerId && deviceId) {
      query += ` AND (customer_id = ? OR device_id = ?) `;
      params.push(customerId, deviceId);
    } else if (customerId) {
      query += ` AND customer_id = ? `;
      params.push(customerId);
    } else {
      query += ` AND device_id = ? `;
      params.push(deviceId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale =
      row.confirmation_status !== ConfirmationStatus.REPORTED && (
      (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now));
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findAllActiveOrPendingForCustomer(customerId) {
    if (!customerId) return [];
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?, ?)
      ORDER BY created_at DESC
    `, [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED]);
    return rows.map(r => this.mapRow(r));
  }

  findQueuedSessions(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    return rows.map(r => this.mapRow(r));
  }

  getNextQueuedSession(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Re-indexes remaining queued sessions after a promotion.
   */
  reindexQueue(receivingAccountId) {
    const queued = this.findQueuedSessions(receivingAccountId);
    let pos = 1;
    for (const session of queued) {
      this.db.execute(`
        UPDATE payment_sessions SET queue_position = ?, updated_at = ?
        WHERE id = ?
      `, [pos++, new Date().toISOString(), session.id]);
    }
  }

  findRecentlyExpiredOrFailed(receivingAccountId, sinceDate) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ?
        AND status IN (?, ?)
        AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT 20
    `, [receivingAccountId, PaymentStatus.EXPIRED, PaymentStatus.FAILED, sinceDate.toISOString()]);

    return rows.map(r => this.mapRow(r));
  }

  /**
   * Records an observation confidence source and updates the verification tier.
   *
   * DUAL-TRUTH MODEL (audit P1-01 / instruction 7): an observer claim NEVER
   * changes the payment status. It marks the session as REPORTED
   * (confirmation_status='REPORTED') while the payment status stays exactly
   * where it is (ACTIVE/PROCESSING). Only confirmPaymentSuccess() — counter
   * confirmation or authenticated manual bank reconciliation — can produce
   * SUCCESS and hence a fulfillment webhook.
   *
   * The bank reference (UTR) is reserved atomically against the canonical
   * ledger so one bank credit can never credit a second order (P1-02). A
   * duplicate/conflicting reference throws LEDGER_RESERVATION_FAILED:* and
   * rolls back the entire recording (requesting reconciliation instead).
   *
   * @param {string} sessionId
   * @param {string} source E.g. 'GMAIL', 'GOOGLE_MESSAGES'
   * @param {string} observationId
   * @param {{ finalizeSuccess?: boolean, bankReferenceNumber?: string|null, amountPaise?: bigint|number, observedAt?: Date }} [options={}]
   *   `finalizeSuccess` is retained for API compatibility and is IGNORED:
   *   observers are no longer allowed to finalize payments.
   * @returns {{ session: any, level: number, sources: string[], tag: string, isFirstReport: boolean, reported: boolean }}
   */
  recordVerificationSource(sessionId, source, observationId, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Payment session not found: ${sessionId}`);

      // Reserve/consume the bank reference for THIS session (P1-02).
      if (options.bankReferenceNumber && session.receivingAccountId) {
        const reservation = this.bankTxn.reserve({
          sessionId: session.id,
          receivingAccountId: session.receivingAccountId,
          merchantId: session.merchantId,
          bankReference: options.bankReferenceNumber,
          amountPaise: options.amountPaise !== undefined && options.amountPaise !== null
            ? options.amountPaise
            : session.amountPaise,
          observedAt: options.observedAt || new Date(),
          observationId,
          source
        });
        if (!reservation.reserved) {
          throw new Error(
            `LEDGER_RESERVATION_FAILED:${reservation.reason}` +
            (reservation.consumedBySessionId ? ` consumed_by=${reservation.consumedBySessionId}` : '')
          );
        }
      }

      // Read current verification sources
      const sourcesSet = new Set(session.verificationSources || []);
      sourcesSet.add(source);
      const sources = Array.from(sourcesSet);

      const level = Math.min(2, sources.length); // 1 or 2 (2-Layer Engine: SMS + Gmail)
      const sourceLabels = sources.map(s => {
        if (s === 'GOOGLE_MESSAGES') return 'SMS';
        if (s === 'GMAIL') return 'Gmail';
        return s;
      });

      let tag = `Single Verification (${sourceLabels.join(', ')})`;
      if (level >= 2) {
        tag = `Dual Verification (${sourceLabels.join(' + ')})`;
      }

      const wasAlreadyReported = session.confirmationStatus && session.confirmationStatus !== 'UNCONFIRMED';

      // Terminal/unsuccessful sessions record evidence WITHOUT any status or
      // confirmation change (GATE B: FAILED/EXPIRED/CANCELLED can never become
      // SUCCESS via observation intake; a SUCCESS session keeps its original
      // confirmation provenance).
      const isTerminal = isTerminalStatus(session.status);
      let targetConfirmation = session.confirmationStatus || ConfirmationStatus.UNCONFIRMED;
      if (!isTerminal) {
        targetConfirmation = ConfirmationStatus.REPORTED;
      }

      const isFirstReport = !wasAlreadyReported && targetConfirmation === ConfirmationStatus.REPORTED;
      const now = new Date().toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET confirmation_status = ?,
            verification_level = ?,
            verification_sources = ?,
            verification_tag = ?,
            attributed_observation_id = COALESCE(attributed_observation_id, ?),
            updated_at = ?
        WHERE id = ?
      `, [
        targetConfirmation,
        level,
        JSON.stringify(sources),
        tag,
        observationId,
        now,
        sessionId
      ]);

      const updated = this.findById(sessionId);
      return {
        session: updated,
        level,
        sources,
        tag,
        isFirstReport,
        reported: updated.confirmationStatus === ConfirmationStatus.REPORTED,
        // Kept for API compatibility: observers can never finalize a payment.
        isFirstSuccess: false
      };
    });
  }

  bindDevice(sessionId, deviceId) {
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE payment_sessions SET device_id = ?, updated_at = ? WHERE id = ?',
      [deviceId, now, sessionId]
    );
    return this.findById(sessionId);
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      receivingAccountId: row.receiving_account_id,
      orderId: row.order_id,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      method: row.method,
      status: row.status,
      queuePosition: row.queue_position,
      slotAcquiredAt: row.slot_acquired_at ? new Date(row.slot_acquired_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      processingStartedAt: row.processing_started_at ? new Date(row.processing_started_at) : null,
      processingExpiresAt: row.processing_expires_at ? new Date(row.processing_expires_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      returnUrl: row.return_url,
      attributedObservationId: row.attributed_observation_id,
      idempotencyKey: row.idempotency_key,
      deviceId: row.device_id || null,
      verificationLevel: row.verification_level !== undefined && row.verification_level !== null ? Number(row.verification_level) : 0,
      verificationSources: JSON.parse(row.verification_sources || '[]'),
      verificationTag: row.verification_tag || 'UNVERIFIED',
      confirmationStatus: row.confirmation_status || ConfirmationStatus.UNCONFIRMED,
      confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
      confirmedBy: row.confirmed_by || null,
      confirmationNote: row.confirmation_note || null,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

