import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { PaymentStatus } from '@youpi/common';

// --- Test-harness credentials -------------------------------------------------
// The gateway now FAILS CLOSED: administrative and payment-management endpoints
// require a server-configured credential. Tests authenticate explicitly with the
// harness operator credential instead of relying on a removed dev fallback.
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const AUTH_HEADERS = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
/** fetch with the harness operator credential merged into the headers. */
const authFetch = (url, options = {}) => globalThis.fetch(url, {
  ...options,
  headers: { ...AUTH_HEADERS, ...(options.headers || {}) }
});
// ------------------------------------------------------------------------------


describe('Android Payment Observer Integration Tests', () => {
  let apiInstance;
  let driver;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6217, testDb);
    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      deviceName: 'Pixel 8 Pro Tester',
      deviceModel: 'Pixel 8 Pro'
    });
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  test('rejects pairing with invalid enrollment token', async () => {
    await assert.rejects(
      () => driver.pair('invalid_token_123'),
      /Device pairing failed/
    );
  });

  test('successfully pairs Android device with a single-use admin pairing challenge', async () => {
    // Preconditions (audit P0-05): enrollment requires a short-lived, single-use
    // challenge issued by the admin API. Static/predictable tokens are refused.
    const base = `http://localhost:${apiInstance.port}`;
    const qrRes = await authFetch(`${base}/api/v1/admin/sms-gateway/pair-qr`);
    assert.equal(qrRes.status, 200);
    const qr = await qrRes.json();
    assert.ok(qr.enrollmentToken);

    const pairResult = await driver.pair(qr.enrollmentToken);
    assert.ok(pairResult.paired);
    assert.ok(pairResult.deviceId);
    assert.ok(pairResult.signingKey);
    assert.equal(driver.deviceId, pairResult.deviceId);
    assert.equal(driver.signingKey, pairResult.signingKey);

    // The static legacy enrollment secret must no longer work.
    const legacySecret = process.env.ANDROID_ENROLLMENT_SECRET || 'android_pairing_enrollment_secret_key_32_chars';
    await assert.rejects(() => driver.pair(legacySecret), /Device pairing failed/);
  });

  test('revokes outstanding pairing tokens and audits consumption/revocation without storing the token', async () => {
    const base = `http://localhost:${apiInstance.port}`;

    // A fresh challenge, as if a QR had been screenshotted or leaked.
    const qrRes = await authFetch(`${base}/api/v1/admin/sms-gateway/pair-qr`);
    assert.equal(qrRes.status, 200);
    const qr = await qrRes.json();

    const revokeRes = await authFetch(`${base}/api/v1/admin/sms-gateway/pairing-tokens/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: qr.payload.merchantId })
    });
    assert.equal(revokeRes.status, 200);
    const revokeBody = await revokeRes.json();
    assert.ok(revokeBody.revoked >= 1, 'the outstanding challenge must be revoked');

    const freshDriver = new AndroidObserverDriver({ apiBaseUrl: base, deviceName: 'Revocation Test Phone' });
    await assert.rejects(
      () => freshDriver.pair(qr.enrollmentToken),
      /Device pairing failed/,
      'a revoked challenge must not enroll a device'
    );

    const auditRows = testDb.query(
      "SELECT action, details FROM audit_logs WHERE action IN ('SMS_GATEWAY_PAIRING_TOKEN_REDEEMED', 'SMS_GATEWAY_PAIRING_TOKENS_REVOKED')"
    );
    assert.ok(auditRows.some(row => row.action === 'SMS_GATEWAY_PAIRING_TOKEN_REDEEMED'));
    assert.ok(auditRows.some(row => row.action === 'SMS_GATEWAY_PAIRING_TOKENS_REVOKED'));
    // Audit rows carry the challenge id, never the bearer token itself.
    assert.equal(JSON.stringify(auditRows).includes(qr.enrollmentToken), false);
  });

  test('sends heartbeat acknowledging liveness', async () => {
    const hbResult = await driver.sendHeartbeat();
    assert.equal(hbResult.status, 'HEARTBEAT_ACK');
    assert.ok(hbResult.timestamp);
  });

  test('rejects observation with expired/drifted timestamp (Replay Protection)', async () => {
    // Timestamp 2 minutes in the past (> 60s drift)
    const oldTimestamp = Date.now() - 120000;
    const res = await driver.submitObservation({
      amount: '200.00',
      timestampOverride: oldTimestamp
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error.includes('validity window'));
  });

  test('submits valid HMAC-signed observation, records REPORTED evidence, and does not finalize the payment alone', async () => {
    // 1. Create and activate a payment session for ₹350
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-ORD-350',
      amountPaise: 35000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    // 2. Android observer submits observation for ₹350
    const res = await driver.submitObservation({
      amount: '350.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-ANDR-9876',
      senderVpa: 'customer@paytm',
      notificationText: 'Payment of ₹350 received from customer@paytm on PhonePe'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);
    // A single signed observation is evidence (REPORTED): it never finalizes a
    // payment without independent bank-credit verification (audit P1-01 / Gate B).
    assert.equal(res.body.attribution.outcomeStatus, 'REPORTED');

    // 3. Verify session in DB stays pending with REPORTED confirmation provenance
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.PROCESSING);
    assert.equal(updated.confirmationStatus, 'REPORTED');
  });
});
