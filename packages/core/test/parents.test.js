/**
 * Guards the decision "a round starts from chosen parents, not from the same base ref N times"
 * (issue 22; parity gap 2B). The predecessor's shape, kept because it is the one that survives a
 * multi-objective frontier: take the top k on *each* objective axis, union them in round-robin
 * order, and fall back to the baseline when nothing is worth continuing from.
 *
 * What must not creep in: a single sort. Two candidates that trade one objective against another
 * must both reach the roster, or the run silently drops the axis nobody made primary. And the
 * roster must be a function of the set alone — two calls over the same non-dominated set give the
 * same parents in the same order, or "which round started from whom" stops being an answerable
 * question.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BASELINE_ID, frontierOf, parentsOf } from '../lib/frontier.js'
import { ranking } from '../lib/ranking.js'
import { createCandidate } from '../lib/loop.js'
import { AT, openWorkspace, runCandidate } from './support/fake-ports.js'

const config = (objectives) => ({ metrics: { primary: Object.keys(objectives)[0], objectives } })
const TWO_AXES = config({ auc: 'up', loss: 'down' })
const BASELINE = { metric: 'auc', value: 0.5 }

/**
 * Three candidates that trade against each other, so no axis can be dropped:
 *   auc (up):  p1 0.80 > p3 0.75 > p2 0.70
 *   loss (down): p2 0.30 < p3 0.40 < p1 0.50
 */
async function tradingWorkspace() {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'p1', metrics: { auc: 0.8, loss: 0.5 } })
  await runCandidate(ports, { candidateId: 'p2', metrics: { auc: 0.7, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'p3', metrics: { auc: 0.75, loss: 0.4 } })
  return ports
}

test('parents are the top k on each objective axis, taken in round-robin order', async () => {
  const ports = await tradingWorkspace()
  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(set.members.map((member) => member.candidate_id), ['baseline', 'p1', 'p2', 'p3'])
  assert.deepEqual(parentsOf(set, { k: 2 }), ['p1', 'p2'], 'the best auc and the best loss both lead the roster')
  assert.deepEqual(parentsOf(set, { k: 3 }), ['p1', 'p2', 'p3'], 'the second round of the rotation adds the compromise candidate')
  assert.deepEqual(parentsOf(set, { k: 9 }), ['p1', 'p2', 'p3'], 'asking for more parents than exist never invents one or repeats one')
  ports.store.close()
})

test('a one-axis contract ranks on that axis alone — the rotation has one list', async () => {
  const ports = await tradingWorkspace()
  const set = frontierOf(ranking(ports.store, config({ auc: 'up' })), { baseline: BASELINE })

  assert.deepEqual(
    set.members.map((member) => member.candidate_id),
    ['baseline', 'p1'],
    'one axis means one non-dominated candidate: the maximum. The other two are dominated on the only number there is.',
  )
  assert.deepEqual(parentsOf(set, { k: 2 }), ['p1'], 'a one-axis roster cannot invent a second name to fill k')
  assert.deepEqual(parentsOf(set, { k: 1 }), ['p1'])
  ports.store.close()
})

test('the rotation can start on a different axis, and says so by changing who leads', async () => {
  const ports = await tradingWorkspace()
  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(parentsOf(set, { k: 1, offset: 1 }), ['p2'], 'rotated to the loss axis first: the lowest loss leads')
  assert.deepEqual(parentsOf(set, { k: 2, offset: 1 }), ['p2', 'p1'], 'and the auc axis follows in the same rotation')
  ports.store.close()
})

test('with no candidate worth continuing from, the round starts from the baseline', async () => {
  const ports = openWorkspace()
  createCandidate(ports, { candidateId: 'bad', round: 1, hypothesis: 'widen the embedding table' })
  ports.store.appendEvent({
    candidate_id: 'bad',
    wall_clock_ms: AT,
    event_type: 'metrics_collected',
    payload: { metrics: { auc: 0.1, loss: 0.9 } },
  })
  ports.store.appendEvent({
    candidate_id: 'bad',
    wall_clock_ms: AT,
    event_type: 'candidate_rejected',
    payload: { phase: 'VERIFY', reject_reason: 'the adversarial review rejected it' },
  })

  // A rejected candidate is still non-dominated on its own numbers when nothing else exists — but
  // its change is not a base ref, so it is not a parent.
  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })
  assert.equal(set.members.some((member) => member.candidate_id === 'bad'), true, 'the set is about numbers, not verdicts')

  assert.deepEqual(parentsOf(set, { k: 2 }), [BASELINE_ID], 'a rejected change is never continued from')
  ports.store.close()
})

test('a workspace with no candidate at all still yields one parent: the baseline', async () => {
  const ports = openWorkspace()
  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(parentsOf(set, { k: 4 }), [BASELINE_ID])
  ports.store.close()
})

test('the same non-dominated set twice gives the same parents, whatever order the rows arrive in', async () => {
  const ports = await tradingWorkspace()
  const view = ranking(ports.store, TWO_AXES)
  const set = frontierOf(view, { baseline: BASELINE })
  const reversed = frontierOf({ ...view, candidates: [...view.candidates].reverse() }, { baseline: BASELINE })

  assert.deepEqual(parentsOf(set, { k: 3 }), parentsOf(set, { k: 3 }))
  assert.deepEqual(parentsOf(set, { k: 3 }), parentsOf(reversed, { k: 3 }), 'input row order is not a decision the roster makes')
  ports.store.close()
})

test('k must be a positive integer: a roster of nothing is a bug at the call site, not an answer', async () => {
  const ports = openWorkspace()
  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.throws(() => parentsOf(set, { k: 0 }), TypeError)
  assert.throws(() => parentsOf(set, { k: 1.5 }), TypeError)
  assert.throws(() => parentsOf(set, {}), TypeError)
  ports.store.close()
})