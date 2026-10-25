/**
 * When does the run end?
 *
 * Three rules, all deterministic, all computed from facts the kernel wrote itself:
 *
 *   `max_rounds`                  a completed round count reached the configured maximum
 *   `max_no_improvement_rounds`   N completed rounds failed to beat the best result so far
 *   `consecutive_empty_rounds`    N completed rounds produced nothing comparable
 *
 * Nothing in this module consults a model. The numbers it compares come from `ranking.js`, which
 * reads only the platform-reported `metrics_collected` facts; a CAND_ANALYZE report saying "this
 * worked" cannot extend a run, and one saying "this failed" cannot shorten it.
 *
 * Two properties are worth stating because they are decisions, not incidentals:
 *
 *   1. **A stop is a fact first.** The `workspace_stopped` event lands before the workspace state
 *      moves to FINALIZE, the same order every other transition uses, so a crash between the two
 *      leaves a detectable lag rather than a conclusion nobody can explain.
 *   2. **One rule is recorded, not a vote.** Rules are checked in the declared order and the first
 *      match wins, so the same facts always produce the same recorded reason.
 *
 * "Did this round beat the best result" is a metric-contract question, not this module's: the resolved
 * contract (`metric-contract.js`) says which metric decides and how large a move has to be to count, so
 * a 0.005 gain inside the contract's 0.01 tolerance is not an improvement here *or* at the gate. When
 * the contract is absent or contradicts itself, both metric rules are skipped — and `describeRules`
 * says so by name (`missing` / `conflict`) instead of comparing against a threshold nobody declared.
 *
 * A stop also never fires while a candidate is still in flight: money spent on a running job cannot
 * be refunded by declaring the experiment over, so FINALIZE waits for the work to land.
 *
 * @module
 */

import { ranking, roundHistory } from './ranking.js'
import { primaryRule, resolveMetricContract } from './metric-contract.js'
import { WORKSPACE_SUBJECT } from './store.js'

/**
 * Re-exported from the store, which owns the identity space: events are keyed by
 * `(candidate_id, local_seq)`, so the reserved subject belongs where that key is defined. Kept
 * importable from here too, because this is the module that writes it.
 */
export { WORKSPACE_SUBJECT }

/** Spec: open-source defaults stop after three rounds; the other two are opt-in. */
export const DEFAULT_STOP = Object.freeze({
  max_rounds: 3,
  max_no_improvement_rounds: 0,
  consecutive_empty_rounds: 0,
})

/** Declared order is the precedence order. Adding a rule appends, so old decisions stay stable. */
export const STOP_RULES = Object.freeze(['max_rounds', 'max_no_improvement_rounds', 'consecutive_empty_rounds'])

/**
 * Normalise the stop configuration. `0` disables a rule — the same "0 means no limit" convention
 * the budget uses, so nobody has to remember two conventions for the same idea.
 *
 * An unusable value is reported in `error` and the rule stays disabled: silently stopping a run
 * because someone wrote `"three"` is the kind of failure that costs a night of compute.
 */
export function stopConfig(config) {
  const declared = config?.stop ?? {}
  const limits = { ...DEFAULT_STOP }
  const errors = []
  for (const rule of STOP_RULES) {
    const value = declared[rule]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push(`stop.${rule} must be a non-negative integer (0 disables it), got ${JSON.stringify(value)}`)
      continue
    }
    limits[rule] = value
  }
  return { ...limits, error: errors.length === 0 ? undefined : errors.join('; ') }
}

/**
 * A move that counts: better in the contract's direction by at least the contract's tolerance for
 * that metric. With no tolerance declared the tolerance is zero, which makes this strictly better —
 * the behaviour a run without a contract would have had, had it been allowed one.
 */
const effectiveImprovement = (value, previous, direction, tolerance = 0) => {
  const difference = direction === 'down' ? previous - value : value - previous
  return difference > 0 && difference >= tolerance
}

/** The trailing streak of completed rounds for which `predicate` held. */
function trailing(rounds, predicate) {
  let streak = 0
  for (const entry of rounds) streak = predicate(entry) ? streak + 1 : 0
  return streak
}

/**
 * Which rule, if any, is satisfied. Pure over the derived view: no store, no clock, no model.
 * @returns {{ rule: string, limit: number, observed: number, message: string } | undefined}
 */
function pickRule({ limits, rounds, view }) {
  const completed = rounds.filter((entry) => entry.complete)

  if (limits.max_rounds > 0) {
    const highest = completed.reduce((max, entry) => Math.max(max, entry.round), 0)
    if (highest >= limits.max_rounds) {
      return {
        rule: 'max_rounds',
        limit: limits.max_rounds,
        observed: highest,
        message: `round ${highest} complete and nothing is in flight; stop.max_rounds is ${limits.max_rounds}`,
      }
    }
  }

  // Both remaining rules are statements about a metric, and the kernel has no domain knowledge of
  // its own: without a metric contract they are skipped, not guessed at.
  if (view.contract.status !== 'ok') return undefined
  const { primary } = view.contract
  const rule = primaryRule(view.contract)
  const tolerance = rule?.minimum_effective_delta ?? 0

  if (limits.max_no_improvement_rounds > 0) {
    const direction = rule?.direction
    let bestSoFar
    let streak = 0
    for (const entry of completed) {
      // An empty round is the other rule's phenomenon; it neither improves nor "fails to improve".
      if (entry.best === undefined) continue
      if (bestSoFar === undefined) {
        bestSoFar = { ...entry.best, round: entry.round }
        continue
      }
      if (effectiveImprovement(entry.best.value, bestSoFar.value, direction, tolerance)) {
        bestSoFar = { ...entry.best, round: entry.round }
        streak = 0
      } else {
        streak += 1
      }
    }
    if (streak >= limits.max_no_improvement_rounds) {
      const held = bestSoFar === undefined ? `${primary} (no result yet)` : `${primary}=${bestSoFar.value} set by ${bestSoFar.candidate_id} in round ${bestSoFar.round}`
      const by = tolerance > 0 ? ` by at least ${tolerance}` : ''
      return {
        rule: 'max_no_improvement_rounds',
        limit: limits.max_no_improvement_rounds,
        observed: streak,
        message: `${streak} completed round(s) without beating ${held}${by} (stop.max_no_improvement_rounds=${limits.max_no_improvement_rounds})`,
      }
    }
  }

  if (limits.consecutive_empty_rounds > 0) {
    const streak = trailing(completed, (entry) => entry.empty)
    if (streak >= limits.consecutive_empty_rounds) {
      return {
        rule: 'consecutive_empty_rounds',
        limit: limits.consecutive_empty_rounds,
        observed: streak,
        message: `${streak} consecutive completed round(s) produced no comparable ${primary} result (stop.consecutive_empty_rounds=${limits.consecutive_empty_rounds})`,
      }
    }
  }

  return undefined
}

/**
 * Per-rule status. A rule that is enabled but has not fired is a different fact from a rule that is
 * off, and a dashboard or dump that shows only "not stopped" hides the difference.
 */
export function describeRules({ limits, view }) {
  const contract = view.contract
  return STOP_RULES.map((rule) => {
    if (limits[rule] === 0) return { rule, enabled: false, limit: 0, reason: 'disabled (0)' }
    if (rule !== 'max_rounds' && contract.status !== 'ok') {
      // The same name the other two readers use: `missing` when there is no contract, `conflict` when
      // it disagrees with itself. A rule that cannot run says which, rather than "needs a metric
      // contract", so a stranger reading a dump does not have to work out which problem it has.
      return {
        rule,
        enabled: true,
        limit: limits[rule],
        contract: contract.status,
        reason: `no contract (${contract.status}): ${contract.message}`,
      }
    }
    return { rule, enabled: true, limit: limits[rule], reason: null }
  })
}

/**
 * Decide whether the workspace should finalise now, and record the decision if so.
 *
 * @param {{ store: any, clock: { now: () => number }, config?: any, log?: (message: string, detail?: unknown) => void }} ports
 */
export function evaluateStop({ store, clock, config, log }) {
  // Resolved before anything else and returned on every path, so "why did this run stop" and "what
  // was it judging on" are answered by one object even when there was no contract to judge with.
  const contract = resolveMetricContract(config?.metrics)

  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  if (workspace.stopped !== undefined || workspace.phase === 'FINALIZE') {
    // Already concluded. Absorbing on purpose: a conclusion recorded once must not be re-derived,
    // re-worded, or followed by more work.
    return { stopped: true, already: true, ...(workspace.stopped ?? {}), contract }
  }

  const view = ranking(store, config, { persist: true })
  const rounds = roundHistory(view)
  const limits = stopConfig(config)

  const inFlight = view.candidates.filter((candidate) => candidate.status === 'active').map((candidate) => candidate.candidate_id)
  if (inFlight.length > 0) {
    return { stopped: false, blocked_by: inFlight, view, rounds, limits, contract }
  }

  const decision = pickRule({ limits, rounds, view })
  if (decision === undefined) return { stopped: false, view, rounds, limits, contract }

  const at = clock.now()
  const payload = {
    rule: decision.rule,
    limit: decision.limit,
    observed: decision.observed,
    message: decision.message,
    best: view.best ?? null,
    // Enough history to explain the decision later without replaying the whole stream, bounded so
    // the payload stays far below the one-event size limit.
    rounds: { considered: rounds.length, last: rounds.slice(-5) },
    rules: describeRules({ limits, view }),
  }
  // Facts before state, as everywhere else: the event is the reason, the state is the conclusion.
  const { local_seq: seq } = store.appendEvent({
    candidate_id: WORKSPACE_SUBJECT,
    wall_clock_ms: at,
    event_type: 'workspace_stopped',
    payload,
  })
  store.setState(undefined, 'workspace', {
    ...workspace,
    phase: 'FINALIZE',
    stopped: { ...payload, at_ms: at, event_seq: seq },
  })
  log?.(`FINALIZE: ${decision.rule} — ${decision.message}`)

  return { stopped: true, already: false, at_ms: at, event_seq: seq, ...payload, view, rounds, limits, contract }
}