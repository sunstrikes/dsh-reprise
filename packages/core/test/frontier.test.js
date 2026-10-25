/**
 * Guards the decision "the frontier is the non-dominated set, not the list of candidates" (issue 22,
 * CONTEXT.md §11). Three things must stay true, and each has failed in a design that folded every
 * candidate into one sorted list and called it a frontier:
 *
 *   - it can hold several candidates that trade one objective against another, and it must drop the
 *     ones something else beats everywhere;
 *   - it can be empty *of candidates*, and the baseline row is in it regardless — that row is what
 *     parent selection falls back to when no candidate is worth continuing from;
 *   - `best` stays a row of the ranking, decided on the primary metric. It is not a verdict about
 *     the set: a candidate can be on the frontier and not be best, and `best` must not move because
 *     a frontier was computed.
 *
 * Same inputs must give the same set in the same order — no clock, no random, no map-order.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { frontierOf } from '../lib/frontier.js'
import { ranking } from '../lib/ranking.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

const config = (objectives) => ({ metrics: { primary: Object.keys(objectives)[0], objectives } })
const TWO_AXES = config({ auc: 'up', loss: 'down' })
/** The baseline every run freezes before its first round: the number candidates must beat. */
const BASELINE = { metric: 'auc', value: 0.7012 }

const ids = (members) => members.map((member) => member.candidate_id)

test('the frontier keeps the candidates that trade one objective against another, and drops the beaten one', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.72, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.75, loss: 0.4 } })
  // c1 beats c3 on both axes: higher auc, lower loss. Nothing trades there.
  await runCandidate(ports, { candidateId: 'c3', metrics: { auc: 0.7, loss: 0.35 } })

  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(ids(set.members), ['baseline', 'c1', 'c2'], 'two trade-offs, the baseline, and no c3')
  assert.equal(set.empty, false)
  assert.deepEqual(set.dominated, [{ candidate_id: 'c3', dominated_by: 'c1' }], 'the set says who removed c3, so a dump can explain it')
  ports.store.close()
})

test('a frontier with no comparable candidate still holds the baseline, and says so', async () => {
  const ports = openWorkspace()
  // A two-axis contract and a candidate that measured only one axis: incomplete, so it cannot be
  // compared and it cannot be on the set. This is a real state — a job that reported the primary and
  // nothing else — and the honest answer is "the frontier is the baseline only", not "c1 is on it".
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.99 } })

  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(ids(set.members), ['baseline'], 'the baseline is in the frontier even when no candidate is')
  assert.equal(set.empty, true, 'empty means "no candidate on the set", which parent selection reads as "start over"')
  assert.deepEqual(set.baseline.vector, { auc: 0.7012 }, 'the baseline row carries the frozen number, so it can be compared later')
  ports.store.close()
})

test('a workspace with no facts at all is an empty set plus the baseline, not a crash', async () => {
  const ports = openWorkspace()

  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(ids(set.members), ['baseline'])
  assert.equal(set.empty, true)
  ports.store.close()
})

test('the baseline is never removed, even when every candidate beats it on the primary metric', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.9, loss: 0.3 } })

  const set = frontierOf(ranking(ports.store, TWO_AXES), { baseline: BASELINE })

  assert.deepEqual(ids(set.members), ['baseline', 'c1'], 'a frontier that dropped its own reference point could not say "no improvement"')
  ports.store.close()
})

test('best stays a row of the ranking: the frontier names a set, and never a winner', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.72, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.75, loss: 0.4 } })

  const view = ranking(ports.store, TWO_AXES)
  const before = view.best
  const set = frontierOf(view, { baseline: BASELINE })

  assert.deepEqual(ids(set.members), ['baseline', 'c1', 'c2'])
  assert.equal('best' in set, false, 'a set with a winner in it is a ranking again — the two words would collide')
  assert.equal(set.members.filter((member) => member.candidate_id !== 'baseline').length, 2)
  assert.deepEqual(
    { ...ranking(ports.store, TWO_AXES).best },
    { ...before },
    'computing a frontier cannot move the best candidate: best is decided on the primary metric alone',
  )
  assert.equal(view.best.candidate_id, 'c2', 'the primary decides, even though c1 is also on the set')
  ports.store.close()
})

test('the same non-dominated set twice is the same list, in the same order, whatever order the rows arrive in', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.72, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.75, loss: 0.4 } })

  const view = ranking(ports.store, TWO_AXES)
  const first = frontierOf(view, { baseline: BASELINE })
  const again = frontierOf(view, { baseline: BASELINE })
  const reversed = frontierOf({ ...view, candidates: [...view.candidates].reverse() }, { baseline: BASELINE })

  assert.deepEqual(ids(once(first)), ids(once(again)), 'two calls over one set of facts must agree')
  assert.deepEqual(ids(once(first)), ids(once(reversed)), 'the order of the input rows is not a decision this set makes')
  ports.store.close()
})

/** Members as plain data: two sets are only "the same" if their rows are, not just their ids. */
const once = (set) => JSON.parse(JSON.stringify(set.members))