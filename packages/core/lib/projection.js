/**
 * The dashboard, computed host-side.
 *
 * This module is the *data* half of the display layer: four read-only projections over the fact
 * plane. It renders nothing — the web components and `dump` both consume these shapes, which is the
 * point. A projection that lived inside a renderer could only be tested by rendering, and a second
 * one inside `dump` would drift from it on the first change.
 *
 * Three constraints, all of them testable and all of them asserted in `projection.test.js`:
 *
 *   - **Read-only.** Every function takes the store as a reader: it calls `ranking(…, { persist:
 *     false })` and never writes, so it works on a `readOnly` handle. A dashboard must not be able
 *     to change the run it is watching.
 *   - **Fact-derived.** No clock, no randomness, no model. Two calls over the same facts are equal.
 *   - **Honest about gaps.** Missing metrics, an unconfigured contract, or a lagging state are
 *     reported as such, because a dashboard that hides them makes an unhealthy run look fine.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { fileArtifacts } from './artifacts.js'
import { budgetOf, spendOf } from './budget.js'
import { GATE_CHECKS } from './gate.js'
import { cudaVisibleDevicesOf, gpuExclusivityOf, gpuHolder, jobReport } from './jobs.js'
import { defaultStaticChecks } from './judge.js'
import { ranking, roundHistory } from './ranking.js'
import { readRoundsState } from './rounds.js'
import { STOP_RULES, describeRules, samplesFor, stopConfig } from './stop.js'
import { configWarnings } from './warnings.js'

const FOUR_STATES = ['ok', 'missing', 'conflict', 'invalid']

const describe = (error) => (error instanceof Error ? error.message : String(error))

/** A one-line summary of an event, chosen from the payload rather than from the event type list. */
export function summariseEvent(event) {
  const payload = event.payload ?? {}
  const parts = []
  // `attempt` is here because gate two is retried: without it a timeline showing three refusals
  // cannot say which try failed, and "why did this stop here?" is answered by exactly that.
  for (const key of ['phase', 'status', 'attempt', 'verdict', 'reason', 'message', 'reject_reason', 'job_id', 'engine']) {
    if (payload[key] !== undefined && payload[key] !== '') parts.push(`${key}=${payload[key]}`)
  }
  if (payload.round !== undefined) parts.push(`round=${payload.round}`)
  if (payload.metrics !== undefined && typeof payload.metrics === 'object') {
    const metrics = Object.entries(payload.metrics)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ')
    if (metrics !== '') parts.push(metrics)
  }
  return parts.join('  ')
}

const view = (store, config) => ranking(store, config, { persist: false })

/**
 * The configuration the run *recorded into itself* at INIT.
 *
 * The dashboard is handed a store, not a config file, so a warning computed from "the config the
 * caller passed" would answer about today's file rather than about the run on screen. These are the
 * keys `loop.js` freezes into the workspace when it first ticks; the caller's config still wins where
 * it has an opinion (a `dump --config` is an operator explicitly asking about a different contract).
 */
const RECORDED_WARNING_KEYS = Object.freeze(['metrics', 'stop', 'budget', 'injection', 'executor'])

function recordedWarningConfig(workspace, config) {
  const recorded = {}
  for (const key of RECORDED_WARNING_KEYS) {
    if (workspace[key] !== undefined) recorded[key] = workspace[key]
  }
  return { ...recorded, ...(config ?? {}) }
}

/** Trailing streaks over the completed-round history — the same quantities the stop rules use. */
function streaks(history) {
  let empty = 0
  let flat = 0
  for (const entry of history) {
    empty = entry.empty ? empty + 1 : 0
    if (entry.empty) continue
    flat = entry.improving ? 0 : flat + 1
  }
  return { empty, flat }
}

function stopRecord(workspace) {
  const stopped = workspace.stopped
  if (stopped === undefined) return { stopped: false }
  return {
    stopped: true,
    rule: stopped.rule,
    limit: stopped.limit,
    observed: stopped.observed,
    message: stopped.message,
    best: stopped.best ?? undefined,
    atMs: stopped.at_ms,
    eventSeq: stopped.event_seq,
    // The rule statuses as they stood when the decision was taken. Recomputing them from today's
    // configuration would print a page that never decided anything.
    rules: stopped.rules,
  }
}

/**
 * The limits the stop rules are read with: **the ones in force when the run concluded**, when it has.
 *
 * A stopped run's page answers "why is this over, and what would have been next"; both are questions
 * about the decision, so the limits are the decision's. The *observed* values, on the other hand, are
 * re-measured from the round history — the same facts the decision read, since a concluded workspace
 * is absorbing and its history cannot change. The one thing that would drift is the wall clock, which
 * is why the caller pins `now` to the recorded stop instant (see `overview()`).
 *
 * An edited `stop` block in a config file therefore changes nothing on a concluded run's page: it
 * describes a decision that was never taken.
 */
function stopLimits(workspace, config) {
  const limits = stopConfig(config)
  const recorded = workspace.stopped?.rules
  if (!Array.isArray(recorded)) return limits
  for (const rule of recorded) {
    if (STOP_RULES.includes(rule?.rule) && typeof rule.limit === 'number') limits[rule.rule] = rule.limit
  }
  return limits
}

// --------------------------------------------------------------- the budget bar

/** A percentage of the bar's width, rounded to a hundredth and never negative. */
const share = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, Number(((part / whole) * 100).toFixed(2)))) : 0)

/**
 * The budget bar's three materials, as widths — the page draws, it does not divide.
 *
 * Spec §6.6: settled is solid, `reserved − settled` is a hatch, the rest of the cap is empty, and the
 * soft limit and the cap are markers named in the legend. Those are three readings of one denominator
 * (the cap), so the denominator and the three shares are published together and the renderer's only
 * job is `width: <share>%`.
 *
 * Two states are not the capped one, and each says so rather than looking like a bar with a value:
 *
 *  - **No cap** (`gpu_hours_limit: 0`, which is the kernel's "unlimited"): the bar is scaled by what
 *    was *used*, `remainingPercent` is 0 because there is no remainder to draw, and there is no
 *    soft-limit marker. Drawing a 0-width bar would read as "nothing spent".
 *  - **Nothing spent yet**: there is no scale at all (`scaleGpuHours: null`) — a bar with no spent
 *    material and no cap has no length to be, and the page says "nothing spent yet".
 *
 * `reservedUnsettledGpuHours` is deliberately not called "in flight": it is `reserved − settled`,
 * which includes the leftover reservation of candidates that already finished — money that was
 * promised and not spent, not work that is running.
 */
export function budgetBar(spend, budget) {
  const limit = budget.gpu_hours_limit
  const limited = limit > 0
  const scaleGpuHours = limited ? limit : spend.usedGpuHours > 0 ? spend.usedGpuHours : null
  const reservedUnsettledGpuHours = spend.inFlightGpuHours
  return {
    limited,
    scaleGpuHours,
    settledPercent: share(spend.settledGpuHours, scaleGpuHours),
    reservedPercent: share(reservedUnsettledGpuHours, scaleGpuHours),
    remainingPercent: limited ? share(Math.max(0, limit - spend.usedGpuHours), limit) : 0,
    // The third material in GPU hours too, because the legend names it and the page may not subtract.
    remainingGpuHours: limited ? Number(Math.max(0, limit - spend.usedGpuHours).toFixed(6)) : 0,
    // The soft limit is a fraction of the cap, so it has no meaning without one.
    softLimitPercent: limited ? share(limit * budget.soft_ratio, limit) : null,
    reservedUnsettledGpuHours,
    over: limited && spend.usedGpuHours > limit,
  }
}

// --------------------------------------------------------------- the cluster

/**
 * How many cards one of our jobs claims, when the configuration says so.
 *
 * Two sources, in the order the job itself would use them: the device list a submission pins is
 * exactly the cards it occupies, and `num_gpus` is the count the executor asks for when it does not
 * pin them. Neither written down means the page cannot answer — `null`, not a guessed 1.
 */
function cardsPerJob(executor) {
  const devices = cudaVisibleDevicesOf({ executor })
  if (devices !== undefined) return devices.split(',').filter((entry) => entry !== '').length
  const declared = executor?.num_gpus
  return Number.isSafeInteger(declared) && declared > 0 ? declared : null
}

/**
 * Why a candidate is sitting at SUBMIT_QUEUED, in the vocabulary of the decision that holds it.
 *
 * The two reasons are asked in the same order the loop asks them, and the `single_job` one is asked
 * through `gpuHolder` — the *same function* the loop holds the candidate with (`jobs.js`). The page
 * saying "held by a running job" while the loop holds it for the budget is the kind of disagreement a
 * person cannot resolve from either side.
 */
function holdReason(candidateId, { store, executor, spend, budget }) {
  if (gpuExclusivityOf({ executor }) === 'single_job' && gpuHolder(store, candidateId) !== undefined) return 'single_job_gpu'
  if (budget.gpu_hours_limit > 0 && spend.usedGpuHours >= budget.gpu_hours_limit * budget.soft_ratio) return 'budget'
  return null
}

/**
 * The cluster page: how many cards our jobs claim, what is waiting, and what the cluster says back.
 *
 * Composed from `jobReport()` — the ledger view ticket 16 owns — rather than re-deriving "which jobs
 * are ours", because two accounts of that would eventually disagree about a job on somebody else's
 * cluster. Two answers are deliberately *not* numbers:
 *
 *  - `cards.inUse` is `null` whenever the listing was not read. A caller with no platform port (a
 *    headless host, `dump`, a test with only a directory) has not read it; printing `0` there is the
 *    answer somebody acts on, and it would be a lie the moment another workspace, or an earlier run
 *    of this one, holds the cards.
 *  - `orphans` / `foreign` are `null` for the same reason. An empty array means "we looked and found
 *    none"; `null` means "we did not look".
 *
 * "We were never given a listing source" and "the executor could not list" are two different
 * refusals and `reason` keeps them apart: the first says the page has no listing source, the second
 * quotes what the executor said.
 *
 * `cards.floor` is the part we do know from our own facts: open ledger rows times cards each.
 */
export function cluster(store, { config, executor, listing } = {}) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const jobs = typeof store.allJobs === 'function' ? store.allJobs() : []
  const open = typeof store.inFlightJobs === 'function' ? store.inFlightJobs() : []
  const report = jobReport({ rows: jobs, listing })
  const perJob = cardsPerJob(executor ?? config?.executor ?? workspace.executor)
  const running = [...report.ours, ...report.orphans].filter((job) => job.terminal !== true)
  const candidates = visibleCandidates(store)

  const outcomes = {}
  for (const outcome of ['succeeded', 'failed', 'canceled', 'lost']) {
    outcomes[outcome] = jobs.filter((row) => row.outcome === outcome).length
  }
  outcomes.open = open.length

  const waiting = candidates
    .filter((candidateId) => store.getState(candidateId, 'phase')?.phase === 'SUBMIT_QUEUED')
    .map((candidateId) => ({
      candidate_id: candidateId,
      reason: holdReason(candidateId, {
        store,
        executor: executor ?? config?.executor ?? workspace.executor,
        spend: spendOf(store),
        budget: budgetOf(workspace, config),
      }),
    }))

  return {
    read: report.read,
    // A missing source is not a refused listing: saying "the executor returned no job listing" about
    // a page that never asked would blame an executor that was never consulted.
    reason: report.read
      ? null
      : listing === undefined
        ? 'this page has no cluster-listing source, so the cluster was not asked'
        : (report.reason ?? 'the cluster listing could not be read'),
    cards: {
      perJob,
      // Only a listing can answer "how many are in use"; our ledger can only say "at least".
      inUse: report.read && perJob !== null ? running.length * perJob : null,
      floor: perJob !== null ? open.length * perJob : null,
      // A floor we could not compute is a sentence, not a dash: a reader who is told "unknown" about
      // the cluster and then sees "— cards" beside it has been told two nothings that look like a zero.
      floorAbsent:
        perJob !== null
          ? null
          : 'this run never recorded how many cards one job claims, so our own ledger cannot say how many it holds',
    },
    jobs: {
      recorded: jobs.length,
      open: open.map((row) => row.candidate_id),
      outcomes,
    },
    queue: {
      count: waiting.length,
      waiting,
      // "Queued upstream" is a listing fact too: only the cluster can say a job is pending there.
      upstream: report.read ? running.filter((job) => job.status === 'PENDING').length : null,
    },
    ours: report.read ? report.ours : null,
    orphans: report.read ? report.orphans : null,
    foreign: report.read ? report.foreign : null,
    unlisted: report.read ? report.unlisted : null,
  }
}

/** Every candidate the store knows, through the same reader the ranking uses. */
function visibleCandidates(store) {
  return typeof store.candidateIds === 'function' ? store.candidateIds() : []
}

/**
 * The workspace page: where the run is, how it is spending, what it found, and why it ended (if it did).
 *
 * `now` is the caller's clock reading — the route's, for the page — and never a `Date.now()` taken
 * here: the projection is a pure function of facts, and "how close is this run to its wall-clock
 * limit" is only reproducible when the instant it was measured at is an input. Without it the
 * wall-clock rule reports that it was not measured, rather than 0 hours.
 */
export function overview(store, { config, executor, listing, now } = {}) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const rows = view(store, config)
  const history = roundHistory(rows)
  const { empty, flat } = streaks(history)
  const budget = budgetOf(workspace, config)
  const spend = spendOf(store)
  const limits = stopLimits(workspace, config)
  // A concluded run's wall clock is the clock that concluded it: reading it against "now" would make
  // the distance to a rule that can no longer fire grow every time the page is opened.
  const readAt = workspace.stopped?.at_ms ?? now
  const startedAt = workspace.started_at_ms

  const candidates = rows.candidates
  return {
    workspace: {
      phase: workspace.phase ?? null,
      paused: workspace.paused ?? null,
      startedAtMs: workspace.started_at_ms ?? null,
    },
    rounds: {
      total: history.length,
      completed: history.filter((entry) => entry.complete).length,
      current: history.length === 0 ? 0 : history[history.length - 1].round,
      emptyStreak: empty,
      noImprovementStreak: flat,
    },
    candidates: {
      total: candidates.length,
      inFlight: candidates.filter((row) => row.status === 'active').map((row) => row.candidate_id),
      done: candidates.filter((row) => row.status === 'done').length,
      rejected: candidates.filter((row) => row.status === 'rejected').length,
      incomplete: rows.incomplete,
    },
    spend: {
      settledGpuHours: spend.settledGpuHours,
      inFlightGpuHours: spend.inFlightGpuHours,
      usedGpuHours: spend.usedGpuHours,
      limitGpuHours: budget.gpu_hours_limit,
      softLimitGpuHours: budget.gpu_hours_limit > 0 ? budget.gpu_hours_limit * budget.soft_ratio : 0,
      tokens: spend.tokens,
      // The bar's three materials and two markers, divided once here — see `budgetBar()`.
      budget: budgetBar(spend, budget),
    },
    best: rows.best,
    frontier: {
      objectives: rows.contract.objectives,
      members: rows.frontier,
      size: rows.frontier.length,
      // The cell lists each member with its number, so it needs the metric the numbers are in and the
      // reading of every member — not just their ids.
      primary: rows.contract.primary ?? null,
      readings: rows.frontier.map((candidateId) => {
        const row = rows.candidates.find((candidate) => candidate.candidate_id === candidateId)
        const value = rows.contract.primary === null ? undefined : row?.vector?.[rows.contract.primary]
        return { candidate_id: candidateId, value: typeof value === 'number' ? value : null }
      }),
    },
    // `status` is the four-state name (`ok` / `missing` / `invalid` / `conflict`); `error` is the
    // sentence. Both are carried so a reader can switch on the name instead of pattern-matching prose.
    metricContract: { ok: rows.contract.ok, status: rows.contract.status, error: rows.contract.error },
    // What the run owes the person reading the page: an uncapped spend on a real executor, a metric
    // contract that disagrees with itself, a round workflow with no model port. Carried by the
    // projection (not by a component) so the dashboard and the injection packet cannot disagree
    // about whether the warning exists — see `warnings.js` for where each one renders.
    warnings: configWarnings(recordedWarningConfig(workspace, config)),
    // What the run is doing to a shared cluster, and what is waiting for it. See `cluster()` for why
    // two of its answers are `null` rather than `0` on a page that cannot ask the cluster anything.
    cluster: cluster(store, { config, executor, listing }),
    stop: {
      ...stopRecord(workspace),
      // Every rule, its limit, and how far along it is. A concluded run reports the limits that were
      // in force when it decided (`stopLimits`); a running one reports today's configuration, which
      // is the only thing that can still change the outcome. The observed values are measured by the
      // same function `decideStop` reads, so a gauge cannot disagree with a recorded conclusion.
      rules: describeRules({
        limits,
        view: rows,
        rounds: history,
        samples: samplesFor(store, workspaceArtifacts(store), rows, limits),
        now: readAt,
        startedAt,
      }),
    },
  }
}

/** Round by round: who ran, how each finished, and whether the round moved the best result. */
export function rounds(store, { config } = {}) {
  const rows = view(store, config)
  const byId = new Map(rows.candidates.map((row) => [row.candidate_id, row]))
  return roundSeries(roundHistory(rows)).map((entry) => ({
    ...entry,
    candidates: entry.candidates.map((candidateId) => {
      const row = byId.get(candidateId)
      const status = row?.status ?? 'active'
      const onFrontier = row?.onFrontier ?? false
      const verdict = verdictStatusOf(store.eventsFor(candidateId))
      return {
        candidate_id: candidateId,
        status,
        value: row?.vector?.[rows.contract.primary] ?? null,
        onFrontier,
        // The four-state name the gate reached, when it reached one. The rail draws the shape; the
        // word travels with it so the coarse read never replaces the precise one.
        verdict,
        shape: shapeOf({ status, onFrontier, verdict }),
      }
    }),
  }))
}

/**
 * The fact that carries a candidate's four-state gate conclusion, when it has one.
 *
 * Two payloads can carry it — a `gate_result` (the gate ran and passed) and a `candidate_rejected`
 * (the gate's refusal ended the candidate) — and the *last* one is the one that stands. One reader,
 * because the candidate page prints this word and the round rail draws it as a shape; two readers
 * would eventually disagree about which fact is the verdict.
 */
function verdictEventOf(events) {
  const ordered = [...(events ?? [])].reverse()
  return ordered.find((event) => FOUR_STATES.includes(event.payload?.status))
}

/** Just the name: `ok` / `missing` / `conflict` / `invalid`, or `null` if no gate concluded. */
function verdictStatusOf(events) {
  return verdictEventOf(events)?.payload?.status ?? null
}

/**
 * The one square the rail draws for a candidate — five shapes, no hue.
 *
 * The map from facts to shapes lives here because it is a reading of facts: the row's status, the
 * frontier's membership, and the four-state name of the gate that stopped it. `invalid` is its own
 * shape and not "rejected" with a footnote — an artifact that arrived and broke its schema is a
 * different thing to look at than a candidate that was refused, which is the whole point of the
 * four-state vocabulary.
 */
function shapeOf({ status, onFrontier, verdict }) {
  if (status === 'rejected') return verdict === 'invalid' ? 'invalid' : 'rejected'
  if (status === 'done') return onFrontier ? 'frontier' : 'done'
  return 'in-flight'
}

/**
 * The step series: one row per round, ready to be drawn and read out.
 *
 * `cumulative` is the best result standing after the round, and `verdict` is the word for what the
 * round did to it (`raised` / `held` / `empty`). Both are decided in `roundHistory` and published
 * here in one shape, so the staircase, the rail and the table under them cannot say three things.
 */
function roundSeries(history) {
  return history.map((entry) => ({
    round: entry.round,
    complete: entry.complete,
    empty: entry.empty,
    improving: entry.improving,
    verdict: entry.improving ? 'raised' : entry.empty ? 'empty' : 'held',
    best: entry.best ?? null,
    cumulative: entry.cumulative ?? null,
    // The candidate ids, in the order the rail draws them.
    candidates: entry.candidates,
  }))
}

/**
 * The artifacts of the workspace a store belongs to.
 *
 * `ports.js` writes them to `<workspace>/artifacts`, and the store lives at `<workspace>/workspace.db`,
 * so the workspace directory is the store's own directory — the same one `withStore` and the views
 * already name. Constructing the reader here (rather than in a renderer) keeps one answer to "where
 * did the judge file that record", and it is read-only: only `read()` is ever called.
 */
export function workspaceArtifacts(store) {
  return fileArtifacts(join(dirname(store.path), 'artifacts'))
}

/** The step names the gate chain runs, in the order the kernel runs them. */
const REVIEW_STEP = 'adversarial_review'

/**
 * The declared chain: the kernel's own metadata checks, gate two's static checks, and the review.
 *
 * Read from the modules that own them rather than restated here, because a panel that hard-codes a
 * check list drifts the first time the kernel adds one — and then the panel is either missing a gate
 * that refused the candidate or showing one that does not exist.
 */
function declaredSteps() {
  return [
    ...defaultStaticChecks({ state: {}, parent: undefined }).map((check) => ({ name: check.name, kind: 'metadata' })),
    ...GATE_CHECKS.map((name) => ({ name, kind: 'static' })),
    { name: REVIEW_STEP, kind: 'review' },
  ]
}

/** The review's own conclusion, in the same vocabulary as a check's. */
function reviewStatus(review) {
  if (review === undefined || review === null) return undefined
  if (review.verdict === 'accept') return 'passed'
  if (review.verdict === 'reject') return 'failed'
  return 'missing'
}

/**
 * The gate chain, one step at a time: **passed / failed / missing**, and missing is not failed.
 *
 * A candidate can stop before the gate ever ran (a LAND failure, a proposal the contract refused), in
 * which case every step is `missing` — the candidate was never judged, and saying "failed" there
 * would blame it for a check nobody performed. A step that ran and refused is `failed`, and both can
 * appear in one chain (a review that approved over a static check that failed is exactly the
 * `conflict` the fact plane refuses to resolve).
 *
 * The evidence is the attempt records the judge wrote (`verify_verdict:<id>:a<N>`) plus the
 * `gate_result` events; when the record is gone (an old workspace, a pruned artifact directory) the
 * event still says what failed, and the step that only the record could name is `missing` rather than
 * guessed.
 *
 * @param {object} store the fact plane, read-only
 * @param {string} candidateId
 * @param {{ artifacts?: { read: (name: string) => unknown } }} [options]
 */
export function gateChain(store, candidateId, { artifacts } = {}) {
  const reader = artifacts ?? workspaceArtifacts(store)
  const events = store.eventsFor(candidateId)
  const state = store.getState(candidateId, 'phase')
  const binding = store.binding(candidateId, 'verify_gate')
  // A gate attempt leaves two kinds of fact: a `gate_result` event while the candidate lives, and a
  // `candidate_rejected` event carrying the attempt when the contract stopped it (a review that
  // approved over a failed check). Both name the attempt, so the chain reads both — a chain that only
  // watched `gate_result` would report the conflict that ended the candidate as "never ran".
  const gateEvents = events.filter(
    (event) =>
      Number.isSafeInteger(event.payload?.attempt) &&
      event.payload.attempt > 0 &&
      (event.event_type === 'gate_result' || typeof event.payload?.artifact === 'string'),
  )

  const numbers = new Set()
  for (const event of gateEvents) {
    if (Number.isSafeInteger(event.payload?.attempt) && event.payload.attempt > 0) numbers.add(event.payload.attempt)
  }
  if (Number.isSafeInteger(binding?.attempt) && binding.attempt > 0) numbers.add(binding.attempt)
  const ordered = [...numbers].sort((left, right) => left - right)

  const attempts = ordered.map((attempt) => {
    const ref = `verify_verdict:${candidateId}:a${attempt}`
    const event = gateEvents.filter((entry) => entry.payload?.attempt === attempt).at(-1)
    let record = typeof reader?.read === 'function' ? reader.read(ref) : undefined
    // A workspace whose per-attempt record is gone still has the plain reference, which names the
    // latest attempt; using it only for the attempt it names keeps attempt 1 from inheriting
    // attempt 2's verdict.
    if (record === undefined) {
      const latest = typeof reader?.read === 'function' ? reader.read(`verify_verdict:${candidateId}`) : undefined
      if (latest?.attempt === attempt) record = latest
    }
    const recordedFailed = (Array.isArray(record?.checks) ? record.checks : [])
      .filter((check) => check?.result === 'fail')
      .map((check) => check.name)
    const eventFailed = Array.isArray(event?.payload?.failed_checks) ? event.payload.failed_checks : []
    return {
      attempt,
      record: ref,
      onDisk: record !== undefined,
      passed: typeof record?.passed === 'boolean' ? record.passed : (typeof event?.payload?.passed === 'boolean' ? event.payload.passed : null),
      review: record?.reviewer ?? event?.payload?.review ?? null,
      failed_checks: [...new Set([...recordedFailed, ...eventFailed])],
      message: event?.payload?.message ?? null,
      atMs: event?.wall_clock_ms ?? null,
    }
  })

  const latest = attempts.at(-1)
  const record = latest === undefined ? undefined : (typeof reader?.read === 'function' ? reader.read(latest.record) : undefined)
  const recorded = new Map(
    (Array.isArray(record?.checks) ? record.checks : []).map((check) => [check?.name, check]),
  )

  const chain = declaredSteps().map((step) => {
    if (step.kind === 'review') {
      const status = reviewStatus(latest?.review) ?? (latest?.passed === true ? 'passed' : undefined)
      return {
        ...step,
        status: status ?? 'missing',
        detail: latest?.review?.rationale ?? '',
      }
    }
    const check = recorded.get(step.name)
    if (check !== undefined) {
      return { ...step, status: check.result === 'pass' ? 'passed' : 'failed', detail: check.detail ?? '' }
    }
    if (latest !== undefined && latest.failed_checks.includes(step.name)) {
      return { ...step, status: 'failed', detail: 'the gate event recorded this check as failed' }
    }
    return {
      ...step,
      status: 'missing',
      detail:
        latest === undefined
          ? 'the gate never ran for this candidate'
          : 'this attempt recorded no result for it — absent, which is not the same as failed',
    }
  })

  // A domain may contribute checks the kernel does not declare (a phase worker, a pack's own
  // parser). They are part of the chain too, so they are appended rather than silently dropped.
  for (const [name, check] of recorded) {
    if (chain.some((step) => step.name === name)) continue
    chain.push({ name, kind: 'recorded', status: check?.result === 'pass' ? 'passed' : 'failed', detail: check?.detail ?? '' })
  }

  const terminal = [...events].reverse().find((event) => event.event_type === 'candidate_rejected')
  return {
    reached: attempts.length > 0,
    // Where it stopped, when it never reached the gate: the refusal names its own phase.
    stoppedAt: attempts.length > 0 ? null : (terminal?.payload?.phase ?? state?.phase ?? null),
    chain,
    attempts,
    binding: binding ?? null,
  }
}

/**
 * One candidate's page: the timeline, every gate conclusion, the failure text, the artifacts it
 * names, and where it sits on the frontier.
 *
 * This is deliberately the `dump --candidate` shape: the CLI renders it, the web renders it, and a
 * reader who has never opened the code is supposed to be able to answer "why did this stop here?"
 * from it alone.
 */
export function candidateDetail(store, candidateId, { config, artifacts } = {}) {
  const state = store.getState(candidateId, 'phase')
  const events = store.eventsFor(candidateId)
  if (state === undefined && events.length === 0) return undefined

  const rows = view(store, config)
  const position = rows.candidates.find((row) => row.candidate_id === candidateId)

  const gates = events
    .filter((event) => FOUR_STATES.includes(event.payload?.status))
    .map((event) => ({
      seq: event.local_seq,
      atMs: event.wall_clock_ms,
      phase: event.payload?.phase ?? state?.phase,
      status: event.payload.status,
      message: event.payload?.blocking_message ?? event.payload?.message ?? '',
      artifact: event.payload?.artifact,
    }))

  // The verdict and the terminal event are two facts: the four-state conclusion, and the decision it
  // justified. Reading only the last one loses the conclusion whenever the terminal event follows it
  // — which is the normal case, and exactly what makes a dump useless for "why".
  const ordered = [...events].reverse()
  const verdictEvent = verdictEventOf(events)
  const terminalEvent = ordered.find(
    (event) => event.payload?.reject_reason !== undefined || event.payload?.blocking_message !== undefined,
  )
  const stopping = verdictEvent ?? terminalEvent
  const rejection =
    stopping === undefined
      ? undefined
      : {
          phase: verdictEvent?.payload?.phase ?? terminalEvent?.payload?.phase ?? state?.phase,
          status: verdictEvent?.payload?.status,
          message:
            verdictEvent?.payload?.blocking_message ??
            verdictEvent?.payload?.message ??
            terminalEvent?.payload?.blocking_message ??
            terminalEvent?.payload?.reject_reason ??
            '',
          reason: terminalEvent?.payload?.reject_reason ?? terminalEvent?.payload?.blocking_message,
          seq: stopping.local_seq,
          eventType: stopping.event_type,
          atMs: stopping.wall_clock_ms,
          artifact: verdictEvent?.payload?.artifact,
          // The terminal event matters separately only when it is not the verdict itself — the
          // normal case, and the one where a reader would otherwise take the message for the whole
          // decision.
          terminal:
            terminalEvent === undefined || terminalEvent === stopping
              ? undefined
              : {
                  seq: terminalEvent.local_seq,
                  eventType: terminalEvent.event_type,
                  atMs: terminalEvent.wall_clock_ms,
                },
        }

  const referenced = new Set()
  for (const event of events) {
    for (const key of ['artifact', 'artifact_path', 'evidence', 'evidence_refs']) {
      const value = event.payload?.[key]
      if (typeof value === 'string') referenced.add(value)
      else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') referenced.add(entry)
    }
  }

  const maxSeq = store.maxSeq(candidateId)
  const appliedSeq = store.appliedSeq(candidateId)
  return {
    candidate_id: candidateId,
    phase: state?.phase ?? null,
    round: state?.round ?? position?.round ?? null,
    status: position?.status ?? 'active',
    // Who this candidate was branched from. Written by the round planner from the frontier when it
    // created the candidate (`parent_id` in the phase state), so "this round started from whom" is
    // answerable per candidate and not only per round. `null` is the honest answer for a candidate a
    // human proposed: nobody chose a parent for it.
    parent: state?.parent_id ?? null,
    // A candidate-level pause marker if anything ever writes one. Workspace pauses live in the
    // workspace record and are rendered once, not per candidate.
    paused: state?.paused ?? null,
    lag: { appliedSeq, maxSeq, pending: Math.max(0, maxSeq - appliedSeq) },
    timeline: events.map((event) => ({
      seq: event.local_seq,
      atMs: event.wall_clock_ms,
      eventType: event.event_type,
      summary: summariseEvent(event),
    })),
    gates,
    // The gate chain, step by step, with the three-way status the panel exists for. See `gateChain()`
    // for why `missing` (the gate never reached this step) is kept apart from `failed` (it ran and
    // refused).
    gateChain: gateChain(store, candidateId, { artifacts }),
    rejection,
    bindings: store.bindings(candidateId),
    job: store.jobFor(candidateId) ?? null,
    artifacts: [...referenced].sort(),
    frontier: {
      vector: position?.vector ?? {},
      complete: position?.complete ?? false,
      missing: position?.missing ?? [],
      onFrontier: position?.onFrontier ?? false,
      dominatedBy: position?.dominatedBy ?? null,
      best: rows.best,
      position:
        position === undefined ? 'unknown' : position.complete ? (position.onFrontier ? 'frontier' : 'dominated') : 'unranked',
    },
  }
}

// ------------------------------------------------------------- the audit

/** Every model call is filed under this artifact name; the panel lists and opens nothing else. */
const MODEL_CALL = 'model_call'

/**
 * A reference this view may open: `model_call:<call site>:<subject>[:<ref>]`.
 *
 * Deliberately a whitelist rather than "starts with model_call": the route's `?ref=` is a string a
 * caller controls, and a read endpoint that turned it into a path would be a directory traversal with
 * a friendly name. Colons cannot climb out of a directory, `..` never matches, and anything else is
 * simply not one of our records.
 */
const MODEL_CALL_REF = /^model_call(:[A-Za-z0-9_.@-]+)+$/

/** The list row for one record: who was asked, what happened, and no prompt bodies (those are on open). */
function callRow(ref, record) {
  return {
    ref,
    call_site: record?.call_site ?? null,
    subject: record?.subject ?? null,
    ref_of_call: record?.ref ?? null,
    status: record?.status ?? null,
    error_class: record?.error_class ?? null,
    question_id: record?.question_id ?? null,
    answered: record?.answer !== null && record?.answer !== undefined,
  }
}

/**
 * The audit page: every judgement the run asked a model for, name order.
 *
 * A call that never answered is on this list. It is not noise: "the provider was down for two hours"
 * is answered by the outage records and by nothing else, and a panel that listed only answers would
 * show a run that did nothing rather than a run nobody could reach.
 *
 * @param {{ artifacts?: { list: Function, read: Function }, callSite?: string }} [options]
 */
export function modelCalls(store, { artifacts, callSite } = {}) {
  const reader = artifacts ?? workspaceArtifacts(store)
  const prefix = typeof callSite === 'string' && callSite !== '' ? `${MODEL_CALL}:${callSite}` : MODEL_CALL
  let names
  try {
    names = typeof reader?.list === 'function' ? reader.list(prefix) : []
  } catch (error) {
    // A directory that cannot be read is reported, not rendered as "no model was ever asked".
    return {
      calls: [],
      count: 0,
      call_site: callSite ?? null,
      reason: `the model-call records could not be read: ${describe(error)}`,
    }
  }
  const calls = names
    .filter((ref) => MODEL_CALL_REF.test(ref))
    .map((ref) => callRow(ref, typeof reader?.read === 'function' ? reader.read(ref) : undefined))
  return { calls, count: calls.length, call_site: callSite ?? null, reason: null }
}

/**
 * One call, full: the prompt, the facts it was given, the raw return, and the object that return
 * became. This is the "click to open the original text" half of the audit panel.
 *
 * @returns {object | undefined} `undefined` for a reference that is not a record this view may open
 */
export function modelCall(store, ref, { artifacts } = {}) {
  if (typeof ref !== 'string' || !MODEL_CALL_REF.test(ref)) return undefined
  const reader = artifacts ?? workspaceArtifacts(store)
  const record = typeof reader?.read === 'function' ? reader.read(ref) : undefined
  if (record === null || typeof record !== 'object') return undefined
  return {
    ref,
    ...callRow(ref, record),
    prompt: record.prompt ?? '',
    facts: record.facts ?? null,
    answer_schema: record.answer_schema ?? '',
    answer: record.answer ?? null,
    response: record.response ?? '',
    cause: record.cause ?? null,
    message: record.message ?? null,
  }
}

/** The baseline the gate compares against, frozen into the workspace (or the `baseline.json` file). */
function frozenBaseline(store) {
  const frozen = readRoundsState(store)?.baseline
  if (frozen !== undefined && typeof frozen.value === 'number') return { metric: frozen.metric ?? null, value: frozen.value }
  try {
    const document = JSON.parse(readFileSync(join(dirname(store.path), 'baseline.json'), 'utf8'))
    const value = typeof document === 'number' ? document : document?.value
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return { metric: typeof document?.metric === 'string' ? document.metric : null, value }
  } catch {
    return undefined
  }
}

/**
 * The frozen baseline, as this run's primary metric may read it — or the reason it may not.
 *
 * Two renderers ask "is there a baseline?" (the conclusion sentence, and the staircase's INIT line),
 * and they must never answer differently: a page that says "beaten the baseline" over a chart with no
 * baseline line is the kind of contradiction this whole view exists to prevent. `absent` is a
 * sentence rather than a null because "no baseline" is a state the page has to say out loud.
 */
function standingBaseline(store, metric) {
  const frozen = frozenBaseline(store)
  if (frozen === undefined) {
    return { baseline: null, absent: 'this run recorded no frozen baseline, so there is nothing to compare against' }
  }
  if (frozen.metric !== null && metric !== null && frozen.metric !== metric) {
    return { baseline: null, absent: `the frozen baseline records ${frozen.metric}, not ${metric}` }
  }
  return { baseline: { value: frozen.value, metric: frozen.metric ?? metric }, absent: null }
}

/**
 * The frame the staircase draws in: the y-axis, and the baseline line across it (spec §6.4, §6.9).
 *
 * The axis spans every comparable candidate value *and* the baseline — not the cumulative series
 * alone — so every mark the chart can draw is inside the frame, and it pads 18% at each end so no
 * step sits on the edge. `null` is a state, not a zero: with nothing comparable there is no axis, and
 * the page draws the rail alone (§6.9). A flat run (every value identical) is padded by 1% of the
 * value instead, because a zero-height range would collapse the plot and divide by zero downstream.
 */
function ladderFrame(store, { rows, history }) {
  const metric = rows.contract.primary ?? null
  const { baseline, absent } = standingBaseline(store, metric)
  const values = rows.candidates
    .filter((row) => row.complete && typeof row.vector?.[metric] === 'number')
    .map((row) => row.vector[metric])
  if (baseline !== null) values.push(baseline.value)

  let axis = null
  let axisAbsent = null
  if (metric === null) {
    axisAbsent = 'this run recorded no metric contract, so nothing can be ranked'
  } else if (values.length === 0) {
    axisAbsent = `no comparable ${metric} has been measured yet, so there is nothing to plot`
  } else {
    const round = (value) => Number(value.toFixed(12))
    const min = Math.min(...values)
    const max = Math.max(...values)
    const spread = max - min
    const pad = spread === 0 ? (Math.abs(max) > 0 ? Math.abs(max) * 0.01 : 1) : spread * 0.18
    const top = round(max + pad)
    const bottom = round(min - pad)
    axis = { top, middle: round((top + bottom) / 2), bottom }
  }

  return {
    metric,
    baseline,
    baselineAbsent: absent,
    axis,
    axisAbsent,
    rounds: roundSeries(history),
  }
}

/**
 * The number the domain published for one metric — read out of the run's own metric contract.
 *
 * This is the "what they published" half of the conclusion line, and it is deliberately *not* a
 * constant in this module: the published tables of a domain belong to that domain, they have a file
 * and a quote, and a pack author who finds a transposed digit fixes a JSON file rather than the
 * kernel. `published.reference` names the row whose configuration the pack's executor runs, so the
 * comparison is against one row and never against a differently-shaped one (a category error the
 * pack's own anti-patterns name).
 *
 * @returns {{ metric: string, method: string, dataset: string|null, value: number,
 *             source: object|null, rows: object[] } | { absent: string }}
 */
export function publishedOf(contract, metric) {
  const block = contract?.published
  if (block === undefined || block === null) {
    return { absent: 'this run\'s metric contract publishes no numbers to compare against' }
  }
  if (typeof block !== 'object' || !Array.isArray(block.rows) || block.rows.length === 0) {
    return { absent: 'the contract\'s published block carries no rows of numbers' }
  }
  const rows = block.rows.filter(
    (row) => row !== null && typeof row === 'object' && typeof row.method === 'string' && typeof row.metrics === 'object',
  )
  const reference = typeof block.reference === 'string' ? rows.find((row) => row.method === block.reference) : undefined
  if (reference === undefined) {
    return {
      absent:
        `the contract names no published row to compare against ` +
        `(published.reference is ${JSON.stringify(block.reference ?? null)})`,
    }
  }
  if (!Number.isFinite(reference.metrics?.[metric])) {
    return { absent: `the published row for ${reference.method} reports no ${metric}` }
  }
  return {
    metric,
    method: reference.method,
    dataset: typeof block.dataset === 'string' ? block.dataset : null,
    value: reference.metrics[metric],
    source: block.source ?? null,
    rows: rows.map((row) => ({ method: row.method, metrics: { ...row.metrics } })),
  }
}

/**
 * The comparison block: what we measured, what we compare it against, and what the domain published.
 *
 * Three quantities a reader has to keep apart, so they are three fields and never one number:
 * `measured` is our own best result, `group` is the baseline (the frozen one the gate compares
 * against, or the previous best when no baseline was measured), and `published` is somebody else's
 * number from the pack. `change` is only ever measured-minus-group; the published difference is its
 * own field, because mixing "better than our baseline" with "closer to their table" is how a run
 * reports a win it did not have.
 *
 * `changePercent` is the same change as a percentage *of the group*, because "(0.7331 - 0.706981) /
 * 0.706981" is arithmetic, and arithmetic in three renderers is three answers. It is a percentage
 * number (`3.694549`, not the ratio `0.03694549`) so the field name says what the number is. It is
 * `null` — never `0`, never `Infinity` — whenever there is no group, or the group is 0 and a relative
 * change does not exist. `group.kind` is what makes the claim readable: the same +2.79% means
 * "against the frozen baseline" or "against the previous best", and they are not the same news.
 */
function comparison(store, { workspace, config, rows, best, against }) {
  const contract = config?.metrics ?? workspace.metrics
  const metric = rows.contract.primary
  const direction = rows.contract.objectives.find((objective) => objective.name === metric)?.direction ?? null
  const spend = spendOf(store)

  const published = publishedOf(contract, metric)
  const publishedBlock = published.absent === undefined ? published : null

  if (best === undefined) {
    return {
      metric: metric ?? null,
      measured: null,
      group: null,
      change: null,
      changePercent: null,
      better: null,
      published: publishedBlock,
      publishedAbsent: published.absent ?? null,
      publishedChange: null,
      net: null,
    }
  }

  const measured = { candidate_id: best.candidate_id, round: best.round ?? null, value: best.value }
  const baseline = standingBaseline(store, metric).baseline
  const parentId = against?.parent ?? null
  let group
  if (baseline !== null) {
    group = { kind: 'baseline', candidate_id: parentId, value: baseline.value }
  } else if (against?.best !== undefined) {
    group = { kind: 'previous-best', candidate_id: against.best.candidate_id ?? null, value: against.best.value }
  } else {
    group = null
  }

  const change = group === null ? null : Number((measured.value - group.value).toFixed(12))
  const changePercent =
    change === null || !(Math.abs(group.value) > 0) ? null : Number(((change / Math.abs(group.value)) * 100).toFixed(6))
  const gpuHours = spend.settledGpuHours
  return {
    metric,
    measured,
    group,
    change,
    changePercent,
    better: change === null || direction === null ? null : direction === 'up' ? change > 0 : change < 0,
    published: publishedBlock,
    publishedAbsent: published.absent ?? null,
    publishedChange:
      publishedBlock === null ? null : Number((measured.value - publishedBlock.value).toFixed(12)),
    // "Net output": the change we bought, next to the GPU hours the run spent buying it.
    net: {
      gpuHours,
      changePerGpuHour: change === null || !(gpuHours > 0) ? null : Number((change / gpuHours).toFixed(6)),
    },
  }
}

/**
 * The conclusion page: what this run established, on which number, and against what.
 *
 * "Against what" is the parent binding, not a memory: a best number with nothing to compare it to
 * is not a conclusion, and the comparison group has to come from a frozen fact.
 */
export function conclusion(store, { config } = {}) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const rows = view(store, config)
  const history = roundHistory(rows)
  const best = rows.best

  let against
  if (best !== undefined) {
    const parentBinding = store.binding(best.candidate_id, 'parent_binding')
    const parentId = parentBinding?.parent_id
    // The comparison group is whatever held the previous best: an earlier round, the parent
    // candidate if it is one of ours. Never a number the kernel remembered from another run.
    const earlier = history.filter((entry) => entry.round < best.round && entry.best !== undefined)
    against = {
      parent: parentId ?? null,
      best: earlier.length === 0 ? undefined : earlier[earlier.length - 1].best,
    }
  }

  return {
    stopped: stopRecord(workspace),
    best,
    // What we measured, against what, and against what the domain published — see `comparison()`.
    comparison: comparison(store, { workspace, config, rows, best, against }),
    // The staircase's own frame: where the INIT line sits, the axis it spans, and the step series
    // between them. Published as one block so the chart, its axis labels and its text alternative are
    // read from a single account of the run.
    ladder: ladderFrame(store, { rows, history }),
    objectives: rows.contract.objectives,
    metricContract: { ok: rows.contract.ok, status: rows.contract.status, error: rows.contract.error },
    frontier: { members: rows.frontier, size: rows.frontier.length },
    incomplete: rows.incomplete,
    rounds: history.length,
    against,
  }
}