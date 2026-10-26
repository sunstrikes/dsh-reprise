/**
 * Guards the decision "how close is each stop rule to firing is a number the projection publishes,
 * computed by the same function that decides whether it fires" (spec §6.3; ticket #4 checkbox 6).
 *
 * The seam is `describeRules` — the per-rule status a renderer reads — and `decideStop`, the decision
 * itself. Two properties are the whole point, and each one is a bug this file exists to prevent:
 *
 *   1. **One measurement.** The number on the gauge and the number in the recorded conclusion come
 *      from one function over one set of inputs, so a page cannot say "3/3" about a run that stopped
 *      for a different reason.
 *   2. **No invented zero.** A rule that is off, or that cannot run because the metric contract is
 *      broken, or whose counter the caller did not supply, shows *no* value — `null` and a sentence —
 *      never `0`. `0` is a reading somebody acts on, and a rule that never ran has not been read.
 *
 * The round histories below are written by hand rather than produced by `tick`: `describeRules` reads
 * the shape `roundHistory()` returns, and a hand-written history states the expectation instead of
 * echoing whatever the kernel happens to compute.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideStop, describeRules, stopConfig } from '../lib/stop.js'
import { resolveMetricContract } from '../lib/metric-contract.js'
import { windowSeries } from './support/samples.js'

const CONTRACT = resolveMetricContract({ name: 'auc', primary: 'auc', objectives: { auc: 'up', logloss: 'down' } })

/** Four completed rounds: two that raised the best, then two that held it. */
const HISTORY = [
  { round: 1, complete: true, empty: false, improving: true, best: { candidate_id: 'r1-c1', metric: 'auc', value: 0.7 } },
  { round: 2, complete: true, empty: false, improving: true, best: { candidate_id: 'r2-c1', metric: 'auc', value: 0.72 } },
  { round: 3, complete: true, empty: false, improving: false, best: { candidate_id: 'r3-c1', metric: 'auc', value: 0.71 } },
  { round: 4, complete: true, empty: false, improving: false, best: { candidate_id: 'r4-c1', metric: 'auc', value: 0.715 } },
]

/** Two productive rounds followed by two that produced nothing comparable. */
const EMPTY_TAIL = [
  ...HISTORY.slice(0, 2),
  { round: 3, complete: true, empty: true, improving: false },
  { round: 4, complete: true, empty: true, improving: false },
]

const WINDOWS = 4
const BASELINE = windowSeries(
  Array.from({ length: WINDOWS }, (_, index) => [index, index * 10, (index + 1) * 10, { auc: 0.7, logloss: 0.6 }]),
)
const SAMPLES = { baseline: BASELINE, candidates: {} }

const STARTED_AT = 1_000_000
const NOW = STARTED_AT + 2.5 * 3_600_000

/**
 * The inputs `describeRules`/`decideStop` take, spelled once. `stop` stays a plain object so a case
 * can enable exactly one rule and leave the rest at their defaults.
 */
const facts = ({ stop = {}, rounds = HISTORY, samples = SAMPLES, contract = CONTRACT, now = NOW, startedAt = STARTED_AT } = {}) => ({
  limits: stopConfig({ stop }),
  view: { contract, best: undefined, candidates: [] },
  rounds,
  contract,
  samples,
  now,
  startedAt,
})

const ruleOf = (rules, name) => rules.find((rule) => rule.rule === name)

test('every enabled rule publishes how far along it is, measured from the decision\'s own inputs', () => {
  const input = facts({
    stop: { max_rounds: 20, max_no_improvement_rounds: 3, consecutive_empty_rounds: 2, max_wall_hours: 10, max_windows: 6 },
  })

  const rules = describeRules(input)

  assert.deepEqual(
    rules.map((rule) => [rule.rule, rule.observed]),
    [
      // The highest *completed* round: a round still running has not been completed, whatever it holds.
      ['max_rounds', 4],
      // Rounds 3 and 4 did not beat the best result standing, and did not extend it either.
      ['max_no_improvement_rounds', 2],
      ['consecutive_empty_rounds', 0],
      // 2.5 hours between the run's start and the reading.
      ['max_wall_hours', 2.5],
      // The longest series any subject recorded, which is the baseline's four windows.
      ['max_windows', WINDOWS],
    ],
    'each rule reports the number it is judged on, not only the one that fired',
  )

  assert.deepEqual(
    rules.map((rule) => rule.distancePercent),
    [20, 66.67, 0, 25, 66.67],
    'and the distance to its limit, as a percentage the renderer draws without dividing anything',
  )
})

test('an empty tail is the empty-round rule\'s number, and it does not also count as "no improvement"', () => {
  const rules = describeRules(facts({ stop: { consecutive_empty_rounds: 2, max_no_improvement_rounds: 2 }, rounds: EMPTY_TAIL }))

  assert.equal(ruleOf(rules, 'consecutive_empty_rounds').observed, 2, 'two rounds in a row produced nothing comparable')
  assert.equal(
    ruleOf(rules, 'max_no_improvement_rounds').observed,
    0,
    'an empty round is not a "failed to improve" round: it is the other rule\'s phenomenon',
  )
})

test('the gauge and the decision read one number: whichever rule fires, its observed value is the one published', () => {
  // Each case turns every other rule off, because the declared order is the precedence order: with
  // the default `max_rounds: 3` in force this run is over on rounds alone in every one of them.
  const cases = [
    { rule: 'max_rounds', stop: { max_rounds: 4 } },
    { rule: 'max_no_improvement_rounds', stop: { max_rounds: 0, max_no_improvement_rounds: 2 } },
    { rule: 'consecutive_empty_rounds', stop: { max_rounds: 0, consecutive_empty_rounds: 2 }, rounds: EMPTY_TAIL },
    { rule: 'max_wall_hours', stop: { max_rounds: 0, max_wall_hours: 2.5 } },
    { rule: 'max_windows', stop: { max_rounds: 0, max_windows: WINDOWS } },
  ]

  for (const { rule, stop, rounds } of cases) {
    const input = facts({ stop, ...(rounds === undefined ? {} : { rounds }) })
    const published = ruleOf(describeRules(input), rule)

    assert.equal(published.observed, published.limit, `${rule}: this case is set up to sit exactly on its limit`)
    assert.equal(published.distancePercent, 100, `${rule}: reaching the limit is the whole of the distance`)

    const decision = decideStop(input)
    assert.equal(decision.stop?.rule, rule, `${rule}: the first rule whose limit is reached is the one recorded`)
    assert.equal(decision.stop.observed, published.observed, `${rule}: the decision and the gauge cannot disagree`)
  }
})

test('a rule that is off, or cannot run, reports no value at all — a zero there would be a lie', () => {
  const off = describeRules(facts({ stop: { max_rounds: 20 } }))
  assert.deepEqual(
    off.filter((rule) => rule.enabled === false).map((rule) => [rule.rule, rule.observed, rule.reason]),
    [
      ['max_no_improvement_rounds', null, 'disabled (0)'],
      ['consecutive_empty_rounds', null, 'disabled (0)'],
      ['max_wall_hours', null, 'disabled (0)'],
      ['max_windows', null, 'disabled (0)'],
    ],
    'a rule set to 0 is off, so it has no reading and no bar',
  )
  assert.equal(ruleOf(off, 'max_rounds').observed, 4, 'while the one rule that is on still reports its count')

  const contradictory = resolveMetricContract({ name: 'two-accounts', primary: 'score', direction: 'lower', objectives: { score: 'up' } })
  const blocked = describeRules(
    facts({ stop: { max_no_improvement_rounds: 2, consecutive_empty_rounds: 1, max_rounds: 20 }, contract: contradictory }),
  )
  for (const rule of blocked.filter((entry) => entry.enabled === true && entry.contract !== undefined)) {
    assert.equal(rule.observed, null, `${rule.rule}: a rule that cannot run has not measured anything`)
    assert.equal(rule.distancePercent, null, `${rule.rule}: and there is no bar to draw`)
    assert.match(rule.reason, /no contract \(conflict\)/, `${rule.rule}: the reason it cannot run is spelled out`)
  }
  assert.equal(ruleOf(blocked, 'max_rounds').observed, 4, 'the contract-free rules are still measurable, and still measured')
})

test('a caller that supplies no round history gets no value, and is told which input was missing', () => {
  // The projection always supplies the history; this is the shape a caller that only has a `view` gets.
  // The one thing it must not get is `0`, which would read as "this run has completed no rounds".
  const rules = describeRules({ limits: stopConfig({ stop: { max_rounds: 20 } }), view: { contract: CONTRACT } })

  const rounds = ruleOf(rules, 'max_rounds')
  assert.equal(rounds.enabled, true)
  assert.equal(rounds.observed, null)
  assert.equal(rounds.distancePercent, null)
  assert.match(rounds.unmeasured, /round history/, 'the reason it has no value is a sentence, not a guess')
})

test('a run that never recorded when it started has no wall-clock reading, rather than zero hours', () => {
  const rules = describeRules(facts({ stop: { max_wall_hours: 10 }, startedAt: null }))

  const wall = ruleOf(rules, 'max_wall_hours')
  assert.equal(wall.enabled, true)
  assert.equal(wall.observed, null, 'zero hours would say "the run just started", which nobody recorded')
  assert.match(wall.unmeasured, /start/)
})