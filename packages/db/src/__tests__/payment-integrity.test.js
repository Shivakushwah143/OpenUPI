import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  PaymentSessionRepository
} from '../index.js';
import { PaymentStatus, ConfirmationStatus } from '@youpi/common';

/**
 * Regression suite for the payment-state and transaction-integrity remediation
 * (audit P0-08 atomic transitions, P1-02 unique bank-reference attribution).
 * Uses local in-memory SQLite and synthetic data only.
 */
describe('Payment State & Transaction Integrity', () => {
  let db;
  let merchantRepo;
  let accountRepo;
  let sessionRepo;
  let merchant;
  let account;

  beforeEach(() => {
    db = new Database({ inMemory: true });
    const seed = runMigrations(db);
    merchant = seed.defaultMerchant;

    merchantRepo = new MerchantRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    account = accountRepo.findActiveForMerchant(merchant.id);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Creates a session and, when `activate` is true, acquires the (single) receiving-account
   * slot and moves it to PROCESSING. Only one session per account can be ACTIVE/PROCESSING.
   */
  function createSession(orderId, amountPaise = 49900n, { activate = true, accountId = account.id, merchantId = merchant.id } = {}) {
    const session = sessionRepo.create({
      merchantId,
      receivingAccountId: accountId,
      orderId,
      amountPaise
    });
    if (activate && accountId) {
      sessionRepo.acquireSlotAtomic(session.id, accountId, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);
    }
    return sessionRepo.findById(session.id);
  }

  const createProcessingSession = (orderId, amountPaise, accountId, merchantId) =>
    createSession(orderId, amountPaise, {
      activate: true,
      ...(accountId ? { accountId } : {}),
      ...(merchantId ? { merchantId } : {})
    });

  describe('Atomic state transitions (P0-08)', () => {
    test('transitionToTerminal can never produce SUCCESS', () => {
      const session = createProcessingSession('ORD-SUCCESS-BYPASS');

      assert.throws(
        () => sessionRepo.transitionToTerminal(session.id, PaymentStatus.SUCCESS),
        /SUCCESS cannot be reached via transitionToTerminal/
      );

      // No partial write: the payment is still PROCESSING and not completed.
      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.PROCESSING);
      assert.equal(after.completedAt, null);
    });

    test('terminal states are final and can never be reopened', () => {
      const session = createProcessingSession('ORD-TERMINAL-FINAL');
      sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);

      assert.throws(
        () => sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED),
        /Terminal states cannot be reopened/
      );
      assert.throws(
        () => sessionRepo.confirmPaymentSuccess(session.id, { allowFromTerminal: false }),
        /Cannot move from 'FAILED'/
      );

      assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.FAILED);
    });

    test('confirmation is refused for a session that is not ACTIVE/PROCESSING', () => {
      const session = sessionRepo.create({
        merchantId: merchant.id,
        receivingAccountId: account.id,
        orderId: 'ORD-NOT-ELIGIBLE',
        amountPaise: 19900n
      });

      // INITIATED (slot not acquired yet) is not confirmable by ordinary confirmation.
      assert.throws(
        () => sessionRepo.confirmPaymentSuccess(session.id),
        /Cannot move from 'INITIATED' to 'SUCCESS' via confirmation/
      );
      assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.INITIATED);
    });

    test('confirmPaymentSuccess is idempotent and writes the SUCCESS outbox row atomically', () => {
      const session = createProcessingSession('ORD-CONFIRM-ONCE');

      const first = sessionRepo.confirmPaymentSuccess(session.id, {
        confirmationStatus: ConfirmationStatus.COUNTER_CONFIRMED,
        operatorId: 'operator-1'
      });
      assert.equal(first.confirmed, true);
      assert.equal(first.session.status, PaymentStatus.SUCCESS);
      assert.equal(first.session.confirmationStatus, ConfirmationStatus.COUNTER_CONFIRMED);
      assert.equal(first.session.confirmedBy, 'operator-1');

      const second = sessionRepo.confirmPaymentSuccess(session.id);
      assert.equal(second.confirmed, false);
      assert.equal(second.alreadyConfirmed, true);

      const outbox = db.query(
        "SELECT * FROM payment_events_outbox WHERE payment_id = ? AND event = 'SUCCESS'",
        [session.id]
      );
      assert.equal(outbox.length, 1);
      assert.equal(Number(outbox[0].flushed), 0);

      // The receiving-account slot is released by the confirmation itself.
      const acct = accountRepo.findById(account.id);
      assert.equal(acct.isSlotBusy, false);
      assert.equal(acct.currentActiveSessionId, null);
    });
  });

  describe('Canonical bank-transaction ledger (P1-02)', () => {
    test('one bank reference can only ever be consumed by one order', () => {
      const orderA = createProcessingSession('ORD-A', 49900n);
      const orderB = createSession('ORD-B', 49900n, { activate: false });

      const first = sessionRepo.recordVerificationSource(orderA.id, 'SMS_GATEWAY', 'obs-a', {
        bankReferenceNumber: 'UTR-UNIQUE-1',
        amountPaise: 49900n
      });
      assert.equal(first.reported, true);

      const ledger = db.query('SELECT * FROM bank_transaction_ledger WHERE bank_reference = ?', ['UTR-UNIQUE-1']);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].consumed_by_session_id, orderA.id);

      // The same UTR claimed for a second order is refused atomically.
      assert.throws(
        () => sessionRepo.recordVerificationSource(orderB.id, 'GMAIL', 'obs-b', {
          bankReferenceNumber: 'UTR-UNIQUE-1',
          amountPaise: 49900n
        }),
        /LEDGER_RESERVATION_FAILED:DUPLICATE_TRANSACTION/
      );

      // Order B keeps no evidence of that bank reference: nothing was written.
      const orderBAfter = sessionRepo.findById(orderB.id);
      assert.equal(orderBAfter.status, PaymentStatus.INITIATED);
      assert.equal(orderBAfter.confirmationStatus, ConfirmationStatus.UNCONFIRMED);
      assert.equal(
        db.query('SELECT * FROM bank_transaction_ledger WHERE consumed_by_session_id = ?', [orderB.id]).length,
        0
      );
    });

    test('the same reference with a materially different amount is refused', () => {
      const orderA = createProcessingSession('ORD-AMOUNT-A', 49900n);
      const orderB = createSession('ORD-AMOUNT-B', 19900n, { activate: false });

      sessionRepo.recordVerificationSource(orderA.id, 'SMS_GATEWAY', 'obs-amount-a', {
        bankReferenceNumber: 'UTR-AMOUNT-1',
        amountPaise: 49900n
      });

      assert.throws(
        () => sessionRepo.recordVerificationSource(orderB.id, 'SMS_GATEWAY', 'obs-amount-b', {
          bankReferenceNumber: 'UTR-AMOUNT-1',
          amountPaise: 19900n
        }),
        /LEDGER_RESERVATION_FAILED:UTR_AMOUNT_CONFLICT/
      );
    });

    test('the ledger is scoped per receiving account: the same UTR on a different bank account is a different credit', () => {
      const otherMerchant = merchantRepo.create({
        businessName: 'Second Store',
        slug: 'second-store',
        contactEmail: 'second@example.com',
        contactPhone: '9000000002'
      });
      const otherAccount = accountRepo.create({
        merchantId: otherMerchant.id,
        upiId: 'secondstore@upi',
        payeeName: 'Second Store',
        isActive: true
      });

      const orderA = createProcessingSession('ORD-SCOPE-A', 49900n);
      const orderB = createProcessingSession('ORD-SCOPE-B', 49900n, otherAccount.id, otherMerchant.id);

      sessionRepo.recordVerificationSource(orderA.id, 'SMS_GATEWAY', 'obs-scope-a', {
        bankReferenceNumber: 'UTR-SHARED',
        amountPaise: 49900n
      });
      sessionRepo.recordVerificationSource(orderB.id, 'SMS_GATEWAY', 'obs-scope-b', {
        bankReferenceNumber: 'UTR-SHARED',
        amountPaise: 49900n
      });

      const rows = db.query('SELECT receiving_account_id FROM bank_transaction_ledger WHERE bank_reference = ?', ['UTR-SHARED']);
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map(r => r.receiving_account_id).sort(),
        [account.id, otherAccount.id].sort()
      );
    });

    test('an operator-supplied UTR already consumed elsewhere rolls the whole confirmation back', () => {
      const orderA = createProcessingSession('ORD-OP-A', 75000n);
      const orderB = createSession('ORD-OP-B', 75000n, { activate: false });

      sessionRepo.recordVerificationSource(orderA.id, 'SMS_GATEWAY', 'obs-op-a', {
        bankReferenceNumber: 'UTR-OPERATOR-1',
        amountPaise: 75000n
      });

      // Order A ends unsuccessfully, which frees the slot for order B.
      sessionRepo.transitionToTerminal(orderA.id, PaymentStatus.FAILED);
      sessionRepo.acquireSlotAtomic(orderB.id, account.id, 300000);
      assert.equal(sessionRepo.findById(orderB.id).status, PaymentStatus.ACTIVE);

      assert.throws(
        () => sessionRepo.confirmPaymentSuccess(orderB.id, {
          bankReferenceNumber: 'UTR-OPERATOR-1',
          allowFromStatuses: [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]
        }),
        /LEDGER_CONFLICT:DUPLICATE_TRANSACTION/
      );

      // Atomic rollback: order B was NOT partially confirmed.
      const orderBAfter = sessionRepo.findById(orderB.id);
      assert.equal(orderBAfter.status, PaymentStatus.ACTIVE);
      assert.equal(orderBAfter.confirmationStatus, ConfirmationStatus.UNCONFIRMED);
      assert.equal(orderBAfter.confirmedAt, null);
    });

    test('observations never change status: a report holds the session for review', () => {
      const session = createProcessingSession('ORD-REPORT-HOLD', 64000n);

      const result = sessionRepo.recordVerificationSource(session.id, 'GOOGLE_MESSAGES', 'obs-report-1', {
        bankReferenceNumber: 'UTR-REPORT-1',
        amountPaise: 64000n
      });

      assert.equal(result.reported, true);
      assert.equal(result.isFirstSuccess, false);

      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.PROCESSING);
      assert.equal(after.confirmationStatus, ConfirmationStatus.REPORTED);
      assert.equal(after.completedAt, null);
      assert.equal(after.verificationLevel, 1);
    });

    test('a FAILED/EXPIRED session cannot be turned into SUCCESS by observation intake', () => {
      const session = createProcessingSession('ORD-TERMINAL-OBS', 31000n);
      sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);

      const result = sessionRepo.recordVerificationSource(session.id, 'GMAIL', 'obs-terminal-1', {
        bankReferenceNumber: 'UTR-TERMINAL-1',
        amountPaise: 31000n
      });

      assert.equal(result.reported, false);
      const after = sessionRepo.findById(session.id);
      assert.equal(after.status, PaymentStatus.FAILED);
      assert.ok(after.completedAt);
    });
  });
});
