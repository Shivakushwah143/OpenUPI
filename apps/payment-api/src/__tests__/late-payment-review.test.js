import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { AndroidObserverDriver } from '../../../android-observer-app/driver.js';
import { PaymentStatus, ConfirmationStatus } from '@youpi/common';

process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };

const DEFAULT_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

describe('Late / unreferenced bank credits — reconciliation review queue', () => {
  let apiInstance;
  let driver;
  let testDb;
  let baseUrl;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6233, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
    driver = new AndroidObserverDriver({ apiBaseUrl: baseUrl, deviceName: 'Late-Credit Test Phone' });

    const qr = await (await fetch(`${baseUrl}/api/v1/admin/sms-gateway/pair-qr`, { headers: ADMIN_HEADERS })).json();
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
    try { body = await res.json(); } catch { /* empty body allowed */ }
    return { status: res.status, body };
  }

  function createSession(amountPaise, orderId, { merchantId = DEFAULT_MERCHANT_ID, accountId = DEFAULT_ACCOUNT_ID, markDone = true } = {}) {
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId,
      receivingAccountId: accountId,
      orderId,
      amountPaise: BigInt(amountPaise)
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, accountId);
    if (markDone) apiInstance.app.context.timingEngine.handlePaymentDone(session.id);
    return session;
  }

  test('a credit arriving after checkout expiry is queued for review, never lost or settled', async () => {
    const session = createSession(5000n, 'LATE-REVIEW-50');
    apiInstance.app.context.sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);

    // Paytm-style notification with no UTR (the weakest but realistic evidence).
    const obs = await driver.submitObservation({
      amount: '50.00',
      notificationText: '₹50 received from Rahul Sharma (rahul@paytm)'
    });
    assert.equal(obs.status, 200);
    assert.equal(obs.body.attribution.outcomeStatus, 'LATE_UNMATCHED');

    // Terminal invariant: the failed session stays failed and unconfirmed.
    const afterObs = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(afterObs.status, PaymentStatus.FAILED);
    assert.notEqual(afterObs.confirmationStatus, ConfirmationStatus.BANK_CONFIRMED);

    // The credit is durably reviewable, even without a customer account.
    const listed = await request('/api/v1/admin/reconciliation-cases?status=OPEN');
    assert.equal(listed.status, 200);
    const reviewCase = listed.body.cases.find(c => c.paymentSessionId === session.id);
    assert.ok(reviewCase, 'late credit must open a reconciliation case');
    assert.equal(reviewCase.reason, 'LATE_AFTER_TERMINAL');
    assert.equal(reviewCase.amountPaise, '5000');
    assert.equal(reviewCase.bankReference, null);
    assert.equal(reviewCase.status, 'OPEN');

    // Review queue is credential-protected.
    assert.equal((await fetch(`${baseUrl}/api/v1/admin/reconciliation-cases`)).status, 401);

    // Resolving the case records an operator decision but changes no payment.
    const resolved = await request(`/api/v1/admin/reconciliation-cases/${reviewCase.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note: 'Refunded manually after bank statement check' })
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.case.status, 'RESOLVED');
    assert.equal(apiInstance.app.context.sessionRepo.findById(session.id).status, PaymentStatus.FAILED);

    // A terminal session still cannot be settled by a late confirmation.
    const confirm = await request('/api/v1/admin/bank-confirmations', {
      method: 'POST',
      body: JSON.stringify({
        receivingAccountId: DEFAULT_ACCOUNT_ID,
        bankReferenceNumber: 'LATE-UTR-5000',
        amountPaise: 5000,
        source: 'MANUAL_OPERATOR'
      })
    });
    assert.equal(confirm.status, 202);
    assert.equal(confirm.body.confirmed, false);
    assert.equal(apiInstance.app.context.sessionRepo.findById(session.id).status, PaymentStatus.FAILED);
  });

  test('an unreferenced notification cannot mark another tenant\'s order as paid', async () => {
    // Other tenant with its own receiving account and an ACTIVE order of the SAME amount.
    const otherMerchantId = '00000000-0000-0000-0000-0000000000c2';
    const otherAccountId = '00000000-0000-0000-0000-0000000000c3';
    testDb.execute(
      'INSERT INTO merchants (id, business_name, slug, contact_email, contact_phone, webhook_secret, api_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [otherMerchantId, 'Other Tenant', 'other-tenant-late', 'other-late@example.com', '+910000000001', 'whsec_other_late', 'other_late_api_key']
    );
    testDb.execute(
      'INSERT INTO payment_receiving_accounts (id, merchant_id, upi_id, payee_name) VALUES (?, ?, ?, ?)',
      [otherAccountId, otherMerchantId, 'otherlate@upi', 'Other Tenant']
    );
    const otherSession = createSession(7500n, 'OTHER-75', {
      merchantId: otherMerchantId,
      accountId: otherAccountId,
      markDone: false
    });

    // Our own live order for the same amount on OUR account.
    const ownSession = createSession(7500n, 'OWN-75', { markDone: false });

    // Notification with no UTR, observed on our receiving account.
    const obs = await driver.submitObservation({
      amount: '75.00',
      notificationText: '₹75 received from Rahul Sharma (rahul@paytm)'
    });
    assert.equal(obs.status, 200);
    assert.equal(obs.body.attribution.paymentSessionId, ownSession.id);

    const untouched = apiInstance.app.context.sessionRepo.findById(otherSession.id);
    assert.equal(untouched.status, PaymentStatus.ACTIVE);
    assert.equal(untouched.confirmationStatus, ConfirmationStatus.UNCONFIRMED);
    assert.equal(untouched.verificationSources.length, 0);

    const own = apiInstance.app.context.sessionRepo.findById(ownSession.id);
    assert.equal(own.confirmationStatus, ConfirmationStatus.REPORTED);
    assert.notEqual(own.status, PaymentStatus.SUCCESS);

    // Naming another tenant's account outright is refused.
    const cross = await driver.submitObservation({
      amount: '75.00',
      receivingAccountId: otherAccountId,
      notificationText: '₹75 received from Rahul Sharma'
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.reason, 'CROSS_TENANT_ACCOUNT');

    apiInstance.app.context.sessionRepo.transitionToTerminal(ownSession.id, PaymentStatus.CANCELLED);
    apiInstance.app.context.sessionRepo.transitionToTerminal(otherSession.id, PaymentStatus.CANCELLED);
  });
});
