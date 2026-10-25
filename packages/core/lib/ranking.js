/**
 * The ranking: one row per candidate with its numbers, the objective vector, and the single `best` —
 * computed entirely in code from facts. It is not the frontier (see `frontier.js` and CONTEXT.md
 * §11): `best` is one row here, chosen on the primary metric, and no member of this view is a
 * verdict about which candidates are worth comparing.
 *
 * Two rules shape this module:
 *
 *   1. **The numbers come from the platform, not from the model.** The only source of a metric
 *      value is the `metrics_collected` event, which the kernel writes from `platform.poll()`. A
 *      CAND_ANALYZE report is an argument about those numbers; it is never an input here, and no
 *      code path in this file reads a payload field written by a model. `stop.js` inherits the same
 *      guarantee by consuming this view and nothing else.
 *   2. **Domain differences are data.** Which metrics exist, which direction is better, and which
 *      one decides "best" all come from the metric contract, resolved once in `metric-contract.js`.
 *      The kernel knows the words `up` and `down` and nothing else about which metric it is or what
 *      it measures — and when the contract is absent or contradicts itself, this view ranks nothing
 *      and carries the name of that reason (`missing` / `conflict`) for the stop rules and the gate
 *      to say in their own answers.
 *
 * The view is materialised per candidate in the workspace KV table, stamped with that candidate's
 * `max(local_seq)`. A tick therefore re-derives a candidate only when a new event landed for it,
 * which is what keeps 10k events from costing 9.4 s per tick. `rebuildRanking` ignores the
 * materialised rows and folds the whole event stream instead: it is the check that lets a
 * contributor change projection logic and prove old facts still read the same.
 *
 * @module
 */

import { frontierOf } from './frontier.js'
import { resolveMetricContract } from './metric-contract.js'
import { WORKSPACE_SUBJECT } from './store.js'

/**
 * Where a candidate's materialised row lives. One KV row, so adding a projection needs no migration.
 *
 * The *key string* stays `derived_frontier`: it names rows already on disk in every existing
 * workspace, and it is data rather than vocabulary — renaming it would buy nothing but a cold
 * re-derive of every candidate. The exported name says what the row is for.
 */
export const RANKING_CACHE_KEY = 'derived_frontier'

/**
 * Subjects in the event stream that are not candidates. `_workspace` carries workspace-level facts
 * (the stop conclusion), and a derived view that counted it as a candidate would report a phantom
 * round 0 and a phantom "no metric" entry.
 */
const NOT_A_CANDIDATE = new Set([WORKSPACE_SUBJECT])

/**
 * Bump when the *reading* of a fact changes — a metric taken from a different field, a status
 * inferred differently. A materialised row is only valid for the code that wrote it, and a row
 * stamped by an older reader would otherwise keep serving an outdated view forever (its `max_seq`
 * still matches, so nothing would ever re-derive it). Changing this constant is the invalidation;
 * `dump --rebuild` is the check that catches a row which disagrees anyway.
 */
export const DERIVED_VERSION = 1

const ACTIVE = 'active'
const DONE = 'done'
const REJECTED = 'rejected'

/** Only finite numbers count as a metric. `NaN` from a parser is absence, not a value to compare. */
function numericMetrics(input) {
  /** @type {Record<string, number>} */
  const out = {}
  if (input === undefined || input === null || typeof input !== 'object') return out
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value
  }
  return out
}

function emptyRow() {
  return { version: DERIVED_VERSION, stamped_seq: 0, round: null, status: ACTIVE, metrics: {}, metrics_seq: 0 }
}

/**
 * Fold events into a candidate's row. Shared by the incremental path and the rebuild so the two can
 * only disagree about *which* facts they saw, never about how a fact is read.
 *
 * Note what is deliberately not read: `cand_analyze.payload.verdict` decides nothing here, and
 * `analyze_report` numbers are not a metric source even when they are perfectly well-formed.
 */
function foldRow(previous, events) {
  const row = { ...(previous ?? emptyRow()) }
  for (const event of events) {
    if (event.event_type === 'candidate_created') {
      const round = event.payload?.round
      row.round = Number.isSafeInteger(round) ? round : row.round
    }
    if (event.event_type === 'metrics_collected') {
      row.metrics = numericMetrics(event.payload?.metrics)
      row.metrics_seq = event.local_seq
    }
    if (event.event_type === 'cand_analyze') row.status = DONE
    if (event.event_type === 'candidate_rejected') row.status = REJECTED
    row.stamped_seq = event.local_seq
  }
  return row
}

/** One candidate's row, from its full event stream. The rebuild's unit of work. */
export function deriveRow(store, candidateId) {
  return foldRow(emptyRow(), store.eventsFor(candidateId))
}

/**
 * The rows for every subject in the event stream, derived incrementally.
 *
 * `persist: false` reads whatever rows already exist but writes nothing — required for a read-only
 * handle (`dump`, the dashboard) and for any caller that must not be able to change facts.
 */
function rowsOf(store, { persist }) {
  const rows = new Map()
  for (const candidateId of store.eventSubjects().filter((id) => !NOT_A_CANDIDATE.has(id))) {
    const cached = store.getState(candidateId, RANKING_CACHE_KEY)
    const max = store.maxSeq(candidateId)

    let row
    if (cached !== undefined && cached.version !== DERIVED_VERSION) {
      // Written by an older reader: its stamp proves nothing, so re-derive from the top.
      row = deriveRow(store, candidateId)
    } else if (cached !== undefined && cached.stamped_seq === max) {
      // Nothing new for this candidate: no event is read at all. This is the whole point of the
      // materialised row — the old implementation hit the cache and then re-read and re-sorted
      // everything anyway.
      row = cached
    } else if (cached !== undefined && cached.stamped_seq < max) {
      row = foldRow(cached, store.eventsAfter(candidateId, cached.stamped_seq))
    } else {
      // Cold cache, or a stamp from the future (corruption): derive from the top.
      row = deriveRow(store, candidateId)
    }

    rows.set(candidateId, row)
    if (persist && (row.stamped_seq !== cached?.stamped_seq || row.version !== cached?.version)) {
      store.setState(candidateId, RANKING_CACHE_KEY, row)
    }
  }
  return rows
}

const strictlyBetter = (a, b, direction) => (direction === 'down' ? a < b : a > b)

function compareByPrimary(left, right, contract) {
  const direction = contract.objectives.find((objective) => objective.name === contract.primary)?.direction
  const a = left.vector[contract.primary]
  const b = right.vector[contract.primary]
  if (a !== b) return strictlyBetter(a, b, direction) ? -1 : 1
  // A tie does not displace the incumbent: the earlier round wins, then the lower id. Deterministic,
  // and it is what makes "no improvement" observable at all — a repeat of the best is not a gain.
  if (left.round !== right.round) return (left.round ?? 0) - (right.round ?? 0)
  return left.candidate_id < right.candidate_id ? -1 : 1
}

/** Turn materialised rows into the ranking: one row per candidate, plus the single best. Pure: no store access, no clock, no model. */
function viewOf(contract, rows) {
  const candidates = []
  for (const candidateId of [...rows.keys()].sort()) {
    const row = rows.get(candidateId)
    const metrics = row.metrics ?? {}
    const vector = {}
    const missing = []
    for (const objective of contract.objectives) {
      if (Object.hasOwn(metrics, objective.name)) vector[objective.name] = metrics[objective.name]
      else missing.push(objective.name)
    }
    candidates.push({
      candidate_id: candidateId,
      round: row.round ?? null,
      status: row.status ?? ACTIVE,
      metrics,
      vector,
      complete: contract.ok && missing.length === 0,
      missing,
      onFrontier: false,
      dominatedBy: null,
      stamped_seq: row.stamped_seq ?? 0,
    })
  }

  const ranked = candidates.filter((row) => row.complete)

  // Who dominates whom is the frontier's question, answered in one place (`frontier.js`) so the set
  // and the row annotations can never disagree. The baseline is not passed in: no candidate dominates
  // the baseline, and this view is about candidates only.
  const set = frontierOf({ contract, candidates })
  for (const row of set.members) row.onFrontier = true
  for (const entry of set.dominated) {
    const row = candidates.find((candidate) => candidate.candidate_id === entry.candidate_id)
    if (row !== undefined) row.dominatedBy = entry.dominated_by
  }

  const best = [...ranked].sort((left, right) => compareByPrimary(left, right, contract))[0]

  return {
    contract,
    candidates,
    best:
      best === undefined
        ? undefined
        : {
            candidate_id: best.candidate_id,
            round: best.round,
            metric: contract.primary,
            value: best.vector[contract.primary],
          },
    frontier: set.members.map((member) => member.candidate_id),
    incomplete: candidates
      .filter((row) => !row.complete && row.missing.length > 0)
      .map((row) => ({ candidate_id: row.candidate_id, missing: row.missing })),
    seqs: Object.fromEntries(candidates.map((row) => [row.candidate_id, row.stamped_seq])),
  }
}

/**
 * The ranking, incrementally.
 *
 * @param {import('./store.js').Store} store
 * @param {{ metrics?: object } | undefined} config the metric contract (resolved by `resolveMetricContract`)
 * @param {{ persist?: boolean }} [options] persist=false for read-only handles
 */
export function ranking(store, config, { persist = true } = {}) {
  const contract = resolveMetricContract(config?.metrics)
  return viewOf(contract, rowsOf(store, { persist }))
}

/**
 * The same ranking, computed from the whole event stream with the materialised rows ignored.
 *
 * This is the verification path: run it over an old workspace after changing projection logic and
 * compare with what the incremental path claims. It never writes, so it is safe on a read-only
 * handle and safe on data you do not want touched.
 */
export function rebuildRanking(store, config) {
  const contract = resolveMetricContract(config?.metrics)
  const rows = new Map()
  for (const candidateId of store.eventSubjects().filter((id) => !NOT_A_CANDIDATE.has(id))) rows.set(candidateId, deriveRow(store, candidateId))
  return viewOf(contract, rows)
}

/**
 * Group the derived view by round and say, per round, whether it is finished, what it achieved, and
 * whether it beat everything before it. The stop rules are statements about this history, so it is
 * computed once, from the facts, and never from a model's claim that a round went well.
 */
export function roundHistory(view) {
  const rounds = new Map()
  for (const candidate of view.candidates) {
    const round = candidate.round ?? 0
    if (!rounds.has(round)) rounds.set(round, [])
    rounds.get(round).push(candidate)
  }

  const history = []
  let bestSoFar
  for (const round of [...rounds.keys()].sort((left, right) => left - right)) {
    const members = rounds.get(round)
    const ranked = members.filter((candidate) => candidate.complete)
    const roundBest = ranked
      .map((candidate) => ({
        candidate_id: candidate.candidate_id,
        value: candidate.vector[view.contract.primary],
      }))
      .sort((left, right) => {
        const direction = view.contract.objectives.find((objective) => objective.name === view.contract.primary)?.direction
        if (left.value !== right.value) return strictlyBetter(left.value, right.value, direction) ? -1 : 1
        return left.candidate_id < right.candidate_id ? -1 : 1
      })[0]

    const direction = view.contract.objectives.find((objective) => objective.name === view.contract.primary)?.direction
    const improving =
      roundBest !== undefined &&
      (bestSoFar === undefined || strictlyBetter(roundBest.value, bestSoFar.value, direction))
    if (improving) bestSoFar = roundBest

    history.push({
      round,
      candidates: members.map((candidate) => candidate.candidate_id).sort(),
      complete: members.every((candidate) => candidate.status !== ACTIVE),
      best: roundBest,
      improving,
      // An "empty" round produced nothing comparable: no candidate reached a metric-bearing end.
      empty: roundBest === undefined,
    })
  }
  return history
}