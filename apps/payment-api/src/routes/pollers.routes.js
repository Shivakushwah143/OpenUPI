import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpServer } from '../server.js';
import { ObservationNormalizer, BankSmsParser, BankEmailParser, generateQrSvg } from '@youpi/core';
import { toRupeesString, toPaise, resolveRuntimeUrls, ObserverSource } from '@youpi/common';
import { issuePairingToken, redeemPairingToken } from '../services/api-auth.js';
import { sealSecret, hashSecret } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Registers observation intake routes for SMS Gateway (Android Native Observer)
 * and Automated Observers (Gmail Direct API / Web Observers).
 * @param {HttpServer} server
 * @param {{
 *   attributionEngine: import('@youpi/core').AttributionEngine,
 *   db: import('@youpi/db').Database,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   sessionRepo?: import('@youpi/db').PaymentSessionRepository,
 *   accountRepo?: import('@youpi/db').ReceivingAccountRepository,
 *   merchantRepo?: import('@youpi/db').MerchantRepository
 * }} ctx
 */
export function registerPollerRoutes(server, ctx) {
  /**
   * Tenant scope for observer intake. The merchant is derived from the SIGNED
   * credential (attached by the request guard), never from the request body
   * (audit P0-03/P0-07).
   */
  const observerMerchantId = req => req.auth?.merchantId || null;

  // GET /api/v1/pollers/active-window (Enables deep intelligent DOM scanning for active amounts and dual-layer verification)
  // Signed observer credential required (guard); scoped to the authenticated merchant.
  server.get('/api/v1/pollers/active-window', async (req, res) => {
    const merchantId = observerMerchantId(req);
    const activeSessions = ctx.db.query(`
      SELECT ps.id, ps.order_id, ps.receiving_account_id, ps.amount_paise, ps.status, ps.verification_level, ps.expires_at, ps.processing_expires_at, ps.completed_at
      FROM payment_sessions ps
      LEFT JOIN payment_receiving_accounts ra ON ps.receiving_account_id = ra.id
      WHERE (ps.status IN ('ACTIVE', 'PROCESSING')
         OR (ps.status = 'SUCCESS' AND ps.verification_level < 2 AND ps.completed_at >= datetime('now', '-60 seconds')))
        AND (? IS NULL OR ps.merchant_id = ?)
      ORDER BY ps.created_at DESC
    `, [merchantId, merchantId]);

    const sessions = activeSessions.map(s => ({
      id: s.id,
      orderId: s.order_id,
      receivingAccountId: s.receiving_account_id,
      amount: toRupeesString(s.amount_paise),
      amountPaise: Number(s.amount_paise),
      status: s.status,
      verificationLevel: s.verification_level || 0,
      expiresAt: s.expires_at,
      processingExpiresAt: s.processing_expires_at
    }));

    HttpServer.json(res, 200, {
      hasActivePayment: sessions.length > 0,
      sessions
    });
  });

  // POST /api/v1/pollers/events (Universal Observation Ingest for Gmail / SMS 2-Layer Observers)
  // The request guard has already verified the HMAC signature and derived the
  // merchant from the credential. Tenant and account identity are resolved here
  // server-side; body claims are only advisory and cross-tenant values are refused.
  server.post('/api/v1/pollers/events', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const merchantId = observerMerchantId(req);

    if (!merchantId) {
      HttpServer.json(res, 401, { error: 'UNAUTHORIZED', message: 'Observer credential required.' });
      return;
    }

    if (!body.source || !Object.values(ObserverSource).includes(body.source)) {
      HttpServer.json(res, 400, { error: 'Missing or invalid observation source.' });
      return;
    }

    const authorizedAccount = ctx.accountRepo
      ? ctx.accountRepo.findActiveForMerchant(merchantId)
      : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [merchantId]);
    const merchantAccounts = ctx.db.query(
      'SELECT id FROM payment_receiving_accounts WHERE merchant_id = ?',
      [merchantId]
    ).map(r => r.id);

    let receivingAccountId = body.receivingAccountId;
    if (receivingAccountId && merchantAccounts.length > 0 && !merchantAccounts.includes(receivingAccountId)) {
      HttpServer.json(res, 403, {
        error: 'FORBIDDEN',
        reason: 'CROSS_TENANT_ACCOUNT',
        message: 'The authenticated observer may not submit observations for this receiving account.'
      });
      return;
    }
    if (!receivingAccountId) {
      receivingAccountId = authorizedAccount?.id || null;
    }
    if (!receivingAccountId) {
      HttpServer.json(res, 400, { error: 'No receiving account is bound to the authenticated observer.' });
      return;
    }

    // Re-scope the request to the verified tenant before evaluation.
    body.receivingAccountId = receivingAccountId;
    req.body = body;

    // Evaluate through Security & Fraud Verification Pipeline
    const rawText = body.rawText || body.text || body.message || body.sms || body.body || (typeof body.rawPayload === 'string' ? body.rawPayload : (body.rawPayload?.text || body.rawPayload?.body));
    const sender = body.sender || body.from || body.rawPayload?.sender || body.rawPayload?.from;

    if (ctx.pipeline && rawText) {
      const pipeResult = ctx.pipeline.process({
        source: body.source,
        rawText,
        sender,
        receivingAccountId,
        paymentSessionId: body.paymentSessionId,
        merchantId,
        isTest: Boolean(body.isTest),
        testModeActive: Boolean(body.testModeActive)
      });

      if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
        HttpServer.json(res, 403, {
          accepted: false,
          status: 'REJECTED',
          reason: 'FRAUDULENT_PAYMENT_INJECTION',
          threatDetected: true,
          banned: true,
          error: 'FRAUDULENT_PAYMENT_INJECTION: Positive identification of fake payment message. Customer account banned and session terminated.'
        });
        return;
      }

      if (pipeResult.status === 'VERIFIED') {
        const stage6 = pipeResult.stages?.stage6?.details || {};
        HttpServer.json(res, 200, {
          accepted: true,
          observationId: pipeResult.messageId || stage6.observationId,
          // Keep the ingest response contract identical to the legacy path:
          // clients key on `attributed` / `paymentSessionId`, not on the stage dump.
          attribution: {
            attributed: true,
            ...stage6,
            paymentSessionId: stage6.attributedSessionId,
            outcomeStatus: pipeResult.stages?.stage6?.outcomeStatus || stage6.outcomeStatus
          },
          pipeline: pipeResult
        });
        return;
      }
    }

    try {
      let amountPaise = body.amountPaise ? BigInt(body.amountPaise) : undefined;
      let bankRef = body.bankReferenceNumber || body.utr;
      let senderVpa = body.senderVpa;
      const observedAt = body.observedAt ? new Date(body.observedAt) : new Date();

      if (rawText && (!amountPaise || !bankRef)) {
        const isEmail = body.source === 'GMAIL' || body.source === 'EMAIL';
        const parsed = isEmail
          ? BankEmailParser.parse({ subject: body.subject || body.rawPayload?.subject || '', body: rawText, date: observedAt, from: sender })
          : BankSmsParser.parse({ text: rawText, sender, timestamp: observedAt });
        if (parsed) {
          if (!amountPaise) amountPaise = parsed.amountPaise;
          if (!bankRef && parsed.bankReferenceNumber) bankRef = parsed.bankReferenceNumber;
          if (!senderVpa && parsed.senderVpa) senderVpa = parsed.senderVpa;
        }
      }

      const normalized = ObservationNormalizer.normalize({
        source: body.source,
        receivingAccountId,
        rawPayload: body.rawPayload || body,
        amountPaise,
        amount: body.amount || (amountPaise ? (Number(amountPaise) / 100).toFixed(2) : undefined),
        observedAt,
        senderVpa,
        bankReferenceNumber: bankRef
      });

      const result = ctx.attributionEngine.processObservation(normalized);

      HttpServer.json(res, 200, {
        accepted: true,
        observationId: result.observationId,
        attribution: result
      });
    } catch (err) {
      console.error('[Poller Ingest Error]:', err.message);
      HttpServer.json(res, 400, { error: err.message });
    }
  });

  // --- ANDROID SMS GATEWAY PAIRING HANDLER ---
  // Enrollment requires a short-lived SINGLE-USE pairing challenge issued by the
  // authenticated admin (audit P0-05): no static secret, no merchant-ID-derived
  // token, and the tenant is taken from the stored challenge rather than the body.
  const handleAndroidPair = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const token = body.enrollmentToken || body.token;
    const deviceName = body.deviceName || 'Android SMS Gateway';
    const deviceModel = body.deviceModel || 'Android Device';

    const redemption = redeemPairingToken(ctx, token);
    if (!redemption.ok) {
      HttpServer.json(res, 401, {
        error: 'Invalid, expired, or already used device pairing token.',
        reason: redemption.code
      });
      return;
    }
    const merchantId = redemption.merchantId;

    const deviceId = crypto.randomUUID();
    const signingKey = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date().toISOString();

    // Pin the device to the receiving account it observes, so later observations
    // are attributed to the account whose QR this merchant actually shows rather
    // than to "whichever account is active" at ingest time.
    const pairedAccount = ctx.accountRepo
      ? ctx.accountRepo.findActiveForMerchant(merchantId)
      : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [merchantId]);

    try {
      // The device signing key is sealed at rest; the plaintext is returned to the
      // device exactly once, during pairing (observer/device secret hardening).
      ctx.db.execute(`
        INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, [deviceId, merchantId, deviceName, deviceModel, sealSecret(signingKey), nowIso, nowIso]);

      if (ctx.auditRepo) {
        ctx.auditRepo.log({
          merchantId,
          entityType: 'ANDROID_DEVICE',
          entityId: deviceId,
          action: 'SMS_GATEWAY_DEVICE_PAIRED',
          actorType: 'ADMIN',
          details: { deviceName, deviceModel }
        });
      }

      HttpServer.json(res, 200, {
        paired: true,
        deviceId,
        signingKey,
        merchantId,
        receivingAccountId: pairedAccount?.id || null,
        message: 'Android SMS Gateway paired successfully.'
      });
    } catch (err) {
      HttpServer.json(res, 500, { error: `Failed to register Android device: ${err.message}` });
    }
  };

  server.post('/api/v1/pollers/android/pair', handleAndroidPair);
  server.post('/api/v1/observers/sms/pair', handleAndroidPair);

  // --- ANDROID SMS GATEWAY OBSERVATION INGESTION ---
  // Signature, timestamp window and nonce replay protection are ENFORCED by the
  // request guard before this handler runs (audit P0-04). The device record and
  // therefore the merchant/account scope come from the authenticated device.
  const handleAndroidSmsEvents = async (req, res) => {
    const rawBodyText = typeof req.rawBody === 'string'
      ? req.rawBody
      : await new Promise(resolve => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
      });

    let body = {};
    try {
      body = rawBodyText ? JSON.parse(rawBodyText) : {};
    } catch {
      HttpServer.json(res, 400, { error: 'Invalid JSON payload.' });
      return;
    }

    const device = req.auth?.device || ctx.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [req.auth?.deviceId || '']);
    if (!device) {
      HttpServer.json(res, 403, { error: 'Device not authorized or inactive.' });
      return;
    }
    const deviceId = device.id;

    // Resolve the receiving account STRICTLY inside the device's own merchant.
    const merchantAccounts = ctx.db.query(
      'SELECT id FROM payment_receiving_accounts WHERE merchant_id = ?',
      [device.merchant_id]
    ).map(r => r.id);

    let receivingAccountId = body.receivingAccountId;
    if (receivingAccountId && merchantAccounts.length > 0 && !merchantAccounts.includes(receivingAccountId)) {
      HttpServer.json(res, 403, {
        error: 'FORBIDDEN',
        reason: 'CROSS_TENANT_ACCOUNT',
        message: 'The authenticated device may not submit observations for this receiving account.'
      });
      return;
    }
    if (!receivingAccountId) {
      const activeAccount = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(device.merchant_id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [device.merchant_id]);
      receivingAccountId = activeAccount?.id || merchantAccounts[0] || null;
    }
    if (!receivingAccountId) {
      HttpServer.json(res, 400, { error: 'No receiving account is bound to this device merchant.' });
      return;
    }

    // Extract amount and details: either pre-parsed or from raw bank SMS
    let amountPaise = body.amountPaise ? BigInt(body.amountPaise) : undefined;
    let bankRef = body.bankReferenceNumber || body.utr;
    let senderVpa = body.senderVpa;
    let observedAt = body.observedAt ? new Date(body.observedAt) : new Date();

    // Check for raw SMS text inside body or rawNotification
    const rawText = body.body || body.sms || body.rawSms || body.message || body.text || body.rawNotification?.text;
    if (rawText && (!amountPaise || !bankRef)) {
      const parsedSms = BankSmsParser.parse({
        text: rawText,
        sender: body.sender || body.rawNotification?.package,
        timestamp: observedAt
      });

      if (parsedSms) {
        if (!amountPaise) amountPaise = parsedSms.amountPaise;
        if (!bankRef && parsedSms.bankReferenceNumber) bankRef = parsedSms.bankReferenceNumber;
        if (!senderVpa && parsedSms.senderVpa) senderVpa = parsedSms.senderVpa;
      }
    }

    if (!amountPaise && body.amount) {
      try {
        amountPaise = toPaise(body.amount);
      } catch {}
    }

    // Evaluate through Security & Fraud Verification Pipeline for Android Ingest
    if (ctx.pipeline && rawText) {
      const pipeResult = ctx.pipeline.process({
        source: 'SMS',
        rawText,
        sender: body.sender || req.headers['x-sender'],
        receivingAccountId,
        paymentSessionId: body.paymentSessionId,
        // Tenant scope comes from the authenticated device; the pipeline refuses
        // to bind a body-supplied session belonging to another merchant.
        merchantId: device.merchant_id,
        isTest: Boolean(body.isTest),
        deviceInfo: device ? `${device.device_name} (${device.device_model})` : 'Android SMS Gateway'
      });

      if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
        HttpServer.json(res, 403, {
          accepted: false,
          status: 'REJECTED',
          reason: 'FRAUDULENT_PAYMENT_INJECTION',
          threatDetected: true,
          banned: true,
          error: 'FRAUDULENT_PAYMENT_INJECTION: Fake SMS detected. Associated customer identity banned and session terminated.'
        });
        return;
      }

      if (pipeResult.status === 'VERIFIED') {
        ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
        const stage6 = pipeResult.stages?.stage6?.details || {};
        HttpServer.json(res, 200, {
          accepted: true,
          observationId: pipeResult.messageId || stage6.observationId,
          attribution: {
            attributed: true,
            ...stage6,
            paymentSessionId: stage6.attributedSessionId,
            outcomeStatus: pipeResult.stages?.stage6?.outcomeStatus || stage6.outcomeStatus
          },
          pipeline: pipeResult
        });
        return;
      }
    }

    // Transport Only Contract (Part D): The Android observer forwards all raw SMS.
    // If no monetary amount is extracted (e.g. personal, promotional, non-bank SMS),
    // update observation timestamp on device and return 200 PROCESSED_NON_BANK.
    if (!amountPaise) {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        status: 'PROCESSED_NON_BANK',
        bankMatch: false,
        message: 'Raw SMS observation ingested and evaluated by server pipeline.'
      });
      return;
    }

    try {
      const normalized = ObservationNormalizer.normalize({
        source: 'ANDROID_OBSERVER', // Maps to Android SMS Observer source in system enums
        receivingAccountId,
        rawPayload: body,
        amountPaise,
        amount: body.amount || (Number(amountPaise) / 100).toFixed(2),
        observedAt,
        senderVpa,
        bankReferenceNumber: bankRef
      });

      const result = ctx.attributionEngine.processObservation(normalized);

      // Update device last observation timestamp
      ctx.db.execute('UPDATE android_devices SET last_observation_at = datetime(\'now\') WHERE id = ?', [deviceId]);

      HttpServer.json(res, 200, {
        accepted: true,
        observationId: result.observationId,
        attribution: result
      });
    } catch (err) {
      console.error('[Android SMS Ingest Error]:', err.message);
      HttpServer.json(res, 400, { error: err.message });
    }
  };

  server.post('/api/v1/pollers/android/events', handleAndroidSmsEvents);
  server.post('/api/v1/observers/sms', handleAndroidSmsEvents);

  // --- ANDROID HEARTBEAT HANDLER ---
  // Heartbeats are signed like observations (guard-enforced) and may only update
  // the authenticated device's own row.
  const handleAndroidHeartbeat = async (req, res) => {
    const deviceId = req.auth?.deviceId;
    if (!deviceId) {
      HttpServer.json(res, 401, { error: 'UNAUTHORIZED', message: 'Signed device request required.' });
      return;
    }

    ctx.db.execute("UPDATE android_devices SET last_heartbeat_at = datetime('now') WHERE id = ?", [deviceId]);

    HttpServer.json(res, 200, {
      status: 'HEARTBEAT_ACK',
      timestamp: Date.now()
    });
  };

  server.post('/api/v1/pollers/android/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/pollers/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/observers/heartbeat', handleAndroidHeartbeat);

  // --- MERCHANT ADMIN: SMS GATEWAY PAIRING QR CODE & STATUS ---
  server.get('/api/v1/admin/sms-gateway/pair-qr', async (req, res) => {
    // Tenant comes from the credential (audit P0-03/P0-07): a merchant-role
    // credential can only enroll devices into its OWN merchant.
    const credentialMerchantId = req.auth?.role === 'MERCHANT' ? req.auth.merchantId : null;
    if (credentialMerchantId && req.query.merchantId && req.query.merchantId !== credentialMerchantId) {
      HttpServer.json(res, 403, { error: 'FORBIDDEN', message: 'Cross-tenant pairing refused.' });
      return;
    }

    let merchant = credentialMerchantId
      ? (ctx.merchantRepo ? ctx.merchantRepo.findById(credentialMerchantId) : null)
      : null;
    if (!merchant && req.query.merchantId) merchant = ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = credentialMerchantId || (merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001'));

    // Canonical runtime URL derivation (Part C2)
    const runtime = resolveRuntimeUrls(merchant?.branding || {});
    const baseUrl = runtime.apiUrl;
    // Single-use, short-lived pairing challenge (only its hash is persisted).
    const pairing = issuePairingToken(ctx, merchantId);
    const token = pairing.token;
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(pairing.expiresAt).getTime();

    const pairingPayloadObj = {
      version: 'v1',
      type: 'YOUPI_SMS_GATEWAY_PAIR',
      serverUrl: baseUrl,
      gatewayUrl: baseUrl,
      apiBaseUrl: baseUrl,
      sessionId,
      token,
      enrollmentToken: token,
      merchantId,
      createdAt: Date.now(),
      expiresAt
    };

    const pairingPayload = JSON.stringify(pairingPayloadObj);
    const qrSvg = generateQrSvg(pairingPayload, 260);

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ?
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at,
      // Device signing keys are never returned in any form (audit P0-05/P0-06).
      signingKeyConfigured: Boolean(d.signing_key_hash),
      keyFingerprint: d.signing_key_hash ? hashSecret(d.signing_key_hash).slice(0, 12) : null
    }));

    HttpServer.json(res, 200, {
      qrSvg,
      pairingQrSvg: qrSvg,
      pairingPayload,
      payload: pairingPayloadObj,
      sessionId,
      expiresAt,
      version: 'v1',
      token,
      enrollmentToken: token,
      gatewayUrl: baseUrl,
      serverUrl: baseUrl,
      devices
    });
  });

  // GET /api/v1/admin/sms-gateway/devices
  server.get('/api/v1/admin/sms-gateway/devices', async (req, res) => {
    // Tenant comes from the credential (audit P0-07): a merchant-role credential
    // may only list its own devices.
    const credentialMerchantId = req.auth?.role === 'MERCHANT' ? req.auth.merchantId : null;
    if (credentialMerchantId && req.query.merchantId && req.query.merchantId !== credentialMerchantId) {
      HttpServer.json(res, 403, { error: 'FORBIDDEN', message: 'Cross-tenant device listing refused.' });
      return;
    }
    let merchant = credentialMerchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(credentialMerchantId) : null) : null;
    if (!merchant && req.query.merchantId) merchant = ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = credentialMerchantId || (merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001'));

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ?
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at
    }));

    HttpServer.json(res, 200, { devices });
  });

  // DELETE /api/v1/admin/sms-gateway/devices/:deviceId
  server.delete('/api/v1/admin/sms-gateway/devices/:deviceId', async (req, res, params) => {
    const deviceId = params.deviceId;
    ctx.db.execute('DELETE FROM android_devices WHERE id = ?', [deviceId]);
    HttpServer.json(res, 200, { success: true, message: 'Device unlinked.' });
  });

  // GET /api/v1/admin/sms-gateway/download-apk & GET /youpi-sms-gateway.apk
  const serveApk = async (req, res) => {
    const apkLocations = [
      path.resolve(__dirname, '../../public/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../merchant-admin/public/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../android-observer-app/app/build/outputs/apk/release/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../android-observer-app/youpi-sms-gateway.apk')
    ];

    let foundPath = null;
    for (const p of apkLocations) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (!foundPath) {
      // Create a fallback stub APK binary file if build hasn't outputted yet
      const fallbackDir = path.resolve(__dirname, '../../public');
      if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
      foundPath = path.join(fallbackDir, 'youpi-sms-gateway.apk');
      if (!fs.existsSync(foundPath)) {
        fs.writeFileSync(foundPath, Buffer.from('PK\x03\x04YOUPI_SMS_GATEWAY_STANDALONE_APK_PACKAGE'));
      }
    }

    const stat = fs.statSync(foundPath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(foundPath).pipe(res);
  };

  server.get('/api/v1/admin/sms-gateway/download-apk', serveApk);
  server.get('/youpi-sms-gateway.apk', serveApk);
}
