/**
 * When does the run end, and when does a single candidate? Two different conclusions, one module.
 *
 * Every rule here is deterministic and computed from facts the kernel wrote itself. Nothing consults
 * a model: the numbers come from `ranking.js` (which reads only platform-reported `metrics_collected`
 * facts) and from the windowed samples `samples.js` records (`window_samples` facts pointing at
 * `window_series` artifacts). A CAND_ANALYZE report saying "this worked" cannot extend a run, and one
 * saying "this failed" cannot shorten it — the report is not an input this module can even see.
 *
 * ## The two kinds of conclusion
 *
* **Workspace conclusions** end the run. They land on the reserved `_workspace` subject as a
 * `workspace_stopped` event and in the workspace state, so `dump` and the dashboard can say why the
 * run ended without recomputing anything. Declared order is the precedence order, and adding a rule
 * appends so that an old decision stays stable:
 *
 *   `max_rounds` · `max_no_improvement_rounds` · `consecutive_empty_rounds` (round-shaped) ·
 *   `max_wall_hours` (a wall-clock ceiling) · `max_windows` (a window/epoch ceiling)
 *
 * **Candidate conclusions** kill one candidate and leave the run going. Rejecting a candidate is not
 * "the experiment is over" — an idea that produced unusable evidence says nothing about the next
 * idea — so these are recorded as `candidate_rejected` facts on that candidate, with a `stop_rule`
 * naming the rule that killed it:
 *
 *   `last_window_unmeasured` — the 「证据无效」 case, in words that do not borrow the four states: the
 *   artifact was fine and the number was **absent** ("not measured"). The reason is
 *   `evidence_missing` and it carries **no four-state status** (CODING_STANDARDS §2), because
 *   nothing was malformed — `evidence_invalid` said the opposite of what the fact was.
 *   `metric_regression` — a ranked metric worse than the baseline in every one of the trailing N
 *   paired windows, beyond that metric's tolerance.
 *
 * ## Priority order (parity-gap §2A)
 *
 *   1. **Platform terminal state.** A stop never fires while a candidate is still in flight: money
 *      spent on a running job cannot be refunded by declaring the experiment over, so the workspace
 *      waits for the work to land. The decision names what it is waiting for (`blocked_by`) rather
 *      than looking stuck.
 *   2. **Workspace ceilings** — the round rules, then the wall-clock and window ceilings, in the
 *      declared order above. These are conclusions about the run.
 *   3. **The evidence rule, then the regression overlay.** The overlay only *tightens*: it can add a
 *      candidate kill, never cancel or soften a conclusion reached above it, and no candidate is
 *      killed on the way out of a workspace conclusion (the run is already over).
 *
 * Between the two candidate rules the evidence rule comes first: a candidate whose tail window
 * reports nothing cannot be compared at all, so "no number" is answered before "worse number".
 *
 * ## The tolerance floor, and why it may only tighten
 *
 * A candidate's regression tolerance is its contract's `minimum_effective_delta` for that metric —
 * the same number the ranking and the gate already use. Cross-hardware common-mode offset makes a
 * healthy candidate look worse by more than that, which is what the predecessor's floor was for: a
 * `stop.regression_floor` **raises** a declared tolerance to a minimum noise floor. It can never
 * lower one — a floor below the declared tolerance is *refused* and the declared tolerance stands
 * (`floor_refused: true` on the decision), because a floor that could shrink a tolerance would let a
 * configuration turn noise into kills. The arithmetic that was in force is recorded either way, so a
 * reader can see why a candidate survived a drop.
 *
 * ## Two properties worth stating because they are decisions, not incidentals
 *
 *   1. **A conclusion is a fact first.** The event lands before the state moves, the same order every
 *      other transition uses, so a crash between the two leaves a detectable lag rather than a
 *      conclusion nobody can explain.
 *   2. **One rule is recorded, not a vote.** Rules are checked in the declared order and the first
 *      match wins, so the same facts always produce the same recorded reason.
 *
 * `decideStop` is that whole decision as a pure function of facts, samples and a clock reading; the
 * store, the artifact directory and the log are reached only by `evaluateStop`, which is the thin
 * shell that reads them, calls it, and records the answer.
 *
 * @module
 */

import { pairWindows } from '@dsh-reprise/contract'

import { BASELINE_SUBJECT } from './baseline.js'
import { ranking, roundHistory } from './ranking.js'
import { primaryRule, resolveMetricContract, windowValues } from './metric-contract.js'
import { windowSamplesOf } from './samples.js'
import { WORKSPACE_SUBJECT } from './store.js'

/**
 * Re-exported from the store, which owns the identity space: events are keyed by
 * `(candidate_id, local_seq)`, so the reserved subject belongs where that key is defined. Kept
 * importable from here too, because this is the module that writes it.
 */
export { WORKSPACE_SUBJECT }

/** Spec: open-source defaults stop after three rounds; every other rule is opt-in. */
export const DEFAULT_STOP = Object.freeze({
  max_rounds: 3,
  max_no_improvement_rounds: 0,
  consecutive_empty_rounds: 0,
  max_wall_hours: 0,
  max_windows: 0,
})

/**
 * Declared order is the precedence order. Adding a rule appends, so old decisions stay stable.
 *
 * These are the *workspace* rules — the ones whose conclusion ends the run and is recorded on
 * `_workspace`; the candidate rules are `CANDIDATE_STOP_RULES` below.
 */
export const STOP_RULES = Object.freeze([
  'max_rounds',
  'max_no_improvement_rounds',
  'consecutive_empty_rounds',
  'max_wall_hours',
  'max_windows',
])

/** Declared order, which is also precedence: unusable evidence is answered before "worse". */
export const CANDIDATE_STOP_RULES = Object.freeze(['last_window_unmeasured', 'metric_regression'])

/**
 * Rules that need no metric contract: a round count, a clock and a window count are readable without
 * knowing which metric decides the run.
 */
const CONTRACT_FREE_RULES = new Set(['max_rounds', 'max_wall_hours', 'max_windows'])

/** Rules whose limit is a number of hours rather than a count. */
const DURATION_RULES = new Set(['max_wall_hours'])

const HOUR_MS = 3_600_000

/** A non-negative finite number, or undefined when the declared value is not one. */
const quantity = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/**
 * The tolerance floor, normalised to `{default, byMetric}`. The same idiom the metric contract uses
 * for its per-metric settings: a bare number for every ranked metric, or an object whose `default`
 * key holds the value for the metrics not named individually.
 */
function normaliseFloor(declared, errors) {
  if (declared === undefined) return { default: 0, byMetric: {} }
  if (typeof declared === 'number') {
    const value = quantity(declared)
    if (value === undefined) {
      errors.push(`stop.regression_floor must be a non-negative number, got ${JSON.stringify(declared)}`)
      return { default: 0, byMetric: {} }
    }
    return { default: value, byMetric: {} }
  }
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    errors.push(`stop.regression_floor must be a number or an object of per-metric numbers, got ${JSON.stringify(declared)}`)
    return { default: 0, byMetric: {} }
  }
  const byMetric = {}
  let fallback = 0
  for (const [key, raw] of Object.entries(declared)) {
    const value = quantity(raw)
    if (value === undefined) {
      errors.push(`stop.regression_floor.${key} must be a non-negative number, got ${JSON.stringify(raw)}`)
      continue
    }
    if (key === 'default') fallback = value
    else byMetric[key] = value
  }
  return { default: fallback, byMetric }
}

/**
 * Normalise the stop configuration. `0` disables a rule — the same "0 means no limit" convention
 * the budget uses, so nobody has to remember two conventions for the same idea.
 *
 * An unusable value is reported in `error` and the rule stays disabled: silently stopping a run
 * because someone wrote `"three"` is the kind of failure that costs a night of compute.
 */
export function stopConfig(config) {
  const declared = config?.stop ?? {}
  const limits = { ...DEFAULT_STOP, regression_windows: 0, regression_floor: { default: 0, byMetric: {} } }
  const errors = []
  for (const rule of STOP_RULES) {
    const value = declared[rule]
    if (value === undefined) continue
    if (DURATION_RULES.has(rule)) {
      const hours = quantity(value)
      if (hours === undefined) {
        errors.push(`stop.${rule} must be a non-negative number of hours (0 disables it), got ${JSON.stringify(value)}`)
        continue
      }
      limits[rule] = hours
      continue
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push(`stop.${rule} must be a non-negative integer (0 disables it), got ${JSON.stringify(value)}`)
      continue
    }
    limits[rule] = value
  }

  const regressionWindows = declared.regression_windows
  if (regressionWindows !== undefined) {
    if (!Number.isSafeInteger(regressionWindows) || regressionWindows < 0) {
      errors.push(
        `stop.regression_windows must be a non-negative integer (0 disables it), got ${JSON.stringify(regressionWindows)}`,
      )
    } else {
      limits.regression_windows = regressionWindows
    }
  }
  limits.regression_floor = normaliseFloor(declared.regression_floor, errors)

  return { ...limits, error: errors.length === 0 ? undefined : errors.join('; ') }
}

/**
 * The tolerance a regression is measured against, and what the floor did to it.
 *
 * `tolerance = max(declared, floor)` is the whole rule: the floor may raise a tolerance (a hardware
 * offset is not a regression) and may never lower one. A floor below the declared tolerance is
 * refused — recorded as `floor_refused`, with the reason — instead of quietly making the kill rule
 * stricter than the contract asked for.
 *
 * @param {{declared?: number, floor?: number}} tolerance
 */
export function regressionTolerance({ declared = 0, floor = 0 }) {
  const floor_refused = floor > 0 && floor < declared
  return {
    declared,
    floor,
    tolerance: Math.max(declared, floor),
    floor_refused,
    ...(floor_refused
      ? { note: `stop.regression_floor ${floor} would loosen the declared tolerance ${declared}; a floor may only raise a tolerance` }
      : {}),
  }
}

/**
 * A move that counts: better in the contract's direction by at least the contract's tolerance for
 * that metric. With no tolerance declared the tolerance is zero, which makes this strictly better —
 * the behaviour a run without a contract would have had, had it been allowed one.
 */
const effectiveImprovement = (value, previous, direction, tolerance = 0) => {
  const difference = direction === 'down' || direction === 'lower' ? previous - value : value - previous
  return difference > 0 && difference >= tolerance
}

/** The trailing streak of completed rounds for which `predicate` held. */
function trailing(rounds, predicate) {
  let streak = 0
  for (const entry of rounds) streak = predicate(entry) ? streak + 1 : 0
  return streak
}

/**
 * The two streaks the round rules measure, over the rounds that have **finished**.
 *
 * Exported because two surfaces print them: the stop gauges here, and the readings row the projection
 * publishes (`overview.rounds.emptyStreak` / `noImprovementStreak`). They used to be two loops — one
 * over the completed rounds, one over the whole history — and on a live run the row said "empty
 * streak 1" while the gauge measured "0/2", because the round still in flight has produced nothing
 * *yet* and the whole-history loop counted that as an empty round. One loop, one number.
 *
 * `flat` is the no-improvement streak *as the rule measures it*: an improvement is a gain of at least
 * the contract's `minimum_effective_delta`, not merely a strictly better number. `roundHistory`'s
 * `improving` flag answers a different question (did the running best rise at all), so it cannot be
 * used here without the two counters disagreeing on a gain smaller than the tolerance.
 *
 * @param {{ rounds?: object[], contract?: object }} facts
 * @returns {{ empty: number, flat: number, best?: object }} `best` is the result the streak is up against, for the message
 */
export function roundStreaks({ rounds = [], contract } = {}) {
  const completed = rounds.filter((entry) => entry.complete)
  const ok = contract?.status === 'ok'
  const rule = ok ? primaryRule(contract) : undefined
  const direction = ok ? rule?.direction : undefined
  const tolerance = ok ? (rule?.minimum_effective_delta ?? 0) : 0

  let best
  let flat = 0
  for (const entry of completed) {
    // An empty round is the other rule's phenomenon; it neither improves nor "fails to improve".
    if (entry.best === undefined) continue
    if (best === undefined) {
      best = { ...entry.best, round: entry.round }
      continue
    }
    if (effectiveImprovement(entry.best.value, best.value, direction, tolerance)) {
      best = { ...entry.best, round: entry.round }
      flat = 0
    } else {
      flat += 1
    }
  }

  return { empty: trailing(completed, (entry) => entry.empty), flat, best }
}

/** How many windows the run has measured, taken from the longest series any subject recorded. */
function windowsMeasured(samples) {
  const lengths = [samples?.baseline, ...Object.values(samples?.candidates ?? {})].map((series) =>
    Array.isArray(series?.windows) ? series.windows.length : 0,
  )
  return lengths.reduce((max, length) => Math.max(max, length), 0)
}

/**
 * How far along every workspace rule is — one measurement, for the decision *and* for the gauges.
 *
 * This function exists because a page that shows "3/3" beside a conclusion recorded as
 * `consecutive_empty_rounds 2/2` is a page nobody can act on: two counters, two answers, one run. So
 * the per-rule reading is taken here, once, and `pickRule` is a comparison over *this* map rather
 * than a second traversal of the same facts. A rule can only report a distance here by being
 * measured, and the only thing `pickRule` adds is the limit it is measured against.
 *
 * Each entry is `{ observed, message }` when the rule was measured, and `{ observed: null }` when it
 * was not — with `unmeasured` naming the missing input, because "I did not look" and "I looked and
 * found 0" are different answers and only one of them belongs on a gauge. A rule that cannot run at
 * all is *not* decided here: a disabled rule and a rule blocked by a broken metric contract are
 * `describeRules`' business, which owns the words for them (`disabled (0)`, `no contract (…)`).
 *
 * `observed` is what a limit is compared against; `reading` is the same value as it is published,
 * present only where rounding it would change the comparison (see the wall clock below).
 *
 * @param {{
 *   limits: object,
 *   view: object,
 *   rounds?: object[],     // `roundHistory(view)`; absent means "not measured"
 *   contract?: object,
 *   samples?: object,      // the window series; absent means "not measured"
 *   now?: number,
 *   startedAt?: number,
 * }} facts
 * @returns {Map<string, { observed: number | null, reading?: number, message?: string, unmeasured?: string }>}
 */
function measureRules({ limits, view, rounds, contract = view.contract, samples, now, startedAt }) {
  const measured = new Map()
  // `undefined` is "the caller did not supply this input"; `[]` is "the caller looked, and there is
  // no round yet". Only the first is unmeasured.
  const completed = rounds === undefined ? undefined : rounds.filter((entry) => entry.complete)

  if (completed === undefined) {
    measured.set('max_rounds', { observed: null, unmeasured: 'no round history was supplied, so this rule was not measured' })
  } else {
    const highest = completed.reduce((max, entry) => Math.max(max, entry.round), 0)
    measured.set('max_rounds', {
      observed: highest,
      message: `round ${highest} complete and nothing is in flight; stop.max_rounds is ${limits.max_rounds}`,
    })
  }

  // The next two rules are statements about a metric, and the kernel has no domain knowledge of its
  // own: without a metric contract they are skipped, not guessed at. They are left *unmeasured*
  // rather than measured as zero, and `describeRules` names the reason (`no contract (…)`).
  const rule = contract.status === 'ok' ? primaryRule(contract) : undefined
  const { primary } = contract
  const tolerance = rule?.minimum_effective_delta ?? 0
  const measurable = contract.status === 'ok' && completed !== undefined

  if (completed === undefined || !measurable) {
    measured.set('max_no_improvement_rounds', {
      observed: null,
      ...(completed === undefined
        ? { unmeasured: 'no round history was supplied, so this rule was not measured' }
        : {}),
    })
    measured.set('consecutive_empty_rounds', {
      observed: null,
      ...(completed === undefined
        ? { unmeasured: 'no round history was supplied, so this rule was not measured' }
        : {}),
    })
  } else {
    // The same function the readings row reads, so the gauge and the cell are one number rather than
    // two loops that happen to agree on a finished run.
    const { empty, flat, best } = roundStreaks({ rounds, contract })
    const held =
      best === undefined
        ? `${primary} (no result yet)`
        : `${primary}=${best.value} set by ${best.candidate_id} in round ${best.round}`
    const by = tolerance > 0 ? ` by at least ${tolerance}` : ''
    measured.set('max_no_improvement_rounds', {
      observed: flat,
      message: `${flat} completed round(s) without beating ${held}${by} (stop.max_no_improvement_rounds=${limits.max_no_improvement_rounds})`,
    })
    measured.set('consecutive_empty_rounds', {
      observed: empty,
      message: `${empty} consecutive completed round(s) produced no comparable ${primary} result (stop.consecutive_empty_rounds=${limits.consecutive_empty_rounds})`,
    })
  }

  // A wall clock is readable without any contract: the run has simply been open too long, and saying
  // so at workspace level is the difference between "the run timed out" and "a candidate timed out".
  // (The budget's own wall clock *pauses* instead — money spent and time spent are different facts,
  // and the tick checks the budget first, so a configured `budget.max_runtime_hours` still pauses.)
  if (typeof now !== 'number' || typeof startedAt !== 'number') {
    measured.set('max_wall_hours', {
      observed: null,
      unmeasured:
        startedAt === null || startedAt === undefined
          ? 'this run recorded no start instant, so its wall clock cannot be measured'
          : 'no clock reading was supplied, so the wall clock was not measured',
    })
  } else {
    const hours = Math.max(0, now - startedAt) / HOUR_MS
    // `observed` is the exact duration the rule is compared against; `reading` is the same number to
    // three decimals, which is what gets published. The two are kept apart on purpose: comparing a
    // *rounded* clock against a whole-hour limit would have a run stop one tick early, and a page
    // that then showed "2.00 / 2" for a run that has not stopped would look broken.
    measured.set('max_wall_hours', {
      observed: hours,
      reading: Number(hours.toFixed(3)),
      message: `the run has been open for ${hours.toFixed(2)}h and stop.max_wall_hours is ${limits.max_wall_hours}`,
    })
  }

  // A window ceiling is the same statement in the run's own unit: enough training has been measured
  // that another candidate would not be compared over the same intervals.
  if (samples === undefined) {
    measured.set('max_windows', {
      observed: null,
      unmeasured: 'the window samples were not read, so the window count was not taken',
    })
  } else {
    const windows = windowsMeasured(samples)
    measured.set('max_windows', {
      observed: windows,
      message: `the run has measured ${windows} window(s) and stop.max_windows is ${limits.max_windows}`,
    })
  }

  return measured
}

/**
 * Which workspace rule, if any, is satisfied. Pure over the derived view and the samples: no store,
 * no clock of its own, no model.
 *
 * A rule fires when the limit it declares has been reached by the value `measureRules` took for it.
 * In declared order, and the first match wins — so the recorded reason is reproducible rather than a
 * vote, which is the property the decision had before the gauges existed.
 *
 * @returns {{ rule: string, limit: number, observed: number, message: string } | undefined}
 */
function pickRule(facts) {
  const measured = measureRules(facts)
  for (const rule of STOP_RULES) {
    const entry = measured.get(rule)
    // Not measured is not zero: a rule whose counter nobody took cannot have been reached.
    if (entry === undefined || entry.observed === null) continue
    if (!(facts.limits[rule] > 0)) continue
    if (entry.observed >= facts.limits[rule]) {
      return {
        rule,
        limit: facts.limits[rule],
        observed: entry.reading ?? entry.observed,
        message: entry.message,
      }
    }
  }
  return undefined
}

/**
 * The 「证据无效」 rule: the candidate's last window carries no finite value for the metric that decides.
 *
 * Named for what it found, and so is the reason it reports. The window series is a well-formed
 * artifact — it is there, it parses, it satisfies the contract — so nothing about it is *invalid*: the
 * number it should carry is **absent**. `evidence_missing` is that fact; the rejection carries no
 * four-state status at all, because there is no artifact that breaks its schema to name.
 *
 * Why the last window and not the mean: a run's tail is where a rollout, a divergence or a broken
 * parser shows up, and the contract's `window_mode` decides how a *comparison* collapses — not
 * whether the run's last window exists. An older window is never substituted, because that would read
 * as "the last measurement" while the fact says "the last window".
 *
 * A candidate with no series at all is **not** killed here: no evidence is a missing measurement (the
 * samples are optional for a candidate), while this rule is about evidence that exists and says
 * nothing where the number should be.
 */
function missingEvidence({ contract, candidate, series }) {
  if (series === undefined || contract.status !== 'ok') return undefined
  const metric = contract.primary
  const windows = windowValues(series, metric)
  const last = windows[windows.length - 1]
  if (last !== undefined && last.value !== undefined) return undefined

  return {
    candidate_id: candidate.candidate_id,
    rule: 'last_window_unmeasured',
    reason: 'evidence_missing',
    metric,
    window: last === undefined ? null : { index: last.index, start: last.start, end: last.end },
    message:
      last === undefined
        ? `${candidate.candidate_id} recorded a window series holding no window at all, so there is nothing to judge it on: the deciding metric was not measured`
        : `${candidate.candidate_id}'s last window [${last.start}, ${last.end}) holds no finite ${metric}, whatever earlier windows measured: the metric was not measured there, so this candidate is rejected now rather than waiting for a timeout`,
  }
}

/** How many trailing paired windows are worse than the baseline by more than `tolerance`. */
function regressionStreak(pairs, objective, tolerance) {
  const lower = objective.direction === 'down' || objective.direction === 'lower'
  let streak = 0
  for (const pair of pairs) {
    const candidate = pair.candidate?.metrics?.[objective.name]
    const baseline = pair.baseline?.metrics?.[objective.name]
    const comparable =
      typeof candidate === 'number' && Number.isFinite(candidate) && typeof baseline === 'number' && Number.isFinite(baseline)
    // A window that did not measure the metric on both sides is not a regression — and not a reprieve
    // either: the run of windows ends here, because "N windows in a row regressed" needs N windows
    // that were actually compared.
    const worse = comparable && (lower ? candidate - baseline : baseline - candidate) > tolerance
    streak = worse ? streak + 1 : 0
  }
  return streak
}

/**
 * The regression overlay: per ranked metric, the trailing run of paired windows that regressed.
 *
 * Windows are paired by their bounds (`pairWindows`), never by position: two runs that evaluated at
 * different steps have no window in common to compare, and pairing them by ordinal would call a
 * different amount of training an improvement. A pair that shares no metric yields no comparison, and
 * "no comparison" is never a kill.
 *
 * Returns the tolerances it used whether or not it killed, so a reader can see the arithmetic that
 * saved a candidate — and whether a floor was refused for trying to loosen it.
 */
function regressedMetric({ limits, contract, candidate, series, baseline }) {
  if (limits.regression_windows <= 0 || contract.status !== 'ok') return { tolerances: [] }
  if (series === undefined || baseline === undefined) return { tolerances: [] }
  const pairing = pairWindows(series, baseline)
  if (pairing.status !== 'ok') return { tolerances: [] }

  const tolerances = []
  let kill
  for (const objective of contract.objectives) {
    const resolved = regressionTolerance({
      declared: objective.minimum_effective_delta ?? 0,
      floor: limits.regression_floor.byMetric[objective.name] ?? limits.regression_floor.default,
    })
    const streak = regressionStreak(pairing.pairs, objective, resolved.tolerance)
    tolerances.push({ candidate_id: candidate.candidate_id, metric: objective.name, windows: streak, ...resolved })
    if (kill !== undefined || streak < limits.regression_windows) continue
    const raised =
      resolved.tolerance > resolved.declared
        ? ` (raised from the contract's ${resolved.declared} by stop.regression_floor ${resolved.floor})`
        : ''
    kill = {
      candidate_id: candidate.candidate_id,
      rule: 'metric_regression',
      reason: 'metric_regression',
      metric: objective.name,
      direction: objective.direction,
      windows: streak,
      limit: limits.regression_windows,
      ...resolved,
      message: `${candidate.candidate_id} is worse than the baseline on ${objective.name} in each of the last ${streak} paired window(s), by more than ${resolved.tolerance}${raised} — a regression across the trailing window run (stop.regression_windows=${limits.regression_windows})`,
    }
  }
  return { kill, tolerances }
}

/**
 * The candidate rules, keyed by the name the fact records. Iterating `CANDIDATE_STOP_RULES` rather
 * than calling them in some order is what makes the declared order the executed order: unusable
 * evidence is answered before "worse", and a rule added later is appended, not slotted in.
 */
const CANDIDATE_JUDGES = Object.freeze({
  last_window_unmeasured: ({ contract, candidate, series }) => ({ kill: missingEvidence({ contract, candidate, series }), tolerances: [] }),
  metric_regression: ({ limits, contract, candidate, series, baseline }) =>
    regressedMetric({ limits, contract, candidate, series, baseline }),
})

/**
 * What to say about each completed candidate. Only `done` candidates are judged: one still running is
 * still writing, and one already rejected has been answered.
 */
function judgeCandidates({ limits, contract, candidates, samples }) {
  const judged = []
  for (const candidate of candidates) {
    if (candidate.status !== 'done') continue
    const series = samples?.candidates?.[candidate.candidate_id]
    const tolerances = []
    let kill
    for (const rule of CANDIDATE_STOP_RULES) {
      if (kill !== undefined) break
      const verdict = CANDIDATE_JUDGES[rule]({ limits, contract, candidate, series, baseline: samples?.baseline })
      tolerances.push(...(verdict.tolerances ?? []))
      kill = verdict.kill
    }
    judged.push({ candidate_id: candidate.candidate_id, ...(kill === undefined ? {} : { kill }), tolerances })
  }
  return judged
}

/**
 * The whole stop decision, as a pure function of facts, samples and a clock reading.
 *
 * @param {{
 *   limits: object,        // `stopConfig(config)`
 *   view: object,          // the frontier view
 *   rounds?: object[],     // `roundHistory(view)`
 *   contract?: object,     // the resolved metric contract
 *   samples?: { baseline?: object, candidates?: Record<string, object> },
 *   now?: number,          // the clock's reading, in milliseconds
 *   startedAt?: number,    // when the run was opened, in milliseconds
 * }} facts
 * @returns {{
 *   stop?: object,         // the workspace conclusion, when one fired
 *   kills: object[],       // candidate conclusions, in candidate order
 *   candidates: object[],  // what was concluded about each completed candidate
 *   tolerances: object[],  // the regression arithmetic that was in force
 *   blocked_by?: string[], // candidates whose work keeps the workspace open
 * }}
 */
export function decideStop({ limits, view, rounds = [], contract = view.contract, samples = {}, now = 0, startedAt = 0 }) {
  const inFlight = view.candidates.filter((candidate) => candidate.status === 'active').map((candidate) => candidate.candidate_id)

  // A workspace conclusion outranks everything: once the run is over, no candidate is killed on the
  // way out — the kill would be a fact about a run that has already been concluded. Nothing concludes
  // anything, so to speak, while a candidate is still spending.
  const stop = inFlight.length > 0 ? undefined : pickRule({ limits, rounds, view, contract, samples, now, startedAt })
  if (stop !== undefined) return { stop, kills: [], candidates: [], tolerances: [] }

  // Candidate conclusions do not end the run, so they are still reached while other work is in
  // flight: a candidate whose evidence is already unusable should not wait for its sibling to finish.
  const judged = judgeCandidates({ limits, contract, candidates: view.candidates, samples })
  return {
    stop: undefined,
    kills: judged.filter((entry) => entry.kill !== undefined).map((entry) => entry.kill),
    candidates: judged,
    tolerances: judged.flatMap((entry) => entry.tolerances),
    ...(inFlight.length === 0 ? {} : { blocked_by: inFlight }),
  }
}

/**
 * Per-rule status: is the rule on, what is its limit, and **how far along is it**.
 *
 * A rule that is enabled but has not fired is a different fact from a rule that is off, and a
 * dashboard or dump that shows only "not stopped" hides the difference. The third fact is the one
 * ticket #4 adds: the observed value, so a reader can see how much room is left before the run ends
 * rather than only learning the reason afterwards.
 *
 * Three fields say why a rule has no reading, and they are not interchangeable:
 *
 *   - `enabled: false` — the rule was configured off (`0` disables, as everywhere in this kernel);
 *   - `reason` — the rule cannot run at all: it is off, or it is a metric rule and the contract is
 *     `missing` / `invalid` / `conflict`;
 *   - `unmeasured` — the rule could run, but this call did not supply the input it needs (a caller
 *     with only a `view` has no round history, no samples and no clock). The value is `null`, never
 *     `0`, because a rule nobody measured has not been read.
 *
 * `distancePercent` is the fraction of its limit a rule has reached, capped at 100 — the fill of a
 * gauge. It is a *distance*, not progress: reaching `max_rounds` is stopping, not succeeding. It is
 * computed here, with the observed value, so no renderer divides two numbers of its own.
 *
 * @param {{
 *   limits: object,        // `stopConfig(config)`
 *   view: object,          // the frontier view
 *   rounds?: object[],     // `roundHistory(view)`
 *   samples?: { baseline?: object, candidates?: Record<string, object> },
 *   now?: number,
 *   startedAt?: number,
 * }} facts
 */
export function describeRules({ limits, view, rounds, samples, now, startedAt }) {
  const contract = view.contract
  const measured = measureRules({ limits, view, rounds, contract, samples, now, startedAt })
  return STOP_RULES.map((rule) => {
    const entry = measured.get(rule) ?? { observed: null }
    // What the gauge prints is the same number the decision records — `reading` where a rounded
    // value is the published one, the measured value everywhere else.
    const shown = entry.observed === null ? null : (entry.reading ?? entry.observed)
    if (limits[rule] === 0) {
      return { rule, enabled: false, limit: 0, observed: null, distancePercent: null, reason: 'disabled (0)' }
    }
    if (!CONTRACT_FREE_RULES.has(rule) && contract.status !== 'ok') {
      // The same name the other two readers use: `missing` when there is no contract, `conflict` when
      // it disagrees with itself. A rule that cannot run says which, rather than "needs a metric
      // contract", so a stranger reading a dump does not have to work out which problem it has.
      return {
        rule,
        enabled: true,
        limit: limits[rule],
        contract: contract.status,
        observed: null,
        distancePercent: null,
        reason: `no contract (${contract.status}): ${contract.message}`,
      }
    }
    return {
      rule,
      enabled: true,
      limit: limits[rule],
      observed: shown,
      distancePercent: shown === null ? null : Math.min(100, Number(((shown / limits[rule]) * 100).toFixed(2))),
      reason: null,
      unmeasured: shown === null ? (entry.unmeasured ?? 'this rule was not measured') : null,
    }
  })
}

/**
 * The windowed samples every candidate rule reads: the frozen baseline's series, and one per
 * candidate.
 *
 * Read through `samples.js`, which owns the fact→artifact link, so the baseline and a candidate are
 * read by the same code — a comparison assembled from two different readings of the same document
 * shape would be able to disagree with itself.
 *
 * Exported because the projection owns the *other* reader of these samples: the `max_windows` gauge
 * on the dashboard reports "how many windows has the run measured", which is `windowsMeasured` over
 * these series. Two readers of the same artifacts would eventually disagree about a count that only
 * one of them can see, so the dashboard walks the same door the decision does.
 */
export function samplesFor(store, artifacts, view, limits) {
  const candidates = {}
  for (const candidate of view.candidates) {
    // Only a completed candidate has a tail to judge; reading a running one's events every tick would
    // re-read a fact stream to learn "not written yet".
    if (candidate.status !== 'done') continue
    const series = windowSamplesOf({ store, artifacts }, candidate.candidate_id)
    if (series !== undefined) candidates[candidate.candidate_id] = series
  }
  // The baseline is the denominator, and only the comparison and the window ceiling read it: a run
  // with neither configured should not carry a document it will not look at.
  const needsBaseline = limits.regression_windows > 0 || limits.max_windows > 0
  return { baseline: needsBaseline ? windowSamplesOf({ store, artifacts }, BASELINE_SUBJECT) : undefined, candidates }
}

/**
 * Record a workspace-level conclusion: the event first, then the state that absorbs it.
 *
 * Exported because the stop rules are not the only thing that can end a workspace. A workspace whose
 * denominator cannot be produced ends too (see `baseline.js`), and a second writer of
 * `workspace_stopped` that spelled the payload differently would make the same conclusion read two
 * ways depending on which writer fired. `status` is present only when the *contract* refused
 * something — a failed run is a stop with a message and no four-state status at all
 * (CODING_STANDARDS §2).
 *
 * @param {{store: any, clock: {now: () => number}, log?: Function}} ports
 * @param {{rule: string, message: string, limit?: number, observed?: number, best?: object|null,
 *          rounds?: object, rules?: object[], status?: string, detail?: object}} decision
 */
export function recordStop({ store, clock, log }, decision) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const at = clock.now()
  const payload = {
    rule: decision.rule,
    limit: decision.limit ?? null,
    observed: decision.observed ?? null,
    message: decision.message,
    best: decision.best ?? null,
    rounds: decision.rounds ?? { considered: 0, last: [] },
    rules: decision.rules ?? [],
    ...(decision.status === undefined ? {} : { status: decision.status }),
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
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

  return { stopped: true, already: false, at_ms: at, event_seq: seq, ...payload }
}

/**
 * Decide whether the workspace should finalise now, which candidates are already lost, and record
 * both kinds of conclusion in the place each belongs.
 *
 * @param {{ store: any, clock: { now: () => number }, config?: any, artifacts?: any, log?: (message: string, detail?: unknown) => void }} ports
 */
export function evaluateStop({ store, clock, config, artifacts, log }) {
  // Resolved before anything else and returned on every path, so "why did this run stop" and "what
  // was it judging on" are answered by one object even when there was no contract to judge with.
  const contract = resolveMetricContract(config?.metrics)

  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  if (workspace.stopped !== undefined || workspace.phase === 'FINALIZE') {
    // Already concluded. Absorbing on purpose: a conclusion recorded once must not be re-derived,
    // re-worded, or followed by more work.
    return { stopped: true, already: true, kills: [], ...(workspace.stopped ?? {}), contract }
  }

  const view = ranking(store, config, { persist: true })
  const rounds = roundHistory(view)
  const limits = stopConfig(config)
  const at = clock.now()
  const samples = samplesFor(store, artifacts, view, limits)
  const startedAt = workspace.started_at_ms ?? at

  const decision = decideStop({
    limits,
    view,
    rounds,
    contract,
    samples,
    now: at,
    startedAt,
  })

  if (decision.stop === undefined) {
    return {
      stopped: false,
      kills: decision.kills,
      candidates: decision.candidates,
      tolerances: decision.tolerances,
      ...(decision.blocked_by === undefined ? {} : { blocked_by: decision.blocked_by }),
      view,
      rounds,
      limits,
      contract,
    }
  }

  const recorded = recordStop(
    { store, clock, log },
    {
      ...decision.stop,
      best: view.best ?? null,
      // Enough history to explain the decision later without replaying the whole stream, bounded so
      // the payload stays far below the one-event size limit.
      rounds: { considered: rounds.length, last: rounds.slice(-5) },
      // The statuses as they stood when the decision was taken, each with the value it had reached —
      // so "why not that one" is answerable from the recorded fact months later, without replaying
      // the run's round history against whatever configuration is in force then.
      rules: describeRules({ limits, view, rounds, samples, now: at, startedAt }),
    },
  )

  return { ...recorded, kills: [], view, rounds, limits, contract }
}