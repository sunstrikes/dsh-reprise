/**
 * Guards the three stop rules ticket 21 adds (spec §相位机 "判停条件一律在代码里算", §Testing Decisions
 * "判停是纯函数加表驱动测试"; parity-gap §2A's priority order).
 *
 * The seam is `decideStop`: a pure function over facts (the frontier view, the round history), the
 * window samples, the resolved metric contract, and an injected clock. No store, no model, no I/O —
 * which is what makes "a model's claim can neither lengthen nor shorten a run" an assertion about
 * this function's inputs rather than a promise about its callers.
 *
 * One failing case per rule, because a rule that only ever passes is a rule nobody has seen work:
 *
 *   1. **the last window has no finite number** → the candidate dies *now*, with the reason
 *      `evidence_invalid` and **no four-state status** (CODING_STANDARDS §2: the artifact was fine,
 *      the number was absent);
 *   2. **per-metric regression** over the trailing N windows, with a tolerance floor that may only
 *      raise a tolerance and never lower one;
 *   3. **wall-clock timeout / window ceiling** are *workspace* conclusions recorded on `_workspace`,
 *      which is a different conclusion from rejecting one candidate.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideStop, stopConfig, WORKSPACE_SUBJECT } from '../lib/stop.js'
import { tick } from '../lib/loop.js'
import { resolveMetricContract } from '../lib/metric-contract.js'
import { BASELINE_SUBJECT } from '../lib/baseline.js'
import { memoryArtifacts } from '../lib/artifacts.js'
import { recordWindowSamples } from '../lib/samples.js'
import { renderDump } from '../lib/cli/dump.js'
import { openWorkspace, reportOf, runCandidate } from './support/fake-ports.js'
import { windowSeries } from './support/samples.js'

/** auc up, logloss down, one tolerance for both: the contract every case starts from. */
const CONTRACT = resolveMetricContract({
  name: 'auc',
  primary: 'auc',
  objectives: { auc: 'up', logloss: 'down' },
  minimum_effective_delta: { auc: 0.01, logloss: 0.01 },
})

/** The denominator: three windows, flat, so a candidate's own series decides the comparison. */
const BASELINE = windowSeries([
  [0, 0, 10, { auc: 0.7, logloss: 0.6 }],
  [1, 10, 20, { auc: 0.7, logloss: 0.6 }],
  [2, 20, 30, { auc: 0.7, logloss: 0.6 }],
])

/** A candidate series from `[metrics, metrics, …]` over the same three windows as the baseline. */
const candidateSeries = (rows) => windowSeries(rows.map((metrics, index) => [index, index * 10, (index + 1) * 10, metrics]))

/** Facts in the shape `decideStop` takes, so each table row is one line of data. */
const facts = ({ stop = {}, candidates = [], samples = {}, now = 0, startedAt = 0, contract = CONTRACT }) => ({
  limits: stopConfig({ stop }),
  view: {
    contract,
    best: undefined,
    candidates: candidates.map((candidate) => ({ status: 'done', complete: true, round: 1, ...candidate })),
  },
  rounds: [],
  contract,
  samples,
  now,
  startedAt,
})

const killOf = (decision) => decision.kills[0]

// ----------------------------------------------------------------- 1. evidence invalid

test('a candidate whose last window has no finite number is killed, with a reason and no four-state status', () => {
  const cases = [
    { name: 'the last window does not measure the deciding metric at all', last: {}, killed: true },
    { name: 'the last window measures it as NaN — a parser failure is not a number', last: { auc: Number.NaN }, killed: true },
    { name: 'the last window measures it as Infinity', last: { auc: Number.POSITIVE_INFINITY }, killed: true },
    { name: 'the last window measured only the guardrail, not the metric that decides', last: { logloss: 0.5 }, killed: true },
    { name: 'the last window holds a finite number', last: { auc: 0.71 }, killed: false },
  ]

  for (const { name, last, killed } of cases) {
    const decision = decideStop(
      facts({
        candidates: [{ candidate_id: 'c1', phase: 'DONE' }],
        samples: {
          baseline: BASELINE,
          candidates: { c1: candidateSeries([{ auc: 0.7 }, { auc: 0.72 }, last]) },
        },
      }),
    )

    if (!killed) {
      assert.deepEqual(decision.kills, [], `${name}: a finite last window is evidence, so nothing is killed`)
      continue
    }
    const kill = killOf(decision)
    assert.equal(kill.candidate_id, 'c1', `${name}: the candidate with the unusable tail is the one that dies`)
    assert.equal(kill.rule, 'last_window_unmeasured', name)
    assert.equal(kill.reason, 'evidence_invalid', `${name}: the reason is "证据无效", and it is a reason, not a status`)
    assert.equal('status' in kill, false, `${name}: nothing was malformed, so no four-state status (CODING_STANDARDS §2)`)
    assert.match(kill.message, /last window/, `${name}: the fact explains which window said nothing`)
  }
})

test('a candidate with no window samples at all is not killed for invalid evidence', () => {
  const decision = decideStop(
    facts({ candidates: [{ candidate_id: 'c1', phase: 'DONE' }], samples: { baseline: BASELINE, candidates: {} } }),
  )

  assert.deepEqual(decision.kills, [], 'no evidence is a missing measurement, not an invalid one')
})

test('an unfinished candidate is never killed for a tail that is still being written', () => {
  const decision = decideStop(
    facts({
      candidates: [{ candidate_id: 'c1', phase: 'MONITOR_POLL', status: 'active', complete: false }],
      samples: { candidates: { c1: candidateSeries([{ auc: 0.7 }, { auc: 0.72 }, {}]) } },
    }),
  )

  assert.deepEqual(decision.kills, [], 'a running candidate keeps writing; "no last value yet" is not a verdict')
  assert.deepEqual(decision.blocked_by, ['c1'], 'and the decision names what it is waiting for')
})

// ----------------------------------------------------------------- 2. regression overlay

test('a metric that is worse than the baseline in the trailing N windows kills; N-1 does not', () => {
  const cases = [
    { name: 'three trailing windows beyond the tolerance, N=3', aucs: [0.68, 0.68, 0.68], n: 3, killed: true, windows: 3 },
    { name: 'two trailing windows beyond the tolerance is not yet N=3', aucs: [0.68, 0.68, 0.68], n: 4, killed: false },
    { name: 'a last window that came back resets the streak', aucs: [0.68, 0.68, 0.7], n: 2, killed: false },
    { name: 'a drop inside the contract tolerance is noise, not a regression', aucs: [0.695, 0.695, 0.695], n: 2, killed: false },
    { name: 'a metric missing from a window breaks the run of windows', aucs: [0.68, {}, 0.68], n: 2, killed: false },
    { name: 'N is a count of trailing windows, not the whole series', aucs: [0.68, 0.68, 0.68], n: 2, killed: true, windows: 3 },
  ]

  for (const { name, aucs, n, killed, windows } of cases) {
    const decision = decideStop(
      facts({
        stop: { regression_windows: n },
        candidates: [{ candidate_id: 'c1', phase: 'DONE' }],
        samples: { baseline: BASELINE, candidates: { c1: candidateSeries(aucs.map((auc) => ({ auc }))) } },
      }),
    )

    if (!killed) {
      assert.deepEqual(decision.kills, [], name)
      continue
    }
    const kill = killOf(decision)
    assert.equal(kill.rule, 'metric_regression', name)
    assert.equal(kill.metric, 'auc', `${name}: the kill names the metric that regressed`)
    assert.equal(kill.windows, windows, `${name}: and how many trailing windows carried it`)
    assert.equal(kill.limit, n, `${name}: the limit that fired is recorded, not just "we killed it"`)
    assert.equal('status' in kill, false, `${name}: a regression is news, not a malformed artifact`)
  }
})

test('a guardrail going backwards is a regression too, in its own direction', () => {
  const decision = decideStop(
    facts({
      stop: { regression_windows: 2 },
      candidates: [{ candidate_id: 'c1', phase: 'DONE' }],
      samples: {
        baseline: BASELINE,
        candidates: { c1: candidateSeries([{ auc: 0.71, logloss: 0.66 }, { auc: 0.71, logloss: 0.66 }, { auc: 0.71, logloss: 0.66 }]) },
      },
    }),
  )

  const kill = killOf(decision)
  assert.equal(kill.metric, 'logloss', 'auc improved while logloss regressed: the ranked metric that went backwards is named')
  assert.equal(kill.direction, 'down', 'and the direction it went backwards in')
})

test('a candidate with no baseline to be worse than is not killed for regressing', () => {
  const decision = decideStop(
    facts({
      stop: { regression_windows: 2 },
      candidates: [{ candidate_id: 'c1', phase: 'DONE' }],
      samples: { candidates: { c1: candidateSeries([{ auc: 0.6 }, { auc: 0.6 }, { auc: 0.6 }]) } },
    }),
  )

  assert.deepEqual(decision.kills, [], 'no denominator, no comparison, no regression — and nothing malformed about it')
})

// ----------------------------------------------------------------- 3. the tolerance floor

test('a tolerance floor may raise a tolerance, and can never lower one', () => {
  const cases = [
    {
      name: 'no floor: a 0.03 drop is beyond the declared 0.01 tolerance',
      floor: undefined,
      aucs: [0.67, 0.67, 0.67],
      killed: true,
      tolerance: 0.01,
      refused: false,
    },
    {
      name: 'a floor of 0.05 raises the tolerance, so the same drop is within it',
      floor: 0.05,
      aucs: [0.67, 0.67, 0.67],
      killed: false,
      tolerance: 0.05,
      refused: false,
    },
    {
      name: 'a floor below the declared tolerance is refused: it would have loosened 0.01 to 0.001',
      floor: 0.001,
      aucs: [0.695, 0.695, 0.695],
      killed: false,
      tolerance: 0.01,
      refused: true,
    },
  ]

  for (const { name, floor, aucs, killed, tolerance, refused } of cases) {
    const stop = { regression_windows: 2, ...(floor === undefined ? {} : { regression_floor: floor }) }
    const decision = decideStop(
      facts({
        stop,
        candidates: [{ candidate_id: 'c1', phase: 'DONE' }],
        samples: { baseline: BASELINE, candidates: { c1: candidateSeries(aucs.map((auc) => ({ auc }))) } },
      }),
    )

    if (!killed) {
      assert.deepEqual(decision.kills, [], name)
      if (floor !== undefined) {
        // The floor's arithmetic is still recorded: a reader must be able to see which tolerance was
        // in force even when it changed the answer to "no kill".
        const toleranceReported = decision.tolerances.find((entry) => entry.metric === 'auc')
        assert.equal(toleranceReported.tolerance, tolerance, name)
        assert.equal(toleranceReported.floor_refused, refused, `${name}: a floor that would loosen is refused, and says so`)
      }
      continue
    }
    const kill = killOf(decision)
    assert.equal(kill.tolerance, tolerance, name)
    assert.equal(kill.floor_refused, refused, name)
  }
})

// ----------------------------------------------------------------- 3. workspace conclusions

test('a wall-clock timeout and a window ceiling are workspace conclusions, not candidate kills', () => {
  const threeWindows = { baseline: BASELINE }
  const cases = [
    { name: 'the wall clock reached the limit', stop: { max_wall_hours: 2 }, now: 7_200_000, expected: 'max_wall_hours', observed: 2 },
    { name: 'the wall clock is a tick short', stop: { max_wall_hours: 2 }, now: 7_199_999, expected: null },
    { name: 'the run measured as many windows as allowed', stop: { max_windows: 3 }, samples: threeWindows, expected: 'max_windows', observed: 3 },
    { name: 'the run is one window short of the ceiling', stop: { max_windows: 4 }, samples: threeWindows, expected: null },
    { name: 'neither ceiling is configured', stop: {}, expected: null },
  ]

  for (const { name, stop, now = 0, samples = {}, expected, observed } of cases) {
    const decision = decideStop(
      facts({ stop, now, startedAt: 0, samples, candidates: [{ candidate_id: 'c1', phase: 'DONE' }] }),
    )

    if (expected === null) {
      assert.equal(decision.stop, undefined, name)
      continue
    }
    assert.equal(decision.stop.rule, expected, name)
    assert.equal(decision.stop.observed, observed, `${name}: the observed value is recorded next to the limit`)
    assert.match(decision.stop.message, /stop\./, `${name}: the message names the configuration that ended the run`)
    assert.deepEqual(decision.kills, [], `${name}: the run is over, so no candidate is killed on the way out`)
  }
})

test('a ceiling does not conclude the run while a candidate is still spending', () => {
  const decision = decideStop(
    facts({
      stop: { max_wall_hours: 1 },
      now: 3 * 3_600_000,
      candidates: [{ candidate_id: 'c1', phase: 'MONITOR_POLL', status: 'active', complete: false }],
    }),
  )

  assert.equal(decision.stop, undefined, 'a job already paid for is not discarded by a conclusion about time')
  assert.deepEqual(decision.blocked_by, ['c1'])
})

// ----------------------------------------------------------------- through the tick seam

test('the tick rejects an evidence-invalid candidate without waiting for a timeout, and does not end the run', async () => {
  const ports = { ...openWorkspace({ config: { metrics: { primary: 'auc', objectives: { auc: 'up' } } } }), artifacts: memoryArtifacts() }
  const tail = candidateSeries([{ auc: 0.7 }, { auc: 0.72 }, { loss: 2.1 }])
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.72 }, series: tail })

  const result = await tick(ports)

  assert.equal(ports.store.getState('r1-c1', 'phase').phase, 'REJECTED', 'the candidate is rejected rather than sitting out the timeout')
  const [rejected] = ports.store.eventsFor('r1-c1').filter((event) => event.event_type === 'candidate_rejected')
  assert.match(rejected.payload.reject_reason, /last window/, 'the reason names the evidence, so the dump can explain it')
  assert.equal(rejected.payload.stop_rule, 'last_window_unmeasured')
  assert.equal(rejected.payload.status, undefined, 'no four-state status: nothing was malformed')
  assert.equal(ports.store.getState(undefined, 'workspace').stopped, undefined, 'one candidate dying is not the run ending')
  assert.equal(result.stopped?.stopped, false)
  ports.store.close()
})

test('a model claim cannot shorten a run', async () => {
  const ports = { ...openWorkspace({ config: { metrics: { primary: 'auc', objectives: { auc: 'up' } } } }), artifacts: memoryArtifacts() }
  const healthy = candidateSeries([{ auc: 0.7 }, { auc: 0.73 }, { auc: 0.75 }])
  // The analysis says the run went backwards; every number the platform reported says it improved.
  const judge = { ...ports.judge, analyze: (input) => reportOf(input, { value: 0.75, verdict: 'regressed' }) }
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.75 }, series: healthy, judge })

  await tick(ports)

  assert.equal(ports.store.getState('r1-c1', 'phase').phase, 'DONE', 'a claim of failure is an argument, not a measurement')
  ports.store.close()
})

test('a model claim cannot lengthen a run', async () => {
  const ports = { ...openWorkspace({ config: { metrics: { primary: 'auc', objectives: { auc: 'up' } } } }), artifacts: memoryArtifacts() }
  const tail = candidateSeries([{ auc: 0.7 }, { auc: 0.72 }, { loss: 2.1 }])
  // The analysis brags that the run improved; its last window never produced a number.
  const judge = { ...ports.judge, analyze: (input) => reportOf(input, { value: 0.72, verdict: 'improved' }) }
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.72 }, series: tail, judge })

  await tick(ports)

  assert.equal(ports.store.getState('r1-c1', 'phase').phase, 'REJECTED', 'the facts decide, whatever the report says')
  ports.store.close()
})

test('the window ceiling ends the run on the workspace subject, and the dump says so', async () => {
  const config = { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_windows: 3 } }
  const ports = { ...openWorkspace({ config }), artifacts: memoryArtifacts() }
  recordWindowSamples(ports, { subject: BASELINE_SUBJECT, subjectKind: 'baseline', jobId: 'job-b', series: BASELINE, source: 'test' })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.71 }, series: candidateSeries([{ auc: 0.7 }, { auc: 0.71 }, { auc: 0.72 }]) })

  const result = await tick(ports)

  assert.equal(result.stopped?.rule, 'max_windows', 'the ceiling is what ended the run')
  assert.equal(ports.store.getState(undefined, 'workspace').phase, 'FINALIZE', 'the workspace moves to FINALIZE, not to a pause')
  const [event] = ports.store.eventsFor(WORKSPACE_SUBJECT).filter((entry) => entry.event_type === 'workspace_stopped')
  assert.equal(event.payload.rule, 'max_windows', 'the conclusion is a fact on _workspace, where workspace conclusions live')
  assert.equal(event.payload.observed, 3)
  assert.equal(event.payload.limit, 3)

  const output = renderDump(ports.store, 'r1-c1', { config })
  assert.match(output, /max_windows/, 'a person reading the dump can see why the run ended')
  assert.match(output, /workspace stop/)
  ports.store.close()
})

