/**
 * The rolling code base anchor: which tree the next candidates branch from, and the ruler that must
 * not move with it.
 *
 * Two numbers are easy to confuse here, and the whole module exists to keep them apart:
 *
 *   - **the anchor** is where the search *stands*. A candidate that dominates it is better than the
 *     best thing we have committed to so far, so later candidates may as well start from it instead
 *     of re-deriving its change.
 *   - **the denominator** (the frozen baseline) is what every comparison is *against*. It is frozen
 *     once, by `baseline.js`, and a roll never touches it: a run whose ruler followed its best
 *     candidate would report "improved" for standing still.
 *
 * The advance rule is **double domination** (parity gap §4.7): only a candidate that dominates the
 * current anchor **and** the starting baseline becomes the new code base. One side is not enough —
 * beating the baseline alone is a trade-off against where the search now stands, and beating the
 * anchor alone may still be worse than where it started, which is not an advance either. The
 * denominator is one axis in the usual case (that is all a frozen baseline measured), so it is
 * compared on the axes it actually has; the anchor is a candidate and is compared on every axis the
 * contract names.
 *
 * A rejected candidate is never nominated, permanently: the exclusion is read from the fact plane
 * (a `candidate_rejected` event folded into the ranking row's status) every time the roll is
 * evaluated, so a restart cannot resurrect a refusal that a process-local set would lose.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { WORKSPACE_SUBJECT } from './store.js'

/** The two ways a roll can be decided. Both exist because moving the base ref is a policy. */
export const ANCHOR_MODES = Object.freeze(['automatic', 'human'])

/** The workspace field the `anchor` intent writes, and the one place a code base is recorded. */
export const ANCHOR_KEY = 'code_base_anchor'

/** Where a `human`-mode roll waits. Next to `pending/`, because it is the same kind of thing. */
export const PROPOSALS_DIRNAME = 'anchor-pending'

const SHA = /^[0-9a-f]{7,64}$/
const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * The code base this workspace is on, or `undefined`.
 *
 * Written by the `anchor` intent (a human decision) or by `anchorStep` below (the automatic rule).
 * Both land in the same field with the same two fields that matter, because a reader — the runner,
 * LAND, `dump` — must not have to know which writer produced it.
 *
 * @returns {{ candidate_id: string, commit: string, source: string, intent_id: string|null } | undefined}
 */
export function readAnchor(store) {
  const raw = store.getState(undefined, 'workspace', {})?.[ANCHOR_KEY]
  if (raw === null || typeof raw !== 'object') return undefined
  const candidateId = raw.candidate_id
  const commit = raw.commit
  if (!isText(candidateId) || typeof commit !== 'string' || !SHA.test(commit)) return undefined
  const source = typeof raw.source === 'string' ? raw.source : isText(raw.intent_id) ? 'human' : 'unknown'
  return { candidate_id: candidateId, commit, source, intent_id: isText(raw.intent_id) ? raw.intent_id : null }
}

/** The mode this run declared. Absent means `automatic`; the round settings validate the value. */
export const anchorModeOf = (settings) => settings?.anchor_mode ?? 'automatic'

const atLeastAsGood = (a, b, direction) => (direction === 'down' ? a <= b : a >= b)
const strictlyBetter = (a, b, direction) => (direction === 'down' ? a < b : a > b)

/**
 * Does `left` dominate `right` over `axes`? Better or equal everywhere, better somewhere.
 *
 * An axis either side is missing makes the pair incomparable — `false`, never "assume it is bad".
 * A half-measured vector taking over the code base is exactly the silent promotion this refuses.
 */
function dominates(left, right, axes) {
  let strictly = false
  for (const axis of axes) {
    const a = left?.[axis.name]
    const b = right?.[axis.name]
    if (typeof a !== 'number' || !Number.isFinite(a)) return false
    if (typeof b !== 'number' || !Number.isFinite(b)) return false
    if (!atLeastAsGood(a, b, axis.direction)) return false
    if (strictlyBetter(a, b, axis.direction)) strictly = true
  }
  return strictly
}

/** The vector of the frozen baseline: the one metric it measured, in the contract's direction. */
function baselineVector(baseline, objectives) {
  if (baseline === null || typeof baseline !== 'object') return undefined
  const metric = baseline.metric
  const value = baseline.value
  if (typeof metric !== 'string' || metric === '' || typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const axis = objectives.find((objective) => objective.name === metric)
  if (axis === undefined) return undefined
  return { vector: { [metric]: value }, axes: [axis] }
}

const byPrimaryThenId = (primary, objectives) => (left, right) => {
  const direction = objectives.find((objective) => objective.name === primary)?.direction ?? 'up'
  const a = left.vector?.[primary]
  const b = right.vector?.[primary]
  if (typeof a === 'number' && typeof b === 'number' && a !== b) return strictlyBetter(a, b, direction) ? -1 : 1
  return left.candidate_id < right.candidate_id ? -1 : 1
}

/**
 * Should the code base roll, and to whom? Pure: facts in, decision out.
 *
 * @param {{
 *   view: { contract: any, candidates: any[] },
 *   baseline?: { metric?: string, value?: number },
 *   anchor?: { candidate_id: string, commit?: string },
 * }} input
 * @returns {{
 *   roll: boolean, candidate_id?: string, reason: string,
 *   evidence: { candidate_id: string, dominates_baseline: boolean, dominates_anchor: boolean, rejected?: boolean } | null,
 *   candidates: { candidate_id: string, status: string, complete: boolean, rejected: boolean, dominates_baseline: boolean, dominates_anchor: boolean }[],
 * }}
 */
export function rollDecision({ view, baseline, anchor } = {}) {
  const contract = view?.contract
  const objectives = contract?.ok === true ? contract.objectives : []
  const empty = { roll: false, reason: 'no_contract', evidence: null, candidates: [] }
  if (objectives.length === 0) return empty

  const starting = baselineVector(baseline, objectives)
  if (starting === undefined) return { roll: false, reason: 'no_baseline', evidence: null, candidates: [] }

  // Sorted by id, so the decision (and the evidence it carries) is a function of the facts rather
  // than of the order the rows happened to arrive in.
  const rows = [...(view?.candidates ?? [])].sort((left, right) =>
    left.candidate_id < right.candidate_id ? -1 : 1,
  )
  const rowOf = (candidateId) => rows.find((row) => row.candidate_id === candidateId)

  // Both sides of the comparison. With no anchor yet the baseline *is* the anchor: a search with
  // nothing landed has nothing to trade off, so beating where it started is the whole rule.
  let anchorVector = starting.vector
  let anchorAxes = starting.axes
  if (anchor !== undefined) {
    const row = rowOf(anchor.candidate_id)
    if (row === undefined) return { roll: false, reason: 'anchor_unknown', evidence: null, candidates: [] }
    if (row.complete !== true) {
      return {
        roll: false,
        reason: 'anchor_incomplete',
        evidence: { candidate_id: row.candidate_id, dominates_baseline: false, dominates_anchor: false },
        candidates: [],
      }
    }
    anchorVector = row.vector
    anchorAxes = objectives
  }

  const considered = []
  const nominees = []
  for (const row of rows) {
    const rejected = row.status === 'rejected'
    const entry = {
      candidate_id: row.candidate_id,
      status: row.status,
      complete: row.complete === true,
      rejected,
      // A candidate is never compared with itself, and an unfinished one has no verdict to act on:
      // its change is not landed, so there is no tree to branch from.
      dominates_baseline: row.complete === true && dominates(row.vector, starting.vector, starting.axes),
      dominates_anchor:
        row.complete === true && row.candidate_id !== anchor?.candidate_id
          ? dominates(row.vector, anchorVector, anchorAxes)
          : false,
    }
    considered.push(entry)
    if (entry.dominates_baseline && entry.dominates_anchor && !rejected) nominees.push(row)
  }

  const pick = (predicate) =>
    considered
      .filter(predicate)
      .map((entry) => rowOf(entry.candidate_id))
      .filter((row) => row !== undefined)
      .sort(byPrimaryThenId(contract.primary, objectives))[0]

  if (nominees.length > 0) {
    // Among the candidates that clear both bars, a nominee another nominee dominates is not a
    // choice: both are eligible, and starting from the worse of two overlapping changes would
    // re-derive the same work. What is left is the set the primary metric (then the id) orders.
    const finalists = nominees.filter(
      (row) => !nominees.some((other) => other !== row && dominates(other.vector, row.vector, objectives)),
    )
    const winner = finalists.sort(byPrimaryThenId(contract.primary, objectives))[0]
    return {
      roll: true,
      candidate_id: winner.candidate_id,
      reason: 'double_domination',
      evidence: {
        candidate_id: winner.candidate_id,
        dominates_baseline: true,
        dominates_anchor: true,
        rejected: false,
      },
      candidates: considered,
    }
  }

  const evidenceFor = (entry) => ({
    candidate_id: entry.candidate_id,
    dominates_baseline: entry.dominates_baseline,
    dominates_anchor: entry.dominates_anchor,
    rejected: entry.rejected,
  })

  // Why nothing rolled, in the order that explains the most: a refused candidate that would have
  // qualified, then the two one-sided misses. A trade-off is named as a trade-off, never as "no
  // candidate" — "we found nothing" and "we found something that loses on one axis" are different
  // facts about the search, and only one of them is a reason to keep going.
  const refused = considered.find((entry) => entry.rejected && entry.dominates_baseline && entry.dominates_anchor)
  if (refused !== undefined) {
    return { roll: false, reason: 'only_rejected_candidates', evidence: evidenceFor(refused), candidates: considered }
  }
  const anchorOnly = pick((entry) => !entry.rejected && entry.complete && entry.dominates_anchor && !entry.dominates_baseline)
  if (anchorOnly !== undefined) {
    const entry = considered.find((row) => row.candidate_id === anchorOnly.candidate_id)
    return { roll: false, reason: 'dominates_anchor_only', evidence: evidenceFor(entry), candidates: considered }
  }
  const baselineOnly = pick(
    (entry) => !entry.rejected && entry.complete && entry.dominates_baseline && !entry.dominates_anchor,
  )
  if (baselineOnly !== undefined) {
    const entry = considered.find((row) => row.candidate_id === baselineOnly.candidate_id)
    return { roll: false, reason: 'dominates_baseline_only', evidence: evidenceFor(entry), candidates: considered }
  }
  return { roll: false, reason: 'no_candidate', evidence: null, candidates: considered }
}

// ------------------------------------------------------------------- proposals

/** Where a human-mode roll waits for its answer: `<workspace>/anchor-pending/<candidate>.json`. */
export const proposalsDir = (workspaceDir) => join(workspaceDir, PROPOSALS_DIRNAME)

/**
 * The rolls waiting for a human, in candidate-id order.
 *
 * This is the reader a `human`-mode run needs: the proposal is evidence, and the decision stays with
 * the person — who answers it with the `anchor` intent (`intents anchor --candidate-id … --commit …`).
 */
export function pendingProposals(workspaceDir) {
  const dir = proposalsDir(workspaceDir)
  let names
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
  const proposals = []
  for (const name of names) {
    try {
      const proposal = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      proposals.push({ ...proposal, path: join(dir, name) })
    } catch {
      proposals.push({ candidate_id: name.slice(0, -'.json'.length), unreadable: true, path: join(dir, name) })
    }
  }
  return proposals
}

/**
 * Write one proposal, once. Returns `false` when this candidate is already waiting.
 *
 * `wx` on purpose: an approval that arrives late must not be re-opened by a second round noticing the
 * same candidate, and two proposals for one decision are two files a person has to reconcile.
 */
function propose(workspaceDir, proposal) {
  const dir = proposalsDir(workspaceDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${proposal.candidate_id}.json`)
  if (existsSync(path)) return false
  try {
    writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  return true
}

// --------------------------------------------------------------- the step

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** One workspace fact: the roll decision, its evidence, and which tree it moved to. */
function tell(store, clock, eventType, payload) {
  return store.appendEvent({
    candidate_id: WORKSPACE_SUBJECT,
    wall_clock_ms: clock.now(),
    event_type: eventType,
    payload,
  }).local_seq
}

const evidenceOf = (decision, mode) => ({
  reason: decision.reason,
  ...(decision.evidence ?? {}),
  mode,
})

/**
 * Decide the roll and act on it — the one place a code base moves.
 *
 * Called by the workspace between rounds (`rounds.js`, before the round's roster is chosen), because
 * that is the last moment at which "which tree do the next candidates branch from" is still open.
 *
 * Three outcomes and no fourth:
 *
 *   - **no roll**: nothing was nominated, and the event says *why* (`dominates_anchor_only` and
 *     friends), because "we checked and it was a trade-off" and "we never checked" look identical
 *     from the outside.
 *   - **`automatic`**: the anchor is written, so `runner.baseRef` — and therefore `git worktree add`
 *     and every diff a harness takes — follows it from the next candidate on. The frozen baseline is
 *     not read, not written, not touched: the ruler belongs to `baseline.js`.
 *   - **`human`**: a proposal is filed under `anchor-pending/` and **nothing moves**. The answer is
 *     the `anchor` intent (`intents anchor --candidate-id … --commit …`), which is the same write
 *     path a person would use if they disagreed with the nomination.
 *
 * Naming the tree is the runner's job (`seal`), because it is the only role allowed to write git:
 * the candidate's worktree is committed and the commit kept behind a ref, so the anchor is a sha the
 * next `git worktree add --detach` can actually branch from. A roll that cannot be named is not a
 * roll — the round keeps the tree it has, and the failure is a fact rather than a crash mid-tick.
 *
 * @param {{
 *   store: any, clock: { now: () => number }, now: number,
 *   anchor?: { seal?: (candidateId: string) => string }, log?: Function,
 * }} context
 * @param {object} state the `rounds` workspace state (its frozen baseline is the denominator)
 * @param {{ contract: any, candidates: any[] }} view the ranking, computed once by the caller
 * @param {{ anchor_mode?: string }} settings the frozen round settings
 */
export function anchorStep(context, state, view, settings) {
  const { store, clock, now, log } = context
  const mode = anchorModeOf(settings)
  const anchor = readAnchor(store)
  const decision = rollDecision({ view, baseline: state?.baseline, anchor })
  if (!decision.roll) return { action: 'no_roll', mode, decision }

  const candidateId = decision.candidate_id
  const fail = (message) => {
    tell(store, clock, 'anchor_roll_failed', { candidate_id: candidateId, mode, message, evidence: evidenceOf(decision, mode) })
    log?.(`anchor: ${candidateId} was nominated but cannot be named as a base ref — ${message}`)
    return { action: 'anchor_roll_failed', mode, decision, message }
  }

  let commit
  try {
    commit = context.anchor?.seal?.(candidateId)
  } catch (error) {
    return fail(messageOf(error))
  }
  if (typeof commit !== 'string' || !SHA.test(commit)) {
    return fail('the runner did not return a commit for the candidate tree')
  }

  if (mode === 'human') {
    const written = propose(dirname(store.path), {
      candidate_id: candidateId,
      commit,
      mode,
      round: state?.round ?? 0,
      proposed_at_ms: now,
      evidence: evidenceOf(decision, mode),
      code_base: anchor ?? null,
      // The denominator is quoted so the person answering the proposal can see it is *not* part of
      // the decision: approving a roll changes the tree, never the ruler.
      denominator: state?.baseline === undefined ? null : { metric: state.baseline.metric, value: state.baseline.value },
    })
    if (written) {
      tell(store, clock, 'anchor_roll_proposed', { candidate_id: candidateId, commit, evidence: evidenceOf(decision, mode) })
      log?.(`anchor: ${candidateId} proposed as the next code base (${commit}) — waiting for an anchor intent`)
    }
    return { action: 'anchor_roll_proposed', mode, decision, commit, written }
  }

  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', {
    ...workspace,
    [ANCHOR_KEY]: { candidate_id: candidateId, commit, source: 'automatic', at_ms: now },
  })
  tell(store, clock, 'anchor_rolled', { candidate_id: candidateId, commit, evidence: evidenceOf(decision, mode) })
  log?.(`anchor: rolled the code base to ${candidateId} (${commit})`)
  return { action: 'anchor_rolled', mode, decision, commit }
}

/**
 * The history of the code base, newest last: what moved it, and what was proposed but never answered.
 *
 * This is the reader `dump` and a person share. It is derived from facts (the anchor events on
 * `_workspace`) plus the proposals still on disk, so it answers "which tree are we on, and why" from
 * the workspace directory alone.
 */
export function anchorHistory(store, workspaceDir) {
  const events = store
    .eventsFor(WORKSPACE_SUBJECT)
    .filter((event) => ['anchor_rolled', 'anchor_roll_proposed', 'anchor_roll_failed'].includes(event.event_type))
    .map((event) => ({ ...event.payload, event_type: event.event_type, at_ms: event.wall_clock_ms, seq: event.local_seq }))
  return { current: readAnchor(store), events, proposals: pendingProposals(workspaceDir) }
}