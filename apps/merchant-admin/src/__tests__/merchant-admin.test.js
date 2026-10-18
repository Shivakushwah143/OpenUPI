import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startAdminServer } from '../index.js';

describe('Merchant Admin Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6101, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }).on('error', reject);
    });
  }

  test('GET /health returns UP', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.status, 'UP');
    assert.equal(json.service, 'merchant-admin');
  });

  test('GET / renders dashboard with queue monitor, observers, counter desk & pairing modal', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));

    assert.ok(res.text.includes('Real-Time Receiving Account Slot Ownership'));
    assert.ok(res.text.includes('Active Slot (5-Minute Window)'));
    assert.ok(res.text.includes('Processing Slot (30s Verification Window)'));
    assert.ok(res.text.includes('Live Counter Payment Requests'));
    assert.ok(res.text.includes('Payment Observers (SMS & Gmail)'));
    assert.ok(res.text.includes('Android SMS Gateway'));
    assert.ok(res.text.includes('Gmail Direct API'));
  });

  test('GET /api/admin/tickets returns tickets array', async () => {
    const res = await get('/api/admin/tickets');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.ok(Array.isArray(json));
  });
});

describe('Merchant Admin — authenticated device pairing proxy', () => {
  let adminInstance;
  let paymentInstance;
  let db;
  let adminBase;

  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test_admin_api_key_123';
  process.env.YOUPI_SECRET_KEY = process.env.YOUPI_SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  before(async () => {
    const { startServer: startPaymentApi } = await import('../../../payment-api/src/index.js');
    db = new Database({ inMemory: true });
    paymentInstance = await startPaymentApi(6235, db);
    process.env.PAYMENT_API_PORT = String(paymentInstance.port);
    adminInstance = await startAdminServer(6103, { db });
    adminBase = `http://localhost:${adminInstance.port}`;
  });

  after(async () => {
    await adminInstance.close();
    await paymentInstance.close();
    db.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${adminBase}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }).on('error', reject);
    });
  }

  test('pairing QR is fetched server-side with the merchant credential and never leaks it to the browser', async () => {
    const merchant = db.queryOne('SELECT api_key FROM merchants ORDER BY created_at ASC LIMIT 1');
    assert.ok(merchant?.api_key);

    const res = await get('/api/v1/admin/sms-gateway/pair-qr');
    assert.equal(res.status, 200, res.text);
    const json = JSON.parse(res.text);
    assert.ok(json.enrollmentToken);
    assert.ok(json.pairingQrSvg);

    // No credential material in the response, headers included.
    assert.equal(res.text.includes(merchant.api_key), false);
    assert.equal(JSON.stringify(res.headers).includes(merchant.api_key), false);
  });

  test('the proxy credential is scoped to pairing endpoints only', async () => {
    const res = await get('/api/v1/admin/payments');
    assert.equal(res.status, 401, 'non-allowlisted admin paths must stay unauthenticated');
  });

  test('rendered console HTML never contains the legacy static enrollment secret', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.equal(res.text.includes('android_pairing_enrollment_secret_key_32_chars'), false);
  });
});
