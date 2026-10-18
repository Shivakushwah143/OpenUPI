import { PaymentStatus, PublicPaymentOutcome } from './enums.js';

/**
 * Valid transitions graph for Payment Sessions:
 * Key: Source State
 * Value: Array of allowed Target States
 *
 * Kept in @youpi/common so BOTH the core state-machine and the database
 * repository (which enforces atomic compare-and-swap transitions) use the
 * single declared graph. (Audit P0-08)
 *
 * Every non-success terminal exit used by the running system is declared here:
 * - INITIATED/QUEUED -> EXPIRED: administrative queue clear and pending-session expiry.
 * - ACTIVE -> FAILED: counter/decline or verification failure while a slot is held.
 * - PROCESSING -> CANCELLED: customer aborts, switches device, or starts a new attempt
 *   while verification is still in flight.
 * These paths can never produce SUCCESS; SUCCESS is reachable from PROCESSING only,
 * and the repository additionally refuses it outside confirmPaymentSuccess().
 * Terminal states are final and can never be reopened.
 */
export const VALID_TRANSITIONS = Object.freeze({
  [PaymentStatus.INITIATED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.QUEUED,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.QUEUED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.ACTIVE]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED,
    PaymentStatus.FAILED
  ],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED
  ],
  [PaymentStatus.SUCCESS]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.EXPIRED]: [],
  [PaymentStatus.CANCELLED]: []
});

/**
 * Validates whether a state transition is permitted by the core state machine.
 * @param {string} currentState
 * @param {string} nextState
 * @returns {boolean}
 */
export function isValidTransition(currentState, nextState) {
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

/**
 * Asserts a valid transition, throwing a detailed domain error if violated.
 * @param {string} currentState
 * @param {string} nextState
 */
export function assertValidTransition(currentState, nextState) {
  if (!isValidTransition(currentState, nextState)) {
    throw new Error(
      `Illegal payment state transition: Cannot move from '${currentState}' to '${nextState}'.`
    );
  }
}

/**
 * Checks whether a payment status is a final, terminal outcome.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
  return [
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED
  ].includes(status);
}

/**
 * Inverse lookup: source states allowed to transition INTO the given target state.
 * Used for atomic conditional (compare-and-swap) UPDATE ... WHERE status IN (...).
 * @param {string} targetStatus
 * @returns {string[]}
 */
export function allowedSourceStatuses(targetStatus) {
  return Object.keys(VALID_TRANSITIONS).filter(
    source => VALID_TRANSITIONS[source].includes(targetStatus)
  );
}

/**
 * Converts internal payment status to the public contract outcome.
 * Throws if the status is not terminal.
 * @param {string} status
 * @returns {string}
 */
export function toPublicOutcome(status) {
  switch (status) {
    case PaymentStatus.SUCCESS:
      return PublicPaymentOutcome.SUCCESS;
    case PaymentStatus.FAILED:
      return PublicPaymentOutcome.FAILED;
    case PaymentStatus.EXPIRED:
      return PublicPaymentOutcome.EXPIRED;
    case PaymentStatus.CANCELLED:
      return PublicPaymentOutcome.CANCELLED;
    default:
      throw new Error(`Status '${status}' is an internal non-terminal state and cannot be mapped to a public outcome.`);
  }
}