/**
 * Guards the decision "the metric contract is read in exactly one place, and `no contract` is a named
 * answer" (spec 契约 / 领域差异必须是数据; ticket 20) — the resolver's own seam.
 *
 * The resolution turns the contract data into the four things every reader needs: which metric decides
 * "best", which metrics are guardrails, how large a difference has to be to count, and whether a series
 * is read as the mean of its windows or as its last window. Four properties are pinned here:
 *
 *   1. one contract resolves to one primary and one guardrail, with roles *derived* from the contract's
 *      own fields — never from its prose;
 *   2. the minimum effective delta has a default and a per-metric override, the override wins, and a
 *      zero or negative one is refused instead of quietly making every difference count;
 *   3. the window reading is per metric, and "last" means the last window — an absent or infinite value
 *      there is *not a measurement*, never an older window wearing its name;
 *   4. an absent contract is `missing` and a self-contradictory one is `conflict` — different facts,
 *      both "no contract", and no reader is handed a default to fall back to.
 *
 * `metric-contract-readers.test.js` holds the other half: that the ranking, the stop rules and the gate
 * all read this one resolution. The tests may name metrics (`score`, `hr@10`); the kernel may not, and
 * `domain.test.js` holds that line.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readMetric, resolveMetricContract } from '../lib/metric-contract.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GENERATIVE_CONTRACT = join(ROOT, 'examples', 'generative-recommenders', 'metric-contract.json')

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

// ------------------------------------------------------------- roles and shape

test('one contract resolves to one primary and one guardrail, with the role derived from its own fields', () => {
  const resolved = resolveMetricContract(RANKED)

  assert.equal(resolved.status, 'ok')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.ref, 'two-numbers', 'the ref is the name frozen artifacts quote')
  assert.equal(resolved.primary, 'score', 'the contract says which metric decides "best"')
  assert.deepEqual(
    resolved.objectives.map((objective) => [objective.name, objective.direction, objective.kind]),
    [
      ['score', 'up', 'primary'],
      ['cost', 'down', 'guardrail'],
    ],
    'both metrics are ranked; their roles differ, and the role is derived from `primary` and `guardrail`',
  )
  assert.deepEqual(
    resolved.guardrails.map((guardrail) => [guardrail.name, guardrail.direction]),
    [['cost', 'down']],
    'the guardrail is a ranked metric that must not go backwards, and it keeps its own direction',
  )
  assert.equal(resolved.direction, 'up', 'one vocabulary for direction, normalised from higher/lower')
})

test('prose `role` is carried for the prompts and never parsed into a decision', () => {
  const resolved = resolveMetricContract({
    primary: 'score',
    objectives: { score: 'up', cost: 'down' },
    role: {
      score: 'primary — the number the gate compares',
      cost: 'cost — recorded, never optimised',
      other: 'diagnostic — a metric the contract does not rank',
    },
  })

  assert.equal(resolved.status, 'ok', 'a role sentence for a metric the contract does not rank is explanation, not a contradiction')
  assert.match(resolved.objectives[0].role ?? '', /^primary/, 'the prose travels as written')
  assert.equal(resolved.objectives[1].kind, 'objective', 'and it does not change the derived role: only `primary`/`guardrail` do')
})

test("the direction may be stated once, in `direction` or in the primary's objective — and two accounts must agree", () => {
  const fromObjective = resolveMetricContract({ primary: 'score', objectives: { score: 'down' } })
  assert.equal(fromObjective.status, 'ok', 'the objective already says which way is better; the top-level field is not needed twice')
  assert.equal(fromObjective.direction, 'down')

  const disagreeing = resolveMetricContract({ primary: 'score', direction: 'higher', objectives: { score: 'down' } })
  assert.equal(disagreeing.status, 'conflict')
  assert.match(disagreeing.message, /direction/)
  assert.match(disagreeing.message, /objectives\.score/)
})

// --------------------------------------------------- the minimum effective delta

test('the tolerance has a default and a per-metric override, and the override wins', () => {
  const strict = resolveMetricContract({ primary: 'score', objectives: { score: 'up', cost: 'down' } })
  assert.deepEqual(
    strict.objectives.map((objective) => objective.minimum_effective_delta),
    [0, 0],
    'nothing declared is a strict comparison — a tolerance the domain did not state is a domain decision',
  )

  const contractWide = resolveMetricContract({
    primary: 'score',
    objectives: { score: 'up', cost: 'down' },
    minimum_effective_delta: 0.01,
  })
  assert.deepEqual(
    contractWide.objectives.map((objective) => objective.minimum_effective_delta),
    [0.01, 0.01],
    'one number applies to every ranked metric',
  )

  const overridden = resolveMetricContract(RANKED)
  assert.deepEqual(
    overridden.objectives.map((objective) => [objective.name, objective.minimum_effective_delta]),
    [
      ['score', 0.02],
      ['cost', 0.01],
    ],
    'a per-metric entry overrides the contract-wide default instead of adding a second opinion',
  )
})

test('a zero or negative tolerance is refused rather than read as "every difference counts"', () => {
  for (const minimum_effective_delta of [0, -0.01, { default: 0 }, { default: 0.01, score: 0 }]) {
    const resolved = resolveMetricContract({ primary: 'score', objectives: { score: 'up', cost: 'down' }, minimum_effective_delta })
    assert.equal(resolved.status, 'invalid', `a tolerance of ${JSON.stringify(minimum_effective_delta)} states nothing`)
    assert.match(resolved.message, /positive/, 'and the refusal says what a usable value looks like')
  }
})

test('a tolerance declared for the guardrail but not for the primary is refused, not silently strict', () => {
  const resolved = resolveMetricContract({
    primary: 'score',
    objectives: { score: 'up', cost: 'down' },
    guardrail: { metric: 'cost' },
    minimum_effective_delta: { cost: 0.01 },
  })
  assert.equal(resolved.status, 'invalid', 'the number a human believes is in force would skip the metric that matters most')
  assert.match(resolved.message, /minimum_effective_delta/)
  assert.match(resolved.message, /primary/)
})

test('a tolerance for a metric the contract does not rank is a conflict, not a comment', () => {
  const resolved = resolveMetricContract({
    primary: 'score',
    objectives: { score: 'up' },
    minimum_effective_delta: { score: 0.01, late: 0.5 },
  })
  assert.equal(resolved.status, 'conflict', 'the contract says two things: this metric matters, and these are the metrics that count')
  assert.match(resolved.message, /late/)
  assert.match(resolved.message, /objectives/)
})

// ------------------------------------------------------------- the window reading

test('the window reading is per metric: mean over the measuring windows, or the last window', () => {
  const resolved = resolveMetricContract({
    primary: 'score',
    objectives: { score: 'up', cost: 'down' },
    window_mode: { default: 'mean', score: 'last' },
  })
  assert.deepEqual(
    resolved.objectives.map((objective) => [objective.name, objective.window]),
    [
      ['score', 'last'],
      ['cost', 'mean'],
    ],
    'each metric is read the way the contract says it is read',
  )

  const series = {
    schema_version: 1,
    unit: 'step',
    windows: [
      { index: 0, start: 0, end: 10, metrics: { score: 0.5, cost: 9 } },
      { index: 1, start: 10, end: 20, metrics: { score: 0.6 } },
      { index: 2, start: 20, end: 30, metrics: { score: 0.7, cost: 8 } },
    ],
  }
  const rule = (name) => resolved.objectives.find((objective) => objective.name === name)

  assert.deepEqual(readMetric(series, rule('score')), { metric: 'score', window: 'last', value: 0.7, reason: undefined })
  assert.deepEqual(
    readMetric(series, rule('cost')),
    { metric: 'cost', window: 'mean', value: 8.5, reason: undefined },
    'the mean is over the windows that measured the metric — window 1 says nothing about cost',
  )
})

test('a last window with no finite number is not a measurement, and no older window stands in for it', () => {
  const series = {
    schema_version: 1,
    unit: 'step',
    windows: [
      { index: 0, start: 0, end: 10, metrics: { score: 0.5 } },
      { index: 1, start: 10, end: 20, metrics: { cost: 9 } },
    ],
  }

  const last = readMetric(series, { name: 'score', window: 'last' })
  assert.equal(last.value, undefined, 'the last window does not measure score, so "last" has no value')
  assert.match(last.reason, /last window/i, 'and the reason says which window was looked at')
  assert.match(last.reason, /score/, 'and which metric was missing from it')

  const mean = readMetric(series, { name: 'score', window: 'mean' })
  assert.equal(mean.value, 0.5, 'the mean mode reads the windows that did measure it')

  const infinite = {
    unit: 'step',
    windows: [
      { index: 0, start: 0, end: 10, metrics: { score: 0.5 } },
      { index: 1, start: 10, end: 20, metrics: { score: Number.POSITIVE_INFINITY } },
    ],
  }
  assert.equal(readMetric(infinite, { name: 'score', window: 'last' }).value, undefined, 'an infinite value is not a measurement')
  assert.equal(readMetric(infinite, { name: 'score', window: 'mean' }).value, 0.5, 'and it does not enter the mean')

  assert.equal(readMetric({ windows: [] }, { name: 'score', window: 'last' }).value, undefined, 'no window, no value')
  assert.equal(readMetric(undefined, { name: 'score', window: 'mean' }).value, undefined, 'no series, no value')
})

test('an unknown window mode, or one aimed at a metric the contract does not rank, is refused', () => {
  const unknown = resolveMetricContract({ primary: 'score', objectives: { score: 'up' }, window_mode: 'median' })
  assert.equal(unknown.status, 'invalid')
  assert.match(unknown.message, /mean/, 'the refusal lists what a mode may be')
  assert.match(unknown.message, /last/)

  const unranked = resolveMetricContract({
    primary: 'score',
    objectives: { score: 'up' },
    window_mode: { score: 'mean', late: 'last' },
  })
  assert.equal(unranked.status, 'conflict', 'a rule about a metric the contract does not rank is the contract disagreeing with itself')
  assert.match(unranked.message, /late/)
})

// ------------------------------------------------- no contract: a named answer

test('an absent contract, and a contract that never says which metric leads, are both `missing`', () => {
  const absent = resolveMetricContract(undefined)
  assert.equal(absent.status, 'missing')
  assert.equal(absent.ok, false)
  assert.match(absent.error, /no metric contract/, 'the dashboard and dump read this sentence')
  assert.equal(absent.primary, undefined, 'and nothing is invented to fill it')
  assert.deepEqual(absent.objectives, [])

  const noPrimary = resolveMetricContract({ objectives: { score: 'up', cost: 'down' } })
  assert.equal(noPrimary.status, 'missing', 'the first objective is not promoted to primary: that would be a guess')
  assert.equal(noPrimary.primary, undefined)
  assert.deepEqual(noPrimary.objectives, [], 'nothing is ranked when nothing says what leads')
})

test('a contract that is well-formed and disagrees with itself is `conflict`, never `invalid`', () => {
  const cases = [
    { contract: { primary: 'score', direction: 'lower', objectives: { score: 'up' } }, names: /direction/ },
    { contract: { primary: 'cost', objectives: { score: 'up' } }, names: /primary/ },
    { contract: { primary: 'score', objectives: { score: 'up', cost: 'down' }, guardrail: { metric: 'score' } }, names: /guardrail/ },
    { contract: { primary: 'score', objectives: { score: 'up' }, guardrail: { metric: 'cost' } }, names: /guardrail/ },
  ]
  for (const { contract, names } of cases) {
    const resolved = resolveMetricContract(contract)
    assert.equal(resolved.status, 'conflict', JSON.stringify(contract))
    assert.match(resolved.message, names, 'the message names the disagreement, not a typo')
    assert.equal(resolved.primary, undefined, 'a contract in conflict resolves to nothing, so no reader can pick a side')
  }

  const malformed = resolveMetricContract({ primary: 'score', objectives: { score: 'sideways' } })
  assert.equal(malformed.status, 'invalid', 'a value that is merely wrong is invalid — the two states stay apart')
})

test('the resolution never throws, and every answer carries the four-state vocabulary', () => {
  for (const value of [undefined, null, 'a contract', [], {}, { primary: 'score', objectives: {} }, 42]) {
    const resolved = resolveMetricContract(value)
    assert.ok(['ok', 'missing', 'invalid', 'conflict'].includes(resolved.status), `${JSON.stringify(value)} resolved to ${resolved.status}`)
    assert.ok(Array.isArray(resolved.problems))
    assert.ok(Array.isArray(resolved.objectives))
    assert.ok(Array.isArray(resolved.guardrails))
  }
})

// ------------------------------------------------------------ the shipped example

test('the shipped example contract resolves to the roles, tolerances and window reading its own file states', () => {
  const resolved = resolveMetricContract(JSON.parse(readFileSync(GENERATIVE_CONTRACT, 'utf8')))

  assert.equal(resolved.status, 'ok', resolved.problems?.join('; '))
  assert.equal(resolved.primary, 'hr@10')
  assert.deepEqual(
    resolved.objectives.map((objective) => [objective.name, objective.direction, objective.kind]),
    [
      ['hr@10', 'up', 'primary'],
      ['ndcg@10', 'up', 'guardrail'],
    ],
  )
  assert.deepEqual(
    resolved.objectives.map((objective) => objective.minimum_effective_delta),
    [0.005, 0.004],
    'the pack states one tolerance per metric; the resolution carries both, keyed by name',
  )
  assert.match(resolved.objectives[1].role ?? '', /^guardrail/, 'the prose role the pack wrote is carried for the prompts')
  assert.equal(resolved.objectives[0].window, 'last', 'the pack reads its numbers from the last full eval, so "last" is its window mode')
})
