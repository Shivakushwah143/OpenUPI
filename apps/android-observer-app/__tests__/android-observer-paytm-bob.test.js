import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { BankSmsParser } from '@youpi/core';
import { PaymentStatus, ConfirmationStatus } from '@youpi/common';

// Harness credentials: the gateway fails closed, so tests authenticate explicitly.
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };

const DEFAULT_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

describe('Android observer — Paytm / Bank of Baroda readiness', () => {
  let apiInstance;
  let driver;
  let testDb;
  let baseUrl;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6231, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
    driver = new AndroidObserverDriver({ apiBaseUrl: baseUrl, deviceName: 'Paytm/BoB Test Phone' });

    const qrRes = await fetch(`${baseUrl}/api/v1/admin/sms-gateway/pair-qr`, { headers: ADMIN_HEADERS });
    const qr = await qrRes.json();
    await driver.pair(qr.enrollmentToken);
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS, ...(options.headers || {}) }
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty body is fine */ }
    return { status: res.status, body };
  }

  function createActiveSession(amountPaise, orderId, merchantId = DEFAULT_MERCHANT_ID, accountId = DEFAULT_ACCOUNT_ID, markDone = true) {
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId,
      receivingAccountId: accountId,
      orderId,
      amountPaise: BigInt(amountPaise)
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, accountId);
    if (markDone) {
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);
    }
    return session;
  }

  /** Frees the receiving-account slot so the next test starts ACTIVE, not QUEUED. */
  function expireSession(sessionId) {
    try {
      const session = apiInstance.app.context.sessionRepo.findById(sessionId);
      apiInstance.app.context.sessionRepo.transitionToTerminal(
        sessionId,
        session?.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED
      );
    } catch { /* already terminal */ }
  }

  describe('Bank SMS parser — Paytm and Bank of Baroda credit direction', () => {
    test('parses Bank of Baroda credit SMS with Ref No', () => {
      const parsed = BankSmsParser.parse({
        text: 'Dear Customer, Your A/c XX1234 has been credited with Rs.10.00 on 18-10-2026 by UPI Ref No 615234987123. -Bank of Baroda',
        sender: 'VK-BOBUPI'
      });
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 1000n);
      assert.equal(parsed.bankReferenceNumber, '615234987123');
    });

    test('parses Bank of Baroda "Cr" shorthand credit SMS', () => {
      const parsed = BankSmsParser.parse({
        text: 'Rs.10.50 Cr in A/c XX1234 on 18-10-26 UPI/P2M/615234987999/Rahul',
        sender: 'VK-BOBUPI'
      });
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 1050n);
      assert.equal(parsed.bankReferenceNumber, '615234987999');
    });

    test('parses Paytm Payments Bank credit SMS', () => {
      const parsed = BankSmsParser.parse({
        text: 'Rs.10.00 credited to your Paytm Payments Bank A/c XX1234 on 18-10-26. UPI Ref 615234987124.',
        sender: 'VK-PAYTMB'
      });
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 1000n);
      assert.equal(parsed.bankReferenceNumber, '615234987124');
    });

    test('parses Paytm P2P app credit notification text', () => {
      const parsed = BankSmsParser.parse({ text: '₹10 received from Rahul Sharma' });
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 1000n);
    });

    test('refuses Bank of Baroda debit SMS even when it mentions UPI', () => {
      const parsed = BankSmsParser.parse({
        text: 'Rs.10.00 debited from A/c XX1234 on 18-10-26 UPI Ref 615234987123 to rahul@paytm',
        sender: 'VK-BOBUPI'
      });
      assert.equal(parsed, null);
    });
  });

  test('heartbeat must be HMAC-signed like observations (APK compatibility)', async () => {
    const unsigned = await request('/api/v1/pollers/android/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ deviceId: driver.deviceId, timestamp: Date.now() })
    });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body.reason, 'MISSING_SIGNATURE_HEADERS');

    const signed = await driver.sendHeartbeat();
    assert.equal(signed.status, 'HEARTBEAT_ACK');
  });

  test('pairing pins the receiving account so observations target that account', async () => {
    assert.equal(driver.receivingAccountId, DEFAULT_ACCOUNT_ID);
  });

  test('Paytm ₹10 observation flips checkout to PAYMENT_DETECTED without settling it', async () => {
    const session = createActiveSession(1000n, 'PAYTM-ORD-10');

    const res = await driver.submitObservation({
      amount: '10.00',
      utr: 'PAYTM-UTR-10A',
      senderVpa: 'rahul@paytm',
      notificationText: '₹10 received from Rahul Sharma (rahul@paytm)'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);

    const stored = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(stored.status, PaymentStatus.PROCESSING);
    assert.equal(stored.confirmationStatus, ConfirmationStatus.REPORTED);

    const state = await request(`/api/v1/checkout/${session.id}/state`);
    assert.equal(state.status, 200);
    assert.equal(state.body.paymentDetected, true);
    assert.equal(state.body.confirmationStatus, ConfirmationStatus.REPORTED);
    assert.notEqual(state.body.status, PaymentStatus.SUCCESS);

    expireSession(session.id);
  });

  test('Bank of Baroda ₹10.50 SMS observation is evidence only, never SUCCESS', async () => {
    const session = createActiveSession(1050n, 'BOB-ORD-1050');

    const res = await driver.submitObservation({
      amount: '10.50',
      notificationText: 'Dear Customer, Your A/c XX1234 has been credited with Rs.10.50 on 18-10-2026 by UPI Ref No 615234987999. -Bank of Baroda'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);
    assert.equal(res.body.attribution.outcomeStatus, 'REPORTED');

    const stored = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(stored.status, PaymentStatus.PROCESSING);
    assert.equal(stored.confirmationStatus, ConfirmationStatus.REPORTED);
    // Ingest through the pipeline records the SMS_GATEWAY channel; the pre-parsed
    // notification path records ANDROID_OBSERVER. Either way it is evidence only.
    assert.ok(
      stored.verificationSources.includes('SMS_GATEWAY') ||
      stored.verificationSources.includes('ANDROID_OBSERVER')
    );

    expireSession(session.id);
  });

  test('signed device cannot attribute across tenants (account or session hint)', async () => {
    // Second tenant + own receiving account + own active order.
    const otherMerchantId = '00000000-0000-0000-0000-0000000000b2';
    const otherAccountId = '00000000-0000-0000-0000-0000000000b3';
    testDb.execute(
      'INSERT INTO merchants (id, business_name, slug, contact_email, contact_phone, webhook_secret, api_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [otherMerchantId, 'Other Tenant', 'other-tenant', 'other@example.com', '+910000000000', 'whsec_other', 'other_api_key']
    );
    testDb.execute(
      'INSERT INTO payment_receiving_accounts (id, merchant_id, upi_id, payee_name) VALUES (?, ?, ?, ?)',
      [otherAccountId, otherMerchantId, 'othertenant@upi', 'Other Tenant']
    );
    const otherSession = createActiveSession(77700n, 'XT-ORD-777', otherMerchantId, otherAccountId, false);

    // (a) Explicitly naming another merchant's account is refused outright.
    const crossAccount = await driver.submitObservation({
      amount: '777.00',
      receivingAccountId: otherAccountId,
      utr: 'XT-UTR-777',
      notificationText: 'Rs.777.00 credited UPI Ref XT-UTR-777'
    });
    assert.equal(crossAccount.status, 403);
    assert.equal(crossAccount.body.reason, 'CROSS_TENANT_ACCOUNT');

    // (b) A body-supplied session id from another tenant is ignored, not honoured.
    const crossSession = await driver.submitObservation({
      amount: '777.00',
      paymentSessionId: otherSession.id,
      utr: 'XT-UTR-778',
      notificationText: 'Rs.777.00 credited UPI Ref XT-UTR-778'
    });
    assert.equal(crossSession.status, 200);
    assert.notEqual(crossSession.body.attribution?.paymentSessionId, otherSession.id);

    const untouched = apiInstance.app.context.sessionRepo.findById(otherSession.id);
    assert.equal(untouched.status, PaymentStatus.ACTIVE);
    assert.equal(untouched.confirmationStatus, ConfirmationStatus.UNCONFIRMED);
  });
});
