/**
 * The frontier: the candidates no other candidate dominates — and the baseline, always.
 *
 * This module is the set, and only the set. `ranking.js` answers "what are the numbers, and who is
 * ahead" with one row per candidate and the single `best`; that is a different question and a
 * different word (CONTEXT.md §11). Three properties are the whole point, and each one is a bug this
 * shape prevents:
 *
 *   1. **It can hold several candidates.** Two candidates that trade one objective against another
 *      dominate neither, so both are worth continuing from even though one of them is not `best`.
 *   2. **It can be empty of candidates.** When nothing is comparable yet, the set is the baseline
 *      alone (`empty: true`) — the honest answer, and the one parent selection reads as "start from
 *      the baseline".
 *   3. **The baseline is always in it.** The baseline row is the reference point every later
 *      comparison is made against; a frontier without it could not say "nothing has improved yet".
 *      It is *not* removed by domination: a candidate only ever dominates another candidate, because
 *      the frozen baseline usually measured just the primary axis and a partial vector must not be
 *      read as "worse everywhere".
 *
 * Everything here is pure: rows in, set out. No store, no clock, no model, no iteration order that
 * the caller could influence — the same rows always produce the same set in the same order.
 *
 * @module
 */

import { createHash } from 'node:crypto'

/** The id the frontier gives the frozen baseline. It is not a candidate and never becomes one. */
export const BASELINE_ID = 'baseline'

/** The one candidate status a parent may have: its change is the one we build on. */
const DONE = 'done'

const atLeastAsGood = (a, b, direction) => (direction === 'down' ? a <= b : a >= b)
const strictlyBetter = (a, b, direction) => (direction === 'down' ? a < b : a > b)

/**
 * Does `left` dominate `right`? Better or equal on every axis, better on at least one.
 *
 * Both sides must have every axis; a vector with a hole is not comparable, and treating the hole as
 * "bad" is how a half-measured candidate silently takes over the set.
 */
function dominates(left, right, objectives) {
  let strictly = false
  for (const objective of objectives) {
    const a = left.vector?.[objective.name]
    const b = right.vector?.[objective.name]
    if (typeof a !== 'number' || typeof b !== 'number') return false
    if (!atLeastAsGood(a, b, objective.direction)) return false
    if (strictlyBetter(a, b, objective.direction)) strictly = true
  }
  return strictly
}

/**
 * The baseline as a member of the set.
 *
 * Its vector carries whatever the frozen evidence measured, which is usually the primary axis alone.
 * `complete` therefore says the truth — "this row cannot be compared on every axis" — while the row
 * is in the set anyway, because being the reference point is not the same as being comparable.
 */
function baselineMember(contract, baseline) {
  if (baseline === undefined || baseline === null) return undefined
  const value = baseline.value
  const metric = typeof baseline.metric === 'string' && baseline.metric !== '' ? baseline.metric : contract?.primary
  /** @type {Record<string, number>} */
  const vector = {}
  if (typeof metric === 'string' && metric !== '' && typeof value === 'number' && Number.isFinite(value)) {
    vector[metric] = value
  }
  const objectives = contract?.ok === true ? contract.objectives : []
  const missing = objectives.filter((objective) => !Object.hasOwn(vector, objective.name)).map((objective) => objective.name)
  return {
    candidate_id: BASELINE_ID,
    round: null,
    status: BASELINE_ID,
    metrics: { ...vector },
    vector,
    complete: contract?.ok === true && missing.length === 0,
    missing,
    baseline: true,
  }
}

/**
 * The non-dominated set over a ranking view.
 *
 * @param {{ contract: any, candidates: any[] }} view the ranking, as `ranking.js` returns it
 * @param {{ baseline?: { metric?: string, value?: number } }} [options] the frozen baseline
 * @returns {{ contract: any, baseline: any, members: any[], dominated: { candidate_id: string, dominated_by: string }[], empty: boolean }}
 */
export function frontierOf(view, { baseline } = {}) {
  const contract = view?.contract
  const objectives = contract?.ok === true ? contract.objectives : []
  const rows = [...(view?.candidates ?? [])].sort((left, right) => (left.candidate_id < right.candidate_id ? -1 : 1))
  // Comparability is about numbers, not verdicts: a rejected candidate still measured what it
  // measured, so it can be non-dominated. Whether it may be *continued from* is parent selection's
  // question, not the set's (a rejected change is not a base ref).
  const comparable = rows.filter((row) => row.complete === true)

  const members = comparable.filter(
    (row) => !comparable.some((other) => other !== row && dominates(other, row, objectives)),
  )
  const dominated = comparable
    .filter((row) => !members.includes(row))
    .map((row) => ({
      candidate_id: row.candidate_id,
      dominated_by: comparable.find((other) => other !== row && dominates(other, row, objectives)).candidate_id,
    }))

  const frozen = baselineMember(contract, baseline)
  return {
    contract,
    baseline: frozen,
    members: frozen === undefined ? members : [frozen, ...members],
    dominated,
    // "Empty" is about candidates: a search with nothing comparable yet is exactly the case parent
    // selection must handle by starting from the baseline, and it is not the same as "no frontier".
    empty: members.length === 0,
  }
}
/**
 * The parents a round starts from: the top `k` on each objective axis, taken in round-robin order.
 *
 * Why not one sort. A frontier with two trade-offs has no single winner, and sorting it on the
 * primary metric throws away the axis nobody made primary — the predecessor's mistake was the mirror
 * image of this one (every candidate started from the same base ref, so the search was N independent
 * experiments). Interleaving the per-axis leaders gives the roster one candidate per axis before it
 * gives any axis a second one.
 *
 * `offset` rotates which axis leads. It is an input, not state: two calls with the same set, `k` and
 * `offset` return the same list, and the round that used an offset records it in its snapshot rather
 * than leaving "why did loss lead that round" to be re-derived from a counter nobody wrote down.
 *
 * A rejected candidate is never a parent even when its numbers are non-dominated: continuing from it
 * would mean branching off a change the gates refused. A still-running candidate is not a parent
 * either — the plan that reads this roster runs after its round finished.
 *
 * @param {{ contract: any, members: any[] }} set the frontier, as `frontierOf` returns it
 * @param {{ k: number, offset?: number }} options k > 0 per round; offset rotates the axis that leads
 * @returns {string[]} candidate ids, or the baseline id alone when nothing is worth continuing from
 */
export function parentsOf(set, { k, offset = 0 } = {}) {
  if (!Number.isSafeInteger(k) || k <= 0) {
    throw new TypeError('parentsOf: k must be a positive integer — it is the number of candidates this round affords')
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError('parentsOf: offset must be a non-negative integer')
  }
  const contract = set?.contract
  const objectives = contract?.ok === true ? contract.objectives : []
  const eligible = (set?.members ?? []).filter((member) => member.baseline !== true && member.status === DONE)

  /** One list per axis, best first, ties by id: the order is a function of the numbers and the ids. */
  const perAxis = objectives.map((objective) =>
    eligible
      .filter((member) => typeof member.vector?.[objective.name] === 'number')
      .sort((left, right) => {
        const a = left.vector[objective.name]
        const b = right.vector[objective.name]
        if (a !== b) return strictlyBetter(a, b, objective.direction) ? -1 : 1
        return left.candidate_id < right.candidate_id ? -1 : 1
      })
      .map((member) => member.candidate_id),
  )

  const start = perAxis.length === 0 ? 0 : offset % perAxis.length
  const rotated = [...perAxis.slice(start), ...perAxis.slice(0, start)]
  const parents = []
  for (let rank = 0; rank < k; rank += 1) {
    for (const axis of rotated) {
      const candidateId = axis[rank]
      if (candidateId !== undefined && !parents.includes(candidateId)) parents.push(candidateId)
      if (parents.length === k) break
    }
    if (parents.length === k) break
  }

  // Nothing comparable, nothing finished, no contract, or every candidate refused: the baseline is
  // the only parent a round can honestly start from. Never an empty roster — a round with no parent
  // is a round with no base ref.
  return parents.length === 0 ? [BASELINE_ID] : parents
}

/**
 * JSON with its object keys sorted, so the same content is always the same bytes.
 *
 * `JSON.stringify` preserves insertion order, and insertion order is a property of whoever built the
 * object — the one thing a content-addressed record must not depend on.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * The round's parent snapshot: who this round starts from, as one content-addressed record.
 *
 * Content-addressed means the address *is* a digest of the contents, so it answers two questions the
 * run must be able to answer after the fact:
 *
 *   - "which round started from whom" — read the content back, by address;
 *   - "did the facts change under me" — the same inputs give the same address, and any difference
 *     (a different parent order, one more frontier member, another contract, another event prefix)
 *     gives a different one. A counter or a timestamp could not do that: it would be different every
 *     call and prove nothing.
 *
 * `events_prefix` is the frontier-relevant fork point: the highest `local_seq` any candidate had
 * reached. `pending` is what a recovery uses to decide whether the snapshot still describes the
 * facts it was taken over, and it is a number rather than a wall clock for the same reason.
 *
 * @param {{
 *   round: number,
 *   events_prefix: { last_local_seq: number },
 *   set: { contract: any, members: any[], empty: boolean },
 *   parents: string[],
 *   offset?: number,
 * }} input
 * @returns {{ address: string, content: object }} address is the sha256 of the canonical content
 */
export function parentSnapshot({ round, events_prefix, set, parents, offset = 0 }) {
  const contract = set?.contract
  const content = {
    round,
    events_prefix: { last_local_seq: events_prefix?.last_local_seq ?? 0 },
    frontier: (set?.members ?? []).map((member) => ({
      candidate_id: member.candidate_id,
      round: member.round ?? null,
      vector: { ...(member.vector ?? {}) },
      baseline: member.baseline === true,
    })),
    empty: set?.empty ?? true,
    parents: [...(parents ?? [])],
    rotation: {
      axes: contract?.ok === true ? contract.objectives.map((objective) => objective.name) : [],
      offset,
    },
    contract: {
      ref: contract?.ref ?? null,
      primary: contract?.primary ?? null,
      status: contract?.status ?? null,
      objectives:
        contract?.ok === true
          ? contract.objectives.map((objective) => ({ name: objective.name, direction: objective.direction }))
          : [],
    },
  }
  return { address: createHash('sha256').update(canonicalJson(content)).digest('hex'), content }
}
