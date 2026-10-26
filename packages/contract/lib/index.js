/**
 * The contract: four-state validation, phase boundaries, the identity binding chain, and the
 * artifact registry.
 *
 * This package depends on nothing else in the repository. That is deliberate — a validator that
 * imports the scheduler can never tell you whether it is enforcing the contract or the
 * scheduler's internal habits.
 *
 * @module
 */

export {
  BLOCKING,
  CONFLICT,
  INVALID,
  MISSING,
  OK,
  STATUSES,
  conflict,
  fail,
  fromFindings,
  invalid,
  isBlocking,
  isOk,
  missing,
  ok,
} from './status.js'

export {
  CANDIDATE_PHASES,
  TERMINAL_PHASES,
  WORKSPACE_PHASES,
  isBeyond,
  isKnownCandidatePhase,
  isPast,
  isTerminal,
  requirementsAt,
} from './order.js'

export {
  artifactKinds,
  artifactSchemaVersion,
  checkField,
  defineArtifact,
  isCount,
  isMilliseconds,
  isNonEmptyString,
  isPlainObject,
  validateArtifact,
} from './artifact.js'

export { BINDING_KINDS, validateCandidate, validateChain } from './identity.js'

export {
  WINDOW_SERIES_KIND,
  WINDOW_SERIES_VERSION,
  checkWindowSeries,
  pairWindows,
  windowKey,
} from './windows.js'

// Registers the built-in kinds as a side effect of importing the package.
import './kinds.js'
import './windows.js'