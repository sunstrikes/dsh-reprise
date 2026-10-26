/**
 * The windowed sample shape and its pairing rule.
 *
 * Contract guarded (spec "事实面": artifacts are files validated by a validator; "契约": four states);
 * ticket 19, "窗口化样本". Four properties are pinned here, and each of them is a way a comparison can
 * quietly become wrong:
 *
 *   1. a series without a window ordinal, without finite numbers, or with no window at all is refused
 *      **by name** — the alternative is a run that measured nothing scoring as a run;
 *   2. the same bounds with different numbers is a `conflict`, while an identical repeat is
 *      `invalid`: "the run contradicts itself" and "the document is malformed" are recovered from
 *      differently and must not be merged;
 *   3. pairing keeps only the intersection of the two runs' window bounds, and names what it dropped
 *      — pairing window 3 with window 3 of a run that evaluated at different steps compares two
 *      different amounts of training;
 *   4. an empty intersection is a refusal with a reason, never an equal result.
 *
 * The fixture matrix (`packages/contract/fixtures/window_series/cases.json`) is swept by
 * `artifacts.test.js`; the cases here are the ones that need a caller-side sentence.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { isBlocking, pairWindows, validateArtifact, windowKey } from '../lib/index.js'

const KIND = 'window_series'

/** A series in one line, so a test reads as the two runs it is talking about. */
function series(unit, windows) {
  return {
    schema_version: 1,
    unit,
    windows: windows.map(([index, start, end, metrics]) => ({ index, start, end, metrics })),
  }
}

const candidate = series('step', [
  [0, 0, 10, { metric_a: 1.5, metric_b: 0.25 }],
  [1, 10, 20, { metric_a: 1.25, metric_b: 0.3 }],
  [2, 20, 30, { metric_a: 1.1, metric_b: 0.35 }],
])

test('a window without an ordinal is refused by name — a row nobody can name is a row nobody can debug', () => {
  const result = validateArtifact(KIND, series('step', [[undefined, 0, 10, { metric_a: 1 }]]))
  assert.equal(result.status, 'missing')
  assert.match(result.message, /windows\[0\]\.index/)
})

test('a metric that is not a finite number is refused by name, not compared', () => {
  for (const [label, value] of [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1.5'],
    ['null', null],
  ]) {
    const result = validateArtifact(KIND, series('step', [[0, 0, 10, { metric_a: value }]]))
    assert.equal(result.status, 'invalid', `${label} must not pass as a measurement`)
    assert.match(result.message, /windows\[0\]\.metrics\.metric_a must be a finite number/)
  }
})

test('a series with no window is invalid — an empty result is a data failure, not a success', () => {
  const result = validateArtifact(KIND, series('step', []))
  assert.equal(result.status, 'invalid')
  assert.match(result.message, /windows must not be empty/)
})

test('the same bounds with different numbers is a conflict; an identical repeat is invalid', () => {
  const contradicted = validateArtifact(
    KIND,
    series('step', [
      [0, 0, 10, { metric_a: 1.5 }],
      [1, 0, 10, { metric_a: 1.6 }],
    ]),
  )
  assert.equal(contradicted.status, 'conflict', 'two accounts of one window is the fact plane disagreeing with itself')
  assert.match(contradicted.message, /\[0, 10\)/)

  const repeated = validateArtifact(
    KIND,
    series('step', [
      [0, 0, 10, { metric_a: 1.5 }],
      [1, 0, 10, { metric_a: 1.5 }],
    ]),
  )
  assert.equal(repeated.status, 'invalid', 'one row per window is the shape\'s promise, not a suggestion')
  assert.match(repeated.message, /repeats the window/)
})

test('windows are identified by their bounds, not by their position', () => {
  assert.equal(windowKey({ start: 0, end: 10 }), '0:10')
  assert.notEqual(windowKey({ start: 0, end: 10 }), windowKey({ start: 10, end: 20 }))
})

test('pairing keeps the intersection and names every window it dropped', () => {
  const baseline = series('step', [
    [0, 0, 10, { metric_a: 1.4, metric_b: 0.2 }],
    [1, 10, 20, { metric_a: 1.2, metric_b: 0.28 }],
    [2, 25, 35, { metric_a: 1.05, metric_b: 0.31 }],
    [3, 30, 40, { metric_a: 1.0, metric_b: 0.33 }],
  ])

  const pairing = pairWindows(candidate, baseline)

  assert.equal(pairing.status, 'ok', pairing.message)
  assert.equal(pairing.message, '', 'an ok pairing has nothing to warn about')
  assert.equal(pairing.unit, 'step')
  assert.deepEqual(
    pairing.pairs.map((pair) => [pair.start, pair.end]),
    [
      [0, 10],
      [10, 20],
    ],
    'only the windows both runs reported are comparable',
  )
  assert.deepEqual(
    pairing.dropped.candidate.map((window) => [window.start, window.end]),
    [[20, 30]],
    'the candidate window the baseline never measured is named, not paired with the nearest one',
  )
  assert.deepEqual(
    pairing.dropped.baseline.map((window) => [window.start, window.end]),
    [
      [25, 35],
      [30, 40],
    ],
    'and the baseline windows the candidate never measured are named too',
  )

  // A pair carries both sides' own ordinals and the numbers each side reported, so a comparison can
  // reach the values without re-joining the series.
  assert.deepEqual(pairing.pairs[1].candidate, { index: 1, metrics: { metric_a: 1.25, metric_b: 0.3 } })
  assert.deepEqual(pairing.pairs[1].baseline, { index: 1, metrics: { metric_a: 1.2, metric_b: 0.28 } })
  assert.deepEqual(pairing.pairs[1].comparable_metrics, ['metric_a', 'metric_b'])
  assert.deepEqual(pairing.pairs[1].candidate_only_metrics, [])
  assert.deepEqual(pairing.pairs[1].baseline_only_metrics, [])
})

test('a window that lines up on one bound only is not paired: bounds are an interval, not a start', () => {
  const pairing = pairWindows(series('step', [[0, 10, 20, { metric_a: 1 }]]), series('step', [[0, 10, 25, { metric_a: 1 }]]))
  assert.deepEqual(pairing.pairs, [])
  assert.equal(pairing.status, 'missing', 'no comparable window exists; nothing is malformed')
  assert.equal(isBlocking(pairing), true, 'a pairing that cannot compare must block the comparison')
  assert.match(pairing.message, /share no window/)
})

test('overlapping runs pair the windows they share and drop the tails: [2,3,4] against [1,2,3] compares 2 and 3 only', () => {
  const candidateWindows = series('step', [
    [0, 2, 3, { metric_a: 1.5 }],
    [1, 3, 4, { metric_a: 1.4 }],
    [2, 4, 5, { metric_a: 1.3 }],
  ])
  const baselineWindows = series('step', [
    [0, 1, 2, { metric_a: 1.45 }],
    [1, 2, 3, { metric_a: 1.42 }],
    [2, 3, 4, { metric_a: 1.35 }],
  ])

  const pairing = pairWindows(candidateWindows, baselineWindows)
  assert.equal(pairing.status, 'ok')
  assert.deepEqual(
    pairing.pairs.map((pair) => [pair.start, pair.end]),
    [
      [2, 3],
      [3, 4],
    ],
    'the intersection of the two runs, in the candidate\'s own order',
  )
  assert.deepEqual(pairing.dropped.candidate, [{ index: 2, start: 4, end: 5 }], 'the candidate ran on past the baseline')
  assert.deepEqual(pairing.dropped.baseline, [{ index: 0, start: 1, end: 2 }], 'the baseline started earlier than the candidate')
})

test('two runs counted in different units are not paired at all, and the reason names both units', () => {
  const pairing = pairWindows(
    series('step', [[0, 0, 10, { metric_a: 1 }]]),
    series('epoch', [[0, 0, 10, { metric_a: 1 }]]),
  )
  assert.deepEqual(pairing.pairs, [], '10 steps and 10 epochs are not the same interval')
  assert.equal(pairing.status, 'conflict', 'both sides are well-formed; they disagree about what a window covers')
  assert.match(pairing.message, /"step".*"epoch"/)
})

test('paired windows report the metric names both sides measured, and separate the rest', () => {
  const pairing = pairWindows(
    series('step', [[0, 0, 10, { metric_a: 1.5, metric_b: 0.25 }]]),
    series('step', [[0, 0, 10, { metric_b: 0.2, metric_c: 0.9 }]]),
  )
  assert.deepEqual(pairing.pairs[0].comparable_metrics, ['metric_b'], 'only a metric both sides measured can be compared')
  assert.deepEqual(
    pairing.pairs[0].candidate_only_metrics,
    ['metric_a'],
    'a metric one side measured and the other did not is reported per window, not silently dropped',
  )
  assert.deepEqual(pairing.pairs[0].baseline_only_metrics, ['metric_c'])
  assert.deepEqual(pairing.metrics, {
    common: ['metric_b'],
    candidate_only: ['metric_a'],
    baseline_only: ['metric_c'],
  })
  assert.equal(pairing.status, 'ok')
})

test('windows that line up but share no metric are not a comparison', () => {
  const pairing = pairWindows(
    series('step', [[0, 0, 10, { metric_a: 1.5 }]]),
    series('step', [[0, 0, 10, { metric_c: 0.9 }]]),
  )
  assert.equal(pairing.pairs.length, 1, 'the windows do line up…')
  assert.equal(pairing.status, 'missing', '…but comparing nothing is not a comparison')
  assert.match(pairing.message, /share no metric name/)
  assert.match(pairing.message, /metric_a/)
  assert.match(pairing.message, /metric_c/)
})

test('a side that is not a series is a refusal with a reason, never a crash', () => {
  const baseline = series('step', [[0, 0, 10, { metric_a: 1 }]])

  // Nothing there is `missing`: the window series was never produced.
  const absent = pairWindows(undefined, baseline)
  assert.equal(absent.status, 'missing')
  assert.match(absent.message, /no candidate window series/)

  // There, and not a series, is `invalid`: the two states are recovered from differently.
  for (const [label, side] of [
    ['a string', 'windows'],
    ['no windows array', { unit: 'step' }],
    ['a window that is not an object', { unit: 'step', windows: [3] }],
  ]) {
    const pairing = pairWindows(side, baseline)
    assert.equal(pairing.status, 'invalid', `${label} exists and breaks the shape`)
    assert.deepEqual(pairing.pairs, [])
    assert.match(pairing.message, /not a window series/, `${label} must say what it could not read`)
  }
})

test('pairing one run against itself pairs every window — the trivial case a comparison must get right', () => {
  const pairing = pairWindows(candidate, candidate)
  assert.equal(pairing.status, 'ok')
  assert.equal(pairing.pairs.length, candidate.windows.length)
  assert.deepEqual(pairing.dropped, { candidate: [], baseline: [] })
  for (const pair of pairing.pairs) {
    assert.deepEqual(pair.candidate.metrics, pair.baseline.metrics)
  }
})