/**
 * The four dashboard views, computed from the core projection.
 *
 * This module is the display layer's whole data half. Each view is a thin envelope around the
 * function `packages/core/lib/projection.js` already exposes, and `dump` renders through those same
 * functions — which is the point: one derivation, two renderers. A second derivation living in the
 * dashboard would disagree with `dump` the first time either side changed, and the person reading
 * both would have no way to tell which one lied.
 *
 * The dependency direction (`ui` reads `core`) is a deliberate exception to "no package depends on
 * core": `dump` owns the projection, `dump` lives in core, and ticket 11 requires the two to be the
 * same code rather than two implementations that happen to agree today. The alternative — injecting
 * the projection at a composition root — would be a port nothing else needs; it is noted in the
 * ticket's report as the place to move this edge if the layering ever has to hold strictly.
 *
 * @module
 */

import { dirname } from 'node:path'

import {
  candidateDetail,
  conclusion,
  modelCall,
  modelCalls,
  overview,
  rounds,
  summariseEvent,
} from '../../core/lib/projection.js'

/**
 * A refusal from the view layer, and the status it deserves.
 *
 * A dedicated class rather than `TypeError`: the route adapter maps this to its status, so a *bug*
 * that happens to throw a `TypeError` is a 500 and never gets disguised as a client error.
 */
export class ViewError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ViewError'
    this.status = status
  }
}

/**
 * The cursor: the store's own ordering key for one fact, `<wall_clock_ms>:<candidate_id>:<local_seq>`.
 *
 * `local_seq` alone is *not* a workspace cursor. Identity is the pair `(candidate_id, local_seq)`, so
 * a candidate created later starts again at 1 and a bare integer cursor would skip its first facts —
 * silently, which is the worst kind. Wall clock (the store's `events_by_time` order) plus the
 * identity pair is a total order over every fact in the workspace, so "everything after this" means
 * exactly one thing. The protocol can go streaming later by pushing these same items, cursor and all.
 */
const CURSOR_PATTERN = /^(\d+):(.+):(\d+)$/

/** The ordering triple of a fact — the same three fields the cursor spells out. */
function orderKey(event) {
  return { wallClockMs: event.wall_clock_ms, candidateId: event.candidate_id, localSeq: event.local_seq }
}

export function cursorOf(event) {
  return `${event.wall_clock_ms}:${event.candidate_id}:${event.local_seq}`
}

/** @returns {{ wallClockMs: number, candidateId: string, localSeq: number } | undefined} */
function parseCursor(value) {
  if (typeof value !== 'string') return undefined
  const match = CURSOR_PATTERN.exec(value)
  if (match === null) return undefined
  return { wallClockMs: Number(match[1]), candidateId: match[2], localSeq: Number(match[3]) }
}

function compareCursors(left, right) {
  if (left.wallClockMs !== right.wallClockMs) return left.wallClockMs < right.wallClockMs ? -1 : 1
  if (left.candidateId !== right.candidateId) return left.candidateId < right.candidateId ? -1 : 1
  return left.localSeq === right.localSeq ? 0 : left.localSeq < right.localSeq ? -1 : 1
}

/** The cursor a request asked for. A malformed one is a client bug, and 400 is how it finds out. */
function requireCursor(value) {
  const parsed = parseCursor(value)
  if (parsed === undefined) {
    throw new ViewError(400, `?after must be a cursor a previous answer returned: "<wall_clock_ms>:<candidate_id>:<local_seq>"`)
  }
  return parsed
}

/**
 * Every fact in the workspace, in the store's own order.
 *
 * Deliberately built from the store's public readers (`eventSubjects` + `eventsFor`) rather than a
 * hand-written query: a second SQL order would be a second definition of "the facts, in order", and
 * the day the two disagreed the increment would skip facts instead of reporting them.
 */
export function allEvents(store) {
  const keyed = []
  for (const subject of store.eventSubjects()) {
    for (const event of store.eventsFor(subject)) keyed.push({ event, key: orderKey(event) })
  }
  return keyed.sort((left, right) => compareCursors(left.key, right.key)).map((entry) => entry.event)
}

/** The declared shape of one incremental item — a fact, its identity, its cursor and its one-liner. */
function renderEvent(event) {
  return {
    cursor: cursorOf(event),
    candidate_id: event.candidate_id,
    local_seq: event.local_seq,
    wall_clock_ms: event.wall_clock_ms,
    event_type: event.event_type,
    summary: summariseEvent(event),
    payload: event.payload,
  }
}

/**
 * Wrap a view in the incremental envelope.
 *
 * The `data` half is *always* derived from every fact; only `incremental.events` is filtered by the
 * cursor. That inequality is deliberate: a cursor can cost you bandwidth, never correctness, so a
 * browser that polls with a stale or wrong cursor still shows a true page.
 */
function envelope(store, name, body, query) {
  const after = query.after === undefined ? null : requireCursor(query.after)
  const events = allEvents(store)
  const fresh = after === null ? events : events.filter((event) => compareCursors(orderKey(event), after) > 0)

  return {
    view: name,
    // Which workspace this page is about. `dump` prints the same path first; a dashboard that does not
    // name its subject cannot be trusted when two windows are open.
    workspace: dirname(store.path),
    cursor: events.length === 0 ? null : cursorOf(events[events.length - 1]),
    after: query.after === undefined ? null : query.after,
    more: fresh.length > 0,
    incremental: { events: fresh.map(renderEvent) },
    ...body,
  }
}

/**
 * The configuration a reader needs to interpret the run: which metric decides "better", which rules
 * decide "enough", and what the run was allowed to spend.
 *
 * Read from the workspace record — exactly like `dump`'s zero-flag path, because the dashboard has
 * only the workspace directory: no session, no agent, no live `tick` config. A workspace that never
 * recorded them says so instead of guessing a direction or a limit.
 */
export function configFrom(store) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const config = {}
  for (const key of ['metrics', 'stop', 'budget']) {
    if (workspace[key] !== undefined) config[key] = workspace[key]
  }
  return Object.keys(config).length === 0 ? undefined : config
}

/**
 * What the page must say out loud even though no number is wrong.
 *
 * The one that matters: a workspace that never recorded a budget falls back to the default
 * `gpu_hours_limit: 0`, which means *unlimited*. Printing a silent 0 would turn "nobody told me the
 * limit" into "there is no limit", which is the opposite of a safe default.
 */
function notesFor(store) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const notes = []
  if (workspace.budget === undefined) {
    notes.push('this workspace never recorded a budget: the GPU-hour limit shown is the default 0, which means unlimited')
  }
  return notes
}

/**
 * The overview page: where the run is, what it is spending, what it found, and why it ended.
 *
 * `listing` is the cluster's answer, when the caller has one (the route reads it through
 * `jobs.js`'s `readListing` before calling in). The page has only the workspace directory and cannot
 * ask the cluster itself, so an absent listing is not an error — it is the `cards.inUse: null`
 * answer, and the projection says why. Passing it through rather than dropping it is what makes
 * "how many cards are in use" a number the page can print at all.
 */
export function overviewView(store, query = {}, { listing } = {}) {
  const data = overview(store, { config: configFrom(store), listing })
  return envelope(store, 'overview', { data, notes: notesFor(store) }, query)
}

/** The rounds page: who ran in each round, how each finished, whether the round moved the best. */
export function roundsView(store, query = {}) {
  return envelope(store, 'rounds', { data: rounds(store, { config: configFrom(store) }) }, query)
}

/** One candidate's page — the same facts `dump --candidate` prints. */
export function candidateView(store, query = {}) {
  const candidateId = query.candidate
  if (typeof candidateId !== 'string' || candidateId === '') {
    throw new ViewError(400, 'candidate view needs ?candidate=<id>')
  }
  const detail = candidateDetail(store, candidateId, { config: configFrom(store) })
  return envelope(
    store,
    'candidate',
    { candidate: candidateId, data: detail ?? null, missing: detail === undefined },
    query,
  )
}

/** The conclusion page: what this run established, on which number, and against what. */
export function conclusionView(store, query = {}) {
  return envelope(store, 'conclusion', { data: conclusion(store, { config: configFrom(store) }) }, query)
}

/**
 * The audit page: every judgement the run asked a model for, one row each, `?site=` to narrow it.
 *
 * The list deliberately carries no prompt bodies — opening a call is a second request, so the page
 * can show a hundred calls without carrying a hundred prompts, and the reader chooses which original
 * text to read.
 */
export function callsView(store, query = {}) {
  return envelope(store, 'calls', { data: modelCalls(store, { callSite: query.site }) }, query)
}

/** One judgement, opened: the prompt it was given and the words that came back, verbatim. */
export function callView(store, query = {}) {
  const ref = query.ref
  if (typeof ref !== 'string' || ref === '') {
    throw new ViewError(400, 'the audit view needs ?ref=<model_call:call-site:subject[:ref]>')
  }
  const call = modelCall(store, ref)
  // `missing` rather than a 404: a workspace whose record was pruned still has a page, and the
  // difference between "not a record" and "no such record" is what the two fields state.
  return envelope(store, 'call', { ref, data: call ?? null, missing: call === undefined }, query)
}