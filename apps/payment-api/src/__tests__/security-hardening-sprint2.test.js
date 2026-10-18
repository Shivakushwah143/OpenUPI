import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Database, runMigrations } from '@youpi/db';
import { MerchantRepository, ReceivingAccountRepository } from '@youpi/db';
import { PaymentStatus, signObserverRequest, openSecret } from '@youpi/common';
import { validateWebhookDestination } from '@youpi/core';
import { startServer } from '../index.js';
import { enforceSecureTransport } from '../services/api-auth.js';

/**
 * Reliability / observer-hardening sprint (audit P1-04..P1-06 plus the
 * follow-up items): dedicated observer credentials, secrets at rest, fail-closed
 * authentication, scoped checkout credentials, authoritative bank confirmation and
 * webhook destination validation.
 */

const ADMIN_KEY = 'admin_test_key_sprint2';

describe('Security Sprint — observer credentials, secrets at rest, checkout scoping, bank confirmation', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let merchantA;
  let merchantB;
  let accountA;
  let accountB;
  let observerA;
  let observerB;

  const admin = { 'X-Admin-Key': ADMIN_KEY };

  function request(path, options = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body
    }).then(async res => {
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, headers: res.headers, body, text };
    });
  }

  async function issueObserverCredential(merchantId) {
    const res = await request('/api/v1/admin/observers/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ merchantId, label: 'sprint-2 suite' })
    });
    assert.equal(res.status, 201);
    return { id: res.body.id, keyId: res.body.keyId, secret: res.body.secret, merchantId };
  }

  before(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    testDb = new Database({ inMemory: true });
    runMigrations(testDb);

    const merchantRepo = new MerchantRepository(testDb);
    const accountRepo = new ReceivingAccountRepository(testDb);

    merchantA = merchantRepo.create({
      businessName: 'Sprint Tenant A',
      slug: 'sprint-tenant-a',
      contactEmail: 'a@sprint.test',
      contactPhone: '+919000000031',
      webhookUrl: 'https://a.sprint.test/webhook',
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      apiKey: crypto.randomBytes(32).toString('hex')
    });
    accountA = accountRepo.create({
      merchantId: merchantA.id,
      upiId: 'sprint-a@bank',
      payeeName: 'Sprint A',
      isMerchantEnabled: true,
      isActive: true
    });

    merchantB = merchantRepo.create({
      businessName: 'Sprint Tenant B',
      slug: 'sprint-tenant-b',
      contactEmail: 'b@sprint.test',
      contactPhone: '+919000000032',
      webhookUrl: 'https://b.sprint.test/webhook',
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      apiKey: crypto.randomBytes(32).toString('hex')
    });
    accountB = accountRepo.create({
      merchantId: merchantB.id,
      upiId: 'sprint-b@bank',
      payeeName: 'Sprint B',
      isMerchantEnabled: true,
      isActive: true
    });

    apiInstance = await startServer(6195, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
    observerA = await issueObserverCredential(merchantA.id);
    observerB = await issueObserverCredential(merchantB.id);
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
    delete process.env.ADMIN_API_KEY;
  });

  test('observation ingest accepts only dedicated observer credentials, never merchant or admin API keys', async () => {
    const path = '/api/v1/pollers/events';
    const payload = {
      source: 'SMS_GATEWAY',
      receivingAccountId: accountA.id,
      amountPaise: '100',
      bankReferenceNumber: 'UTR-KEY-SEPARATION',
      rawText: 'Rs.1 credited Ref UTR-KEY-SEPARATION'
    };
    const rawBody = JSON.stringify(payload);

    for (const credential of [merchantA.apiKey, ADMIN_KEY]) {
      const res = await request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signObserverRequest({ keyId: credential, secret: credential, method: 'POST', path, rawBody })
        },
        body: rawBody
      });
      assert.equal(res.status, 401, 'non-observer credentials must never authenticate observation ingest');
    }

    const accepted = await request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signObserverRequest({ ...observerA, method: 'POST', path, rawBody })
      },
      body: rawBody
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.accepted, true);
  });

  test('observer credential secrets are sealed at rest; rotation and revocation take effect immediately', async () => {
    const row = testDb.queryOne('SELECT * FROM observer_credentials WHERE id = ?', [observerA.id]);
    assert.ok(row.secret_enc.startsWith('enc:v1:'), 'observer secret must be sealed at rest');
    assert.equal(row.secret_enc.includes(observerA.secret), false);
    assert.equal(openSecret(row.secret_enc), observerA.secret);

    const path = '/api/v1/pollers/active-window';
    const signedGet = credential => request(path, {
      headers: { ...signObserverRequest({ keyId: credential.keyId, secret: credential.secret, method: 'GET', path, rawBody: '' }) }
    });
    assert.equal((await signedGet(observerA)).status, 200);

    const rotated = await request(`/api/v1/admin/observers/credentials/${observerA.id}/rotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...admin }, body: '{}'
    });
    assert.equal(rotated.status, 200);
    const rotatedCredential = { id: rotated.body.id, keyId: rotated.body.keyId, secret: rotated.body.secret };
    assert.equal((await signedGet(observerA)).status, 401, 'the rotated-away credential must stop working');
    assert.equal((await signedGet(rotatedCredential)).status, 200);

    const revoked = await request(`/api/v1/admin/observers/credentials/${rotatedCredential.id}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...admin }, body: '{}'
    });
    assert.equal(revoked.status, 200);
    assert.equal((await signedGet(rotatedCredential)).status, 401);

    observerA = await issueObserverCredential(merchantA.id);
  });

  test('device signing keys are sealed at rest while paired devices keep authenticating', async () => {
    const qr = await request('/api/v1/admin/sms-gateway/pair-qr', { headers: admin });
    assert.equal(qr.status, 200);

    const paired = await request('/api/v1/pollers/android/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: qr.body.enrollmentToken, deviceName: 'Sealed Key Phone' })
    });
    assert.equal(paired.status, 200);
    const signingKey = paired.body.signingKey;

    const stored = testDb.queryOne('SELECT signing_key_hash FROM android_devices WHERE id = ?', [paired.body.deviceId]);
    assert.ok(stored.signing_key_hash.startsWith('enc:v1:'), 'device signing key must be sealed at rest');
    assert.equal(stored.signing_key_hash.includes(signingKey), false);
    assert.equal(openSecret(stored.signing_key_hash), signingKey);

    const body = JSON.stringify({ deviceId: paired.body.deviceId });
    const timestamp = String(Date.now());
    const signature = crypto.createHmac('sha256', signingKey).update(`${body}:${timestamp}`).digest('hex');
    const heartbeat = await request('/api/v1/pollers/android/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': paired.body.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body
    });
    assert.equal(heartbeat.status, 200);
  });

  test('fail closed: anonymous payment creation is refused and TLS is required in production', async () => {
    const created = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: `SPRINT-ANON-${Date.now()}`, amount: '5.00' })
    });
    assert.equal(created.status, 401);

    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const fakeRes = { writeHead() {}, end() {} };
      assert.equal(enforceSecureTransport({ headers: {}, socket: {} }, fakeRes), false);
      assert.equal(enforceSecureTransport({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }, fakeRes), true);
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  test('payment-status polling requires a scoped, expiring checkout credential', async () => {
    const created = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ orderId: `SPRINT-CHECKOUT-${Date.now()}`, amount: '42.00', merchantId: merchantA.id, autoActivate: true })
    });
    assert.equal(created.status, 201);
    const { paymentId, checkoutToken, checkoutUrl } = created.body;
    assert.ok(checkoutToken && checkoutToken.length >= 32);
    assert.ok(checkoutUrl.includes(`t=${encodeURIComponent(checkoutToken)}`));

    const stored = testDb.queryOne('SELECT checkout_token_hash FROM payment_sessions WHERE id = ?', [paymentId]);
    assert.ok(stored.checkout_token_hash);
    assert.equal(stored.checkout_token_hash.includes(checkoutToken), false, 'only the token hash is stored');

    assert.equal((await request(`/api/v1/payments/${paymentId}`)).status, 401);
    assert.equal((await request(`/api/v1/payments/${paymentId}`, { headers: { 'X-Checkout-Token': 'wrong' } })).status, 401);
    assert.equal((await request(`/api/v1/checkout/${paymentId}/state`)).status, 401);

    const scoped = await request(`/api/v1/payments/${paymentId}?t=${encodeURIComponent(checkoutToken)}`);
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.paymentId, paymentId);

    const stateWithToken = await request(`/api/v1/checkout/${paymentId}/state?t=${encodeURIComponent(checkoutToken)}`);
    assert.equal(stateWithToken.status, 200);

    assert.equal((await request(`/api/v1/payments/${paymentId}`, { headers: admin })).status, 200);

    testDb.execute('UPDATE payment_sessions SET checkout_token_expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      paymentId
    ]);
    const expired = await request(`/api/v1/payments/${paymentId}?t=${encodeURIComponent(checkoutToken)}`);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.reason, 'CHECKOUT_TOKEN_EXPIRED');
  });

  test('corroborating observers never settle a payment; an authenticated bank confirmation does', async () => {
    testDb.execute(
      "UPDATE payment_sessions SET status = 'CANCELLED' WHERE receiving_account_id = ? AND status IN ('ACTIVE','PROCESSING','QUEUED')",
      [accountA.id]
    );
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [accountA.id]);

    const created = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ orderId: `SPRINT-BANK-${Date.now()}`, amount: '77.00', merchantId: merchantA.id, autoActivate: true })
    });
    assert.equal(created.status, 201);
    const paymentId = created.body.paymentId;
    assert.equal(created.body.status, PaymentStatus.ACTIVE, `session not active: ${created.text}`);
    const reference = `UTR-SPRINT-${Date.now()}`;

    for (const source of ['SMS_GATEWAY', 'GMAIL']) {
      const payload = {
        source,
        receivingAccountId: accountA.id,
        amountPaise: '7700',
        bankReferenceNumber: reference,
        rawText: `Rs.77 credited Ref ${reference}`
      };
      const rawBody = JSON.stringify(payload);
      const res = await request('/api/v1/pollers/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signObserverRequest({ ...observerA, method: 'POST', path: '/api/v1/pollers/events', rawBody })
        },
        body: rawBody
      });
      assert.equal(res.status, 200);
    }

    assert.notEqual(
      apiInstance.app.context.sessionRepo.findById(paymentId).status,
      PaymentStatus.SUCCESS,
      'two corroborating observer channels must not settle a payment'
    );

    const anonymous = await request('/api/v1/admin/bank-confirmations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receivingAccountId: accountA.id, bankReferenceNumber: reference, amountPaise: 7700 })
    });
    assert.equal(anonymous.status, 401);

    const confirmation = await request('/api/v1/admin/bank-confirmations', {
      // eslint-disable-next-line no-console

      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ receivingAccountId: accountA.id, bankReferenceNumber: reference, amountPaise: 7700, source: 'ACQUIRER' })
    });
    assert.equal(confirmation.status, 200, `bank confirmation failed: ${confirmation.text}`);
    assert.equal(confirmation.body.confirmed, true);
    assert.equal(apiInstance.app.context.sessionRepo.findById(paymentId).status, PaymentStatus.SUCCESS);

    // A referenced credit with no matching order is recorded but never fulfils anything.
    const unmatched = await request('/api/v1/admin/bank-confirmations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ receivingAccountId: accountB.id, bankReferenceNumber: 'UTR-NO-ORDER', amountPaise: 999900, source: 'ACQUIRER' })
    });
    assert.equal(unmatched.status, 202);
    assert.equal(unmatched.body.confirmed, false);
    assert.equal(unmatched.body.reason, 'NO_MATCHING_SESSION');
  });

  test('webhook destinations are validated: metadata/private targets and plain HTTP in production are refused', async () => {
    const metadata = await validateWebhookDestination('http://169.254.169.254/latest/meta-data/', { allowLocalhost: true });
    assert.equal(metadata.ok, false);
    assert.equal(metadata.reason, 'BLOCKED_ADDRESS');

    const privateTarget = await validateWebhookDestination('https://10.0.0.5/hook', { allowLocalhost: true });
    assert.equal(privateTarget.ok, false);

    const httpInProduction = await validateWebhookDestination('http://example.com/hook', { allowLocalhost: false });
    assert.equal(httpInProduction.ok, false);
    assert.equal(httpInProduction.reason, 'HTTPS_REQUIRED');

    const rejected = await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ merchantId: merchantA.id, webhookUrl: 'http://169.254.169.254/latest/meta-data/' })
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, 'INVALID_WEBHOOK_DESTINATION');
  });
});
