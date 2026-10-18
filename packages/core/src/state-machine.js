/**
 * The authoritative state graph now lives in @youpi/common so that the
 * database repository (CAS enforcement) and all core engines share one
 * declaration. Re-exported here to preserve the existing public API.
 */
export {
  VALID_TRANSITIONS,
  isValidTransition,
  assertValidTransition,
  isTerminalStatus,
  allowedSourceStatuses,
  toPublicOutcome
} from '@youpi/common';