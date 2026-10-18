import {
  PaymentStatus,
  ObservationAttributionStatus,
  ConfirmationStatus,
  TicketStatus,
  SenderType
} from '@youpi/common';

export class AttributionEngine {
  /**
   * @param {{
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   obsRepo: import('@youpi/db').ObservationRepository,
   *   ticketRepo?: import('@youpi/db').SupportTicketRepository,
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   eventEmitter?: { emit: (event: string, payload: any) => void }
   * }} options
   */
  constructor(options) {
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.ticketRepo = options.ticketRepo;
    this.reviewRepo = options.reviewRepo;
    this.auditRepo = options.auditRepo;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    const isTestExecution = process.env.NODE_ENV === 'test' ||
      (process.execArgv && process.execArgv.includes('--test')) ||
      (process.argv && process.argv.some(a => typeof a === 'string' && a.includes('test')));

    /**
     * Corroboration window (ms): a second, independent channel must observe the
     * SAME bank credit within this spread to satisfy bank-credit verification.
     * With 0 (test default) corroboration is immediate/implicit, because the
     * synthetic observations are submitted back-to-back. Raise it (env
     * PAYMENT_GRACE_PERIOD_MS) in production when SMS and email observers
     * typically report the same credit tens of seconds apart.
     */
    this.gracePeriodMs = options.gracePeriodMs !== undefined
      ? options.gracePeriodMs
      : (process.env.PAYMENT_GRACE_PERIOD_MS !== undefined
        ? Number(process.env.PAYMENT_GRACE_PERIOD_MS)
        : (isTestExecution ? 0 : 5000));
    /** @type {Map<string, NodeJS.Timeout>} */
    this.pendingGraceTimers = new Map();
  }

  destroy() {
    for (const timer of this.pendingGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingGraceTimers.clear();
  }

  /**
   * Records a bank credit that could not be attributed to a live payment in the
   * durable reconciliation queue. Never changes a payment status: an operator
   * must review the case and use the authoritative confirmation flow.
   * @param {{ session?: any, normalizedObs: any, observationId: string, reason: string }} input
   * @returns {any|null}
   */
  _recordReviewCase({ session, normalizedObs, observationId, reason }) {
    if (!this.reviewRepo) return null;
    let merchantId = session?.merchantId || null;
    if (!merchantId) {
      const row = this.sessionRepo.db.queryOne(
        'SELECT merchant_id FROM payment_receiving_accounts WHERE id = ?',
        [normalizedObs.receivingAccountId]
      );
      merchantId = row?.merchant_id || null;
    }
    if (!merchantId) return null;

    try {
      const result = this.reviewRepo.create({
        merchantId,
        receivingAccountId: normalizedObs.receivingAccountId,
        paymentSessionId: session?.id || null,
        observationId,
        amountPaise: normalizedObs.amountPaise,
        bankReference: normalizedObs.bankReferenceNumber || null,
        source: normalizedObs.source,
        reason
      });
      if (result.created && this.auditRepo) {
        this.auditRepo.log({
          merchantId,
          entityType: 'PAYMENT_REVIEW_CASE',
          entityId: result.case.id,
          action: 'PAYMENT_REVIEW_CASE_OPENED',
          actorType: 'SYSTEM',
          details: {
            reason,
            observationId,
            paymentSessionId: session?.id || null,
            amountPaise: normalizedObs.amountPaise.toString(),
            bankReferenceNumber: normalizedObs.bankReferenceNumber || null
          }
        });
      }
      this.eventEmitter.emit('PAYMENT.REVIEW_REQUIRED', {
        reviewCaseId: result.case.id,
        merchantId,
        paymentSessionId: session?.id || null,
        amountPaise: normalizedObs.amountPaise,
        reason
      });
      return result.case;
    } catch (err) {
      // Review queueing must never break observation intake; the audit trail
      // above and the observation row remain the fallback evidence.
      console.error('[Attribution] Failed to open review case:', err.message);
      return null;
    }
  }

  /**
   * Tenant-scope guard (audit P0-09): an observation may only ever touch a
   * session bound to the SAME receiving account it was observed on. A session
   * without a receiving account (non-UPI counter session) can never be matched
   * by bank-observation intake.
   * @param {any} session
   * @param {any} normalizedObs
   * @returns {boolean}
   */
  _isSameReceivingAccount(session, normalizedObs) {
    return Boolean(
      session &&
      session.receivingAccountId &&
      normalizedObs.receivingAccountId &&
      session.receivingAccountId === normalizedObs.receivingAccountId
    );
  }

  /**
   * Evidence-only options handed to the repository: the bank reference is
   * reserved atomically against the canonical transaction ledger.
   * @param {any} normalizedObs
   */
  _evidenceOptions(normalizedObs) {
    return {
      bankReferenceNumber: normalizedObs.bankReferenceNumber || null,
      amountPaise: normalizedObs.amountPaise,
      observedAt: normalizedObs.observedAt
    };
  }

  /**
   * Finds the session that a bank reference is already exclusively reserved to,
   * so a later observation of the SAME credit from another channel attaches to
   * the SAME order instead of creating a second credit.
   * @param {any} normalizedObs
   * @returns {string | null}
   */
  _resolveSessionByReservedReference(normalizedObs) {
    if (!normalizedObs.bankReferenceNumber) return null;
    const row = this.sessionRepo.db.queryOne(`
      SELECT consumed_by_session_id FROM bank_transaction_ledger
      WHERE receiving_account_id = ? AND bank_reference = ? AND consumed_by_session_id IS NOT NULL
    `, [normalizedObs.receivingAccountId, normalizedObs.bankReferenceNumber]);
    return row ? row.consumed_by_session_id : null;
  }

  /**
   * Records the observation against the session and returns a duplicate-ignored
   * result when the bank reference is already consumed by another order.
   */
  _rejectDuplicateTransaction(observationId, session, err) {
    const reason = err && typeof err.message === 'string' ? err.message : 'LEDGER_RESERVATION_FAILED';
    this.obsRepo.markDuplicate(observationId);

    if (this.auditRepo) {
      this.auditRepo.log({
        merchantId: session ? session.merchantId : null,
        entityType: 'PAYMENT_SESSION',
        entityId: session ? session.id : null,
        action: 'DUPLICATE_BANK_REFERENCE_REJECTED',
        actorType: 'SYSTEM',
        details: { observationId, reason }
      });
    }

    return {
      attributed: false,
      duplicate: true,
      lateMatch: false,
      paymentSessionId: session ? session.id : undefined,
      observationId,
      outcomeStatus: ObservationAttributionStatus.DUPLICATE_TRANSACTION,
      reason
    };
  }

  /**
   * All observations attributed to a session that reference the same bank credit.
   * @param {any} session
   * @param {string} bankReference
   */
  _referenceEvidence(session, bankReference) {
    return this.sessionRepo.db.query(`
      SELECT source, ingested_at FROM payment_observations
      WHERE receiving_account_id = ? AND bank_reference_number = ? AND attributed_payment_id = ?
      ORDER BY ingested_at ASC
    `, [session.receivingAccountId, bankReference, session.id]);
  }

  /**
   * INDEPENDENT BANK-CREDIT VERIFICATION (audit Gate B).
   *
   * A payment becomes SUCCESS only when ALL of the following hold:
   * 1. the session is bound to the observation's receiving account (tenant scope);
   * 2. a trustworthy bank reference was reserved to THIS session in the canonical
   *    ledger, for the exact same amount;
   * 3. the same credit was independently observed from at least two channels whose
   *    reports fall inside the corroboration window — or the ledger row carries
   *    authoritative BANK_CONFIRMED provenance.
   *
   * It never reserves a reference itself, never credits a second order, and never
   * widens beyond the session's own receiving account. Failure leaves the payment
   * REPORTED for manual reconciliation.
   *
   * @param {string} sessionId
   * @param {any} [normalizedObs]
   * @returns {{
   *   confirmed: boolean,
   *   alreadyConfirmed?: boolean,
   *   reason?: string,
   *   sources?: string[],
   *   session?: any
   * }}
   */
  _verifyBankCredit(sessionId, normalizedObs = null) {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return { confirmed: false, reason: 'SESSION_NOT_FOUND' };

    if (session.status === PaymentStatus.SUCCESS) {
      return { confirmed: false, alreadyConfirmed: true, session };
    }

    if (![PaymentStatus.ACTIVE, PaymentStatus.PROCESSING].includes(session.status)) {
      return { confirmed: false, reason: 'SESSION_NOT_ELIGIBLE', session };
    }

    if (!session.receivingAccountId) {
      return { confirmed: false, reason: 'NO_RECEIVING_ACCOUNT', session };
    }

    const bankReference = normalizedObs?.bankReferenceNumber || null;
    if (!bankReference) {
      // No trustworthy bank reference: nothing that uniquely identifies a bank
      // credit. Manual reconciliation is required (never automatic SUCCESS).
      return { confirmed: false, reason: 'NO_TRUSTED_BANK_REFERENCE', session };
    }

    const ledgerRow = this.sessionRepo.bankTxn.findByReference(session.receivingAccountId, bankReference);
    if (!ledgerRow || ledgerRow.consumed_by_session_id !== session.id) {
      return { confirmed: false, reason: 'REFERENCE_NOT_RESERVED_TO_SESSION', session };
    }

    if (Number(ledgerRow.amount_paise) !== Number(session.amountPaise)) {
      return { confirmed: false, reason: 'AMOUNT_MISMATCH', session };
    }

    const authoritativeBankProof = ledgerRow.provenance === 'BANK_CONFIRMED';
    const evidence = this._referenceEvidence(session, bankReference);
    const sources = [...new Set(evidence.map(e => e.source))];
    const spreadMs = evidence.length > 1
      ? new Date(evidence[evidence.length - 1].ingested_at).getTime() - new Date(evidence[0].ingested_at).getTime()
      : 0;
    // Corroboration is EVIDENCE, not settlement: two observer channels agreeing on
    // the same credit raises confidence and is recorded, but without an
    // authenticated bank/acquirer source (BANK_CONFIRMED ledger provenance) the
    // payment is NOT marked verified and the order is NOT fulfilled automatically.
    const corroborated = sources.length >= 2 && (this.gracePeriodMs <= 0 || spreadMs <= this.gracePeriodMs);

    if (!authoritativeBankProof) {
      return {
        confirmed: false,
        reason: corroborated
          ? 'AWAITING_AUTHORITATIVE_BANK_CONFIRMATION'
          : 'INSUFFICIENT_INDEPENDENT_EVIDENCE',
        corroborated,
        sources,
        session
      };
    }

    const result = this.sessionRepo.confirmPaymentSuccess(session.id, {
      confirmationStatus: ConfirmationStatus.BANK_CONFIRMED,
      allowFromStatuses: [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING],
      bankReferenceNumber: bankReference,
      confirmationNote: authoritativeBankProof
        ? `Authoritative bank-credit confirmation for reference ${bankReference}`
        : `Bank credit ${bankReference} independently observed on channels: ${sources.join(', ')}`
    });

    if (this.auditRepo && result.confirmed) {
      this.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'PAYMENT_BANK_CREDIT_VERIFIED',
        actorType: 'SYSTEM',
        details: {
          bankReferenceNumber: bankReference,
          sources,
          authoritativeBankProof
        }
      });
    }

    if (result.confirmed) {
      const confirmedSession = result.session || session;
      this.eventEmitter.emit('PAYMENT.SUCCESS', {
        paymentId: confirmedSession.id,
        orderId: confirmedSession.orderId,
        merchantId: confirmedSession.merchantId,
        amountPaise: confirmedSession.amountPaise,
        bankReferenceNumber: bankReference,
        confirmationStatus: ConfirmationStatus.BANK_CONFIRMED,
        sources,
        verificationLevel: confirmedSession.verificationLevel,
        verificationTag: confirmedSession.verificationTag,
        sourcesList: confirmedSession.verificationSources
      });
    }

    return { confirmed: result.confirmed, alreadyConfirmed: result.alreadyConfirmed, sources, session: result.session || session };
  }

  /**
   * Applies an AUTHENTICATED bank/acquirer confirmation (sprint item 7).
   *
   * The reference is reserved to exactly ONE matching session on the receiving
   * account for the exact amount, its ledger provenance is set to BANK_CONFIRMED,
   * and that session — and only that session — may then reach SUCCESS.
   *
   * @param {{
   *   receivingAccountId: string,
   *   merchantId: string,
   *   bankReferenceNumber: string,
   *   amountPaise: bigint|number,
   *   source?: string,
   *   confirmedBy?: string
   * }} input
   * @returns {{ ok: boolean, confirmed: boolean, reason?: string, sessionId?: string, ledgerRowId?: string }}
   */
  confirmAuthoritativeBankCredit(input) {
    const reference = String(input?.bankReferenceNumber || '').trim();
    const amount = input?.amountPaise !== undefined && input?.amountPaise !== null ? Number(input.amountPaise) : null;
    if (!input?.receivingAccountId || !reference || amount === null || Number.isNaN(amount)) {
      return { ok: false, confirmed: false, reason: 'MISSING_FIELDS' };
    }

    const bankTxn = this.sessionRepo.bankTxn;
    const existing = bankTxn.findByReference(input.receivingAccountId, reference);
    if (existing) {
      if (Number(existing.amount_paise) !== amount) {
        return { ok: false, confirmed: false, reason: 'AMOUNT_MISMATCH', ledgerRowId: existing.id };
      }
      if (existing.merchant_id !== input.merchantId) {
        return { ok: false, confirmed: false, reason: 'CROSS_TENANT_REFERENCE', ledgerRowId: existing.id };
      }
      if (existing.provenance !== 'BANK_CONFIRMED') {
        this.sessionRepo.db.execute(
          "UPDATE bank_transaction_ledger SET provenance = 'BANK_CONFIRMED' WHERE id = ?",
          [existing.id]
        );
      }
    }

    const candidates = this.sessionRepo.db.query(`
      SELECT id FROM payment_sessions
      WHERE receiving_account_id = ? AND amount_paise = ? AND status IN (?, ?)
      ORDER BY created_at ASC
    `, [input.receivingAccountId, amount, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    for (const candidate of candidates) {
      const reservation = bankTxn.reserve({
        sessionId: candidate.id,
        receivingAccountId: input.receivingAccountId,
        merchantId: input.merchantId,
        bankReference: reference,
        amountPaise: amount,
        observedAt: new Date(),
        source: input.source || 'ACQUIRER',
        provenance: 'BANK_CONFIRMED'
      });

      // Already consumed by another order: this credit can never be credited twice.
      if (!reservation.reserved) continue;

      const verification = this._verifyBankCredit(candidate.id, { bankReferenceNumber: reference });
      if (verification.confirmed) {
        return { ok: true, confirmed: true, sessionId: candidate.id, ledgerRowId: reservation.rowId || existing?.id };
      }
      return {
        ok: true,
        confirmed: false,
        reason: verification.reason,
        sessionId: candidate.id,
        ledgerRowId: reservation.rowId || existing?.id
      };
    }

    return { ok: true, confirmed: false, reason: 'NO_MATCHING_SESSION' };
  }

  /**
   * Processes a normalized canonical observation through the attribution pipeline.
   * @param {ReturnType<typeof import('./normalizer.js').ObservationNormalizer.normalize>} normalizedObs
   * @returns {{
   *   attributed: boolean,
   *   duplicate: boolean,
   *   lateMatch: boolean,
   *   paymentSessionId?: string,
   *   observationId: string,
   *   outcomeStatus: string,
   *   verificationLevel?: number,
   *   verificationTag?: string,
   *   verificationSources?: string[]
   * }}
   */
  processObservation(normalizedObs) {
    // Tier 1: Check fingerprint for deduplication
    const existing = this.obsRepo.findByFingerprint(normalizedObs.fingerprintHash);
    if (existing) {
      // If observation came from the SAME source, drop as redundant duplicate
      if (existing.source === normalizedObs.source) {
        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_OBSERVATION',
            entityId: existing.id,
            action: 'DUPLICATE_OBSERVATION_DROPPED',
            actorType: 'OBSERVER',
            details: { fingerprintHash: normalizedObs.fingerprintHash, source: normalizedObs.source }
          });
        }
        return {
          attributed: false,
          duplicate: true,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId || undefined,
          observationId: existing.id,
          outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
        };
      }

      // A DIFFERENT channel produced the SAME canonical observation fingerprint.
      // When a bank reference is present the fingerprint is derived from
      // (receiving account + amount + UTR), so this means: the SAME bank credit
      // was independently observed on another channel — the only case that may
      // strengthen verification (audit P1-01). An observation that is merely a
      // different text with a different reference/time bucket never reaches here.
      const corroboratedSessionId = existing.attributedPaymentId
        || this._resolveSessionByReservedReference(normalizedObs);

      if (corroboratedSessionId) {
        const session = this.sessionRepo.findById(corroboratedSessionId);
        if (session && this._isSameReceivingAccount(session, normalizedObs)) {
          const pendingTimer = this.pendingGraceTimers.get(session.id);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.pendingGraceTimers.delete(session.id);
          }

          const savedObs = this.obsRepo.create(normalizedObs);
          let verifyResult;
          try {
            verifyResult = this.sessionRepo.recordVerificationSource(
              session.id,
              normalizedObs.source,
              savedObs.id,
              this._evidenceOptions(normalizedObs)
            );
          } catch (err) {
            return this._rejectDuplicateTransaction(savedObs.id, session, err);
          }
          this.obsRepo.markAttributed(savedObs.id, session.id);

          if (this.auditRepo) {
            this.auditRepo.log({
              merchantId: session.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: session.id,
              action: 'PAYMENT_VERIFICATION_UPGRADED',
              actorType: 'SYSTEM',
              details: {
                observationId: savedObs.id,
                source: normalizedObs.source,
                level: verifyResult.level,
                tag: verifyResult.tag,
                sources: verifyResult.sources
              }
            });
          }

          this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
            paymentId: session.id,
            orderId: session.orderId,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });

          const confirmation = this._verifyBankCredit(session.id, normalizedObs);

          if (confirmation.alreadyConfirmed) {
            // The SAME credit was observed again after this order was already
            // bank-confirmed: idempotent duplicate, never a second credit.
            return {
              attributed: true,
              duplicate: true,
              lateMatch: false,
              paymentSessionId: session.id,
              observationId: savedObs.id,
              outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED,
              confirmationStatus: ConfirmationStatus.BANK_CONFIRMED,
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              verificationSources: verifyResult.sources
            };
          }

          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            paymentSessionId: session.id,
            observationId: savedObs.id,
            // A second channel is still only EVIDENCE until independent
            // bank-credit verification succeeds.
            outcomeStatus: confirmation.confirmed ? PaymentStatus.SUCCESS : 'REPORTED',
            confirmationStatus: confirmation.confirmed
              ? ConfirmationStatus.BANK_CONFIRMED
              : ConfirmationStatus.REPORTED,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            verificationSources: verifyResult.sources
          };
        }
      }
    }

    // Persist new observation as UNATTRIBUTED first
    const savedObs = this.obsRepo.create(normalizedObs);

    // Tier 2: resolve a candidate session STRICTLY inside the observation's own
    // receiving account. There is deliberately NO gateway-wide (cross-merchant /
    // cross-account) same-amount fallback: a credit on account A can never pay an
    // order on account B (audit P0-09, P1-03).
    let currentSession = null;
    const targetSessionId = normalizedObs.rawPayload?.targetSessionId;
    if (targetSessionId) {
      const candidate = this.sessionRepo.findById(targetSessionId);
      if (candidate &&
          this._isSameReceivingAccount(candidate, normalizedObs) &&
          candidate.amountPaise === normalizedObs.amountPaise) {
        currentSession = candidate;
      }
    }
    if (!currentSession) {
      currentSession = this.sessionRepo.findCurrentActiveOrProcessing(normalizedObs.receivingAccountId);
    }
    if (currentSession && currentSession.amountPaise !== normalizedObs.amountPaise) {
      const matchRow = this.sessionRepo.db.queryOne(`
        SELECT * FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);
      // Ambiguous / absent scoped match must never widen beyond this account.
      currentSession = matchRow ? this.sessionRepo.mapRow(matchRow) : null;
    }

    if (currentSession) {
      // Invariant Check 1: Must be in ACTIVE or PROCESSING status
      const isEligibleStatus = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING].includes(currentSession.status);

      // Invariant Check 2: Exact Amount Match (in integer paise)
      const isAmountMatch = currentSession.amountPaise === normalizedObs.amountPaise;

      // Invariant Check 3: Temporal Window (with 5-minute clock skew tolerance, strictly preventing hijacking of prior expired sessions)
      let isPriorExpiredSession = false;
      if (currentSession.slotAcquiredAt && normalizedObs.observedAt < currentSession.slotAcquiredAt) {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(
          normalizedObs.receivingAccountId,
          thirtyMinutesAgo
        );
        isPriorExpiredSession = recentExpired.some(s => s.amountPaise === normalizedObs.amountPaise);
      }

      const slotStart = currentSession.slotAcquiredAt
        ? new Date(currentSession.slotAcquiredAt.getTime() - 300000)
        : new Date(currentSession.createdAt.getTime() - 300000);

      const isTimeValid = !isPriorExpiredSession && (normalizedObs.observedAt >= slotStart);

      if (isEligibleStatus && isAmountMatch && isTimeValid) {
        const wasActive = currentSession.status === PaymentStatus.ACTIVE;

        // Close any open corroboration window for this session: this channel is
        // either the first report or the corroborating one.
        const pendingGrace = this.pendingGraceTimers.get(currentSession.id);
        if (pendingGrace) {
          clearTimeout(pendingGrace);
          this.pendingGraceTimers.delete(currentSession.id);
        }

        // Record this observation as EVIDENCE ONLY. Observers can never finalize a
        // payment: recordVerificationSource keeps the payment status untouched,
        // marks the session REPORTED and reserves the bank reference (UTR) against
        // the canonical transaction ledger atomically (audit P1-01/P1-02).
        let verifyResult;
        try {
          verifyResult = this.sessionRepo.recordVerificationSource(
            currentSession.id,
            normalizedObs.source,
            savedObs.id,
            this._evidenceOptions(normalizedObs)
          );
        } catch (err) {
          // This bank reference is already consumed by another order (or conflicts
          // on amount): never credit a second order, never crash observation intake.
          return this._rejectDuplicateTransaction(savedObs.id, currentSession, err);
        }

        this.obsRepo.markAttributed(savedObs.id, currentSession.id);

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: currentSession.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: currentSession.id,
            action: pendingGrace ? 'PAYMENT_VERIFICATION_CORROBORATED' : 'PAYMENT_OBSERVATION_REPORTED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              bankReferenceNumber: normalizedObs.bankReferenceNumber || null,
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.REPORTED', {
          paymentId: currentSession.id,
          orderId: currentSession.orderId,
          merchantId: currentSession.merchantId,
          amountPaise: currentSession.amountPaise,
          observationId: savedObs.id,
          source: normalizedObs.source,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        if (pendingGrace) {
          this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
        } else {
          this.eventEmitter.emit('PAYMENT.LEVEL1_VERIFIED', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            merchantId: currentSession.merchantId,
            amountPaise: currentSession.amountPaise,
            observationId: savedObs.id,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
        }

        // INDEPENDENT BANK-CREDIT VERIFICATION before SUCCESS: the SAME bank credit
        // must be independently observed on a second channel (matching account,
        // amount and bank reference), or be backed by authoritative bank proof.
        // One SMS alone stays REPORTED forever (audit P1-01, Gate B).
        const confirmation = this._verifyBankCredit(currentSession.id, normalizedObs);

        if (confirmation.confirmed) {
          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            wasActive,
            paymentSessionId: currentSession.id,
            observationId: savedObs.id,
            outcomeStatus: PaymentStatus.SUCCESS,
            confirmationStatus: ConfirmationStatus.BANK_CONFIRMED,
            verificationLevel: Math.max(verifyResult.level, 2),
            verificationTag: verifyResult.tag,
            verificationSources: verifyResult.sources
          };
        }

        // Not independently verifiable yet: stay REPORTED. The reported hold keeps
        // the session from expiring while a corroborating channel may still arrive;
        // the window itself never finalizes anything.
        if (this.gracePeriodMs > 0) {
          const targetSessionId = currentSession.id;
          const corroborationTimer = setTimeout(() => {
            this.pendingGraceTimers.delete(targetSessionId);
          }, this.gracePeriodMs);
          if (corroborationTimer.unref) corroborationTimer.unref();
          this.pendingGraceTimers.set(targetSessionId, corroborationTimer);
        }

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          wasActive,
          paymentSessionId: currentSession.id,
          observationId: savedObs.id,
          outcomeStatus: 'REPORTED',
          confirmationStatus: ConfirmationStatus.REPORTED,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Check if observation confirms a recently successful session on this receiving account (within 60s)
    // Upgrades verification level (e.g. from Level 1 -> Level 2 -> Level 3)
    const recentSuccessSession = this.sessionRepo.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = 'SUCCESS'
        AND amount_paise = ? AND completed_at >= datetime('now', '-60 seconds')
      ORDER BY completed_at DESC LIMIT 1
    `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);

    if (recentSuccessSession) {
      // Check if this session's attributed observation had a UTR
      const existingObs = recentSuccessSession.attributed_observation_id
        ? this.obsRepo.findById(recentSuccessSession.attributed_observation_id)
        : null;

      // If both have UTRs and they do NOT match, this is NOT the same transaction!
      const isUtrConflict = normalizedObs.bankReferenceNumber &&
        existingObs?.bankReferenceNumber &&
        normalizedObs.bankReferenceNumber !== existingObs.bankReferenceNumber;

      const sessionSlotStart = recentSuccessSession.slot_acquired_at
        ? new Date(new Date(recentSuccessSession.slot_acquired_at).getTime() - 30000)
        : new Date(new Date(recentSuccessSession.created_at).getTime() - 30000);
      const sessionCompleted = recentSuccessSession.completed_at
        ? new Date(new Date(recentSuccessSession.completed_at).getTime() + 30000)
        : new Date();

      // Temporal check: observation must have been observed during this session's window
      if (!isUtrConflict && normalizedObs.observedAt >= sessionSlotStart && normalizedObs.observedAt <= sessionCompleted) {
        // This only enriches an ALREADY bank-confirmed success with extra evidence;
        // it never creates a new success and never alters the confirmation.
        const verifyResult = this.sessionRepo.recordVerificationSource(
          recentSuccessSession.id,
          normalizedObs.source,
          savedObs.id,
          this._evidenceOptions(normalizedObs)
        );

        this.obsRepo.markAttributed(savedObs.id, recentSuccessSession.id);

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: recentSuccessSession.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: recentSuccessSession.id,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: recentSuccessSession.id,
          orderId: recentSuccessSession.order_id,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: recentSuccessSession.id,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Tier 3: Late Observation Handling
    // Check if observation matches a recently expired or failed session on this receiving account (< 30 mins)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    // Cancelled orders are included here on purpose: a credit can still land
    // after the customer cancelled, and it must reach the review queue rather
    // than disappear (it never revives the cancelled session).
    const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(
      normalizedObs.receivingAccountId,
      thirtyMinutesAgo,
      { includeCancelled: true }
    );

    const lateMatchedSession = recentExpired.find(s => s.amountPaise === normalizedObs.amountPaise);

    if (lateMatchedSession) {
      // Mark observation as LATE_UNMATCHED
      this.obsRepo.markLateUnmatched(savedObs.id);

      // A genuine bank credit that landed after the checkout window must never be
      // lost: queue it for operator review. The expired/failed session itself is
      // untouched (terminal invariants preserved).
      this._recordReviewCase({
        session: lateMatchedSession,
        normalizedObs,
        observationId: savedObs.id,
        reason: 'LATE_AFTER_TERMINAL'
      });

      if (this.auditRepo) {
        this.auditRepo.log({
          merchantId: lateMatchedSession.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: lateMatchedSession.id,
          action: 'LATE_OBSERVATION_DETECTED',
          actorType: 'SYSTEM',
          details: {
            observationId: savedObs.id,
            source: normalizedObs.source,
            amountPaise: normalizedObs.amountPaise.toString(),
            sessionStatus: lateMatchedSession.status
          }
        });
      }

      // Automatically create a high-priority reconciliation support ticket if customer exists
      if (this.ticketRepo && lateMatchedSession.customerId) {
        this.ticketRepo.createTicket({
          merchantId: lateMatchedSession.merchantId,
          customerId: lateMatchedSession.customerId,
          paymentId: lateMatchedSession.id,
          subject: `[LATE PAYMENT DETECTED] Order #${lateMatchedSession.orderId}`,
          status: TicketStatus.OPEN,
          initialMessage: {
            senderType: SenderType.ADMIN,
            senderId: lateMatchedSession.merchantId,
            message: `A delayed payment observation of ${normalizedObs.amountPaise / 100n} INR was detected after session ${lateMatchedSession.id} ended with status ${lateMatchedSession.status}. Flagged for manual merchant reconciliation.`
          }
        });
      }

      // Emit LATE_DETECTED event
      this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
        paymentId: lateMatchedSession.id,
        orderId: lateMatchedSession.orderId,
        merchantId: lateMatchedSession.merchantId,
        amountPaise: normalizedObs.amountPaise,
        observationId: savedObs.id
      });

      return {
        attributed: false,
        duplicate: false,
        lateMatch: true,
        paymentSessionId: lateMatchedSession.id,
        observationId: savedObs.id,
        outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
      };
    }

    // An unattributed credit that carries a bank reference is a real credit we
    // could not place: queue it for reconciliation instead of dropping it.
    if (normalizedObs.bankReferenceNumber) {
      this._recordReviewCase({
        session: null,
        normalizedObs,
        observationId: savedObs.id,
        reason: 'UNMATCHED_BANK_CREDIT'
      });
    }

    // Unattributed observation
    return {
      attributed: false,
      duplicate: false,
      lateMatch: false,
      observationId: savedObs.id,
      outcomeStatus: ObservationAttributionStatus.UNATTRIBUTED
    };
  }
}
