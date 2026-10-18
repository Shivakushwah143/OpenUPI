import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository } from '@youpi/db';
import { verifyHmac, PaymentStatus } from '@youpi/common';
import { WebhookEngine } from '../webhook-engine.js';

/**
 * Durable webhook outbox (audit P1-06): the outbox row is written with the payment
 * state change, deliveries are idempotent and signed, failures are retried with
 * backoff, a restart cannot lose a notification, and destinations are validated.
 */

describe('Durable webhook outbox — delivery, retry, idempotency, recovery, SSRF', () => {
  let db;
  let merchantRepo;
  let sessionRepo;
  let engine;
  let server;
  let port;
  const requests = [];
  let failFirstAttempt = true;

  before(async () => {
    db = new Database({ inMemory: true });
    runMigrations(db);
    merchantRepo = new MerchantRepository(db);
    sessionRepo = new PaymentSessionRepository(db);

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ headers: req.headers, body });
        if (failFirstAttempt) {
          failFirstAttempt = false;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"temporary"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;

    engine = new WebhookEngine({ db, merchantRepo, maxRetries: 5, allowLocalhostDestinations: true });
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  function createMerchant(slug, webhookUrl) {
    return merchantRepo.create({
      businessName: `Webhook ${slug}`,
      slug,
      contactEmail: `${slug}@test.local`,
      contactPhone: '+919000000099',
      webhookUrl,
      webhookSecret: crypto.randomBytes(32).toString('hex')
    });
  }

  test('a terminal state change writes a durable outbox row that survives until flushed', async () => {
    const merchant = createMerchant('outbox-flush', `http://127.0.0.1:${port}/hook`);
    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: `WH-OUTBOX-${Date.now()}`,
      amountPaise: 25000n,
      status: PaymentStatus.PROCESSING
    });

    sessionRepo.confirmPaymentSuccess(session.id, {
      confirmationStatus: 'BANK_CONFIRMED',
      allowFromStatuses: [PaymentStatus.PROCESSING]
    });

    const outbox = db.query('SELECT * FROM payment_events_outbox WHERE payment_id = ?', [session.id]);
    assert.equal(outbox.length, 1, 'the state change must persist exactly one outbox row');
    assert.equal(outbox[0].event, 'SUCCESS');
    assert.equal(outbox[0].flushed, 0);

    // A NEW engine instance (as after a restart) flushes the pending event.
    const restartedEngine = new WebhookEngine({ db, merchantRepo, maxRetries: 5, allowLocalhostDestinations: true });
    const flushed = await restartedEngine.flushOutbox();
    assert.equal(flushed.length, 1);

    const deliveries = db.query('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
    assert.equal(deliveries.length, 1, 'exactly one delivery row per (payment, event)');
    assert.equal(deliveries[0].event_type, 'SUCCESS');
    assert.equal(deliveries[0].is_successful, 0, 'the first attempt returned 500');
    assert.equal(deliveries[0].attempt_count, 1);
    assert.ok(deliveries[0].next_retry_at, 'a failed delivery must be scheduled for retry');

    assert.equal(db.query('SELECT * FROM payment_events_outbox WHERE payment_id = ?', [session.id])[0].flushed, 1);
  });

  test('deliveries are HMAC-signed with the merchant webhook secret and carry a stable delivery id', async () => {
    const sent = requests[requests.length - 1];
    assert.ok(sent.headers['x-gateway-signature'].startsWith('sha256='));
    assert.ok(sent.headers['x-gateway-delivery-id']);

    const merchant = merchantRepo.findAll().find(m => m.webhookUrl.includes(String(port)));
    const signature = sent.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(
      verifyHmac(sent.body, merchant.webhookSecret, signature),
      true,
      'the payload signature must verify against the merchant webhook secret'
    );

    // The delivery id is derived from (payment, event): retries reuse it.
    const delivery = db.query('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1')[0];
    assert.equal(delivery.id, WebhookEngine.deliveryIdFor(delivery.payment_id, delivery.event_type));
  });

  test('failed deliveries are retried with backoff until they succeed', async () => {
    const pending = db.query('SELECT * FROM webhook_deliveries WHERE is_successful = 0');
    assert.equal(pending.length, 1);

    // Simulate the backoff window elapsing.
    db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      pending[0].id
    ]);

    const results = await engine.retryPending();
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);

    const after = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [pending[0].id]);
    assert.equal(after.is_successful, 1);
    assert.equal(after.attempt_count, 2);
    assert.equal(after.next_retry_at, null, 'a successful delivery is never retried again');
  });

  test('re-dispatching the same event is idempotent (one delivery row, one re-attempt)', async () => {
    const delivery = db.query('SELECT * FROM webhook_deliveries LIMIT 1')[0];
    const session = sessionRepo.findById(delivery.payment_id);
    const merchant = merchantRepo.findById(session.merchantId);

    await engine.dispatch('SUCCESS', session);

    const rows = db.query('SELECT * FROM webhook_deliveries WHERE payment_id = ? AND event_type = ?', [session.id, 'SUCCESS']);
    assert.equal(rows.length, 1, 'a replayed event must not create a second delivery row');
    assert.equal(rows[0].id, delivery.id, 'the delivery id stays stable across retries');
    assert.equal(merchant.id, session.merchantId);
  });

  test('a blocked (internal) webhook destination is recorded and never fetched for other tenants', async () => {
    const merchant = createMerchant('outbox-blocked', 'http://169.254.169.254/latest/meta-data/');
    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: `WH-BLOCKED-${Date.now()}`,
      amountPaise: 10000n,
      status: PaymentStatus.PROCESSING
    });

    const result = await engine.dispatch('SUCCESS', session);
    assert.equal(result.delivered, false);
    assert.match(result.error, /BLOCKED_DESTINATION/);

    const delivery = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
    assert.ok(delivery);
    assert.equal(delivery.is_successful, 0);
    assert.equal(delivery.next_retry_at, null, 'a permanently blocked destination is not retried forever');
    assert.match(delivery.response_body, /BLOCKED_DESTINATION/);
  });

  test('processOnce() drains the outbox and pending retries in one background pass', async () => {
    const merchant = createMerchant('outbox-process', `http://127.0.0.1:${port}/hook-2`);
    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: `WH-PROCESS-${Date.now()}`,
      amountPaise: 15000n,
      status: PaymentStatus.PROCESSING
    });
    sessionRepo.confirmPaymentSuccess(session.id, {
      confirmationStatus: 'BANK_CONFIRMED',
      allowFromStatuses: [PaymentStatus.PROCESSING]
    });

    const result = await engine.processOnce();
    assert.ok(Array.isArray(result.flushed));
    const delivery = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
    assert.ok(delivery, 'the background worker must materialise the delivery');
    assert.equal(delivery.endpoint_url, merchant.webhookUrl);
  });
});
