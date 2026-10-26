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
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

test('the rounds projection publishes the step series and one shape per candidate, for the rail', async () => {
  // The rail draws one square per candidate and a step per round, and it must not decide either for
  // itself: "which shape is this candidate" is a reading of facts (a status, the frontier, the
  // four-state verdict), and a renderer that derived it would disagree with `dump` the first time
  // either side changed. So the roadmap is published here, as data.
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } }) // completes, and leads
  await runCandidate(ports, { candidateId: 'r1-c2', round: 1, metrics: { auc: 0.69 } }) // completes, dominated
  // Round 2: one candidate whose artifact is present but malformed, one whose artifact never landed.
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, judge: fakeJudge({ verify: ({ candidateId, now }) => ({ candidate_id: candidateId, passed: 'yes-please', checks: [], decided_at_ms: now }) }) })
  // Round 4: a round with a real result that lost, so "held" is covered too.
  await runCandidate(ports, { candidateId: 'r4-c1', round: 4, metrics: { auc: 0.68 } })
  // The two states no executor run produces on demand are written as facts directly, and only after
  // every kernel-driven candidate is done: a later tick would otherwise pick them up and finish them.
  createCandidate(ports, { candidateId: 'r2-c2', round: 2, hypothesis: 'left the artifact behind' })
  ports.store.appendEvent({
    candidate_id: 'r2-c2',
    wall_clock_ms: ports.clock.now(),
    event_type: 'candidate_rejected',
    payload: { phase: 'MONITOR_POLL', status: 'missing', blocking_message: 'the metrics artifact is not there' },
  })
  // Round 5: created and still running.
  createCandidate(ports, { candidateId: 'r5-c1', round: 5, hypothesis: 'still in flight' })

  const lines = rounds(ports.store, { config: ports.config })
  const shapes = Object.fromEntries(
    lines.flatMap((line) => line.candidates.map((candidate) => [candidate.candidate_id, candidate.shape])),
  )

  assert.deepEqual(shapes, {
    'r1-c1': 'frontier',
    'r1-c2': 'done',
    'r2-c1': 'invalid',
    'r2-c2': 'rejected',
    'r4-c1': 'done',
    'r5-c1': 'in-flight',
  })
  assert.deepEqual(
    lines.map((line) => ({ round: line.round, verdict: line.verdict, after: line.cumulative?.value })),
    [
      { round: 1, verdict: 'raised', after: 0.7 },
      { round: 2, verdict: 'empty', after: 0.7 },
      { round: 4, verdict: 'held', after: 0.7 },
      { round: 5, verdict: 'empty', after: 0.7 },
    ],
    'the step series is the best standing after each round, and the word for how the round ended',
  )
  assert.equal(
    lines.flatMap((line) => line.candidates).find((candidate) => candidate.candidate_id === 'r2-c2').verdict,
    'missing',
    'the four-state name travels with the shape, because a shape is a coarse read of it',
  )
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

test('the conclusion publishes the frame the staircase draws in: the baseline, and the axis it spans', async () => {
  // The chart needs three things it must not derive: where the INIT line sits, how tall the axis is,
  // and what the three axis labels say. All three come from one place, so the numbers on the page and
  // the numbers a reader takes away cannot be two derivations of the same fact.
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.72 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7201 } })
  await runCandidate(ports, { candidateId: 'r3-c1', round: 3, metrics: { auc: 0.7401 } })
  writeFileSync(join(dirname(ports.store.path), 'baseline.json'), JSON.stringify({ metric: 'auc', value: 0.71 }))

  const ladder = conclusion(ports.store, { config: ports.config }).ladder

  assert.equal(ladder.metric, 'auc')
  assert.deepEqual(ladder.baseline, { value: 0.71, metric: 'auc' }, 'the INIT line is the frozen baseline, with its number')
  assert.equal(ladder.baselineAbsent, null)
  // The axis spans every value the chart can draw (0.71 … 0.7401 = 0.0301) and pads it by 18% at each
  // end, so a step never sits on the frame (spec §6.4). 0.0301 * 0.18 = 0.005418.
  assert.deepEqual(ladder.axis, { top: 0.745518, middle: 0.72505, bottom: 0.704582 })
  assert.deepEqual(
    ladder.rounds.map((entry) => ({ round: entry.round, verdict: entry.verdict, after: entry.cumulative.value })),
    [
      { round: 1, verdict: 'raised', after: 0.72 },
      { round: 2, verdict: 'raised', after: 0.7201 },
      { round: 3, verdict: 'raised', after: 0.7401 },
    ],
    'and the series it draws is one row per round',
  )
  ports.store.close()
})

test('a run that recorded no baseline draws no line, and says the baseline was not recorded', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.72 } })

  const ladder = conclusion(ports.store, { config: ports.config }).ladder

  assert.equal(ladder.baseline, null, 'a missing baseline is not zero and not the first candidate — it is absent')
  assert.match(ladder.baselineAbsent, /no frozen baseline/i, 'and the legend can say so in words')
  assert.deepEqual(ladder.axis, { top: 0.7236, middle: 0.71, bottom: 0.6964 }, 'the axis still spans the candidates')
  ports.store.close()
})

test('a run with nothing comparable publishes no axis at all, so the page draws only the rail', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  await runCandidate(ports, {
    candidateId: 'r1-c1',
    round: 1,
    judge: fakeJudge({ verify: () => ({ candidate_id: 'r1-c1', passed: 'no' }) }),
  })

  const ladder = conclusion(ports.store, { config: ports.config }).ladder

  assert.equal(ladder.axis, null, 'there is no value to put on a y-axis, so there is no axis')
  assert.match(ladder.axisAbsent, /no comparable auc/i, 'and the page can say what is missing instead of drawing an empty box')
  assert.equal(ladder.rounds.length, 1, 'the rounds are still published — the rail is the part that survives')
  assert.equal(ladder.rounds[0].empty, true)
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