import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentStatus } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_CHECKOUT_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}
import {
  getDatabase,
  ensureDatabaseInitialized,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  CustomerSessionRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  DeviceRepository,
  ObserverCredentialRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  WebhookEngine,
  PaymentVerificationPipeline
} from '@youpi/core';
import { HttpServer } from './server.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerCheckoutRoutes } from './routes/checkout.routes.js';
import { registerPollerRoutes } from './routes/pollers.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { getWhatsAppBerryService, WhatsAppBerryService } from './services/whatsapp-berry.service.js';
import {
  requireAdmin,
  verifySignedRequest,
  verifySignedDeviceRequest,
  resolveObserverCredential,
  resolveDeviceSecret,
  enforceSecureTransport,
  identifyPrincipal,
  resolveAdminApiKey,
  isProduction,
  MERCHANT_ALLOWED_ADMIN_PATHS,
  MERCHANT_ROLE,
  OBSERVER_ROLE
} from './services/api-auth.js';

export function createPaymentApp(customDb = null, options = {}) {
  const db = customDb || getDatabase();
  ensureDatabaseInitialized(db);
  const { defaultMerchant } = runMigrations(db);
  const isCustom = !!customDb;
  const whatsappBerryService = options.whatsappBerryService || (isCustom ? new WhatsAppBerryService({
    sessionId: 'test_berry_session',
    sessionPath: path.resolve(rootDir, 'data/test_berry_auth'),
    databasePath: path.resolve(rootDir, 'data/test_berry_store.db'),
    metaFile: path.resolve(rootDir, 'data/test_whatsapp_session.json')
  }) : getWhatsAppBerryService());

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const customerRepo = new CustomerRepository(db);
  const customerSessionRepo = new CustomerSessionRepository(db, customerRepo);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const deviceRepo = new DeviceRepository(db);
  const observerCredentialRepo = new ObserverCredentialRepository(db);

  const eventEmitter = new EventEmitter();

  const queueEngine = new QueueEngine({
    sessionRepo,
    accountRepo,
    eventEmitter,
    auditRepo
  });

  const timingEngine = new TimingEngine({
    sessionRepo,
    queueEngine,
    eventEmitter,
    auditRepo,
    activeDurationMs: Number(process.env.PAYMENT_ACTIVE_WINDOW_MS || 300000),
    processingDurationMs: Number(process.env.PAYMENT_PROCESSING_WINDOW_MS || 30000)
  });

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    eventEmitter
  });

  const recoveryEngine = new RecoveryEngine({
    db,
    sessionRepo,
    accountRepo,
    queueEngine,
    timingEngine,
    auditRepo
  });

  const webhookEngine = new WebhookEngine({
    db,
    merchantRepo,
    maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES || 5)
  });

  const server = new HttpServer();
  let checkoutBaseUrl = process.env.BASE_CHECKOUT_URL || 'http://localhost:7000';
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      const raw = fs.readFileSync(rootEnv, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BASE_CHECKOUT_URL=')) {
          const val = trimmed.split('=')[1]?.trim();
          if (val) checkoutBaseUrl = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {}

  // BULLETPROOF QUEUE PROMOTION HANDLER
  function handleSlotFreedAndPromote(receivingAccountId) {
    if (!receivingAccountId) return null;
    const promoted = queueEngine.promoteNext(receivingAccountId);
    if (promoted) {
      if (promoted.expiresAt) {
        timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
      server.broadcastSse(promoted.id, 'status_change', {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: promoted.expiresAt
      });
      server.broadcastSse(`queue_${receivingAccountId}`, 'queue_update', {
        promotedId: promoted.id
      });
    }
    return promoted;
  }

  // When a payment succeeds, fails, expires, or cancels: dispatch webhook & promote next queued customer
  eventEmitter.on('PAYMENT.SUCCESS', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.SUCCESS,
        verificationLevel: data.verificationLevel || session.verificationLevel || 1,
        verificationTag: data.verificationTag || session.verificationTag,
        sources: data.sources || session.verificationSources
      });
      webhookEngine.dispatch('SUCCESS', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.LEVEL1_VERIFIED', (data) => {
    server.broadcastSse(data.paymentId, 'status_change', {
      status: 'VERIFYING',
      verificationLevel: 1,
      verificationTag: data.verificationTag,
      message: 'Payment detected! Verifying secondary channel...'
    });
  });

  eventEmitter.on('PAYMENT.FAILED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('FAILED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.EXPIRED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.EXPIRED
      });
      webhookEngine.dispatch('EXPIRED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.CANCELLED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.CANCELLED
      });
      webhookEngine.dispatch('CANCELLED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.FRAUD_BLOCKED', (data) => {
    if (data.sessionId) {
      server.broadcastSse(data.sessionId, 'status_change', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true
        }
      });
      server.broadcastSse(data.sessionId, 'account_blocked', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION'
      });
    }
  });

  // Active 30-Second Verification Polling Orchestrator (Triple Verification Standard):
  // Concurrently sweeps Gmail, Google Messages SMS, and Android Observer every 1.5s
  // Continues polling for remaining sources until Level 3 (Triple Verification) is reached or 30s window finishes!
  const activeSweepTimers = new Set();

  eventEmitter.on('SESSION.PROCESSING', (data) => {
    const sessionId = data.sessionId;
    let sweepCount = 0;
    const maxSweeps = 20; // 20 sweeps * 1.5s = 30 seconds

    const sweepTimer = setInterval(async () => {
      try {
        sweepCount++;
        const current = sessionRepo.findById(sessionId);

        // Stop polling if session is terminal failed/expired/cancelled, or reached full Triple Verification (level >= 3), or exceeded 30s
        const isCompleteOrCancelled = !current ||
          current.status === PaymentStatus.FAILED ||
          current.status === PaymentStatus.EXPIRED ||
          current.status === PaymentStatus.CANCELLED ||
          (current.verificationLevel >= 3) ||
          sweepCount >= maxSweeps;

        if (isCompleteOrCancelled) {
          clearInterval(sweepTimer);
          activeSweepTimers.delete(sweepTimer);
          return;
        }

        // Sweep 1: Google Messages Web SMS
        try {
          const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
          fetch(`http://localhost:${smsPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(1200) }).catch(() => {});
        } catch {}

        // Sweep 2: Gmail Inbox
        try {
          const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
          fetch(`http://localhost:${gmailPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(1200) }).catch(() => {});
        } catch {}

        // Sweep 3: Check pending/unattributed Android push notifications in DB
        try {
          const unattributed = obsRepo.findUnattributed(current.receivingAccountId);
          for (const obs of unattributed) {
            attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          }
        } catch {}
      } catch {
        clearInterval(sweepTimer);
        activeSweepTimers.delete(sweepTimer);
      }
    }, 1500);

    if (sweepTimer.unref) sweepTimer.unref();
    activeSweepTimers.add(sweepTimer);
  });

  // Continuous 1-second background queue sync and auto-expiry daemon
  const queueSyncDaemon = setInterval(() => {
    try {
      const nowIso = new Date().toISOString();

      // Sweep expired ACTIVE sessions
      const expiredActive = db.query(`
        SELECT id, receiving_account_id FROM payment_sessions
        WHERE status = 'ACTIVE' AND expires_at <= ?
      `, [nowIso]);

      for (const row of expiredActive) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.EXPIRED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Sweep failed PROCESSING sessions
      const failedProc = db.query(`
        SELECT id, receiving_account_id FROM payment_sessions
        WHERE status = 'PROCESSING' AND processing_expires_at <= ?
      `, [nowIso]);

      for (const row of failedProc) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.FAILED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Scan for vacant receiving accounts that have waiting queued sessions
      const vacantAccounts = db.query(`
        SELECT id FROM payment_receiving_accounts
        WHERE is_active = 1 AND (is_slot_busy = 0 OR current_active_session_id IS NULL)
      `);

      for (const acc of vacantAccounts) {
        handleSlotFreedAndPromote(acc.id);
      }
    } catch {}
  }, 1000);

  if (queueSyncDaemon.unref) queueSyncDaemon.unref();

  // Durable webhook delivery worker (audit P1-06): flushes the transactional
  // outbox and retries failed deliveries with backoff. Runs in-process so a
  // crash/restart cannot lose a notification; `processOnce()` is idempotent.
  const webhookWorkerIntervalMs = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS || 5000);
  let webhookWorkerBusy = false;
  const webhookWorkerDaemon = setInterval(async () => {
    if (webhookWorkerBusy) return;
    webhookWorkerBusy = true;
    try {
      await webhookEngine.processOnce();
    } catch (err) {
      console.error('[WebhookWorker]', err.message);
    } finally {
      webhookWorkerBusy = false;
    }
  }, webhookWorkerIntervalMs);
  if (webhookWorkerDaemon.unref) webhookWorkerDaemon.unref();

  // Boot catch-up: deliver anything the previous process had not flushed.
  webhookEngine.processOnce().catch(() => {});

  // Continuous 1-Second Aggressive Polling Daemon across SMS Gateway & Gmail Observers
  const aggressivePollerDaemon = setInterval(async () => {
    try {
      // Find all active/processing sessions currently waiting for bank confirmation
      const activeSessions = db.query(`
        SELECT id, receiving_account_id, amount_paise, status
        FROM payment_sessions
        WHERE status IN ('ACTIVE', 'PROCESSING') AND method = 'UPI'
      `);

      if (activeSessions.length === 0) return;

      // 1. Poll SMS Observer
      try {
        const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
        fetch(`http://localhost:${smsPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
      } catch {}

      // 2. Poll Gmail Observer
      try {
        const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
        fetch(`http://localhost:${gmailPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
      } catch {}

      // 3. Sweep any pending unattributed observations in DB matching active sessions
      for (const session of activeSessions) {
        try {
          const unattributed = obsRepo.findUnattributed(session.receiving_account_id);
          for (const obs of unattributed) {
            attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          }
        } catch {}
      }
    } catch {}
  }, 1000);

  if (aggressivePollerDaemon.unref) aggressivePollerDaemon.unref();

  // Execute crash recovery on boot
  const recoveryStats = recoveryEngine.recover();

  // Health check routes
  const healthHandler = (req, res) => {
    HttpServer.json(res, 200, {
      status: 'UP',
      service: 'payment-api',
      timestamp: new Date().toISOString(),
      recoveryStats
    });
  };
  server.get('/health', healthHandler);
  server.get('/api/v1/health', healthHandler);

  const pipeline = new PaymentVerificationPipeline({
    db,
    sessionRepo,
    obsRepo,
    customerRepo,
    attributionEngine,
    auditRepo,
    merchantRepo,
    server,
    eventEmitter
  });

  const context = {
    db,
    merchantRepo,
    accountRepo,
    customerRepo,
    customerSessionRepo,
    sessionRepo,
    deviceRepo,
    observerCredentialRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    queueEngine,
    timingEngine,
    attributionEngine,
    pipeline,
    recoveryEngine,
    eventEmitter,
    defaultMerchant,
    checkoutBaseUrl,
    whatsappBerryService,
    webhookEngine
  };

  // ---------------------------------------------------------------------------
  // Server-enforced authentication / authorization (audit P0-02..P0-07).
  // Runs before ANY route handler; identity always comes from a credential, never
  // from caller-supplied merchant/account IDs.
  // ---------------------------------------------------------------------------
  const OBSERVER_SIGNED_PATHS = new Set([
    '/api/v1/pollers/events',
    '/api/v1/pollers/active-window'
  ]);
  const DEVICE_SIGNED_PATHS = new Set([
    '/api/v1/pollers/android/events',
    '/api/v1/observers/sms',
    '/api/v1/pollers/android/heartbeat',
    '/api/v1/pollers/heartbeat',
    '/api/v1/observers/heartbeat'
  ]);

  if (isProduction() && !resolveAdminApiKey()) {
    throw new Error(
      'Refusing to start: ADMIN_API_KEY is not configured. Administrative APIs are never exposed unsigned in production.'
    );
  }
  if (isProduction() && !String(process.env.YOUPI_SECRET_KEY || process.env.OPENUPI_SECRET_KEY || '').trim()) {
    throw new Error(
      'Refusing to start: YOUPI_SECRET_KEY is not configured. Observer/device secrets cannot be protected at rest without it.'
    );
  }

  server.setRequestGuard(async (req, res, pathname, method) => {
    // Authenticated surfaces are TLS-only in production (observer hardening item 1).
    const authenticatedSurface = pathname.startsWith('/api/v1/admin/')
      || OBSERVER_SIGNED_PATHS.has(pathname)
      || DEVICE_SIGNED_PATHS.has(pathname);
    if (authenticatedSurface && !enforceSecureTransport(req, res)) return false;

    const needsRawBody = OBSERVER_SIGNED_PATHS.has(pathname) || DEVICE_SIGNED_PATHS.has(pathname);
    if (needsRawBody) {
      req.rawBody = await new Promise(resolve => {
        let data = '';
        let aborted = false;
        req.on('data', chunk => {
          if (aborted) return;
          data += chunk;
          if (data.length > 256 * 1024) {
            aborted = true;
            HttpServer.json(res, 413, { error: 'Payload Too Large' });
            req.destroy();
          }
        });
        req.on('end', () => resolve(data));
        req.on('error', () => resolve(data));
      });
      if (res.writableEnded) return false;
    }

    // --- Administrative & merchant-management surface ---
    if (pathname.startsWith('/api/v1/admin/')) {
      const merchantScoped = MERCHANT_ALLOWED_ADMIN_PATHS.includes(pathname);
      const principal = requireAdmin(req, res, { ctx: context, allowMerchant: merchantScoped });
      if (!principal) return false;
      if (principal.role === MERCHANT_ROLE) {
        const claimed = req.headers['x-merchant-id'];
        if (claimed && claimed !== principal.merchantId) {
          HttpServer.json(res, 403, { error: 'FORBIDDEN', message: 'Cross-tenant administrative access refused.' });
          return false;
        }
      }
      req.auth = principal;
      return true;
    }

    // --- Trusted observer ingest (signed, tenant derived from credential) ---
    if (OBSERVER_SIGNED_PATHS.has(pathname)) {
      const credential = resolveObserverCredential(req, context);
      if (!credential.ok) {
        HttpServer.json(res, 401, {
          error: 'UNAUTHORIZED',
          reason: credential.code,
          message: 'Observer credential required (X-Observer-Key).'
        });
        return false;
      }
      const verified = verifySignedRequest({
        req,
        res,
        ctx: context,
        secret: credential.secret,
        scope: `observer:${credential.credential.id}`,
        rawBody: req.rawBody || ''
      });
      if (!verified) return false;
      if (context.observerCredentialRepo) context.observerCredentialRepo.touch(credential.credential.id);
      req.auth = {
        role: OBSERVER_ROLE,
        actorId: `observer:${credential.credential.id}`,
        credentialId: credential.credential.id,
        keyId: credential.credential.keyId,
        merchantId: credential.merchant.id,
        merchant: credential.merchant
      };
      return true;
    }

    // --- Android/SMS device ingest (signed with the paired device key) ---
    if (DEVICE_SIGNED_PATHS.has(pathname)) {
      let deviceId = req.headers['x-device-id'];
      if (!deviceId && req.rawBody) {
        try {
          deviceId = JSON.parse(req.rawBody || '{}').deviceId;
        } catch { /* ignored: reported as missing device id */ }
      }
      if (!deviceId) {
        HttpServer.json(res, 401, { error: 'UNAUTHORIZED', reason: 'MISSING_DEVICE_ID', message: 'Signed device request requires X-Device-Id.' });
        return false;
      }
      const device = context.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [deviceId]);
      if (!device) {
        HttpServer.json(res, 403, { error: 'FORBIDDEN', message: 'Device not authorized or inactive.' });
        return false;
      }
      const deviceSecret = resolveDeviceSecret(device);
      if (!deviceSecret.ok) {
        HttpServer.json(res, 403, { error: 'FORBIDDEN', reason: deviceSecret.code, message: 'Device signing key is unavailable.' });
        return false;
      }
      const verified = verifySignedDeviceRequest({
        req,
        res,
        ctx: context,
        secret: deviceSecret.secret,
        scope: `device:${deviceId}`,
        rawBody: req.rawBody || ''
      });
      if (!verified) return false;
      req.auth = { role: 'OBSERVER_DEVICE', actorId: deviceId, merchantId: device.merchant_id, deviceId, device };
      return true;
    }

    // --- Merchant payment creation: credential-scoped tenant (P0-07) ---
    if (pathname === '/api/v1/payments' && method === 'POST') {
      const principal = identifyPrincipal(req, context);
      // Fail closed everywhere: payment creation always requires a credential.
      if (!principal) {
        HttpServer.json(res, 401, {
          error: 'UNAUTHORIZED',
          message: 'A merchant (X-API-Key) or operator (X-Admin-Key) credential is required to create payments.'
        });
        return false;
      }
      if (!enforceSecureTransport(req, res)) return false;
      if (principal.role === MERCHANT_ROLE) {
        const claimed = req.headers['x-merchant-id'];
        if (claimed && claimed !== principal.merchantId) {
          HttpServer.json(res, 403, { error: 'FORBIDDEN', message: 'Cross-tenant payment creation refused.' });
          return false;
        }
      }
      req.auth = principal;
      return true;
    }

    return true;
  });

  registerPaymentRoutes(server, context);
  registerCheckoutRoutes(server, context);
  registerPollerRoutes(server, context);
  registerAdminRoutes(server, context);
  registerCustomerRoutes(server, context);
  registerDeviceRoutes(server, context);

  function destroy() {
    clearInterval(queueSyncDaemon);
    clearInterval(aggressivePollerDaemon);
    clearInterval(webhookWorkerDaemon);
    for (const timer of activeSweepTimers) {
      clearInterval(timer);
    }
    activeSweepTimers.clear();
    timingEngine.destroy();
    if (typeof attributionEngine.destroy === 'function') {
      attributionEngine.destroy();
    }
  }

  return {
    server,
    context,
    destroy,
    rawServer: server.createServer()
  };
}

export function startServer(port = null, customDb = null) {
  const finalPort = port || Number(process.env.PAYMENT_API_PORT || 6100);
  const app = createPaymentApp(customDb);

  return new Promise(resolve => {
    const instance = app.rawServer.listen(finalPort, () => {
      console.log(`[Payment API] Server listening on port ${finalPort}`);
      resolve({
        app,
        port: finalPort,
        close: () => new Promise(cb => {
          app.destroy();
          instance.close(cb);
        })
      });
    });
  });
}

// Auto-run if executed directly as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
