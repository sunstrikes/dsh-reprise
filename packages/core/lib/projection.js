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
 *   - **Read-only.** Every function takes the store as a reader: it calls `frontier(…, { persist:
 *     false })` and never writes, so it works on a `readOnly` handle. A dashboard must not be able
 *     to change the run it is watching.
 *   - **Fact-derived.** No clock, no randomness, no model. Two calls over the same facts are equal.
 *   - **Honest about gaps.** Missing metrics, an unconfigured contract, or a lagging state are
 *     reported as such, because a dashboard that hides them makes an unhealthy run look fine.
 *
 * @module
 */

import { dirname, join } from 'node:path'

import { fileArtifacts } from './artifacts.js'
import { budgetOf, spendOf } from './budget.js'
import { frontier, roundHistory } from './frontier.js'
import { GATE_CHECKS } from './gate.js'
import { cudaVisibleDevicesOf, gpuExclusivityOf, jobReport } from './jobs.js'
import { defaultStaticChecks } from './judge.js'
import { describeRules, stopConfig } from './stop.js'
import { configWarnings } from './warnings.js'

const FOUR_STATES = ['ok', 'missing', 'conflict', 'invalid']

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

const view = (store, config) => frontier(store, config, { persist: false })

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

/** Why a candidate is sitting at SUBMIT_QUEUED, in the vocabulary of the decision that holds it. */
function holdReason(candidateId, { executor, rows, spend, budget, openJobs }) {
  if (gpuExclusivityOf({ executor }) === 'single_job') {
    const holder = openJobs.find((job) => job.candidate_id !== candidateId)
    if (holder !== undefined) return 'single_job_gpu'
  }
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
 *  - `cards.inUse` is `null` whenever the listing was not read. The dashboard has no platform port,
 *    so for it the cluster is always unread; printing `0` there is the answer somebody acts on, and
 *    it would be a lie the moment another workspace, or an earlier run of this one, holds the cards.
 *  - `orphans` / `foreign` are `null` for the same reason. An empty array means "we looked and found
 *    none"; `null` means "we did not look".
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
        executor: executor ?? config?.executor ?? workspace.executor,
        spend: spendOf(store),
        budget: budgetOf(workspace, config),
        openJobs: open,
      }),
    }))

  return {
    read: report.read,
    reason: report.read ? null : (report.reason ?? 'the cluster listing was not read'),
    cards: {
      perJob,
      // Only a listing can answer "how many are in use"; our ledger can only say "at least".
      inUse: report.read && perJob !== null ? running.length * perJob : null,
      floor: perJob !== null ? open.length * perJob : null,
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
 */
export function overview(store, { config, executor, listing } = {}) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const rows = view(store, config)
  const history = roundHistory(rows)
  const { empty, flat } = streaks(history)
  const budget = budgetOf(workspace, config)
  const spend = spendOf(store)

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
    },
    best: rows.best,
    frontier: {
      objectives: rows.contract.objectives,
      members: rows.frontier,
      size: rows.frontier.length,
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
      // A concluded run reports the rules it decided with; a running one reports today's
      // configuration, which is the only thing that can still change the outcome.
      rules: stopRecord(workspace).rules ?? describeRules({ limits: stopConfig(config), view: rows }),
    },
  }
}

/** Round by round: who ran, how each finished, and whether the round moved the best result. */
export function rounds(store, { config } = {}) {
  const rows = view(store, config)
  const byId = new Map(rows.candidates.map((row) => [row.candidate_id, row]))
  return roundHistory(rows).map((entry) => ({
    round: entry.round,
    complete: entry.complete,
    empty: entry.empty,
    improving: entry.improving,
    best: entry.best,
    candidates: entry.candidates.map((candidateId) => {
      const row = byId.get(candidateId)
      return {
        candidate_id: candidateId,
        status: row?.status ?? 'active',
        value: row?.vector?.[rows.contract.primary],
        onFrontier: row?.onFrontier ?? false,
      }
    }),
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
  const verdictEvent = ordered.find((event) => FOUR_STATES.includes(event.payload?.status))
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
    objectives: rows.contract.objectives,
    metricContract: { ok: rows.contract.ok, status: rows.contract.status, error: rows.contract.error },
    frontier: { members: rows.frontier, size: rows.frontier.length },
    incomplete: rows.incomplete,
    rounds: history.length,
    against,
  }
}