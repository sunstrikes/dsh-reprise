/**
 * Phase order and the boundary predicates.
 *
 * The distinction between `isPast` and `isBeyond` is load-bearing, not pedantic. A phase that
 * asks "what must already exist for me to run?" must use `isBeyond`: asking with an inclusive
 * comparison makes `VERIFY` demand the `verify_gate` that `VERIFY` is about to create, and the
 * whole candidate dies at its first tick. A prototype run hit exactly that and rejected two
 * candidates — fail-closed, correct direction, wrong conclusion.
 *
 * @module
 */

/** Candidate phases in path order. `REJECTED` is terminal and deliberately not on the path. */
export const CANDIDATE_PHASES = Object.freeze([
  'LAND',
  'BUILD',
  'VERIFY',
  'SUBMIT_QUEUED',
  'SUBMIT',
  'MONITOR_POLL',
  'CAND_ANALYZE',
  'DONE',
])

export const TERMINAL_PHASES = Object.freeze(['DONE', 'REJECTED'])

export const WORKSPACE_PHASES = Object.freeze(['INIT', 'BASELINE', 'ROUND_PLAN', 'FINALIZE'])

/** @param {string} phase */
export const isTerminal = (phase) => TERMINAL_PHASES.includes(phase)

/** @param {string} phase */
export const isKnownCandidatePhase = (phase) =>
  CANDIDATE_PHASES.includes(phase) || phase === 'REJECTED'

/**
 * Has this phase been reached? Boundary included.
 * @param {string} phase
 * @param {string} boundary
 */
export function isPast(phase, boundary) {
  const [a, b] = [CANDIDATE_PHASES.indexOf(phase), CANDIDATE_PHASES.indexOf(boundary)]
  return a >= 0 && b >= 0 && a >= b
}

/**
 * Is this phase strictly after the boundary — i.e. may it demand what the boundary produces?
 * Use this, not `isPast`, wherever the answer decides a requirement.
 * @param {string} phase
 * @param {string} boundary
 */
export function isBeyond(phase, boundary) {
  const [a, b] = [CANDIDATE_PHASES.indexOf(phase), CANDIDATE_PHASES.indexOf(boundary)]
  return a >= 0 && b >= 0 && a > b
}

/**
 * What a candidate in this phase may require to exist. Derived from the phase graph, never
 * hardcoded per call site — that is how `isPast`/`isBeyond` mistakes get reintroduced.
 *
 * Every entry here is produced by a phase, so every entry uses `isBeyond`: `LAND` freezes
 * `parent_binding`, `VERIFY` freezes `verify_gate`, `SUBMIT` writes the job row, and none of them
 * may demand its own output.
 *
 * @param {string} phase
 * @returns {{ bindings: string[], needsJob: boolean }}
 */
export function requirementsAt(phase) {
  const bindings = []
  if (isBeyond(phase, 'LAND')) bindings.push('parent_binding')
  if (isBeyond(phase, 'VERIFY')) bindings.push('verify_gate')
  return { bindings, needsJob: isBeyond(phase, 'SUBMIT') }
}