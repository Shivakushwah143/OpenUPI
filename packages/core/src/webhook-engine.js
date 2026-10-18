import crypto from 'node:crypto';
import { generateHmac, toRupeesString, openSecret } from '@youpi/common';
import { isTerminalStatus, toPublicOutcome } from './state-machine.js';
import { validateWebhookDestination } from './webhook-destination.js';

/**
 * Webhook delivery engine (audit P1-05 / P1-06).
 *
 * Delivery is driven by the durable `payment_events_outbox` written in the SAME
 * transaction as the payment state change:
 *   1. `flushOutbox()` materialises an idempotent delivery row per (payment, event);
 *   2. `retryPending()` retries failed deliveries with exponential backoff;
 *   3. a background worker (see payment-api index.js) calls `processOnce()`.
 *
 * Every attempt re-validates the destination (SSRF), signs the exact payload with
 * the merchant's webhook secret (HMAC-SHA256) and reuses a stable delivery id so a
 * merchant can de-duplicate retries.
 */
export class WebhookEngine {
  /**
   * @param {{
   *   db: import('@youpi/db').Database,
   *   merchantRepo: import('@youpi/db').MerchantRepository,
   *   maxRetries?: number,
   *   allowLocalhostDestinations?: boolean
   * }} options
   */
  constructor(options) {
    this.db = options.db;
    this.merchantRepo = options.merchantRepo;
    this.maxRetries = options.maxRetries || 5;
    // Only local/dev (or an explicitly injected test harness) may target loopback.
    this.allowLocalhostDestinations = options.allowLocalhostDestinations !== undefined
      ? options.allowLocalhostDestinations
      : process.env.NODE_ENV !== 'production';
  }

  /** Invalidates a cached merchant row after a settings change. */
  clearCache() {}

  /**
   * Validates a webhook destination for the current runtime.
   * @param {string} url
   */
  async validateDestination(url) {
    return validateWebhookDestination(url, {
      allowLocalhost: this.allowLocalhostDestinations && process.env.NODE_ENV !== 'production'
    });
  }

  /**
   * Stable delivery id for a (payment, event) pair: retries reuse the id so the
   * merchant can deduplicate at-least-once delivery.
   * @param {string} paymentId
   * @param {string} event
   */
  static deliveryIdFor(paymentId, event) {
    return `whd_${crypto.createHash('sha256').update(`${paymentId}:${event}`).digest('hex').slice(0, 32)}`;
  }

  /** Builds the canonical payload for an event. */
  buildPayload(event, session) {
    const publicOutcome = isTerminalStatus(event) ? toPublicOutcome(event) : event;
    return {
      event: publicOutcome,
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: Number(session.amountPaise),
      currency: session.currency || 'INR',
      method: session.method || 'UPI',
      completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : new Date().toISOString(),
      metadata: session.metadata || {}
    };
  }

  /** Signs the exact payload bytes with the merchant webhook secret. */
  signPayload(payloadString, merchant) {
    const secret = merchant && merchant.webhookSecret ? openSecret(merchant.webhookSecret) : '';
    return `sha256=${generateHmac(payloadString, secret)}`;
  }

  /**
   * Dispatches a payment event. Always records a durable delivery row before the
   * network call, so a crash or timeout never loses the notification.
   * @returns {Promise<{ delivered: boolean, deliveryId: string, status?: number, error?: string }>}
   */
  async dispatch(event, session) {
    const merchant = this.merchantRepo.findById(session.merchantId);
    if (!merchant || !merchant.webhookUrl) {
      return { delivered: false, deliveryId: '', error: 'No webhook URL configured for merchant.' };
    }
    return this.deliver({ event, session, merchant });
  }

  /**
   * Flushes durable outbox rows into delivery rows. The outbox row is marked
   * flushed once the delivery row exists — retries are owned by the delivery row.
   * @param {number} limit
   */
  async flushOutbox(limit = 50) {
    const pending = this.db.query(
      'SELECT * FROM payment_events_outbox WHERE flushed = 0 ORDER BY created_at ASC LIMIT ?',
      [limit]
    );

    const results = [];
    for (const row of pending) {
      const session = this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [row.payment_id]);
      if (!session) {
        this._markOutboxFlushed(row.id);
        continue;
      }
      const sessionView = this.viewSession(session);

      let delivery = { delivered: false, deliveryId: '', error: 'NOT_ATTEMPTED' };
      try {
        delivery = await this.dispatch(row.event, sessionView);
      } catch (err) {
        delivery = { delivered: false, deliveryId: '', error: err.message };
      }

      // The delivery row (if any) now owns the retry lifecycle.
      this._markOutboxFlushed(row.id);
      results.push({ outboxId: row.id, paymentId: row.payment_id, event: row.event, ...delivery });
    }
    return results;
  }

  /**
   * Single background pass: materialise pending events, then retry failed
   * deliveries. Safe to run concurrently across processes (idempotent rows).
   */
  async processOnce() {
    const flushed = await this.flushOutbox();
    const retried = await this.retryPending();
    return { flushed, retried };
  }

  /**
   * Retries overdue pending deliveries with exponential backoff.
   * Backoff: 5s, 30s, 2m, 10m, 1h.
   */
  async retryPending() {
    const nowIso = new Date().toISOString();
    const pending = this.db.query(`
      SELECT * FROM webhook_deliveries
      WHERE is_successful = 0 AND attempt_count < ? AND next_retry_at IS NOT NULL AND next_retry_at <= ?
      ORDER BY next_retry_at ASC
      LIMIT 20
    `, [this.maxRetries, nowIso]);

    const results = [];
    for (const item of pending) {
      const merchant = this.merchantRepo.findById(item.merchant_id);
      if (!merchant || !item.endpoint_url) continue;

      // Re-validate on every attempt: DNS may now point somewhere internal.
      const validation = await this.validateDestination(item.endpoint_url);
      if (!validation.ok) {
        this._backoff(item, null, `BLOCKED_DESTINATION:${validation.reason}`, false);
        results.push({ id: item.id, success: false, attempt: item.attempt_count + 1, reason: validation.reason });
        continue;
      }

      const signature = this.signPayload(item.payload, merchant);
      let respStatus = null;
      let respBody = null;
      let isSuccess = false;

      try {
        const res = await fetch(item.endpoint_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Event': item.event_type,
            'X-Gateway-Signature': signature,
            'X-Gateway-Delivery-Id': item.id,
            'X-Gateway-Timestamp': Date.now().toString()
          },
          body: item.payload,
          signal: AbortSignal.timeout(10000)
        });
        respStatus = res.status;
        respBody = (await res.text()).substring(0, 1000);
        isSuccess = res.ok;
      } catch (err) {
        respBody = err.message;
      }

      this._backoff(item, respStatus, respBody, isSuccess);
      results.push({ id: item.id, success: isSuccess, attempt: item.attempt_count + 1 });
    }

    return results;
  }

  /**
   * Performs one delivery attempt for an event and records it idempotently.
   * @param {{ event: string, session: any, merchant: any, deliveryId?: string }} input
   */
  async deliver(input) {
    const { event, session, merchant } = input;
    const publicOutcome = isTerminalStatus(event) ? toPublicOutcome(event) : event;
    const deliveryId = input.deliveryId || WebhookEngine.deliveryIdFor(session.id, publicOutcome);

    const existing = this.db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);

    const validation = await this.validateDestination(merchant.webhookUrl);
    if (!validation.ok) {
      if (!existing) {
        this._insertDelivery({
          deliveryId,
          merchantId: merchant.id,
          paymentId: session.id,
          event: publicOutcome,
          payload: JSON.stringify(this.buildPayload(event, session)),
          endpointUrl: merchant.webhookUrl,
          responseStatus: null,
          responseBody: `BLOCKED_DESTINATION:${validation.reason}`,
          isSuccessful: false,
          attemptCount: 1,
          nextRetryAt: null
        });
      }
      return { delivered: false, deliveryId, error: `BLOCKED_DESTINATION:${validation.reason}` };
    }

    const payloadString = existing ? existing.payload : JSON.stringify(this.buildPayload(event, session));
    const signature = this.signPayload(payloadString, merchant);
    const attemptCount = (existing ? existing.attempt_count : 0) + 1;

    let responseStatus = null;
    let responseBody = null;
    let isSuccessful = false;

    try {
      const res = await fetch(merchant.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Event': publicOutcome,
          'X-Gateway-Signature': signature,
          'X-Gateway-Delivery-Id': deliveryId,
          'X-Gateway-Timestamp': Date.now().toString()
        },
        body: payloadString,
        signal: AbortSignal.timeout(10000)
      });
      responseStatus = res.status;
      responseBody = (await res.text()).substring(0, 1000);
      isSuccessful = res.ok;
    } catch (err) {
      responseBody = err.message || 'Network timeout';
    }

    if (existing) {
      this._backoff(existing, responseStatus, responseBody, isSuccessful);
    } else {
      this._insertDelivery({
        deliveryId,
        merchantId: merchant.id,
        paymentId: session.id,
        event: publicOutcome,
        payload: payloadString,
        endpointUrl: merchant.webhookUrl,
        responseStatus,
        responseBody,
        isSuccessful,
        attemptCount,
        nextRetryAt: isSuccessful || attemptCount >= this.maxRetries
          ? null
          : new Date(Date.now() + this._backoffFor(attemptCount)).toISOString()
      });
    }

    return {
      delivered: isSuccessful,
      deliveryId,
      status: responseStatus,
      error: isSuccessful ? undefined : responseBody
    };
  }

  /** Maps a raw payment_sessions row to the shape the payload builder expects. */
  viewSession(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      orderId: row.order_id,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      method: row.method,
      status: row.status,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      metadata: (() => {
        try { return JSON.parse(row.metadata || '{}'); } catch { return {}; }
      })()
    };
  }

  _backoffFor(attemptCount) {
    const backoffs = [5000, 30000, 120000, 600000, 3600000];
    return backoffs[Math.min(Math.max(attemptCount - 1, 0), backoffs.length - 1)];
  }

  _backoff(item, responseStatus, responseBody, isSuccessful) {
    const nextAttempt = item.attempt_count + 1;
    const nextRetryAt = isSuccessful || nextAttempt >= this.maxRetries
      ? null
      : new Date(Date.now() + this._backoffFor(nextAttempt)).toISOString();

    this.db.execute(`
      UPDATE webhook_deliveries
      SET attempt_count = ?, is_successful = ?, response_status = ?,
          response_body = ?, next_retry_at = ?
      WHERE id = ?
    `, [nextAttempt, isSuccessful ? 1 : 0, responseStatus, responseBody, nextRetryAt, item.id]);
  }

  _insertDelivery(input) {
    try {
      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.deliveryId,
        input.merchantId,
        input.paymentId,
        input.event,
        input.payload,
        input.endpointUrl,
        input.responseStatus,
        input.responseBody,
        input.attemptCount,
        input.isSuccessful ? 1 : 0,
        input.nextRetryAt,
        new Date().toISOString()
      ]);
    } catch (err) {
      // Idempotency index (payment_id, event_type): another worker already
      // recorded this delivery — nothing to do.
      if (!/UNIQUE/i.test(err.message || '')) throw err;
    }
  }

  _markOutboxFlushed(outboxId) {
    try {
      this.db.execute(
        "UPDATE payment_events_outbox SET flushed = 1, updated_at = ? WHERE id = ?",
        [new Date().toISOString(), outboxId]
      );
    } catch {}
  }
}
