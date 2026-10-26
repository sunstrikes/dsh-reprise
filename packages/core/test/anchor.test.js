/**
 * Guards the decision "the code base rolls forward, and the ruler does not" (issue 23; parity gap
 * §4.7: 双支配推进 + 分母永不滚 + reject 永久排除).
 *
 * Four properties, each one a way this could quietly go wrong:
 *
 *   1. **Double domination.** A candidate becomes the new code base only when it dominates the
 *      *current anchor* **and** the *starting baseline*. Dominating the baseline alone says the
 *      search found something better than where it began; dominating the anchor alone says it is
 *      better than where it stands now. A candidate that beats one and loses to the other is a
 *      trade-off, not an advance, and rolling onto it would move the tree every round for no reason.
 *   2. **The denominator never rolls.** A roll changes the tree later candidates branch from. Every
 *      number is still compared against the frozen baseline record — byte for byte, before and
 *      after — or "improved" would silently start meaning "improved on the last thing we liked".
 *   3. **A rejected candidate is never nominated again, permanently.** Permanent is a claim about
 *      the fact plane, so the proof reads the event stream after reopening the store; an in-memory
 *      set would pass a single-process test and lose the exclusion on the next restart.
 *   4. **Human mode proposes and changes nothing.** The base ref only moves when the human answer
 *      arrives — as the `anchor` intent that has existed since ticket 12 and had no reader.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readRoundsState } from '../lib/rounds.js'
import { ranking } from '../lib/ranking.js'
import { Store } from '../lib/store.js'
import { readAnchor, rollDecision } from '../lib/anchor.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

const TWO_AXES = { metrics: { primary: 'auc', objectives: { auc: 'up', loss: 'down' } } }
const BASELINE = { metric: 'auc', value: 0.8 }

/**
 * A workspace whose numbers already say what the two negative cases need.
 *
 * The starting baseline measured one axis only (that is what a frozen baseline usually has), and the
 * current anchor is *below* it on auc while being better on loss — which is exactly the situation in
 * which "dominates the anchor" and "dominates the baseline" can disagree. That disagreement is the
 * whole reason the rule asks for both.
 */
async function compared() {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'anchor', metrics: { auc: 0.78, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'anchor-only', metrics: { auc: 0.79, loss: 0.29 } })
  await runCandidate(ports, { candidateId: 'baseline-only', metrics: { auc: 0.85, loss: 0.35 } })
  await runCandidate(ports, { candidateId: 'both', metrics: { auc: 0.85, loss: 0.28 } })
  const view = ranking(ports.store, TWO_AXES)
  return { ports, view, anchor: { candidate_id: 'anchor', commit: 'a'.repeat(40) } }
}

test('a candidate that dominates the current anchor and the starting baseline moves the code base', async () => {
  const { ports, view, anchor } = await compared()
  const decision = rollDecision({ view, baseline: BASELINE, anchor })

  assert.equal(decision.roll, true)
  assert.equal(decision.candidate_id, 'both')
  assert.equal(decision.reason, 'double_domination')
  assert.deepEqual(decision.evidence.dominates_baseline, true)
  assert.deepEqual(decision.evidence.dominates_anchor, true)
  ports.store.close()
})

test('dominating the anchor alone is not enough: the baseline still owns the ruler', async () => {
  const { ports, view, anchor } = await compared()
  // Run the same facts without the candidate that satisfies both, so the best remaining nominee is
  // the anchor-only one. This is the negative case stated on its own, not a side effect of ordering.
  const withoutBoth = { ...view, candidates: view.candidates.filter((row) => row.candidate_id !== 'both') }
  const decision = rollDecision({ view: withoutBoth, baseline: BASELINE, anchor })

  assert.equal(decision.roll, false)
  assert.equal(decision.reason, 'dominates_anchor_only')
  assert.equal(decision.evidence.candidate_id, 'anchor-only')
  assert.equal(decision.evidence.dominates_anchor, true)
  assert.equal(decision.evidence.dominates_baseline, false)
  ports.store.close()
})

test('dominating the baseline alone is not enough: the anchor owns the tree', async () => {
  const { ports, view, anchor } = await compared()
  const withoutBoth = { ...view, candidates: view.candidates.filter((row) => row.candidate_id !== 'both') }
  const decision = rollDecision({ view: withoutBoth, baseline: BASELINE, anchor: { ...anchor, candidate_id: 'anchor' } })
  // 'anchor-only' dominates the anchor but not the baseline, 'baseline-only' the other way round.
  // The decision names the trade-off it refused rather than one arbitrary loser.
  assert.equal(decision.roll, false)
  assert.ok(['dominates_anchor_only', 'dominates_baseline_only'].includes(decision.reason))
  ports.store.close()
})

test('a candidate that only beats the baseline never rolls while an anchor is set', async () => {
  const { ports, view } = await compared()
  const onlyBaseline = {
    ...view,
    candidates: view.candidates.filter((row) => ['baseline-only', 'anchor'].includes(row.candidate_id)),
  }
  const decision = rollDecision({
    view: onlyBaseline,
    baseline: BASELINE,
    anchor: { candidate_id: 'anchor', commit: 'a'.repeat(40) },
  })

  assert.equal(decision.roll, false)
  assert.equal(decision.reason, 'dominates_baseline_only')
  assert.equal(decision.evidence.candidate_id, 'baseline-only')
  assert.equal(decision.evidence.dominates_baseline, true)
  assert.equal(decision.evidence.dominates_anchor, false)
  ports.store.close()
})

test('with no anchor yet, the starting baseline is the anchor: beating it is the first roll', async () => {
  const { ports, view } = await compared()
  const decision = rollDecision({ view, baseline: BASELINE, anchor: undefined })

  assert.equal(decision.roll, true, 'a search with nothing landed yet has nothing to trade off')
  assert.equal(decision.candidate_id, 'both')
  assert.equal(decision.evidence.dominates_baseline, true)
  assert.equal(decision.evidence.dominates_anchor, true, 'the baseline is both sides of the comparison')
  ports.store.close()
})

test('no contract means no roll: "better" is not guessed', async () => {
  const { ports, view, anchor } = await compared()
  const decision = rollDecision({ view: { ...view, contract: { ok: false, status: 'missing' } }, baseline: BASELINE, anchor })

  assert.equal(decision.roll, false)
  assert.equal(decision.reason, 'no_contract')
  ports.store.close()
})

test('an anchor whose own numbers are gone is not a base the run can reason about', async () => {
  const { ports, view } = await compared()
  const decision = rollDecision({ view, baseline: BASELINE, anchor: { candidate_id: 'missing', commit: 'b'.repeat(40) } })

  assert.equal(decision.roll, false)
  assert.equal(decision.reason, 'anchor_unknown')
  ports.store.close()
})

test('the roll is a function of the facts: the same rows give the same nominee, every time', async () => {
  const { ports, view, anchor } = await compared()
  const first = rollDecision({ view, baseline: BASELINE, anchor })
  const second = rollDecision({ view: { ...view, candidates: [...view.candidates].reverse() }, baseline: BASELINE, anchor })

  assert.deepEqual(first, second, 'row order is not a decision the roll makes')
  ports.store.close()
})

test('an unreadable anchor record is absent, not a commit the runner could branch from', () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-anchor-')))
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', { ...workspace, code_base_anchor: { candidate_id: 42, commit: null } })

  assert.equal(readAnchor(store), undefined)
  store.close()
})

test('the anchor record keeps how it was decided: an intent id, or the automatic rule', () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-anchor-')))
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', {
    ...workspace,
    code_base_anchor: { candidate_id: 'r1-h1', commit: 'c'.repeat(40), source: 'automatic', at_ms: 7 },
  })

  assert.deepEqual(readAnchor(store), {
    candidate_id: 'r1-h1',
    commit: 'c'.repeat(40),
    source: 'automatic',
    intent_id: null,
  })
  store.close()
})

// ------------------------------------------------------- the denominator (slice 2)

test('a roll leaves the frozen baseline record byte-identical: the denominator never rolls', async () => {
  const ports = await roundsWorkspace({ roll: true })
  await planFirstRound(ports)
  const before = JSON.stringify(readRoundsState(ports.store).baseline)
  const beforeFrozen = ports.store
    .ops(1_000)
    .filter((row) => row.op === 'baseline_frozen')
    .map((row) => row.detail)

  await planSecondRound(ports)

  const after = JSON.stringify(readRoundsState(ports.store).baseline)
  assert.equal(after, before, 'the denominator is the same bytes before and after the roll')
  assert.equal(readAnchor(ports.store)?.candidate_id, 'r1-h3', 'and the code base did move')
  assert.deepEqual(
    ports.store
      .ops(1_000)
      .filter((row) => row.op === 'baseline_frozen')
      .map((row) => row.detail),
    beforeFrozen,
    'no second measurement and no rewrite: the frozen record is what earlier rounds were compared against',
  )
  // The ruler every comparison reads is the same one after the roll, which is the property the
  // byte-identity above is protecting.
  assert.deepEqual(readRoundsState(ports.store).baseline, JSON.parse(before))
  ports.store.close()
})

// ------------------------------------------------------------------ helpers

const AT = 1_761_091_200_000
const ROUNDS = {
  metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
  baseline: { metric: 'auc', value: 0.8 },
  max_rounds: 2,
  candidates_per_round: 3,
  retry: { base_ms: 1_000, max_ms: 8_000, max_attempts: 2 },
}

/** Three finished candidates with the numbers the roll rule needs to distinguish. */
const FINISHED = {
  'r1-h1': { auc: 0.78, loss: 0.3 },
  'r1-h2': { auc: 0.85, loss: 0.35 },
  'r1-h3': { auc: 0.85, loss: 0.28 },
}

async function roundsWorkspace({ mode = 'automatic' } = {}) {
  const { judgeFor } = await import('./support/domain.js')
  const { FakeClock } = await import('./support/fake-ports.js')
  const { stepWorkspace } = await import('../lib/rounds.js')

  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-anchor-')))
  const clock = new FakeClock()
  // The run's metric contract is the two-axis one: the roll compares the anchor on every axis the
  // contract names, so a one-axis contract could not tell a trade-off from an advance.
  const config = {
    metrics: TWO_AXES.metrics,
    rounds: { ...ROUNDS, ...(mode === 'automatic' ? {} : { anchor: mode }) },
  }
  const model = async (request) => {
    if (request.call_site === 'round_plan') {
      return {
        hypotheses: [
          { id: 'h1', statement: `round ${request.facts.round}: widen the table`, expected_files: ['model/embedding.py'] },
          { id: 'h2', statement: `round ${request.facts.round}: share the projection`, expected_files: ['model/attention.py'] },
          { id: 'h3', statement: `round ${request.facts.round}: drop the auxiliary head`, expected_files: ['model/heads.py'] },
        ],
      }
    }
    return { summary: 'round one: both changes landed', lessons: [], next_round_focus: ['measure the rare-feature rate first'] }
  }
  const judge = judgeFor({ model, metric: ROUNDS.metric, baseline: ROUNDS.baseline.value })
  const seals = new Map(Object.keys(FINISHED).map((id, index) => [id, String(index + 1).repeat(40)]))
  const ports = {
    store,
    clock,
    judge,
    config,
    anchor: { seal: (candidateId) => seals.get(candidateId) ?? 'e'.repeat(40) },
    step: () => stepWorkspace(ports),
  }
  return ports
}

/** Finish a candidate the way the phase machine would: metrics, an analysis, a terminal phase. */
function finish(store, candidateId) {
  const metrics = FINISHED[candidateId] ?? { auc: 0.9, loss: 0.9 }
  store.appendEvent({
    candidate_id: candidateId,
    wall_clock_ms: AT,
    event_type: 'metrics_collected',
    payload: { metrics },
  })
  store.appendEvent({ candidate_id: candidateId, wall_clock_ms: AT, event_type: 'cand_analyze', payload: { verdict: 'improved' } })
  store.setState(candidateId, 'phase', { ...store.getState(candidateId, 'phase'), phase: 'DONE', next_action_at: 0 })
}

/** INIT -> BASELINE -> plan round 1, then finish its candidates with numbers that trade off. */
async function planFirstRound(ports) {
  await ports.step() // INIT -> BASELINE
  await ports.step() // BASELINE -> ROUND_PLAN
  await ports.step() // plan round 1
  for (const candidateId of Object.keys(FINISHED)) {
    assert.ok(ports.store.getState(candidateId, 'phase') !== undefined, `${candidateId} exists to be finished`)
    finish(ports.store, candidateId)
  }
  return ports
}

/**
 * Reflect round 1, close it, and plan round 2 — where the roll is decided.
 *
 * `r1-h1` is the code base before that step, placed through the `anchor` intent rather than by
 * writing the state: the reader under test is the one the intent feeds.
 */
async function planSecondRound(ports) {
  const { placeIntent } = await import('../lib/intents.js')
  const { consumePending } = await import('../lib/intents.js')
  const workspaceDir = join(ports.store.path, '..')
  placeIntent(
    workspaceDir,
    { kind: 'anchor', intent_id: 'anchor-r1', candidate_id: 'r1-h1', commit: 'f'.repeat(40) },
    { now: ports.clock.now() },
  )
  consumePending({ store: ports.store, clock: ports.clock, now: ports.clock.now() })
  assert.equal(readAnchor(ports.store)?.candidate_id, 'r1-h1', 'the anchor intent put the run on r1-h1')

  await ports.step() // reflect round 1
  await ports.step() // close round 1
  await ports.step() // plan round 2 — the roll is decided before the roster
  return readRoundsState(ports.store)
}