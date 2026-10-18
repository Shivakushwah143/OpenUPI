import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Database, runMigrations } from '@youpi/db';
import { MerchantRepository } from '@youpi/db';
import { ReceivingAccountRepository } from '@youpi/db';
import { PaymentStatus, signObserverRequest } from '@youpi/common';
import { startServer } from '../index.js';

/**
 * Negative security regression suite for the P0 remediation
 * (audit OpenUPI_Implementation_Security_Audit_2026-10-18.md):
 * P0-01 arbitrary command execution, P0-02/07 unauthorized admin & tenant
 * spoofing, P0-03/04 unsigned/spoofed/replayed observations, P0-05 pairing,
 * P0-06 secret exposure and unverified manual confirmation.
 *
 * Every case asserts the ATTACK is refused — never that a weakened check passes.
 */

const ADMIN_KEY = 'admin_test_key_9f2c41aa7b';

// High-entropy credentials: any partial disclosure of these values in a response
// would be a genuine leak, not a substring coincidence with route field names.
const TENANT_A_KEY = crypto.randomBytes(32).toString('hex');
const TENANT_B_KEY = crypto.randomBytes(32).toString('hex');
const TENANT_A_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');
const TENANT_B_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

describe('Security Hardening — Negative Access & Forgery Tests (P0-01..P0-07)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let merchantA;
  let merchantB;
  let accountA;
  let accountB;
  let observerA;
  let observerB;

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

  const admin = { 'X-Admin-Key': ADMIN_KEY };
  const asMerchant = key => ({ 'X-API-Key': key });

  before(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;

    testDb = new Database({ inMemory: true });
    runMigrations(testDb);

    const merchantRepo = new MerchantRepository(testDb);
    const accountRepo = new ReceivingAccountRepository(testDb);

    merchantA = merchantRepo.create({
      businessName: 'Tenant A Store',
      slug: 'sec-tenant-a',
      contactEmail: 'a@example.com',
      contactPhone: '+919000000001',
      webhookUrl: 'https://a.example.com/webhook',
      webhookSecret: TENANT_A_WEBHOOK_SECRET,
      apiKey: TENANT_A_KEY
    });
    accountA = accountRepo.create({
      merchantId: merchantA.id,
      upiId: 'tenant-a@bank',
      payeeName: 'Tenant A',
      isMerchantEnabled: true,
      isActive: true
    });

    merchantB = merchantRepo.create({
      businessName: 'Tenant B Store',
      slug: 'sec-tenant-b',
      contactEmail: 'b@example.com',
      contactPhone: '+919000000002',
      webhookUrl: 'https://b.example.com/webhook',
      webhookSecret: TENANT_B_WEBHOOK_SECRET,
      apiKey: TENANT_B_KEY
    });
    accountB = accountRepo.create({
      merchantId: merchantB.id,
      upiId: 'tenant-b@bank',
      payeeName: 'Tenant B',
      isMerchantEnabled: true,
      isActive: true
    });

    apiInstance = await startServer(6197, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;

    // Dedicated observer credentials (never the merchant/admin API keys).
    const issueCredential = async merchantId => {
      const res = await request('/api/v1/admin/observers/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...admin },
        body: JSON.stringify({ merchantId, label: 'security suite' })
      });
      assert.equal(res.status, 201);
      return { keyId: res.body.keyId, secret: res.body.secret, id: res.body.id, merchantId };
    };
    observerA = await issueCredential(merchantA.id);
    observerB = await issueCredential(merchantB.id);
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
    delete process.env.ADMIN_API_KEY;
  });

  // ---------------------------------------------------------------- P0-01/02
  test('P0-01/P0-02: anonymous callers cannot reach administrative or payment-management endpoints', async () => {
    const targets = [
      ['GET', '/api/v1/admin/all-settings'],
      ['GET', '/api/v1/admin/merchant-settings'],
      ['GET', '/api/v1/admin/tunnel/status'],
      ['POST', '/api/v1/admin/tunnel/stop'],
      ['POST', '/api/v1/admin/counter-confirm'],
      ['POST', '/api/v1/admin/upi-accounts'],
      ['GET', '/api/v1/admin/security/banned-users']
    ];

    for (const [method, path] of targets) {
      const res = await request(path, { method, body: method === 'POST' ? '{}' : undefined, headers: { 'Content-Type': 'application/json' } });
      assert.equal(res.status, 401, `anonymous ${method} ${path} must be 401, got ${res.status}`);
    }
  });

  test('P0-01: the tunnel command-execution endpoint no longer exists and arbitrary commands are never executed', async () => {
    const res = await request('/api/v1/admin/tunnel/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ command: 'echo pwned > /tmp/youpi-pwned.txt' })
    });

    assert.equal(res.status, 404);

    const status = await request('/api/v1/admin/tunnel/status', { headers: admin });
    assert.equal(status.status, 200);
    assert.equal(status.body.command, undefined, 'tunnel status must never return the command line (it can carry credentials)');
  });

  test('P0-02: a merchant credential cannot perform gateway-operator operations', async () => {
    const res = await request('/api/v1/admin/tunnel/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMerchant(merchantB.apiKey) },
      body: '{}'
    });
    assert.equal(res.status, 403);

    const confirm = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMerchant(merchantB.apiKey) },
      body: JSON.stringify({ paymentId: 'any', operatorId: 'attacker' })
    });
    assert.equal(confirm.status, 403);
  });

  test('P0-07: a forged admin credential is rejected', async () => {
    const res = await request('/api/v1/admin/all-settings', { headers: { 'X-Admin-Key': 'not_the_admin_key' } });
    assert.equal(res.status, 401);
  });

  // ------------------------------------------------------------------- P0-03
  test('P0-03: unsigned, wrongly-keyed and tampered observer observations are refused', async () => {
    const path = '/api/v1/pollers/events';
    const bodyObj = {
      source: 'SMS_GATEWAY',
      receivingAccountId: accountA.id,
      amountPaise: '25000',
      bankReferenceNumber: 'UTR-TAMPER-1',
      rawText: 'Rs.250 credited to tenant-a@bank Ref UTR-TAMPER-1'
    };
    const rawBody = JSON.stringify(bodyObj);

    // 1. No credential at all
    const anonymous = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody });
    assert.equal(anonymous.status, 401);

    // 2. Unknown observer credential
    const unknownKey = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signObserverRequest({ keyId: 'obs_unknown', secret: 'unknown_observer_secret', method: 'POST', path, rawBody }) },
      body: rawBody
    });
    assert.equal(unknownKey.status, 401);

    // 3. Signature valid for a DIFFERENT body (tampered amount) -> mismatch
    const signedHeaders = signObserverRequest({ ...observerA, method: 'POST', path, rawBody });
    const tamperedBody = JSON.stringify({ ...bodyObj, amountPaise: '99999900' });
    const tampered = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signedHeaders },
      body: tamperedBody
    });
    assert.equal(tampered.status, 401);

    // 4. Valid signature but expired timestamp -> replay window refused
    const expired = await request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signObserverRequest({ ...observerA, method: 'POST', path, rawBody, timestamp: Date.now() - 10 * 60 * 1000 })
      },
      body: rawBody
    });
    assert.equal(expired.status, 401);
  });

  test('P0-03: a captured signed observer request cannot be replayed', async () => {
    const path = '/api/v1/pollers/events';
    const rawBody = JSON.stringify({
      source: 'SMS_GATEWAY',
      receivingAccountId: accountA.id,
      amountPaise: '100',
      bankReferenceNumber: 'UTR-REPLAY-1',
      rawText: 'Rs.1 credited Ref UTR-REPLAY-1'
    });
    const headers = {
      'Content-Type': 'application/json',
      ...signObserverRequest({ ...observerA, method: 'POST', path, rawBody })
    };

    const first = await request(path, { method: 'POST', headers, body: rawBody });
    assert.notEqual(first.status, 401, 'the first, legitimately signed request must be accepted by the guard');

    const replay = await request(path, { method: 'POST', headers, body: rawBody });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.reason, 'REPLAY_DETECTED');
  });

  test('P0-03/P0-07: a tenant cannot submit observations for another tenant receiving account or pick its own source of truth', async () => {
    const path = '/api/v1/pollers/events';
    const rawBody = JSON.stringify({
      source: 'SMS_GATEWAY',
      receivingAccountId: accountA.id,
      amountPaise: '25000',
      bankReferenceNumber: 'UTR-CROSSTENANT-1',
      rawText: 'Rs.250 credited Ref UTR-CROSSTENANT-1'
    });

    const res = await request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signObserverRequest({ ...observerB, method: 'POST', path, rawBody })
      },
      body: rawBody
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'CROSS_TENANT_ACCOUNT');
  });

  test('P0-07: unsigned calls to the signed observer window are refused', async () => {
    const res = await request('/api/v1/pollers/active-window');
    assert.equal(res.status, 401);
  });

  // ------------------------------------------------------------------- P0-04
  test('P0-04: unsigned or wrongly-signed Android device observations and heartbeats are refused', async () => {
    const deviceId = crypto.randomUUID();
    const signingKey = crypto.randomBytes(32).toString('hex');
    testDb.execute(
      `INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`,
      [deviceId, merchantA.id, 'Test Phone', 'Pixel', signingKey]
    );

    const eventsPath = '/api/v1/pollers/android/events';
    const rawBody = JSON.stringify({ deviceId, receivingAccountId: accountA.id, amount: '5.00', bankReferenceNumber: 'UTR-DEV-1' });

    // 1. Knowledge of a registered device id alone must not be enough
    const unsigned = await request(eventsPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody });
    assert.equal(unsigned.status, 401);

    // 2. Wrong signing key
    const forged = crypto.createHmac('sha256', 'wrong_key').update(`${rawBody}:${Date.now()}`).digest('hex');
    const wrongKey = await request(eventsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Timestamp': String(Date.now()),
        'X-Signature': forged
      },
      body: rawBody
    });
    assert.equal(wrongKey.status, 401);

    // 3. Unsigned heartbeat
    const heartbeatBody = JSON.stringify({ deviceId });
    const heartbeat = await request('/api/v1/pollers/android/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: heartbeatBody
    });
    assert.equal(heartbeat.status, 401);

    // 4. Unknown device id cannot self-enroll through the ingest path
    const unknownDevice = await request(eventsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': crypto.randomUUID(),
        'X-Timestamp': String(Date.now()),
        'X-Signature': forged
      },
      body: rawBody
    });
    assert.equal(unknownDevice.status, 403);
  });

  // ------------------------------------------------------------------- P0-05
  test('P0-05: pairing challenges are single-use, expiring and never accept a merchant-derived static token', async () => {
    const qr = await request('/api/v1/admin/sms-gateway/pair-qr', { headers: admin });
    assert.equal(qr.status, 200);

    const token = qr.body.enrollmentToken;
    assert.ok(token && token.length >= 32, 'pairing challenge must be high entropy');

    const first = await request('/api/v1/pollers/android/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: token, deviceName: 'Phone 1' })
    });
    assert.equal(first.status, 200);
    assert.ok(first.body.merchantId);
    assert.equal(first.body.merchantId, qr.body.payload.merchantId);

    const second = await request('/api/v1/pollers/android/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: token, deviceName: 'Phone 2' })
    });
    assert.equal(second.status, 401, 'a pairing challenge must be single use');

    const predictable = await request('/api/v1/pollers/android/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: `pair_${merchantA.id}`, merchantId: merchantA.id })
    });
    assert.equal(predictable.status, 401, 'merchant-derived tokens must not enroll devices');
  });

  // ------------------------------------------------------------------- P0-06
  test('P0-06: admin responses never return stored secrets', async () => {
    const responses = await Promise.all([
      request('/api/v1/admin/all-settings', { headers: admin }),
      request('/api/v1/admin/merchant-settings', { headers: admin }),
      request('/api/v1/admin/gmail/credentials', { headers: admin }),
      request('/api/v1/admin/sms-gateway/devices', { headers: admin })
    ]);

    const secrets = [
      merchantA.apiKey,
      merchantB.apiKey,
      merchantA.webhookSecret,
      merchantB.webhookSecret
    ];

    for (const res of responses) {
      assert.equal(res.status, 200);
      for (const secret of secrets) {
        assert.equal(res.text.includes(secret), false, 'an admin response leaked a stored secret');
        // Partial disclosure is also forbidden: neither the leading nor trailing
        // window of a stored secret may be returned.
        assert.equal(res.text.includes(secret.slice(0, 4)), false, 'an admin response leaked part of a stored secret');
        assert.equal(res.text.includes(secret.slice(-4)), false, 'an admin response leaked part of a stored secret');
      }
      assert.equal(res.text.includes('Masked'), false, 'admin responses must expose configured/not-configured flags, never masked secret material');
    }

    const merchantSettings = await request('/api/v1/admin/merchant-settings', { headers: admin });
    assert.equal(merchantSettings.body.webhookSecret, undefined);
    assert.equal(merchantSettings.body.apiKey, undefined);
    assert.equal(typeof merchantSettings.body.webhookSecretConfigured, 'boolean');

    const devices = await request('/api/v1/admin/sms-gateway/devices', { headers: admin });
    assert.ok(Array.isArray(devices.body.devices));
    for (const device of devices.body.devices) {
      assert.equal(device.signingKey, undefined);
      assert.equal(device.signingKeyMasked, undefined);
    }
  });

  // ------------------------------------------------------------- P0-02/06
  test('P0-02: an authenticated operator cannot drive a UPI session to SUCCESS without independent bank evidence', async () => {
    const created = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMerchant(merchantA.apiKey) },
      body: JSON.stringify({ orderId: `SEC-ORD-${Date.now()}`, amount: '250.00', autoActivate: true })
    });
    assert.equal(created.status, 201);
    const paymentId = created.body.paymentId;

    // 1. No evidence at all
    const bare = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ paymentId, operatorId: 'attacker_operator' })
    });
    assert.equal(bare.status, 409);
    assert.equal(bare.body.error, 'MANUAL_CONFIRMATION_NOT_ALLOWED');

    // 2. Fabricated bank reference that no observer ever reported
    const fabricated = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({
        paymentId,
        operatorId: 'attacker_operator',
        bankReferenceNumber: 'UTR-FABRICATED-0001',
        reconciliationNote: 'trust me'
      })
    });
    assert.equal(fabricated.status, 409);
    assert.equal(fabricated.body.error, 'MANUAL_RECONCILIATION_UNVERIFIED');

    // 3. Even a real reference observed for ANOTHER tenant must not settle this order
    testDb.execute(
      `INSERT INTO bank_transaction_ledger (id, receiving_account_id, merchant_id, bank_reference, amount_paise, observed_at, first_source, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 'SMS', 'OBSERVED', datetime('now'))`,
      [crypto.randomUUID(), accountB.id, merchantB.id, 'UTR-TENANT-B-1', 25000]
    );
    const crossTenant = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({
        paymentId,
        operatorId: 'attacker_operator',
        bankReferenceNumber: 'UTR-TENANT-B-1',
        reconciliationNote: 'reuse another tenant credit'
      })
    });
    assert.equal(crossTenant.status, 409);

    // The session must still be unresolved.
    const session = apiInstance.app.context.sessionRepo.findById(paymentId);
    assert.notEqual(session.status, PaymentStatus.SUCCESS);
  });

  test('P0-06: an operator can only reconcile a bank reference that was independently observed for this account and amount', async () => {
    // Free the receiving-account slot so the session under test is ACTIVE (a QUEUED
    // session is legitimately not confirmable).
    testDb.execute(
      "UPDATE payment_sessions SET status = 'CANCELLED' WHERE receiving_account_id = ? AND status IN ('ACTIVE','PROCESSING','QUEUED')",
      [accountA.id]
    );
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [accountA.id]);

    const created = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMerchant(merchantA.apiKey) },
      body: JSON.stringify({ orderId: `SEC-ORD-OK-${Date.now()}`, amount: '120.00', autoActivate: true })
    });
    assert.equal(created.status, 201);
    const paymentId = created.body.paymentId;
    assert.equal(created.body.status, PaymentStatus.ACTIVE);
    const reference = 'UTR-OBSERVED-OK-1';

    testDb.execute(
      `INSERT INTO bank_transaction_ledger (id, receiving_account_id, merchant_id, bank_reference, amount_paise, observed_at, first_source, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 'SMS', 'OBSERVED', datetime('now'))`,
      [crypto.randomUUID(), accountA.id, merchantA.id, reference, 12000]
    );

    // Wrong amount for the same reference must still be refused.
    const wrongAmount = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ paymentId, operatorId: 'operator_1', bankReferenceNumber: 'UTR-OBSERVED-OK-2', reconciliationNote: 'unknown ref' })
    });
    assert.equal(wrongAmount.status, 409);

    const confirmed = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ paymentId, operatorId: 'operator_1', bankReferenceNumber: reference, reconciliationNote: 'statement line matched' })
    });
    assert.equal(confirmed.status, 200);

    const session = apiInstance.app.context.sessionRepo.findById(paymentId);
    assert.equal(session.status, PaymentStatus.SUCCESS);

    // The reference is consumed: it can never be credited to a second order.
    testDb.execute(
      "UPDATE payment_sessions SET status = 'CANCELLED' WHERE receiving_account_id = ? AND status IN ('ACTIVE','PROCESSING','QUEUED')",
      [accountA.id]
    );
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [accountA.id]);

    const reused = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMerchant(merchantA.apiKey) },
      body: JSON.stringify({ orderId: `SEC-ORD-REUSE-${Date.now()}`, amount: '120.00', autoActivate: true })
    });
    assert.equal(reused.status, 201);
    const reuse = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ paymentId: reused.body.paymentId, operatorId: 'operator_1', bankReferenceNumber: reference, reconciliationNote: 'double spend' })
    });
    assert.equal(reuse.status, 409);
  });

  test('P0-07: a merchant credential cannot create payments for, or read settings of, another tenant', async () => {
    const forgedTenant = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMerchant(merchantB.apiKey), 'X-Merchant-Id': merchantA.id },
      body: JSON.stringify({ orderId: `SEC-XT-${Date.now()}`, amount: '10.00', merchantId: merchantA.id })
    });
    assert.equal(forgedTenant.status, 403);

    const stolenSettings = await request('/api/v1/admin/merchant-settings', {
      headers: { ...asMerchant(merchantB.apiKey), 'X-Merchant-Id': merchantA.id }
    });
    assert.equal(stolenSettings.status, 403);
  });
});
