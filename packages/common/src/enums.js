/**
 * Internal high-resolution payment session lifecycle states.
 */
export const PaymentStatus = Object.freeze({
  INITIATED: 'INITIATED',
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Public-facing payment outcomes consumed by external merchants.
 */
export const PublicPaymentOutcome = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Supported payment modalities.
 */
export const PaymentMethod = Object.freeze({
  UPI: 'UPI',
  COD: 'COD',
  CASH_COUNTER: 'CASH_COUNTER',
  CARD_COUNTER: 'CARD_COUNTER'
});

/**
 * Merchant gateway selling modes.
 */
export const SellingMode = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE'
});

/**
 * Observation channel sources feeding the payment detection engine (2-Layer: SMS + Gmail).
 * Android observer layer is completely removed.
 */
export const ObserverSource = Object.freeze({
  GMAIL: 'GMAIL',
  GOOGLE_MESSAGES: 'GOOGLE_MESSAGES',
  ANDROID_OBSERVER: 'ANDROID_OBSERVER',
  SMS_GATEWAY: 'SMS_GATEWAY',
  MANUAL_COUNTER: 'MANUAL_COUNTER'
});

/**
 * Attribution status for raw observations.
 */
export const ObservationAttributionStatus = Object.freeze({
  UNATTRIBUTED: 'UNATTRIBUTED',
  ATTRIBUTED: 'ATTRIBUTED',
  LATE_UNMATCHED: 'LATE_UNMATCHED',
  DUPLICATE_IGNORED: 'DUPLICATE_IGNORED',
  /** Evidence was reported but cannot be attributed automatically (ambiguity,
   * duplicate bank reference, cross-tenant mismatch) and requires manual
   * bank reconciliation. Never a success by itself. */
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  /** Observation references a bank transaction already consumed by another order. */
  DUPLICATE_TRANSACTION: 'DUPLICATE_TRANSACTION'
});

/**
 * Payment confirmation provenance (dual-truth model):
 * - REPORTED: an observer (SMS/email/android) CLAIMED a credit. Never sufficient
 *   to fulfill an order by itself.
 * - MANUAL_RECONCILIATION: an authenticated operator matched the credit against
 *   the bank account statement.
 * - COUNTER_CONFIRMED: physical cash/card counter confirmation by an operator.
 * - BANK_CONFIRMED: reserved for an authoritative bank/acquirer confirmation channel.
 */
export const ConfirmationStatus = Object.freeze({
  UNCONFIRMED: 'UNCONFIRMED',
  REPORTED: 'REPORTED',
  MANUAL_RECONCILIATION: 'MANUAL_RECONCILIATION',
  COUNTER_CONFIRMED: 'COUNTER_CONFIRMED',
  BANK_CONFIRMED: 'BANK_CONFIRMED',
  /** Cash-on-delivery order accepted: no money received yet, fulfillment happens on delivery. */
  COD_ORDER_PLACED: 'COD_ORDER_PLACED'
});

/**
 * Support ticket lifecycle states.
 */
export const TicketStatus = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
});

/**
 * Live chat message sender identity type.
 */
export const SenderType = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN'
});

/**
 * Audit log actor classifications.
 */
export const AuditActorType = Object.freeze({
  SYSTEM: 'SYSTEM',
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  OBSERVER: 'OBSERVER'
});
