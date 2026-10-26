/**
 * Guards the decision "the ranking, the stop rules and the gate decide with one resolved contract, and
 * when there is no contract all three say the same word" (spec 契约 / 相位机; ticket 20).
 *
 * The defect this file exists for: three readers each read the contract their own way — one promoted
 * the first objective to primary, one compared strictly with no tolerance, one fell back to whatever
 * number the job reported — so "did this candidate improve" had three answers, and a missing key failed
 * open. Each test here therefore asserts the *same* answer arriving at all three readers:
 *
 *   1. one primary and one guardrail, seen identically by `frontier` (the ranking's best), `evaluateStop`
 *      (the stop rules) and `createJudge` (the gate's comparison);
 *   2. the minimum effective delta is *consumed*, not carried: a move inside the tolerance is
 *      `inconclusive` at the gate and does not reset the stop rules' no-improvement streak;
 *   3. an absent contract, and a self-contradictory one, are `missing` and `conflict` respectively at all
 *      three readers, with no silent default anywhere.
 *
 * The other half — the resolution itself, its per-metric tolerance and its window reading — is
 * `metric-contract.test.js`. The tests may name metrics (`score`); the kernel may not.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ranking } from '../lib/ranking.js'
import { compareMetric, createJudge } from '../lib/judge.js'
import { tick } from '../lib/loop.js'
import { describeRules, evaluateStop, stopConfig } from '../lib/stop.js'
import { FEED_PROMPTS_DIR } from './support/domain.js'
import { windowSeries } from './support/samples.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

/**
 * One contract with both roles, a contract-wide tolerance and a per-metric override. Deliberately a
 * metric nobody in the kernel knows, so a passing test cannot be the kernel spelling one out.
 */
const RANKED = Object.freeze({
  name: 'two-numbers',
  primary: 'score',
  direction: 'higher',
  objectives: { score: 'up', cost: 'down' },
  guardrail: { metric: 'cost', direction: 'lower' },
  minimum_effective_delta: { default: 0.01, score: 0.02 },
  window_mode: 'mean',
})

/** A judge built from a contract, with a model port that answers nothing (no call site runs here). */
const judgeFor = (metricContract) => createJudge({ model: async () => '{}', skillsDir: FEED_PROMPTS_DIR, metricContract })

test('one contract resolves to one primary and one guardrail, and the three readers read that answer', async () => {
  // 1. the ranking: "best" is decided on the primary, and the view carries the guardrail it may not trade away.
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { score: 0.71, cost: 3.2 } })
  const view = ranking(ports.store, { metrics: RANKED })
  assert.equal(view.contract.status, 'ok')
  assert.equal(view.contract.primary, 'score')
  assert.equal(view.best.metric, 'score', 'the ranking reads the resolved primary, not a second interpretation')
  assert.deepEqual(
    view.contract.guardrails.map((guardrail) => guardrail.name),
    ['cost'],
    'the ranking can say which metric a winner may not have traded away',
  )

  // 2. the stop rules: the same contract, and it says so in its own answer.
  const stop = evaluateStop({ store: ports.store, clock: ports.clock, config: { metrics: RANKED } })
  assert.equal(stop.contract.primary, 'score', 'the stop decision reads the same resolution')
  assert.deepEqual(
    stop.contract.guardrails.map((guardrail) => guardrail.name),
    ['cost'],
  )

  // 3. the gate: the same contract, so a comparison cannot be made against a different "better".
  const judge = judgeFor(RANKED)
  assert.equal(judge.contract.status, 'ok')
  assert.equal(judge.contract.primary, 'score')
  assert.deepEqual(
    judge.contract.guardrails.map((guardrail) => guardrail.name),
    ['cost'],
  )
  ports.store.close()
})

test('the tolerance is consumed by the gate and by the stop rules, not just carried around', async () => {
  // The gate: a difference smaller than the tolerance is not a difference.
  const observed = { metric: 'score', value: 0.505 }
  assert.equal(compareMetric(observed, 0.5, 'higher'), 'improved', 'with no tolerance, any difference counts')
  assert.equal(
    compareMetric(observed, 0.5, 'higher', 0.01),
    'inconclusive',
    'a 0.005 move inside a 0.01 tolerance is not an improvement — the contract said so, not the kernel',
  )
  assert.equal(compareMetric({ metric: 'score', value: 0.52 }, 0.5, 'higher', 0.01), 'improved', 'and a 0.02 move is')

  // The stop rules: a round that "improved" inside the tolerance did not beat the best result.
  const stopWith = (minimum_effective_delta) => ({
    metrics: { ...RANKED, minimum_effective_delta },
    stop: { max_rounds: 0, max_no_improvement_rounds: 1 },
  })

  const tolerated = openWorkspace({ config: stopWith({ default: 0.01 }) })
  await runCandidate(tolerated, { candidateId: 'r1-c1', round: 1, metrics: { score: 0.7, cost: 3 } })
  await runCandidate(tolerated, { candidateId: 'r2-c1', round: 2, metrics: { score: 0.705, cost: 3 } })
  const fired = await tick(tolerated)
  assert.equal(fired.stopped?.rule, 'max_no_improvement_rounds', 'a 0.005 gain under a 0.01 tolerance does not extend the run')
  tolerated.store.close()

  const effective = openWorkspace({ config: stopWith({ default: 0.001 }) })
  await runCandidate(effective, { candidateId: 'r1-c1', round: 1, metrics: { score: 0.7, cost: 3 } })
  await runCandidate(effective, { candidateId: 'r2-c1', round: 2, metrics: { score: 0.705, cost: 3 } })
  const stillRunning = await tick(effective)
  assert.equal(stillRunning.stopped?.stopped, false, 'the same 0.005 move clears a 0.001 tolerance and keeps the run alive')
  effective.store.close()
})

test('no contract is `missing` at all three readers, and none of them picks a default', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { score: 0.71 } })

  // 1. the ranking.
  const view = ranking(ports.store, {})
  assert.equal(view.contract.status, 'missing')
  assert.equal(view.contract.ok, false)
  assert.match(view.contract.error, /no metric contract/, 'the dashboard and dump read this sentence')
  assert.equal(view.best, undefined)
  assert.deepEqual(view.frontier, [])

  // 2. the stop rules: the two metric rules cannot run, and say the same status instead of guessing.
  const stop = evaluateStop({ store: ports.store, clock: ports.clock, config: { metrics: { objectives: { score: 'up' } } } })
  assert.equal(stop.contract.status, 'missing')
  const limits = stopConfig({ stop: { max_no_improvement_rounds: 1, consecutive_empty_rounds: 1 } })
  const rules = describeRules({ limits, view: { contract: stop.contract } })
  // The metric rules, which are the ones that cannot run without a contract. The ceilings
  // (`max_wall_hours`, `max_windows`) are readable without one and are asserted to stay enabled.
  assert.deepEqual(
    rules
      .filter((rule) => rule.rule === 'max_no_improvement_rounds' || rule.rule === 'consecutive_empty_rounds')
      .map((rule) => [rule.contract, /no contract \(missing\)/.test(rule.reason ?? '')]),
    [
      ['missing', true],
      ['missing', true],
    ],
    'each metric rule names the same status rather than comparing against a guess',
  )
  const ceilings = describeRules({ limits: stopConfig({ stop: { max_wall_hours: 1, max_windows: 10 } }), view: { contract: stop.contract } })
    .filter((rule) => rule.rule === 'max_wall_hours' || rule.rule === 'max_windows')
  assert.deepEqual(
    ceilings.map((rule) => [rule.enabled, rule.reason]),
    [
      [true, null],
      [true, null],
    ],
    'a clock and a window count mean the same thing without a contract, so the ceilings stay enabled',
  )

  // 3. the gate: it cannot admit anything without a contract, and refuses with the same status name.
  assert.throws(
    () => createJudge({ model: async () => '{}', skillsDir: FEED_PROMPTS_DIR }),
    (error) => {
      assert.equal(error.status, 'missing')
      assert.match(error.message, /no metric contract/)
      return true
    },
  )
  ports.store.close()
})

test('a self-contradictory contract is `conflict` at all three readers — not `invalid`, and not a default', async () => {
  // Two accounts of "better": the top-level direction says lower, the primary's objective says up.
  const contradictory = { name: 'two-accounts', primary: 'score', direction: 'lower', objectives: { score: 'up' } }

  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { score: 0.71 } })

  const view = ranking(ports.store, { metrics: contradictory })
  assert.equal(view.contract.status, 'conflict')
  assert.equal(view.best, undefined, 'nothing is ranked by a contract nobody can agree with')

  const stop = evaluateStop({ store: ports.store, clock: ports.clock, config: { metrics: contradictory } })
  assert.equal(stop.contract.status, 'conflict')
  const limits = stopConfig({ stop: { max_no_improvement_rounds: 1 } })
  const [, noImprovement] = describeRules({ limits, view: { contract: stop.contract } })
  assert.match(noImprovement.reason ?? '', /no contract \(conflict\)/, 'the stop rules say which contradiction, not "needs a metric contract"')

  assert.throws(
    () => judgeFor(contradictory),
    (error) => {
      assert.equal(error.status, 'conflict')
      assert.match(error.message, /direction/)
      return true
    },
  )
  ports.store.close()
})

// ------------------------------------------- the window mode actually decides the ranking

/**
 * The handoff ticket 20 left open: the window reading existed (`readMetric`) but nothing in
 * production called it, so "mean of the windows" and "the last window" were two answers to a
 * question the ranking never asked — it ranked the executor's own headline number. These tests
 * hold the wire in place: when a candidate reported a window series, the number that enters the
 * ranking and the guardrail vectors comes from `readMetric` under the contract's mode, and a
 * disagreement with the executor's flat aggregate is recorded rather than silently resolved.
 */

/** `score` up (primary), `cost` down (guardrail): the roles the shipped pack uses, named locally. */
const WINDOWED = Object.freeze({
  name: 'two-numbers',
  primary: 'score',
  objectives: { score: 'up', cost: 'down' },
  guardrail: { metric: 'cost', direction: 'lower' },
})

/**
 * Three windows whose mean and last window are both exact and different, so a test can write either
 * as a literal: score is (0.5, 1.0, 1.5) — mean 1.0, last 1.5 — and cost is (4, 3, 2) — mean 3, last 2.
 */
const WINDOWS = windowSeries([
  [0, 0, 1, { score: 0.5, cost: 4 }],
  [1, 1, 2, { score: 1, cost: 3 }],
  [2, 2, 3, { score: 1.5, cost: 2 }],
])

/** The executor's own aggregate, deliberately different from both readings of the windows. */
const REPORTED = { score: 0.55, cost: 9 }

test('a candidate with a window series is ranked the way the contract reads it — mean or last, per metric', async () => {
  const readUnder = async (windowMode) => {
    const contract = { ...WINDOWED, window_mode: windowMode }
    const ports = openWorkspace({ config: { metrics: contract } })
    await runCandidate(ports, { candidateId: 'c1', metrics: REPORTED, series: WINDOWS })
    const row = ranking(ports.store, { metrics: contract }).candidates[0]
    ports.store.close()
    return row
  }

  const last = await readUnder('last')
  assert.equal(last.vector.score, 1.5, 'window_mode "last": the last window decides, not the executor\'s 0.55')
  assert.equal(last.vector.cost, 2, 'and the guardrail is read the same way — it is an objective like any other')
  assert.deepEqual(last.vector_source, { score: 'window_series', cost: 'window_series' })

  const mean = await readUnder({ default: 'mean', score: 'last' })
  assert.equal(mean.vector.score, 1.5, 'a per-metric override is honoured: score is still read as its last window')
  assert.equal(mean.vector.cost, 3, 'and cost, with no override, is the mean of (4, 3, 2)')

  const allMean = await readUnder('mean')
  assert.equal(allMean.vector.score, 1, 'the mean of (0.5, 1, 1.5) is 1, which no arithmetic on REPORTED produces')
  assert.equal(allMean.vector.cost, 3)
})

test('the disagreement between the series and the executor is recorded, so neither side wins silently', async () => {
  const contract = { ...WINDOWED, window_mode: 'last' }
  const ports = openWorkspace({ config: { metrics: contract } })
  await runCandidate(ports, { candidateId: 'c1', metrics: REPORTED, series: WINDOWS })

  const fact = ports.store.eventsFor('c1').find((event) => event.event_type === 'window_samples')
  assert.deepEqual(fact.payload.window_read.values, { score: 1.5, cost: 2 }, 'the sample record carries what the contract read')
  assert.deepEqual(
    fact.payload.window_read.disagreements,
    [
      { metric: 'score', window: 'last', contract: 1.5, reported: 0.55 },
      { metric: 'cost', window: 'last', contract: 2, reported: 9 },
    ],
    'both accounts are kept: the contract decides, and the fact says the executor reported something else',
  )
  assert.deepEqual(fact.payload.metrics, ['cost', 'score'], 'the names the series measured are still recorded beside it')
  ports.store.close()
})

test('a candidate that reported no series is still ranked by its metrics — the fallback is the absence of evidence', async () => {
  const ports = openWorkspace({ config: { metrics: WINDOWED } })
  await runCandidate(ports, { candidateId: 'c1', metrics: REPORTED })

  const row = ranking(ports.store, { metrics: WINDOWED }).candidates[0]
  assert.equal(row.vector.score, 0.55, 'no windows, so the only number that exists is the one the executor reported')
  assert.equal(row.vector.cost, 9)
  assert.deepEqual(row.vector_source, { score: 'executor', cost: 'executor' })
  ports.store.close()
})

test('a series whose tail does not measure the metric is not measured — the flat number is not substituted', async () => {
  const contract = { ...WINDOWED, window_mode: 'last' }
  // The last window carries cost only, so the deciding metric has no last-window value.
  const series = windowSeries([
    [0, 0, 1, { score: 0.6, cost: 4 }],
    [1, 1, 2, { cost: 3 }],
  ])
  const ports = openWorkspace({ config: { metrics: contract } })
  await runCandidate(ports, { candidateId: 'c1', metrics: REPORTED, series })

  const row = ranking(ports.store, { metrics: contract }).candidates[0]
  assert.equal(Object.hasOwn(row.vector, 'score'), false, 'readMetric answered "not measured", and an older window never stands in')
  assert.deepEqual(row.missing, ['score'])
  assert.equal(row.vector.cost, 3, 'the guardrail was measured in the last window, so it is still readable')
  assert.equal(row.complete, false, 'a row without its deciding metric is incomplete, not ranked on a number nobody measured')

  const fact = ports.store.eventsFor('c1').find((event) => event.event_type === 'window_samples')
  assert.match(fact.payload.window_read.unmeasured.score, /last window/, 'and the reason names the window that said nothing')
  ports.store.close()
})

test('the series wins only under the mode it was read with: a contract that changed its mode re-reads the flat number', async () => {
  // The samples were recorded under `last`; a reader asking for `mean` cannot reuse that reading, and
  // must not pretend the last-window number is a mean. It falls back to the executor's number until a
  // series is read under the mode the reader states — the honest answer, and visibly so on the row.
  const ports = openWorkspace({ config: { metrics: { ...WINDOWED, window_mode: 'last' } } })
  await runCandidate(ports, { candidateId: 'c1', metrics: REPORTED, series: WINDOWS })

  const row = ranking(ports.store, { metrics: { ...WINDOWED, window_mode: 'mean' } }).candidates[0]
  assert.equal(row.vector.score, 0.55, 'the recorded last-window read is not a mean, so it is not used')
  assert.deepEqual(row.vector_source, { score: 'executor', cost: 'executor' })
  ports.store.close()
})
