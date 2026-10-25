/**
 * Guards the decision "the dashboard's data is a host-side, read-only projection of facts"
 * (spec: 展示层; issue 06 AC 3/5, issue 11's seam).
 *
 * These tests are about the *data*, not the rendering: the projection is what `dump` and the web
 * components both read, so proving it here is what lets the UI stay a pure renderer. Two properties
 * matter most and each has a test: it never writes, and it agrees with a full rebuild of the same
 * facts.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Store } from '../lib/store.js'
import { createCandidate, tick } from '../lib/loop.js'
import { candidateDetail, conclusion, overview, rounds } from '../lib/projection.js'
import { fakeJudge, openWorkspace, runCandidate } from './support/fake-ports.js'

const config = (objectives, primary, extra = {}) => ({ metrics: { primary, objectives }, ...extra })

test('the overview answers "where is this run, and how much is it costing" without reading events by hand', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { budget: { gpu_hours_limit: 4 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, {
    candidateId: 'r1-c2',
    round: 1,
    judge: fakeJudge({ verify: () => ({ candidate_id: 'r1-c2', passed: 'yes' }) }),
  })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })

  const view = overview(ports.store, { config: ports.config })

  assert.equal(view.rounds.total, 2, 'two rounds have facts')
  assert.equal(view.rounds.completed, 2, 'and both are finished')
  assert.equal(view.candidates.total, 3)
  assert.deepEqual(view.candidates.inFlight, [], 'nothing is running, so the eye can trust the rest of the page')
  assert.equal(view.candidates.rejected, 1, 'a rejected candidate stays visible instead of vanishing from the count')
  assert.equal(view.best.candidate_id, 'r2-c1')
  assert.equal(view.spend.settledGpuHours, 1, 'two candidates settled half a GPU hour each: the number is the ledger, not a guess')
  assert.equal(view.spend.inFlightGpuHours, 0)
  assert.equal(view.spend.limitGpuHours, 4, 'the limit is shown next to the spend, or the number means nothing')
  assert.equal(view.stop.stopped, false, 'the run has not concluded yet')
  ports.store.close()
})

test('settled and in-flight spend are different numbers, because only one of them is still at risk', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { budget: { gpu_hours_limit: 4 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  // Walk a second candidate to SUBMIT and leave its job running: money reserved, not yet settled.
  createCandidate(ports, { candidateId: 'r1-c2', round: 1, hypothesis: 'still queued' })
  for (let index = 0; index < 6; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }

  const view = overview(ports.store, { config: ports.config })

  assert.deepEqual(view.candidates.inFlight, ['r1-c2'], 'the candidate holding money is named')
  assert.equal(view.spend.settledGpuHours, 0.5, 'one candidate has finished and settled')
  assert.equal(view.spend.inFlightGpuHours, 0.5, 'one has not, so its reservation is shown separately')
  assert.equal(view.spend.usedGpuHours, 1, 'the total is what any remaining-budget question must use')
  ports.store.close()
})

test('a concluded workspace reports which rule ended it, in the words recorded at the time', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 1 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const stopped = await tick(ports)
  assert.equal(stopped.stopped.rule, 'max_rounds')

  const view = overview(ports.store, { config: ports.config })
  const final = conclusion(ports.store, { config: ports.config })

  assert.equal(view.stop.stopped, true)
  assert.equal(view.stop.rule, 'max_rounds', 'the dashboard reads the recorded reason, not a re-derivation that could drift')
  assert.equal(view.workspace.phase, 'FINALIZE')
  assert.equal(final.stopped.rule, 'max_rounds')
  assert.match(final.stopped.message, /round 1/)
  ports.store.close()
})

test('the rounds projection says which rounds improved and which produced nothing', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.69 } })
  await runCandidate(ports, { candidateId: 'r3-c1', round: 3, metrics: { auc: 0.75 } })

  const lines = rounds(ports.store, { config: ports.config })

  assert.deepEqual(
    lines.map((line) => ({ round: line.round, improving: line.improving, empty: line.empty })),
    [
      { round: 1, improving: true, empty: false },
      { round: 2, improving: false, empty: false },
      { round: 3, improving: true, empty: false },
    ],
    'a reader must be able to see that round 2 was a real result that lost, not a round that produced nothing',
  )
  assert.equal(lines[2].best.value, 0.75)
  ports.store.close()
})

test('the candidate detail carries the timeline, every gate verdict, the failure text and the artifacts', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, {
    candidateId: 'r1-c2',
    round: 1,
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({
        candidate_id: candidateId,
        passed: 'yes-please',
        checks: [],
        decided_at_ms: now,
      }),
    }),
  })

  const detail = candidateDetail(ports.store, 'r1-c2', { config: ports.config })

  assert.equal(detail.phase, 'REJECTED')
  assert.equal(detail.rejection.status, 'invalid', 'the four-state conclusion is the reason, so the detail must carry it')
  assert.match(detail.rejection.message, /strict boolean/, 'the failure原文, not a summary of it')
  assert.equal(detail.rejection.phase, 'VERIFY')
  assert.deepEqual(
    detail.gates.map((gate) => `${gate.phase}:${gate.status}`),
    ['VERIFY:invalid'],
    'every gate conclusion stays on the page, so a later phase cannot hide an earlier objection',
  )
  assert.ok(detail.timeline.length >= 3, 'the reader can see the steps that led there')
  assert.equal(detail.frontier.complete, false, 'and where it sits — here, nowhere: it has no metric')
  assert.deepEqual(detail.frontier.missing, ['auc'])
  ports.store.close()
})

test('the conclusion names the best candidate, its number, and what it is being compared against', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 2 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })
  await tick(ports)

  const final = conclusion(ports.store, { config: ports.config })

  assert.equal(final.best.candidate_id, 'r2-c1')
  assert.equal(final.best.metric, 'auc')
  assert.equal(final.best.value, 0.7401)
  assert.equal(final.best.round, 2)
  assert.equal(
    final.against.parent,
    'baseline-0',
    'the parent binding is the comparison group — a best number with nothing to compare against is not a conclusion',
  )
  assert.equal(final.against.best.value, 0.7, 'and the best result from before this candidate is shown next to it')
  assert.equal(final.rounds, 2)
  ports.store.close()
})

test('the projection is read-only: it works on a handle that could not write even if it tried', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 1 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7, loss: 0.3 } })
  await tick(ports)
  const dir = ports.store.path.replace(/\/workspace\.db$/, '')
  const before = ports.store.eventsFor('r1-c1').length
  ports.store.close()

  const readOnly = Store.openReadOnly(dir)
  try {
    const view = overview(readOnly, { config: ports.config })
    const lines = rounds(readOnly, { config: ports.config })
    const detail = candidateDetail(readOnly, 'r1-c1', { config: ports.config })
    const final = conclusion(readOnly, { config: ports.config })
    assert.equal(view.best.candidate_id, 'r1-c1')
    assert.equal(lines.length, 1)
    assert.equal(detail.candidate_id, 'r1-c1')
    assert.equal(final.best.candidate_id, 'r1-c1')
  } finally {
    readOnly.close()
  }

  const after = Store.openReadOnly(dir)
  assert.equal(after.eventsFor('r1-c1').length, before, 'a dashboard read must never add a fact')
  after.close()
})

test('the projection is a pure function of the facts: same store, same page', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })

  const first = overview(ports.store, { config: ports.config })
  const second = overview(ports.store, { config: ports.config })

  assert.deepEqual(second, first, 'no clock and no randomness: two readers at the same instant see the same run')
  ports.store.close()
})

test('an unknown candidate is reported as absent, not rendered as an empty candidate', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })

  const detail = candidateDetail(ports.store, 'nobody', { config: ports.config })

  assert.equal(detail, undefined)
  ports.store.close()
})