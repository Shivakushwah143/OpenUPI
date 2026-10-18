import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startSmsObserver } from '../index.js';
import { BankSmsParser } from '../sms-parser.js';
import { PaymentStatus } from '@youpi/common';

describe('Google Messages / SMS Payment Observer Integration Tests', () => {
  let apiInstance;
  let smsInstance;
  let smsBaseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6196, testDb);
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
    smsInstance = await startSmsObserver(6098, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      observerCredential: process.env.YOUPI_OBSERVER_CREDENTIAL
    });
    smsBaseUrl = `http://localhost:${smsInstance.port}`;
  });

  after(async () => {
    await smsInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${smsBaseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('Bank SMS Parser', () => {
    test('correctly parses credit SMS with amount, UTR, and sender VPA', () => {
      const sms = {
        text: 'Dear SBI user, A/C 1234 credited by Rs 499.00 on 08Sep26 by UPI/CR/667788/buyer@okhdfcbank Ref: 667788.',
        sender: 'VK-SBIUPI'
      };

      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 49900n);
      assert.equal(parsed.amount, '499.00');
      assert.equal(parsed.bankReferenceNumber, '667788');
      assert.equal(parsed.senderVpa, 'buyer@okhdfcbank');
    });

    test('ignores debit SMS alerts', () => {
      const debitSms = {
        text: 'Your a/c 1234 debited by Rs 250.00 at Grocery Store.',
        sender: 'VK-HDFCBK'
      };

      const parsed = BankSmsParser.parse(debitSms);
      assert.equal(parsed, null);
    });
  });

  describe('SMS Observer HTTP Service & Attribution', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'sms-observer');
    });

    test('End-to-End: processing bank SMS records REPORTED evidence on the active payment session (never finalizes alone)', async () => {
      // 1. Create a payment in Payment API for ₹499
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'SMS-ORD-499',
        amountPaise: 49900n
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // 2. Process incoming SMS alert via SMS Observer
      const result = await smsInstance.service.processSms({
        text: 'A/C 1234 credited with Rs. 499.00 on 08-Sep-2026. Ref: UTR-SMS-499 from payer@upi',
        sender: 'VM-ICICIB'
      });

      assert.ok(result);
      assert.equal(result.accepted, true);
      assert.equal(result.attribution.attributed, true);
      assert.equal(result.attribution.paymentSessionId, session.id);
      // A single SMS is a claim: it is recorded as evidence but cannot finalize the
      // payment without independent bank-credit verification (audit P1-01 / Gate B).
      assert.equal(result.attribution.outcomeStatus, 'REPORTED');

      // 3. Verify session in DB stays pending with REPORTED confirmation provenance
      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(updated.status, PaymentStatus.PROCESSING);
      assert.equal(updated.confirmationStatus, 'REPORTED');
    });
  });
});
