import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { BankEmailParser } from '../parser.js';
import { PaymentStatus } from '@youpi/common';

describe('Gmail Payment Observer Integration Tests', () => {
  let apiInstance;
  let gmailInstance;
  let gmailBaseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6198, testDb);
    // Observer ingest is signed with a DEDICATED observer credential (separate from
    // merchant/admin API keys); the secret is returned once at issuance.
    process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
    process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const merchantId = testDb.queryOne('SELECT id FROM merchants ORDER BY created_at ASC LIMIT 1').id;
    const issuedRes = await fetch(`http://localhost:${apiInstance.port}/api/v1/admin/observers/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_API_KEY },
      body: JSON.stringify({ merchantId, label: 'observer suite' })
    });
    const issued = await issuedRes.json();
    if (issuedRes.status !== 201) throw new Error(`Observer credential provisioning failed: ${issuedRes.status}`);
    process.env.YOUPI_OBSERVER_CREDENTIAL = `${issued.keyId}.${issued.secret}`;
    gmailInstance = await startGmailObserver(6099, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      observerCredential: process.env.YOUPI_OBSERVER_CREDENTIAL
    });
    gmailBaseUrl = `http://localhost:${gmailInstance.port}`;
  });

  after(async () => {
    await gmailInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${gmailBaseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('Bank Email Parser', () => {
    test('correctly parses HDFC credit notification email', () => {
      const email = {
        subject: 'ALERT: Account credited with Rs. 200.00',
        body: 'Dear Customer, your account has been credited with Rs. 200.00 on 08-Sep-2026. Ref no: UTR-HDFC-9911 from sender@upi.',
        from: 'alerts@hdfcbank.net'
      };

      const parsed = BankEmailParser.parse(email);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 20000n);
      assert.equal(parsed.amount, '200.00');
      assert.equal(parsed.bankReferenceNumber, 'UTR-HDFC-9911');
      assert.equal(parsed.senderVpa, 'sender@upi');
    });

    test('correctly parses custom or alt-account emails like "20.00 received"', () => {
      const altEmail = {
        subject: '20.00 received',
        body: '20.00 received from alt account',
        from: 'alt@gmail.com'
      };

      const parsed = BankEmailParser.parse(altEmail);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 2000n);
      assert.equal(parsed.amount, '20.00');
    });

    test('ignores debit notification emails', () => {
      const debitEmail = {
        subject: 'ALERT: Account debited with Rs. 500.00',
        body: 'Your account was debited for purchase at Amazon.',
        from: 'alerts@hdfcbank.net'
      };

      const parsed = BankEmailParser.parse(debitEmail);
      assert.equal(parsed, null);
    });
  });

  describe('Gmail Observer HTTP Service', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'gmail-observer');
    });

    test('GET /oauth/url returns valid Google OAuth URL', async () => {
      const res = await get('/oauth/url');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.ok(json.authUrl.includes('accounts.google.com/o/oauth2/v2/auth'));
      assert.ok(json.authUrl.includes('gmail.readonly'));
    });

    test('End-to-End: processing bank email records REPORTED evidence on the active payment session (never finalizes alone)', async () => {
      // 1. Create a payment in Payment API
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-ORD-777',
        amountPaise: 20000n
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // 2. Process matching incoming bank email via Gmail Observer
      const result = await gmailInstance.poller.processEmail({
        subject: 'Credit alert: Rs 200.00 received',
        body: 'Your account received Rs 200.00 from buyer@upi Ref: UTR-GMAIL-777',
        from: 'alerts@icicibank.com'
      });

      assert.ok(result);
      assert.equal(result.accepted, true);
      assert.equal(result.attribution.attributed, true);
      assert.equal(result.attribution.paymentSessionId, session.id);

      // The single email is a REPORTED claim: it can no longer finalize the payment.
      // Independent bank-credit verification (a second channel reporting the same
      // bank reference) is required before SUCCESS.
      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(updated.status, PaymentStatus.PROCESSING);
      assert.equal(updated.confirmationStatus, 'REPORTED');
    });
  });
});
