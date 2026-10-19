import { HttpServer } from '../server.js';
import { toRupeesString, buildUpiUri, PaymentStatus, PaymentMethod, ConfirmationStatus, UPI_PROVIDERS } from '@youpi/common';
import { validateSessionDeviceAccess } from '@youpi/core';
import { requireCheckoutAccess } from '../services/api-auth.js';

/**
 * Validates device access to an active payment session.
 * Enforces:
 * 1. If session has no device binding yet, binds to requesting device if provided.
 * 2. If session is bound to Device A, Device B receives DUPLICATE_SESSION_DETECTED (HTTP 409).
 */
function checkSessionDeviceAccess(session, req, body = null, ctx = null) {
  // If session is already in a terminal state, allow access so terminal status can be rendered
  if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
    return { allowed: true, boundDeviceId: session.deviceId, isTerminal: true };
  }

  // Internal server-side HTML render calls bypass device blocking
  if (req.headers['x-internal-render'] === 'true') {
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  const requestingDeviceId = req.headers['x-device-id'] ||
    body?.deviceId ||
    (req.query && req.query.deviceId) ||
    null;

  // If session does not have a device binding yet:
  if (!session.deviceId) {
    if (requestingDeviceId) {
      if (ctx?.deviceRepo) {
        let dev = ctx.deviceRepo.findById(requestingDeviceId);
        if (!dev) {
          try {
            ctx.deviceRepo.create({
              id: requestingDeviceId,
              publicKey: `adhoc_${requestingDeviceId}`,
              fingerprintHash: `fp_${requestingDeviceId}`
            });
          } catch {}
        } else {
          ctx.deviceRepo.touch(requestingDeviceId);
        }
      }
      if (ctx?.sessionRepo) {
        try {
          ctx.sessionRepo.bindDevice(session.id, requestingDeviceId);
          session.deviceId = requestingDeviceId;
        } catch (err) {
          console.warn('[checkSessionDeviceAccess] bindDevice error:', err.message);
        }
      }
    }
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  // If session HAS a bound device:
  // Allow if requesting device matches bound device OR if requesting device is omitted on same session
  if (!requestingDeviceId || requestingDeviceId === session.deviceId) {
    if (requestingDeviceId && ctx?.deviceRepo) {
      ctx.deviceRepo.touch(requestingDeviceId);
    }
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  // Device mismatch: only reject if an explicitly DIFFERENT device ID was provided!
  return {
    allowed: false,
    statusCode: 409,
    body: {
      error: 'DUPLICATE_SESSION_DETECTED',
      session_id: session.id,
      conflicting_session_id: session.id,
      action: 'END_SESSION_AND_CREATE_NEW',
      message: 'This payment session was created on another device. For security reasons, this session cannot be continued from this device.',
      boundDeviceId: session.deviceId,
      requestingDeviceId
    }
  };
}

/**
 * Registers customer checkout portal routes.
 * @param {HttpServer} server
 * @param {{
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   queueEngine: import('@youpi/core').QueueEngine,
 *   timingEngine: import('@youpi/core').TimingEngine
 * }} ctx
 */
/**
 * Determines whether UPI pollers / observers (Android SMS, Google Messages, Gmail) are active.
 * Strict Rule: Healthy (WORKING) ONLY IF:
 * 1. Gmail OAuth is configured AND Gmail observer is actively polling.
 * 2. SMS Gateway is connected (Android app or Google Messages) AND actively polling / reflecting messages.
 * If either is missing, unconfigured, or offline, status is ISSUES with downtime warning.
 */
// ---------------------------------------------------------------------------
// Observer health probes (advisory indicator ONLY: never part of any payment
// decision). These are loopback HTTP calls to the observer services, so they
// used to put the observer services' response time directly on the checkout
// status path. Measured effect before this change: 133 of 135 ms of a
// `GET /api/v1/checkout/:id/state` call, which is the request the checkout makes
// the moment a payment observation arrives over SSE.
//
// Three targeted properties restore bounded, predictable latency:
//   1. probes run concurrently, not sequentially;
//   2. a short TTL memo keyed on the cheap local signals (active device, Gmail
//      config, observer ports) so a polling loop pays the probe at most once;
//   3. stale-while-revalidate: an expired entry is served immediately and
//      refreshed in the background, so no status read ever blocks on a probe.
// ---------------------------------------------------------------------------
const OBSERVER_PROBE_TIMEOUT_MS = Number(process.env.OBSERVER_PROBE_TIMEOUT_MS || 300);
const OBSERVER_HEALTH_TTL_MS = Number(process.env.OBSERVER_HEALTH_TTL_MS || 1000);
const OBSERVER_HEALTH_STALE_MAX_MS = Number(process.env.OBSERVER_HEALTH_STALE_MAX_MS || 10000);
/** @type {Map<string, { at: number, fingerprint: string, value: any, refreshing: boolean }>} */
const observerHealthCache = new Map();

/** Cheap local inputs that can change the health verdict without any network probe. */
function observerHealthFingerprint(ctx, merchantId) {
  let androidDeviceId = '';
  try {
    const row = ctx.db
      ? ctx.db.queryOne("SELECT id FROM android_devices WHERE is_active = 1 AND last_heartbeat_at >= datetime('now', '-5 minutes') LIMIT 1")
      : null;
    androidDeviceId = row?.id || '';
  } catch { /* treated as "no device" */ }

  let hasRefreshToken = 0;
  let hasApiKey = 0;
  try {
    const branding = (ctx.merchantRepo?.findById ? ctx.merchantRepo.findById(merchantId) : null)?.branding || {};
    const gmailConfig = branding.gmailConfig || {};
    hasRefreshToken = gmailConfig.refreshToken && String(gmailConfig.refreshToken).trim() ? 1 : 0;
    hasApiKey = gmailConfig.apiKey && String(gmailConfig.apiKey).trim() ? 1 : 0;
  } catch { /* treated as unconfigured */ }

  return [
    androidDeviceId,
    hasRefreshToken,
    hasApiKey,
    Number(process.env.SMS_OBSERVER_PORT || 6002),
    Number(process.env.GMAIL_OBSERVER_PORT || 6003)
  ].join('|');
}

/** Display name of the most recently heartbeating Android device. */
function activeDeviceName(ctx) {
  try {
    const row = ctx.db
      ? ctx.db.queryOne("SELECT device_name FROM android_devices WHERE is_active = 1 AND last_heartbeat_at >= datetime('now', '-5 minutes') LIMIT 1")
      : null;
    return row?.device_name || 'Enrolled Device';
  } catch {
    return 'Enrolled Device';
  }
}

/** GETs a loopback observer endpoint; null on any error/timeout. */
async function probeObserverJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OBSERVER_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Resolves observer liveness. All independent probes run concurrently; the whole
 * function is bounded by OBSERVER_PROBE_TIMEOUT_MS per probe stage.
 */
async function probeObserverHealth(ctx, merchantId, fingerprint) {
  const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
  const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
  const parts = String(fingerprint || '').split('|');
  const hasActiveDevice = Boolean(parts[0]);
  const hasRefreshToken = parts[1] === '1';
  const gmailConfigured = hasRefreshToken || parts[2] === '1';

  const smsProbe = hasActiveDevice
    ? Promise.resolve({ ok: true, reason: `Android SMS Gateway Active (${activeDeviceName(ctx)})` })
    : probeObserverJson(`http://127.0.0.1:${smsPort}/api/browser/status`).then(data => {
        const isRecent = data?.lastSeenAt && (Date.now() - new Date(data.lastSeenAt).getTime() < 300000);
        const ok = Boolean(data && data.isPaired === true && data.status === 'CONNECTED' && data.mode === 'BACKGROUND' && (data.isPolling === true || isRecent));
        return { ok, reason: ok ? 'Google Messages SMS Gateway active & paired' : 'SMS gateway disconnected' };
      });

  const gmailProbe = (async () => {
    if (gmailConfigured) {
      const [health, browser] = await Promise.all([
        probeObserverJson(`http://127.0.0.1:${gmailPort}/health`),
        probeObserverJson(`http://127.0.0.1:${gmailPort}/api/browser/status`)
      ]);
      let pollerActive = health?.status === 'UP' || Boolean(browser && (browser.isLoggedIn || browser.status === 'CONNECTED' || browser.isPolling));
      if (!pollerActive) {
        const automator = await probeObserverJson('http://127.0.0.1:6099/health');
        pollerActive = Boolean(automator && automator.status === 'UP' && (automator.isPolling || automator.pollerActive !== false));
      }
      // Unchanged semantics: a configured refresh token counts as an active poller.
      const ok = pollerActive || hasRefreshToken;
      return {
        ok,
        reason: ok ? 'Gmail OAuth connected and actively polling' : 'Gmail OAuth configured but observer service is offline'
      };
    }
    const browser = await probeObserverJson(`http://127.0.0.1:${gmailPort}/api/browser/status`);
    const ok = Boolean(browser && browser.isLoggedIn === true && browser.status === 'CONNECTED');
    return { ok, reason: ok ? 'Gmail browser automator logged in' : 'Gmail OAuth not configured' };
  })();

  const [sms, gmail] = await Promise.all([smsProbe, gmailProbe]);
  return {
    smsHealthy: Boolean(sms.ok),
    smsReason: sms.reason,
    gmailHealthy: Boolean(gmail.ok),
    gmailReason: gmail.reason
  };
}

/** Memoized observer health with stale-while-revalidate (see block comment above). */
function getObserverHealth(ctx, merchantId) {
  const fingerprint = observerHealthFingerprint(ctx, merchantId);
  const cached = observerHealthCache.get(merchantId);
  const now = Date.now();

  if (cached && cached.fingerprint === fingerprint) {
    if (now - cached.at < OBSERVER_HEALTH_TTL_MS) return Promise.resolve(cached.value);
    if (cached.value && now - cached.at < OBSERVER_HEALTH_STALE_MAX_MS) {
      if (!cached.refreshing) {
        cached.refreshing = true;
        probeObserverHealth(ctx, merchantId, fingerprint)
          .then(value => {
            observerHealthCache.set(merchantId, {
              at: Date.now(),
              fingerprint: observerHealthFingerprint(ctx, merchantId),
              value,
              refreshing: false
            });
          })
          .catch(() => { cached.refreshing = false; });
      }
      return Promise.resolve(cached.value);
    }
  }

  return probeObserverHealth(ctx, merchantId, fingerprint).then(value => {
    observerHealthCache.set(merchantId, {
      at: Date.now(),
      fingerprint: observerHealthFingerprint(ctx, merchantId),
      value,
      refreshing: false
    });
    return value;
  });
}

async function checkUpiServerHealth(ctx, enabledMethods = [], sellingMode = 'OFFLINE', merchantId = '00000000-0000-0000-0000-000000000001') {
  // 0. Check False Narrative Dev Switch (Active for 10 minutes from enabling time)
  try {
    const merchant = ctx.merchantRepo?.findById ? ctx.merchantRepo.findById(merchantId) : null;
    const falseNarrativeUntil = merchant?.branding?.falseNarrativeUntil;
    const falseNarrativeMode = (merchant?.branding?.falseNarrativeMode || 'GREEN').toUpperCase();
    if (falseNarrativeUntil && Number(falseNarrativeUntil) > Date.now()) {
      const remainingSeconds = Math.max(0, Math.round((Number(falseNarrativeUntil) - Date.now()) / 1000));
      if (falseNarrativeMode === 'GREEN') {
        return {
          status: 'WORKING',
          tier: 'GREEN',
          label: 'Server Is Working',
          isWorking: true,
          reason: 'False Narrative Active (Dev Override: GREEN): UPI servers interpreted as operational',
          smsHealthy: true,
          gmailHealthy: true,
          warning: null,
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'GREEN',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      } else if (falseNarrativeMode === 'YELLOW') {
        return {
          status: 'BUSY',
          tier: 'YELLOW',
          label: 'UPI Server Busy',
          isWorking: true,
          reason: 'False Narrative Active (Dev Override: YELLOW): UPI servers experiencing processing delays',
          smsHealthy: true,
          gmailHealthy: false,
          warning: 'Your payment may go through extra processing seconds.',
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'YELLOW',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      } else if (falseNarrativeMode === 'RED') {
        return {
          status: 'ISSUES',
          tier: 'RED',
          label: 'Server Facing Issues',
          isWorking: false,
          reason: 'False Narrative Active (Dev Override: RED): UPI servers facing downtime',
          smsHealthy: false,
          gmailHealthy: false,
          warning: 'It is not recommended to pay by UPI right now as the server is facing downtime.',
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'RED',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      }
    }
  } catch (err) {}

  // Observer liveness: concurrent probes, short TTL memo, stale-while-revalidate
  // (see probeObserverHealth / getObserverHealth above).
  const { smsHealthy, smsReason, gmailHealthy, gmailReason } = await getObserverHealth(ctx, merchantId);

  // 3-Tier Health Model:
  // Green: Both SMS + Gmail connected -> healthy
  // Yellow: Either SMS OR Gmail connected -> extra processing time
  // Red: Neither connected -> server facing issues
  const hasCash = sellingMode === 'ONLINE'
    ? enabledMethods.includes('COD')
    : enabledMethods.includes('CASH_COUNTER');

  if (smsHealthy && gmailHealthy) {
    return {
      status: 'WORKING',
      tier: 'GREEN',
      label: 'Server Is Working',
      isWorking: true,
      reason: 'All observers active: Gmail OAuth polling & SMS Gateway connected',
      smsHealthy: true,
      gmailHealthy: true,
      warning: null,
      recommendedAlternative: null
    };
  }

  if (smsHealthy || gmailHealthy) {
    return {
      status: 'BUSY',
      tier: 'YELLOW',
      label: 'UPI Server Busy',
      isWorking: true,
      reason: smsHealthy ? 'SMS observer active, Gmail observer offline' : 'Gmail observer active, SMS observer offline',
      smsHealthy,
      gmailHealthy,
      warning: 'Your payment may go through extra processing seconds.',
      recommendedAlternative: null
    };
  }

  return {
    status: 'ISSUES',
    tier: 'RED',
    label: 'Server Facing Issues',
    isWorking: false,
    reason: 'Both Gmail OAuth and SMS Gateway are offline or unconfigured',
    smsHealthy: false,
    gmailHealthy: false,
    warning: 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.',
    recommendedAlternative: hasCash ? 'CASH' : null
  };
}

export function registerCheckoutRoutes(server, ctx) {
  // GET /api/v1/checkout/:id/state
  server.get('/api/v1/checkout/:id/state', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Checkout session not found: ${params.id}` });
      return;
    }

    // Status polling is credential-scoped: merchant/operator key or the expiring
    // checkout credential issued for this session (sprint item 4).
    if (!requireCheckoutAccess(req, res, ctx, session)) return;

    // Server-side Ban & Fraud Enforcement
    const isCustomerBanned = session.customerId && ctx.customerRepo && ctx.customerRepo.isBanned(session.customerId);
    const isSessionBlocked = session.status === 'BLOCKED' || (session.metadata?.banReason === 'FRAUDULENT_PAYMENT_INJECTION');

    if (isCustomerBanned || isSessionBlocked) {
      const cust = session.customerId ? ctx.customerRepo.findById(session.customerId) : null;
      HttpServer.json(res, 200, {
        id: session.id,
        orderId: session.orderId,
        amount: toRupeesString(session.amountPaise),
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        customerName: cust?.name || 'Customer',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true,
          reason: cust?.banReason || 'FRAUDULENT_PAYMENT_INJECTION'
        }
      });
      return;
    }

    // Authoritative Server-Side Expiration Enforcer
    const now = Date.now();
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() <= now) {
      ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);
      session.status = PaymentStatus.EXPIRED;
      if (session.receivingAccountId) {
        ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt && session.processingExpiresAt.getTime() <= now) {
      ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);
      session.status = PaymentStatus.FAILED;
      if (session.receivingAccountId) {
        ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.FAILED });
    }

    // Terminal session handling: if session is terminal, return terminal state directly (CASE 4)
    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      const merchant = ctx.merchantRepo.findById(session.merchantId);
      const branding = {
        appName: 'YOUPI PG',
        primaryColor: '#2563eb',
        ...(merchant?.branding || {})
      };
      HttpServer.json(res, 200, {
        id: session.id,
        paymentId: session.id,
        orderId: session.orderId,
        amount: toRupeesString(session.amountPaise),
        amountPaise: session.amountPaise.toString(),
        currency: session.currency,
        status: session.status,
        confirmationStatus: session.confirmationStatus || ConfirmationStatus.UNCONFIRMED,
        paymentDetected: false,
        timeRemainingSeconds: 0,
        isTerminal: true,
        branding
      });
      return;
    }

    // Device-level session binding validation (Section 8 & 9)
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const snapshot = session.metadata?.receivingAccountSnapshot;
    let receivingAccount = session.receivingAccountId
      ? ctx.accountRepo.findById(session.receivingAccountId)
      : null;

    if (!receivingAccount && snapshot?.id) {
      receivingAccount = ctx.accountRepo.findById(snapshot.id);
    }
    if (!receivingAccount && session.method === 'UPI') {
      receivingAccount = ctx.accountRepo.findActiveForMerchant(session.merchantId);
    }

    const payeeVpa = receivingAccount?.upiId || snapshot?.upiId || null;
    const payeeName = receivingAccount?.payeeName || snapshot?.payeeName || merchant?.businessName || 'Merchant Store';
    const isMerchantEnabled = receivingAccount
      ? Boolean(receivingAccount.isMerchantEnabled)
      : (snapshot?.isMerchantEnabled !== undefined ? Boolean(snapshot.isMerchantEnabled) : true);
    const upiMode = isMerchantEnabled ? 'MERCHANT' : 'NON_MERCHANT';

    let timeRemainingSeconds = 0;
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.processingExpiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.QUEUED) {
      timeRemainingSeconds = ctx.queueEngine.calculateEstimatedWaitSeconds(
        session.receivingAccountId,
        session.queuePosition
      );
    }

    let upiUri = null;
    if (session.status === PaymentStatus.ACTIVE && payeeVpa) {
      try {
        upiUri = buildUpiUri({
          payeeVpa,
          payeeName,
          amountPaise: session.amountPaise,
          transactionRef: session.orderId,
          currency: session.currency || 'INR'
        });
      } catch {
        upiUri = null;
      }
    }

    const branding = {
      appName: 'YOUPI PG',
      primaryColor: '#2563eb',
      headerTheme: 'gradient',
      logoUrl: null,
      counterInstructions: 'Please visit the billing counter and present this screen to the cashier.',
      cardCounterInstructions: 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
      ...(merchant?.branding || {})
    };

    const supportEmails = branding.supportEmails || (merchant?.contactEmail ? [merchant.contactEmail] : []);
    const supportMobiles = branding.supportMobiles || (merchant?.contactPhone ? [merchant.contactPhone] : []);
    const privacyPolicyUrl = branding.privacyPolicyUrl || null;
    branding.supportEmails = supportEmails;
    branding.supportMobiles = supportMobiles;
    const isCounterSession = session.method === 'CASH_COUNTER' || session.method === 'CARD_COUNTER';
    const merchantBranding = merchant?.branding || {};
    const sellingMode = merchantBranding.sellingMode || (isCounterSession ? 'OFFLINE' : 'ONLINE');
    branding.sellingMode = sellingMode;

    let rawEnabled = merchantBranding.enabledPaymentMethods || (sellingMode === 'ONLINE' ? ['UPI', 'COD'] : ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    let enabledMethods = ['UPI'];
    if (sellingMode === 'ONLINE') {
      if (rawEnabled.includes('COD')) {
        enabledMethods.push('COD');
      }
    } else {
      if (rawEnabled.includes('CASH_COUNTER')) {
        enabledMethods.push('CASH_COUNTER');
      }
      if (rawEnabled.includes('CARD_COUNTER')) {
        enabledMethods.push('CARD_COUNTER');
      }
    }

    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-customer-token'] || null);

    let customer = null;
    if (session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber,
          fullName: c.name,
          phoneNumber: c.mobileNumber
        };
      }
    } else if (!customer && bearerToken && ctx.customerSessionRepo) {
      const authContext = ctx.customerSessionRepo.findByToken(bearerToken);
      if (authContext?.customer) {
        const c = authContext.customer;
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber,
          fullName: c.name,
          phoneNumber: c.mobileNumber
        };
      }
    }

    // Single active payment session check (Section 1 & 2)
    const requestingDeviceId = req.headers['x-device-id'] || session.deviceId || null;
    let hasActiveSessionConflict = false;
    let conflictingSession = null;
    const conflictingActive = ctx.sessionRepo.findConflictingActiveSession
      ? ctx.sessionRepo.findConflictingActiveSession({
          customerId: session.customerId,
          deviceId: requestingDeviceId,
          excludeSessionId: session.id
        })
      : null;

    if (conflictingActive && conflictingActive.id !== session.id && [PaymentStatus.INITIATED, PaymentStatus.ACTIVE, PaymentStatus.QUEUED].includes(session.status)) {
      if (requestingDeviceId && conflictingActive.deviceId && requestingDeviceId !== conflictingActive.deviceId) {
        // CASE 3: Active session on another device -> DUPLICATE_SESSION_DETECTED
        HttpServer.json(res, 409, {
          error: 'DUPLICATE_SESSION_DETECTED',
          session_id: session.id,
          conflicting_session_id: conflictingActive.id,
          action: 'END_SESSION_AND_CREATE_NEW',
          message: 'This payment session was created on another device. For security reasons, this session cannot be continued from this device.',
          boundDeviceId: conflictingActive.deviceId,
          requestingDeviceId
        });
        return;
      }

      // CASE 2: Active session on same device -> CONTINUE ACTIVE SESSION or END & START NEW
      hasActiveSessionConflict = true;
      conflictingSession = {
        id: conflictingActive.id,
        paymentId: conflictingActive.id,
        orderId: conflictingActive.orderId,
        amount: toRupeesString(conflictingActive.amountPaise),
        status: conflictingActive.status,
        checkoutUrl: `/checkout/${conflictingActive.id}`
      };
    }

    // Build URI and compute remaining time ONLY if session is already active (e.g. after customer bound or counter active)
    if (session.status === PaymentStatus.ACTIVE) {
      if (payeeVpa && !upiUri) {
        try {
          upiUri = buildUpiUri({
            payeeVpa,
            payeeName,
            amountPaise: session.amountPaise,
            transactionRef: session.orderId,
            currency: session.currency || 'INR'
          });
        } catch {}
      }
      if (session.expiresAt) {
        timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
      }
    }

    // Advisory UPI/observer indicator. It is deliberately OUTSIDE the payment
    // decision path, so its probe cost is traced here to prove where checkout
    // status latency is actually spent.
    if (req.trace) req.trace.mark('health_start');
    const upiServerIndicator = await checkUpiServerHealth(ctx, enabledMethods, sellingMode, session.merchantId);
    if (req.trace) req.trace.mark('health_end');

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      merchantName: merchant?.businessName || 'Merchant',
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: session.status,
      reason: session.metadata?.cancelledReason || null,
      cancelledReason: session.metadata?.cancelledReason || null,
      // Observation evidence is surfaced as PAYMENT_DETECTED while the session
      // stays unsettled. It never implies SUCCESS: only an authoritative bank
      // confirmation can settle the payment (dual-truth model).
      confirmationStatus: session.confirmationStatus || ConfirmationStatus.UNCONFIRMED,
      paymentDetected: session.confirmationStatus === ConfirmationStatus.REPORTED,
      metadata: session.metadata || {},
      method: session.method,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      sellingMode,
      enabledMethods,
      customer,
      hasActiveSessionConflict,
      conflictingSession,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      serverNow: new Date().toISOString(),
      upiUri,
      payeeVpa,
      payeeName,
      isMerchantEnabled,
      upiMode,
      upiServerIndicator,
      receivingAccountId: receivingAccount?.id || snapshot?.id || null,
      providers: UPI_PROVIDERS,
      canClickPaymentDone: session.status === PaymentStatus.ACTIVE,
      returnUrl: session.returnUrl,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      deviceId: session.deviceId || null,
      branding
    });
  });

  // GET /api/v1/checkout/server-health
  server.get('/api/v1/checkout/server-health', async (req, res) => {
    const merchantId = req.query?.merchantId || '00000000-0000-0000-0000-000000000001';
    const health = await checkUpiServerHealth(ctx, [], 'OFFLINE', merchantId);
    HttpServer.json(res, 200, health);
  });

  // POST /api/v1/checkout/:id/bind-customer
  server.post('/api/v1/checkout/:id/bind-customer', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const token = body.token || body.sessionToken || ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const { customerId } = body;

    let customer = null;
    if (token && ctx.customerSessionRepo) {
      const authContext = ctx.customerSessionRepo.findByToken(token);
      if (!authContext) {
        HttpServer.json(res, 401, { error: 'Invalid or expired customer session token.' });
        return;
      }
      customer = authContext.customer;
    } else if (customerId && ctx.customerRepo) {
      customer = ctx.customerRepo.findById(customerId);
    }

    if (!customer) {
      HttpServer.json(res, 400, { error: 'A valid customer session token or customerId is required.' });
      return;
    }

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    // Device-level session binding validation
    const deviceAccess = checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    if (deviceAccess.boundDeviceId && ctx.deviceRepo) {
      try { ctx.deviceRepo.associateCustomer(deviceAccess.boundDeviceId, customer.id); } catch {}
    }

    // INVARIANT: Payment session identity is IMMUTABLE once bound!
    // Cannot mutate or hijack an active session to another customer identity.
    if (session.customerId && session.customerId !== customer.id) {
      HttpServer.json(res, 409, {
        error: 'Payment session is already bound to another customer identity and cannot be mutated or reassigned.'
      });
      return;
    }

    // Check for active customer session conflict
    const otherActive = ctx.sessionRepo.findActiveForCustomer
      ? ctx.sessionRepo.findActiveForCustomer(customer.id, params.id)
      : null;

    let hasActiveSessionConflict = false;
    let conflictingSession = null;
    if (otherActive && otherActive.id !== params.id) {
      hasActiveSessionConflict = true;
      conflictingSession = {
        id: otherActive.id,
        paymentId: otherActive.id,
        orderId: otherActive.orderId,
        amount: toRupeesString(otherActive.amountPaise),
        status: otherActive.status,
        checkoutUrl: `/checkout/${otherActive.id}`
      };
    }

    // If already bound to this exact customer and already activated, return current state with conflict status
    if (session.customerId === customer.id && session.status !== PaymentStatus.INITIATED) {
      HttpServer.json(res, 200, {
        success: true,
        status: session.status,
        queuePosition: session.queuePosition || 0,
        expiresAt: session.expiresAt,
        hasActiveSessionConflict,
        conflictingSession,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
          fullName: customer.name,
          phoneNumber: customer.mobileNumber
        }
      });
      return;
    }

    // Bind customer to payment session
    ctx.db.execute(`
      UPDATE payment_sessions
      SET customer_id = ?, updated_at = ?
      WHERE id = ?
    `, [customer.id, new Date().toISOString(), params.id]);

    // INVARIANT: Single Active Payment Session per Customer
    if (otherActive && otherActive.id !== params.id) {
      const requestingDeviceId = req.headers['x-device-id'] || null;
      if (requestingDeviceId && otherActive.deviceId && requestingDeviceId !== otherActive.deviceId) {
        // CASE 3: Active session on another device -> DUPLICATE_SESSION_DETECTED
        HttpServer.json(res, 409, {
          error: 'DUPLICATE_SESSION_DETECTED',
          session_id: params.id,
          conflicting_session_id: otherActive.id,
          action: 'END_SESSION_AND_CREATE_NEW',
          message: 'This customer already has an active payment session on another device. For security reasons, this session cannot be continued from this device.',
          boundDeviceId: otherActive.deviceId,
          requestingDeviceId
        });
        return;
      }

      hasActiveSessionConflict = true;
      conflictingSession = {
        id: otherActive.id,
        paymentId: otherActive.id,
        orderId: otherActive.orderId,
        amount: toRupeesString(otherActive.amountPaise),
        status: otherActive.status,
        checkoutUrl: `/checkout/${otherActive.id}`
      };
    }

    // INVARIANT: When customer logs in or signs up, activate session and start 5-minute timer NOW (unless conflict exists)!
    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    const targetAccountId = session.receivingAccountId || ctx.accountRepo?.findActiveForMerchant(session.merchantId)?.id || session.metadata?.receivingAccountSnapshot?.id;
    if (!hasActiveSessionConflict && session.status === PaymentStatus.INITIATED && targetAccountId) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, targetAccountId);
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'CUSTOMER_AUTHENTICATED_AND_BOUND',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber, sessionStatus: queueResult.status, hasActiveSessionConflict }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      hasActiveSessionConflict,
      conflictingSession,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        fullName: customer.name,
        phoneNumber: customer.mobileNumber
      }
    });
  });

  // POST /api/v1/checkout/:id/retry-new-payment - Cancels previous abandoned active session and activates new payment
  server.post('/api/v1/checkout/:id/retry-new-payment', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const customerId = session.customerId;
    const requestingDeviceId = req.headers['x-device-id'] || session.deviceId || null;

    // Find all conflicting active/processing/queued sessions for this customer OR device
    const conflicting = ctx.db.query(`
      SELECT id, receiving_account_id, status FROM payment_sessions
      WHERE id != ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')
        AND (
          (? IS NOT NULL AND customer_id = ?)
          OR (? IS NOT NULL AND device_id = ?)
        )
    `, [session.id, customerId, customerId, requestingDeviceId, requestingDeviceId]);

    for (const c of conflicting) {
      ctx.sessionRepo.transitionToTerminal(c.id, PaymentStatus.CANCELLED, {
        reason: 'USER_RETRY_NEW_PAYMENT',
        replacedBySessionId: session.id
      });
      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(c.id);
        if (typeof ctx.timingEngine.clearTimers === 'function') {
          ctx.timingEngine.clearTimers(c.id);
        }
      }
      server.broadcastSse(c.id, 'status_change', {
        status: PaymentStatus.CANCELLED,
        reason: 'USER_RETRY_NEW_PAYMENT'
      });
    }

    // Target receiving account
    const activeMerchantAcc = ctx.accountRepo ? ctx.accountRepo.findActiveForMerchant(session.merchantId) : null;
    const targetAccountId = activeMerchantAcc?.id ||
      session.receivingAccountId ||
      session.metadata?.receivingAccountSnapshot?.id;

    if (targetAccountId && session.receivingAccountId !== targetAccountId) {
      ctx.db.execute('UPDATE payment_sessions SET receiving_account_id = ? WHERE id = ?', [targetAccountId, session.id]);
      session.receivingAccountId = targetAccountId;
    }

    // Now activate current session immediately on the newly freed slot
    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    if (targetAccountId) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, targetAccountId);
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
      ctx.sessionRepo.reindexQueue(targetAccountId);
    }

    const updated = ctx.sessionRepo.findById(session.id);
    HttpServer.json(res, 200, {
      success: true,
      paymentId: updated.id,
      status: updated.status,
      queuePosition: updated.queuePosition || 0,
      expiresAt: updated.expiresAt,
      message: 'Previous active session cancelled. New payment session activated.'
    });
  });

  // POST /api/v1/checkout/:id/payment-done
  server.post('/api/v1/checkout/:id/payment-done', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      // Idempotent
      HttpServer.json(res, 200, {
        status: PaymentStatus.PROCESSING,
        message: 'Already in verification processing.'
      });
      return;
    }

    const now = Date.now();
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() <= now) {
      ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);
      if (session.receivingAccountId) {
        ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
      HttpServer.json(res, 400, {
        error: 'Cannot start verification: payment session has EXPIRED.'
      });
      return;
    }

    if (session.status !== PaymentStatus.ACTIVE) {
      HttpServer.json(res, 400, {
        error: `Cannot start verification: session is in status '${session.status}', must be 'ACTIVE'.`
      });
      return;
    }

    const updated = ctx.timingEngine.handlePaymentDone(params.id);

    // Broadcast SSE update
    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
    server.broadcastSse('admin_counter_events', 'status_change', {
      status: PaymentStatus.PROCESSING,
      sessionId: updated.id,
      orderId: updated.orderId,
      amountPaise: updated.amountPaise ? updated.amountPaise.toString() : '0'
    });

    HttpServer.json(res, 200, {
      paymentId: updated.id,
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
  });

  // POST /api/v1/checkout/:id/cancel
  server.post('/api/v1/checkout/:id/cancel', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 200, {
        paymentId: session.id,
        status: session.status
      });
      return;
    }


    const updated = ctx.timingEngine.handleCancel(params.id);

    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.CANCELLED
    });

    HttpServer.json(res, 200, {
      paymentId: updated?.id || session.id,
      status: PaymentStatus.CANCELLED
    });
  });

  // POST /api/v1/checkout/:id/select-method (Switches payment method e.g. Cash/Card at Counter, COD, or UPI)
  server.post('/api/v1/checkout/:id/select-method', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { method } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot switch payment method for terminal session in status '${session.status}'` });
      return;
    }

    const validMethods = [PaymentMethod.UPI, PaymentMethod.COD, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER];
    if (!validMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Invalid payment method '${method}'. Allowed: ${validMethods.join(', ')}` });
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const merchantBranding = merchant?.branding || {};
    const isCounterRequested = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    let sellingMode = merchantBranding.sellingMode || (isCounterRequested ? 'OFFLINE' : 'ONLINE');
    let rawEnabled = merchantBranding.enabledPaymentMethods || (sellingMode === 'ONLINE' ? ['UPI', 'COD'] : ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    let enabledMethods = ['UPI'];
    if (sellingMode === 'ONLINE') {
      if (rawEnabled.includes('COD')) enabledMethods.push('COD');
    } else {
      if (rawEnabled.includes('CASH_COUNTER')) enabledMethods.push('CASH_COUNTER');
      if (rawEnabled.includes('CARD_COUNTER')) enabledMethods.push('CARD_COUNTER');
    }

    if (!enabledMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Payment method '${method}' is disabled by the merchant.` });
      return;
    }

    const previousMethod = session.method;
    const isCounter = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    const isCod = method === PaymentMethod.COD;
    const wasCounter = previousMethod === PaymentMethod.CASH_COUNTER || previousMethod === PaymentMethod.CARD_COUNTER;
    const wasCod = previousMethod === PaymentMethod.COD;
    const wasUpi = previousMethod === PaymentMethod.UPI || (!wasCounter && !wasCod);
    const nowIso = new Date().toISOString();

    let updates = `method = ?, updated_at = ?`;
    let updateParams = [method, nowIso];

    let oldReceivingAccountId = null;
    let timeRemainingSeconds = 0;
    let newExpiresAt = null;

    if (isCounter || isCod) {
      // Switching from UPI to COD or Counter:
      // Invariant: Concurrency slot and queue window are strictly for UPI payments.
      // Immediately invalidate and cancel the UPI queue reservation and its active timer.
      if (session.receivingAccountId) {
        oldReceivingAccountId = session.receivingAccountId;
      }

      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(session.id);
      }

      if (isCod) {
        // In Online Selling Mode, if Cash on Delivery is selected:
        // Run a parallel standalone timer of 5 minutes (300 seconds) which is NOT part of the queue.
        newExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
        updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0, expires_at = ?`;
        updateParams.push(newExpiresAt.toISOString());
        session.receivingAccountId = null;
        session.status = PaymentStatus.ACTIVE;
        session.queuePosition = 0;
        session.expiresAt = newExpiresAt;

        // Start parallel 5-minute timer in timingEngine
        if (ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(session.id, newExpiresAt);
        }
        timeRemainingSeconds = 300;
      } else {
        // Offline counter payment (CASH_COUNTER or CARD_COUNTER)
        updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0, expires_at = NULL`;
        session.receivingAccountId = null;
        session.status = PaymentStatus.ACTIVE;
        session.queuePosition = 0;
        session.expiresAt = null;
        timeRemainingSeconds = 0;
      }
    } else if (!isCounter && !isCod && (wasCounter || wasCod)) {
      // Switching back to UPI:
      // Cancel any running parallel COD timer
      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(session.id);
      }

      // Re-resolve active receiving account and enqueue/activate into UPI queue
      const receivingAccount = ctx.accountRepo.findActiveForMerchant(session.merchantId);
      if (receivingAccount) {
        const queueResult = ctx.queueEngine.enqueueOrActivate(session.id, receivingAccount.id);
        updates += `, receiving_account_id = ?, status = ?, queue_position = ?, expires_at = ?`;
        updateParams.push(
          receivingAccount.id,
          queueResult.status,
          queueResult.queuePosition,
          queueResult.expiresAt ? queueResult.expiresAt.toISOString() : null
        );
        session.receivingAccountId = receivingAccount.id;
        session.status = queueResult.status;
        session.queuePosition = queueResult.queuePosition;
        session.expiresAt = queueResult.expiresAt;

        if (queueResult.expiresAt && ctx.timingEngine && queueResult.status === PaymentStatus.ACTIVE) {
          ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
        }
        if (queueResult.expiresAt) {
          timeRemainingSeconds = Math.max(0, Math.ceil((queueResult.expiresAt.getTime() - Date.now()) / 1000));
        }
      }
    } else if (!isCounter && !isCod && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));
    }

    updateParams.push(session.id);
    ctx.db.execute(`UPDATE payment_sessions SET ${updates} WHERE id = ?`, updateParams);
    session.method = method;

    // If slot was released on the receiving account, update receiving account and promote waiting queued sessions!
    if (oldReceivingAccountId) {
      ctx.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
        WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
      `, [nowIso, oldReceivingAccountId, session.id]);

      const promoted = ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      } else {
        ctx.sessionRepo.reindexQueue(oldReceivingAccountId);
      }
    }

    // Broadcast SSE update to customer session channel
    server.broadcastSse(session.id, 'status_change', {
      status: session.status,
      method: session.method,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null
    });

    // Broadcast live event to merchant dashboard counter desk if counter method
    if (isCounter) {
      server.broadcastSse('admin_counter_events', 'counter_payment_requested', {
        paymentId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise.toString(),
        method: session.method,
        status: session.status,
        createdAt: session.createdAt
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'PAYMENT_METHOD_SWITCHED',
        actorType: 'CUSTOMER',
        details: { from: previousMethod, to: method }
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.METHOD_SWITCHED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        fromMethod: previousMethod,
        toMethod: method
      });
    }

    const counterInstr = method === PaymentMethod.CARD_COUNTER
      ? (merchantBranding.cardCounterInstructions || merchantBranding.counterInstructions || 'Please visit the billing counter and pay via Card POS.')
      : (merchantBranding.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.');

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      method: session.method,
      status: session.status,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      counterInstructions: counterInstr
    });
  });

  // POST /api/v1/checkout/:id/confirm-cod (Confirm Cash on Delivery Order)
  server.post('/api/v1/checkout/:id/confirm-cod', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot place COD order for terminal session in status '${session.status}'` });
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const branding = merchant?.branding || {};
    const sellingMode = branding.sellingMode || (branding.enabledPaymentMethods?.some(m => m === 'CASH_COUNTER' || m === 'CARD_COUNTER') ? 'OFFLINE' : 'ONLINE');
    if (sellingMode !== 'ONLINE') {
      HttpServer.json(res, 400, { error: 'Cash on Delivery is only available in Online Selling Mode.' });
      return;
    }

    const rawEnabled = branding.enabledPaymentMethods || ['UPI', 'COD'];
    if (!rawEnabled.includes('COD')) {
      HttpServer.json(res, 400, { error: 'Cash on Delivery is currently disabled by merchant.' });
      return;
    }

    // Cancel Active Timer
    if (ctx.timingEngine) {
      if (typeof ctx.timingEngine.cancelActiveTimer === 'function') {
        ctx.timingEngine.cancelActiveTimer(session.id);
      }
    }

    // Update payment session to SUCCESS with COD method and release slot.
    // COD is an order acceptance (no bank credit involved), so it still goes
    // through the single atomic confirmation path with explicit COD provenance —
    // SUCCESS must never bypass the state machine or the CAS guard (audit P0-08).
    const nowIso = new Date().toISOString();
    const oldReceivingAccountId = session.receivingAccountId || session.receiving_account_id;

    ctx.sessionRepo.confirmPaymentSuccess(session.id, {
      confirmationStatus: ConfirmationStatus.COD_ORDER_PLACED,
      allowFromStatuses: [
        PaymentStatus.INITIATED,
        PaymentStatus.QUEUED,
        PaymentStatus.ACTIVE,
        PaymentStatus.PROCESSING
      ],
      confirmationNote: 'Cash on Delivery order placed by customer'
    });

    ctx.sessionRepo.db.execute(`
      UPDATE payment_sessions
      SET method = 'COD',
          verification_tag = 'COD_ORDER_PLACED',
          verification_level = 1,
          receiving_account_id = NULL,
          updated_at = ?
      WHERE id = ? AND status = ?
    `, [nowIso, session.id, PaymentStatus.SUCCESS]);

    // Slot was released atomically by confirmPaymentSuccess: promote next queued customer
    if (oldReceivingAccountId) {
      const promoted = ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      }
    }

    const updated = ctx.sessionRepo.findById(session.id);

    let customer = null;
    if (updated.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(updated.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber
        };
      }
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: updated.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: updated.id,
        action: 'COD_ORDER_PLACED',
        actorType: 'CUSTOMER',
        details: { orderId: updated.orderId, amountPaise: updated.amountPaise.toString() }
      });
    }

    // Broadcast SSE
    server.broadcastSse(params.id, 'status_change', {
      status: 'SUCCESS',
      method: 'COD',
      verificationTag: 'COD_ORDER_PLACED'
    });

    // Webhook dispatch
    if (ctx.webhookEngine && merchant && merchant.webhookUrl) {
      ctx.webhookEngine.dispatch('SUCCESS', updated).catch(err => console.error('COD Webhook dispatch failed:', err.message));
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: updated.id,
      orderId: updated.orderId,
      amount: toRupeesString(updated.amountPaise),
      amountPaise: updated.amountPaise.toString(),
      currency: updated.currency,
      method: 'COD',
      status: 'SUCCESS',
      verificationTag: 'COD_ORDER_PLACED',
      customer,
      returnUrl: session.returnUrl
    });
  });

  // GET /api/v1/checkout/:id/cod (Query COD order info)
  server.get('/api/v1/checkout/:id/cod', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }
    let customer = null;
    if (session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber
        };
      }
    }
    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      method: session.method,
      status: session.status,
      verificationTag: session.verificationTag,
      customer,
      placedAt: session.completedAt || session.createdAt
    });
  });

  // POST /api/v1/checkout/:id/expire (Explicit Client Expiry Trigger)
  server.post('/api/v1/checkout/:id/expire', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.ACTIVE) {
      ctx.timingEngine.handleActiveTimerExpiration(session.id);
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      status: PaymentStatus.EXPIRED
    });
  });

  // POST /api/v1/checkout/:id/trigger-hook (Merchant Action & Telemetry Trigger)
  server.post('/api/v1/checkout/:id/trigger-hook', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { action, details } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: `HOOK_${action || 'USER_ACTION'}`,
        actorType: 'CUSTOMER',
        details: details || {}
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.ACTION_TRIGGERED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        action: action || 'ACTION',
        details: details || {}
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      action: action || 'ACTION',
      timestamp: new Date().toISOString()
    });
  });

  // POST /api/v1/checkout/:id/simulate-observation (Inject simulated SMS / Email observation)
  server.post('/api/v1/checkout/:id/simulate-observation', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await HttpServer.parseBody(req);
    const source = (body.source || 'SMS').toUpperCase();
    const rawText = (body.rawText || body.message || body.text || '').toString();
    const sender = (body.sender || '').toString();

    if (!rawText) {
      HttpServer.json(res, 400, { error: 'Missing message body' });
      return;
    }

    const pipeline = ctx.pipeline;
    if (!pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline not available' });
      return;
    }

    const result = pipeline.process({
      source,
      rawText,
      sender,
      paymentSessionId: session.id,
      receivingAccountId: session.receivingAccountId,
      isTest: Boolean(body.isTest),
      testModeActive: Boolean(body.testModeActive)
    });

    if (result.status === 'REJECTED' && result.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        error: 'FRAUDULENT_PAYMENT_INJECTION: Fake payment observation detected. User banned and session terminated.'
      });
      return;
    }

    HttpServer.json(res, 200, {
      success: result.success,
      status: result.status,
      result
    });
  });

  // POST /api/v1/checkout/:id/end-and-restart-payment (or end-session-and-create-new)
  // Cancels previous session created on another device and creates a fresh payment session bound to current device
  async function handleEndAndRestartPayment(req, res, params) {
    const session = ctx.sessionRepo.findById(params.id);
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const conflictingSessionId = body?.conflictingSessionId || body?.conflicting_session_id || null;

    if (!session && !conflictingSessionId) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const targetSession = session || ctx.sessionRepo.findById(conflictingSessionId);
    if (!targetSession) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const newDeviceId = req.headers['x-device-id'] || body?.deviceId || null;
    if (!newDeviceId) {
      HttpServer.json(res, 400, { error: 'Current device identity is required to bind the new payment session.' });
      return;
    }

    const sourceSession = (conflictingSessionId ? ctx.sessionRepo.findById(conflictingSessionId) : null) || targetSession;
    const customerId = body?.customerId || sourceSession?.customerId || targetSession.customerId || null;

    // 1. Identify ALL sessions on old/other devices that must be cancelled
    const sessionsToTerminate = new Map();

    if (![PaymentStatus.CANCELLED, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.SUCCESS].includes(targetSession.status)) {
      sessionsToTerminate.set(targetSession.id, targetSession);
    }

    if (conflictingSessionId) {
      const confSess = ctx.sessionRepo.findById(conflictingSessionId);
      if (confSess && ![PaymentStatus.CANCELLED, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.SUCCESS].includes(confSess.status)) {
        sessionsToTerminate.set(confSess.id, confSess);
      }
    }

    if (customerId && ctx.sessionRepo.findAllActiveOrPendingForCustomer) {
      const custSessions = ctx.sessionRepo.findAllActiveOrPendingForCustomer(customerId);
      for (const cs of custSessions) {
        if (![PaymentStatus.CANCELLED, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.SUCCESS].includes(cs.status)) {
          if (!cs.deviceId || cs.deviceId !== newDeviceId || cs.id === targetSession.id) {
            sessionsToTerminate.set(cs.id, cs);
          }
        }
      }
    }

    if (session && session.id !== targetSession.id && ![PaymentStatus.CANCELLED, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.SUCCESS].includes(session.status)) {
      sessionsToTerminate.set(session.id, session);
    }

    // Also check if an active session on the receiving account belongs to the same order / customer
    const receivingAccountIdForLookup = targetSession.receivingAccountId || session?.receivingAccountId;
    if (receivingAccountIdForLookup && ctx.sessionRepo.findCurrentActiveOrProcessing) {
      const activeOnAcc = ctx.sessionRepo.findCurrentActiveOrProcessing(receivingAccountIdForLookup);
      if (activeOnAcc && activeOnAcc.deviceId !== newDeviceId) {
        const cleanTargetOrder = targetSession.orderId ? targetSession.orderId.replace(/-R\d+$/, '') : '';
        const cleanActiveOrder = activeOnAcc.orderId ? activeOnAcc.orderId.replace(/-R\d+$/, '') : '';
        if ((cleanTargetOrder && cleanTargetOrder === cleanActiveOrder) || (customerId && activeOnAcc.customerId === customerId)) {
          sessionsToTerminate.set(activeOnAcc.id, activeOnAcc);
        }
      }
    }

    // Resolve receiving account ID for new session (guarantee active account for merchant)
    const activeMerchantAcc = ctx.accountRepo ? ctx.accountRepo.findActiveForMerchant(sourceSession.merchantId) : null;
    const targetReceivingAccountId = activeMerchantAcc?.id || sourceSession.receivingAccountId;

    const affectedAccountIds = new Set();
    for (const [sId, sObj] of sessionsToTerminate.entries()) {
      if (sObj?.receivingAccountId) {
        affectedAccountIds.add(sObj.receivingAccountId);
      }
    }
    if (receivingAccountIdForLookup) {
      affectedAccountIds.add(receivingAccountIdForLookup);
    }
    if (targetReceivingAccountId) {
      affectedAccountIds.add(targetReceivingAccountId);
    }

    // 2. Terminate all old sessions, cancel timers, and broadcast SSE
    for (const [sId, sObj] of sessionsToTerminate.entries()) {
      ctx.sessionRepo.transitionToTerminal(sId, PaymentStatus.CANCELLED, {
        reason: 'REPLACED_ON_ANOTHER_DEVICE',
        replacedByDeviceId: newDeviceId
      });

      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(sId);
        if (typeof ctx.timingEngine.clearTimers === 'function') {
          ctx.timingEngine.clearTimers(sId);
        }
      }

      server.broadcastSse(sId, 'status_change', {
        status: PaymentStatus.CANCELLED,
        reason: 'REPLACED_ON_ANOTHER_DEVICE',
        message: 'Payment session closed because you continued on another device.'
      });
    }

    // 3. Immediately release receiving-account slot, re-index queue, and promote next queued session if applicable
    const termIds = Array.from(sessionsToTerminate.keys());
    for (const accId of affectedAccountIds) {
      const nowIso = new Date().toISOString();
      if (termIds.length > 0) {
        ctx.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id IN (${termIds.map(() => '?').join(',')}) OR current_active_session_id IS NULL)
        `, [nowIso, accId, ...termIds]);
      }

      if (ctx.sessionRepo.reindexQueue) {
        ctx.sessionRepo.reindexQueue(accId);
      }

      if (ctx.queueEngine && typeof ctx.queueEngine.promoteNext === 'function') {
        const promoted = ctx.queueEngine.promoteNext(accId);
        if (promoted) {
          if (ctx.timingEngine && promoted.expiresAt) {
            ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
          }
          server.broadcastSse(promoted.id, 'status_change', {
            status: PaymentStatus.ACTIVE,
            queuePosition: 0,
            expiresAt: promoted.expiresAt
          });
          server.broadcastSse('admin_counter_events', 'status_change', {
            status: PaymentStatus.ACTIVE,
            sessionId: promoted.id,
            orderId: promoted.orderId,
            amountPaise: promoted.amountPaise ? promoted.amountPaise.toString() : '0'
          });
        }
      }
    }

    // 4. Generate unique order reference from sourceSession
    const cleanOrderId = sourceSession.orderId ? sourceSession.orderId.replace(/-R\d+$/, '') : `ORD-${Date.now()}`;
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const newOrderId = `${cleanOrderId}-R${randSuffix}`;

    // 5. Ensure device exists and register
    if (newDeviceId && ctx.deviceRepo) {
      let dev = ctx.deviceRepo.findById(newDeviceId);
      if (!dev) {
        try {
          ctx.deviceRepo.create({
            id: newDeviceId,
            publicKey: `adhoc_${newDeviceId}`,
            fingerprintHash: `fp_${newDeviceId}`
          });
        } catch {}
      } else {
        ctx.deviceRepo.touch(newDeviceId);
      }
    }

    // 6. Create fresh payment session bound to newDeviceId
    const newSession = ctx.sessionRepo.create({
      merchantId: sourceSession.merchantId,
      customerId: customerId || sourceSession.customerId,
      receivingAccountId: targetReceivingAccountId,
      orderId: newOrderId,
      amountPaise: sourceSession.amountPaise,
      currency: sourceSession.currency,
      method: sourceSession.method || PaymentMethod.UPI,
      status: PaymentStatus.INITIATED,
      returnUrl: sourceSession.returnUrl,
      deviceId: newDeviceId,
      metadata: {
        ...(sourceSession.metadata || {}),
        reboundFromSessionId: sourceSession.id,
        reboundAt: new Date().toISOString()
      }
    });

    if (customerId && ctx.deviceRepo) {
      try { ctx.deviceRepo.associateCustomer(newDeviceId, customerId); } catch {}
    }

    // 7. Enqueue or activate new session if UPI
    let queueResult = { status: newSession.status, queuePosition: 0, expiresAt: null };
    if (newSession.receivingAccountId && (String(newSession.method).toUpperCase() === 'UPI' || !newSession.method)) {
      queueResult = ctx.queueEngine.enqueueOrActivate(newSession.id, newSession.receivingAccountId);
      if (queueResult.expiresAt && ctx.timingEngine) {
        ctx.timingEngine.startActiveTimer(newSession.id, queueResult.expiresAt);
      }
      server.broadcastSse(newSession.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: newSession.id,
        orderId: newSession.orderId,
        amountPaise: newSession.amountPaise ? newSession.amountPaise.toString() : '0'
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: sourceSession.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: newSession.id,
        action: 'PAYMENT_SESSION_RECREATED_ON_NEW_DEVICE',
        actorType: 'CUSTOMER',
        actorId: customerId || 'ANONYMOUS',
        details: {
          terminatedSessionIds: Array.from(sessionsToTerminate.keys()),
          newSessionId: newSession.id,
          newDeviceId
        }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      oldSessionId: targetSession.id,
      terminatedSessionIds: Array.from(sessionsToTerminate.keys()),
      newSessionId: newSession.id,
      paymentId: newSession.id,
      orderId: newSession.orderId,
      checkoutUrl: `/checkout/${newSession.id}`,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      message: 'Previous sessions terminated. New payment session activated and bound to this device.'
    });
  }

  server.post('/api/v1/checkout/:id/end-and-restart-payment', handleEndAndRestartPayment);
  server.post('/api/v1/checkout/:id/end-session-and-create-new', handleEndAndRestartPayment);

  // GET /api/v1/checkout/:id/stream and /events (SSE)
  server.get('/api/v1/checkout/:id/stream', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }
    if (!requireCheckoutAccess(req, res, ctx, session)) return;
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    server.initSse(params.id, res);
  });

  server.get('/api/v1/checkout/:id/events', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    server.initSse(params.id, res);
  });
}
