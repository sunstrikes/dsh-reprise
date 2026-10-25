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

/** The id the frontier gives the frozen baseline. It is not a candidate and never becomes one. */
export const BASELINE_ID = 'baseline'

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