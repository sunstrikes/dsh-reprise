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

import { budgetOf, spendOf } from './budget.js'
import { ranking, roundHistory } from './ranking.js'
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
 * The workspace page: where the run is, how it is spending, what it found, and why it ended (if it did).
 */
export function overview(store, { config } = {}) {
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
 * One candidate's page: the timeline, every gate conclusion, the failure text, the artifacts it
 * names, and where it sits on the frontier.
 *
 * This is deliberately the `dump --candidate` shape: the CLI renders it, the web renders it, and a
 * reader who has never opened the code is supposed to be able to answer "why did this stop here?"
 * from it alone.
 */
export function candidateDetail(store, candidateId, { config } = {}) {
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

  const artifacts = new Set()
  for (const event of events) {
    for (const key of ['artifact', 'artifact_path', 'evidence', 'evidence_refs']) {
      const value = event.payload?.[key]
      if (typeof value === 'string') artifacts.add(value)
      else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') artifacts.add(entry)
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
    rejection,
    bindings: store.bindings(candidateId),
    job: store.jobFor(candidateId) ?? null,
    artifacts: [...artifacts].sort(),
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