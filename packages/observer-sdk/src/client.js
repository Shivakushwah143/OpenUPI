import { generateHmac, signObserverRequest } from '@youpi/common';

export class PaymentObserverClient {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   sourceName: string,
   *   observerKey?: string
   * }} options
   */
  constructor(options) {
    this.apiBaseUrl = (options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100').replace(/\/+$/, '');
    this.sourceName = options.sourceName;
    // Observer credential (merchant API key). Required: observer ingest rejects
    // unsigned or unknown-credential requests (audit P0-03).
    this.observerKey = options.observerKey || process.env.YOUPI_OBSERVER_KEY || process.env.YOUPI_MERCHANT_API_KEY || '';
  }

  /**
   * Builds the signed headers required by every trusted observer call.
   * @param {string} path
   * @param {'GET'|'POST'} method
   * @param {string} rawBody
   */
  signedHeaders(path, method, rawBody = '') {
    if (!this.observerKey) {
      throw new Error('Observer credential missing: set observerKey or YOUPI_OBSERVER_KEY before calling the gateway.');
    }
    return {
      'Content-Type': 'application/json',
      ...signObserverRequest({
        secret: this.observerKey,
        method,
        path,
        rawBody
      })
    };
  }

  /**
   * Signed GET used for active-window discovery.
   */
  async getActiveWindow() {
    const path = '/api/v1/pollers/active-window';
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: this.signedHeaders(path, 'GET', '')
    });
    if (!res.ok) {
      throw new Error(`Observer active-window failed [HTTP ${res.status}]`);
    }
    return await res.json();
  }

  /**
   * Submits a normalized or semi-normalized observation to Payment Core.
   * @param {{
   *   receivingAccountId: string,
   *   amountPaise?: bigint | number,
   *   amount?: string | number,
   *   observedAt?: Date | string,
   *   senderVpa?: string,
   *   bankReferenceNumber?: string,
   *   rawPayload?: Record<string, any>
   * }} data
   * @returns {Promise<{ accepted: boolean, observationId: string, attribution: any }>}
   */
  async submitObservation(data) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/events`;
    const payload = {
      source: this.sourceName,
      receivingAccountId: data.receivingAccountId,
      amountPaise: data.amountPaise !== undefined ? data.amountPaise.toString() : undefined,
      amount: data.amount,
      observedAt: (data.observedAt instanceof Date ? data.observedAt : new Date(data.observedAt || Date.now())).toISOString(),
      senderVpa: data.senderVpa,
      bankReferenceNumber: data.bankReferenceNumber,
      sender: data.sender || data.rawPayload?.sender || data.rawPayload?.from,
      rawText: data.rawText || data.rawPayload?.text || data.rawPayload?.body,
      rawPayload: data.rawPayload || {}
    };

    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: this.signedHeaders('/api/v1/pollers/events', 'POST', body),
      body
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Observer submit failed [HTTP ${res.status}]: ${errBody}`);
    }

    return await res.json();
  }

  /**
   * Submits signed observation from Android Observer with HMAC-SHA256 signature.
   * @param {{
   *   deviceId: string,
   *   signingKey: string,
   *   receivingAccountId?: string,
   *   amount?: string | number,
   *   amountPaise?: bigint | number,
   *   observedAt?: Date | string,
   *   rawNotification?: Record<string, any>
   * }} data
   */
  async submitAndroidSigned(data) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/events`;
    const timestamp = Date.now().toString();

    const bodyObj = {
      deviceId: data.deviceId,
      receivingAccountId: data.receivingAccountId,
      amount: data.amount,
      amountPaise: data.amountPaise !== undefined ? data.amountPaise.toString() : undefined,
      observedAt: (data.observedAt instanceof Date ? data.observedAt : new Date(data.observedAt || Date.now())).toISOString(),
      rawNotification: data.rawNotification || {}
    };

    const bodyString = JSON.stringify(bodyObj);
    const sigPayload = `${bodyString}:${timestamp}`;
    const signature = generateHmac(sigPayload, data.signingKey);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': data.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyString
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Android observation submit failed [HTTP ${res.status}]: ${errBody}`);
    }

    return await res.json();
  }

  /**
   * Submits Android heartbeat.
   * @param {string} deviceId
   */
  /**
   * Submits a signed Android heartbeat (heartbeats are authenticated like observations).
   * @param {string} deviceId
   * @param {string} signingKey
   */
  async submitHeartbeat(deviceId, signingKey) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/heartbeat`;
    const timestamp = Date.now().toString();
    const bodyString = JSON.stringify({ deviceId });
    const signature = generateHmac(`${bodyString}:${timestamp}`, signingKey);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyString
    });
    return await res.json();
  }
}
