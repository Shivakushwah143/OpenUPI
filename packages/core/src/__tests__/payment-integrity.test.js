import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AttributionEngine, ObservationNormalizer } from '../index.js';
import {
  PaymentStatus,
  ConfirmationStatus,
  ObserverSource,
  ObservationAttributionStatus
} from '@youpi/common';
import {
  Database,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  PaymentSessionRepository,
  ObservationRepository,
  AuditLogRepository
} from '@youpi/db';

/**
 * Regression suite for attribution integrity (audit P0-09 tenant isolation,
 * P1-01 independent bank-credit verification, Gate B).
 *
 * Two synthetic merchants/accounts, in-memory SQLite, synthetic observations only.
 */
describe('Attribution Integrity: tenant isolation & bank-credit verification', () => {
  let db;
  let sessionRepo;
  let obsRepo;
  let auditRepo;
  let merchantRepo;
  let accountRepo;
  let engine;
  let emittedEvents;
  let merchantA;
  let merchantB;
  let accountA;
  let accountB;

  beforeEach(() => {
    db = new Database({ inMemory: true });
    const seed = runMigrations(db);

    merchantRepo = new MerchantRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    obsRepo = new ObservationRepository(db);
    auditRepo = new AuditLogRepository(db);

    merchantA = seed.defaultMerchant;
    accountA = accountRepo.findActiveForMerchant(merchantA.id);

    merchantB = merchantRepo.create({
      businessName: 'Second Store',
      slug: 'second-store',
      contactEmail: 'second@example.com',
      contactPhone: '9000000002'
    });
    accountB = accountRepo.create({
      merchantId: merchantB.id,
      upiId: 'secondstore@upi',
      payeeName: 'Second Store',
      isActive: true
    });

    emittedEvents = [];
    engine = new AttributionEngine({
      sessionRepo,
      obsRepo,
      auditRepo,
      eventEmitter: { emit: (event, payload) => emittedEvents.push({ event, payload }) }
    });
  });

  afterEach(() => {
    engine.destroy();
    db.close();
  });

  /** Creates an ACTIVE (or PROCESSING) session on the given account. */
  function activeSession(merchant, account, orderId, amountPaise, { processing = true } = {}) {
    const session = sessionRepo.create({
      merchantId: merchant.id,
      receivingAccountId: account.id,
      orderId,
      amountPaise
    });
    sessionRepo.acquireSlotAtomic(session.id, account.id, 300000);
    if (processing) {
      sessionRepo.transitionToProcessing(session.id, 30000);
    }
    return sessionRepo.findById(session.id);
  }

  function observation({ accountId, source, amountPaise, bankReferenceNumber, observedAt }) {
    return ObservationNormalizer.normalize({
      source,
      receivingAccountId: accountId,
      amountPaise,
      bankReferenceNumber,
      observedAt: observedAt || new Date(),
      rawPayload: { text: 'synthetic bank credit notification' }
    });
  }

  describe('Independent bank-credit verification (P1-01 / Gate B)', () => {
    test('one SMS alone never marks a real order bank-confirmed', () => {
      const session = activeSession(merchantA, accountA, 'ORD-SINGLE-SMS', 49900n);

      const result = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 49900n,
        bankReferenceNumber: 'UTR-ONE-CHANNEL'
      }));

      assert.equal(result.attributed, true);
      assert.equal(result.outcomeStatus, 'REPORTED');
      assert.equal(result.confirmationStatus, ConfirmationStatus.REPORTED);

      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.PROCESSING);
      assert.equal(after.confirmationStatus, ConfirmationStatus.REPORTED);
      assert.equal(after.completedAt, null);

      assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS').length, 0);
      assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.REPORTED').length, 1);
    });

    test('two independent channels reporting the SAME bank reference confirm the payment once', () => {
      const session = activeSession(merchantA, accountA, 'ORD-CORROBORATED', 49900n);

      const smsResult = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 49900n,
        bankReferenceNumber: 'UTR-CORROB-1'
      }));
      assert.equal(smsResult.outcomeStatus, 'REPORTED');

      const emailResult = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.GMAIL,
        amountPaise: 49900n,
        bankReferenceNumber: 'UTR-CORROB-1'
      }));

      assert.equal(emailResult.attributed, true);
      assert.equal(emailResult.outcomeStatus, PaymentStatus.SUCCESS);
      assert.equal(emailResult.confirmationStatus, ConfirmationStatus.BANK_CONFIRMED);

      const confirmed = sessionRepo.findById(session.id);
      assert.equal(confirmed.status, PaymentStatus.SUCCESS);
      assert.equal(confirmed.confirmationStatus, ConfirmationStatus.BANK_CONFIRMED);
      assert.ok(confirmed.completedAt);
      assert.ok(confirmed.confirmedAt);

      // Exactly ONE success event: corroboration upgrades did not re-fire success.
      const successEvents = emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS');
      assert.equal(successEvents.length, 1);
      assert.equal(successEvents[0].payload.paymentId, session.id);

      // Both channels are linked to the ONE ledger row for that bank credit.
      const ledger = db.query('SELECT * FROM bank_transaction_ledger WHERE bank_reference = ?', ['UTR-CORROB-1']);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].consumed_by_session_id, session.id);

      const linked = db.query(
        'SELECT DISTINCT source FROM payment_observations WHERE attributed_payment_id = ? AND bank_reference_number = ?',
        [session.id, 'UTR-CORROB-1']
      );
      assert.deepEqual(linked.map(r => r.source).sort(), ['GMAIL', 'SMS_GATEWAY']);
    });

    test('two channels that do NOT reference the same bank credit never confirm the payment', () => {
      const session = activeSession(merchantA, accountA, 'ORD-DIFFERENT-UTRS', 29900n);

      engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 29900n,
        bankReferenceNumber: 'UTR-ABC-1'
      }));

      const second = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.GMAIL,
        amountPaise: 29900n,
        bankReferenceNumber: 'UTR-ABC-2'
      }));

      assert.equal(second.attributed, true);
      assert.notEqual(second.outcomeStatus, PaymentStatus.SUCCESS);

      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.PROCESSING);
      assert.notEqual(after.confirmationStatus, ConfirmationStatus.BANK_CONFIRMED);
      assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS').length, 0);
    });

    test('an observation with no bank reference can never confirm a payment', () => {
      const session = activeSession(merchantA, accountA, 'ORD-NO-UTR', 12900n);

      for (const source of [ObserverSource.SMS_GATEWAY, ObserverSource.GMAIL, ObserverSource.GOOGLE_MESSAGES]) {
        const result = engine.processObservation(observation({
          accountId: accountA.id,
          source,
          amountPaise: 12900n
        }));
        assert.notEqual(result.outcomeStatus, PaymentStatus.SUCCESS);
      }

      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.PROCESSING);
      assert.notEqual(after.confirmationStatus, ConfirmationStatus.BANK_CONFIRMED);
    });

    test('a replayed bank reference cannot credit a second order', () => {
      const orderA = activeSession(merchantA, accountA, 'ORD-REPLAY-A', 19900n);
      const orderB = sessionRepo.create({
        merchantId: merchantA.id,
        receivingAccountId: accountA.id,
        orderId: 'ORD-REPLAY-B',
        amountPaise: 19900n
      });

      engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 19900n,
        bankReferenceNumber: 'UTR-REPLAY-1'
      }));
      const confirmedA = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.GMAIL,
        amountPaise: 19900n,
        bankReferenceNumber: 'UTR-REPLAY-1'
      }));
      assert.equal(confirmedA.outcomeStatus, PaymentStatus.SUCCESS);
      assert.equal(sessionRepo.findById(orderA.id).status, PaymentStatus.SUCCESS);

      // The same credit offered again resolves to the SAME already-confirmed order
      // (one bank transaction = one order), never to the second order.
      const replayed = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.GOOGLE_MESSAGES,
        amountPaise: 19900n,
        bankReferenceNumber: 'UTR-REPLAY-1'
      }));

      assert.equal(replayed.paymentSessionId, orderA.id);
      assert.equal(replayed.duplicate, true);
      assert.equal(replayed.outcomeStatus, ObservationAttributionStatus.DUPLICATE_IGNORED);
      assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS').length, 1);
      assert.notEqual(sessionRepo.findById(orderB.id).status, PaymentStatus.SUCCESS);
      assert.equal(
        db.query('SELECT COUNT(*) AS c FROM bank_transaction_ledger WHERE bank_reference = ?', ['UTR-REPLAY-1'])[0].c,
        1
      );
    });
  });

  describe('Tenant isolation (P0-09)', () => {
    test('an observation on one merchant account never credits another merchant active order', () => {
      // Merchant A has an ACTIVE order for the exact same amount.
      const orderA = activeSession(merchantA, accountA, 'ORD-TENANT-A', 49900n, { processing: false });

      // The credit is observed on merchant B's receiving account (no active order there).
      const result = engine.processObservation(observation({
        accountId: accountB.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 49900n,
        bankReferenceNumber: 'UTR-TENANT-B'
      }));

      assert.equal(result.attributed, false);
      assert.notEqual(result.paymentSessionId, orderA.id);
      assert.equal(result.outcomeStatus, ObservationAttributionStatus.UNATTRIBUTED);

      const afterA = sessionRepo.findById(orderA.id);
      assert.equal(afterA.status, PaymentStatus.ACTIVE);
      assert.equal(afterA.confirmationStatus, ConfirmationStatus.UNCONFIRMED);
      assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS').length, 0);
    });

    test('a forged targetSessionId for another tenant is ignored', () => {
      const orderA = activeSession(merchantA, accountA, 'ORD-FORGED-TARGET', 49900n, { processing: false });

      const forged = ObservationNormalizer.normalize({
        source: ObserverSource.SMS_GATEWAY,
        receivingAccountId: accountB.id,
        amountPaise: 49900n,
        bankReferenceNumber: 'UTR-FORGED-1',
        rawPayload: { text: 'synthetic', targetSessionId: orderA.id }
      });

      const result = engine.processObservation(forged);

      assert.equal(result.attributed, false);
      assert.equal(sessionRepo.findById(orderA.id).status, PaymentStatus.ACTIVE);
      assert.equal(
        db.query('SELECT COUNT(*) AS c FROM payment_observations WHERE attributed_payment_id = ?', [orderA.id])[0].c,
        0
      );
    });

    test('two orders with the same amount on different accounts are credited independently', () => {
      const orderA = activeSession(merchantA, accountA, 'ORD-AMOUNT-A', 49900n);
      const orderB = activeSession(merchantB, accountB, 'ORD-AMOUNT-B', 49900n);

      engine.processObservation(observation({
        accountId: accountB.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 49900n,
        bankReferenceNumber: 'UTR-PER-ACCOUNT'
      }));

      assert.equal(sessionRepo.findById(orderB.id).confirmationStatus, ConfirmationStatus.REPORTED);
      assert.equal(sessionRepo.findById(orderA.id).confirmationStatus, ConfirmationStatus.UNCONFIRMED);
      assert.equal(sessionRepo.findById(orderA.id).status, PaymentStatus.PROCESSING);
    });
  });

  describe('Terminal sessions & late observations', () => {
    test('an observed credit for an EXPIRED session becomes a reconciliation case, never SUCCESS', () => {
      const session = activeSession(merchantA, accountA, 'ORD-LATE-1', 34900n);
      sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);

      const observedAt = new Date(Date.now() - 60000);
      const result = engine.processObservation(observation({
        accountId: accountA.id,
        source: ObserverSource.GMAIL,
        amountPaise: 34900n,
        bankReferenceNumber: 'UTR-LATE-1',
        observedAt
      }));

      assert.notEqual(result.outcomeStatus, PaymentStatus.SUCCESS);
      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.FAILED);
      assert.notEqual(after.confirmationStatus, ConfirmationStatus.BANK_CONFIRMED);
      assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS').length, 0);

      const auditActions = db.query('SELECT action FROM audit_logs WHERE entity_id = ?', [session.id]).map(r => r.action);
      assert.ok(auditActions.some(a => a === 'LATE_OBSERVATION_DETECTED' || a === 'PAYMENT_OBSERVATION_REPORTED'));
    });
  });
});
