/**
 * Where the executor adapter meets the contract: the samples it parses are the samples the kernel's
 * validator accepts and pairs.
 *
 * Contract guarded (spec "事实面": artifacts are files validated by a validator; "Testing Decisions":
 * the executor boundary is an adapter and the shape is the contract); ticket 19, "窗口化样本". Two
 * lines are held here, and neither can be checked from inside one package:
 *
 *   1. the series `lib/window-samples.js` parses out of the recorded cluster event file is **accepted
 *      by the contract's validator**, at the version the contract speaks — the adapter cannot quietly
 *      invent a shape, and the validator cannot quietly change one without this failing;
 *   2. a candidate and a baseline are compared **only** where their window bounds agree: runs
 *      evaluated every 10 steps and every 20 steps share no window, and that is a refusal with a
 *      reason rather than a comparison of window 0 against window 0.
 *
 * The contract is imported by relative path on purpose. `packages/exec` declares no dependency on
 * `@dsh-reprise/contract` — the adapter returns a classified outcome and the kernel decides what it
 * means (see `packages/exec/README.md`) — so this crossing exists only in test glue, and writing it
 * as a package import would turn a test-only edge into a dependency the manifest would have to lie
 * about. The fixture is the recorded one this package parses.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { artifactSchemaVersion, pairWindows, validateArtifact, WINDOW_SERIES_KIND } from '../../contract/lib/index.js'
import { parseEventFile } from '../lib/window-samples.js'

const EVENTS = readFileSync(new URL('./fixtures/tensorboard/scalars-4x3.tfevents', import.meta.url))

function seriesFrom(windowSteps) {
  const parsed = parseEventFile(EVENTS, { window_steps: windowSteps })
  assert.equal(parsed.ok, true, `the recorded event file must parse: ${parsed.reason}`)
  return parsed.series
}

test('the series the adapter parses is one the kernel\'s validator accepts, at the contract\'s version', () => {
  const series = seriesFrom(10)

  const verdict = validateArtifact(WINDOW_SERIES_KIND, series)
  assert.equal(verdict.status, 'ok', `the adapter writes the contract's shape, not its own: ${verdict.message}`)
  assert.equal(
    series.schema_version,
    artifactSchemaVersion(WINDOW_SERIES_KIND),
    'one version number for the document, or the contract cannot refuse a series it cannot read',
  )
})

test('two runs evaluated at the same steps pair window by window, and every metric both measured is comparable', () => {
  const pairing = pairWindows(seriesFrom(10), seriesFrom(10))

  assert.equal(pairing.status, 'ok', pairing.message)
  assert.equal(pairing.pairs.length, 4)
  assert.deepEqual(pairing.dropped, { candidate: [], baseline: [] })
  assert.deepEqual(
    pairing.metrics.common,
    ['eval/hr@10', 'eval/ndcg@10', 'train/loss'],
    'the metric names come from the samples, which is why the kernel never has to know them',
  )

  // A paired window carries both sides' own ordinals and both sides' numbers, so the comparison can
  // be made from the pairing alone rather than by re-reading either series.
  const [firstPair] = pairing.pairs
  assert.deepEqual([firstPair.start, firstPair.end], [0, 10])
  assert.deepEqual(Object.keys(firstPair.candidate.metrics), Object.keys(firstPair.baseline.metrics))
})

test('a baseline evaluated at different steps shares no window, so nothing is compared', () => {
  const pairing = pairWindows(seriesFrom(10), seriesFrom(20))

  assert.equal(pairing.status, 'missing', 'no comparable window exists; nothing is malformed')
  assert.deepEqual(pairing.pairs, [], 'pairing window 0 with window 0 here would compare two different amounts of training')
  assert.deepEqual(
    pairing.dropped.candidate.map((window) => [window.start, window.end]),
    [
      [0, 10],
      [10, 20],
      [20, 30],
      [30, 40],
    ],
  )
  assert.match(pairing.message, /share no window/)
})

test('a window the baseline never evaluated is named in the dropped list and kept out of the comparison', () => {
  const candidate = seriesFrom(10)
  const { windows } = seriesFrom(10)
  const baseline = {
    ...seriesFrom(10),
    windows: [windows[0], windows[2], windows[3]].map((window, index) => ({ ...window, index })),
  }

  const pairing = pairWindows(candidate, baseline)
  assert.deepEqual(
    pairing.pairs.map((pair) => [pair.start, pair.end]),
    [
      [0, 10],
      [20, 30],
      [30, 40],
    ],
  )
  assert.deepEqual(
    pairing.dropped.candidate.map((window) => [window.start, window.end]),
    [[10, 20]],
    'the candidate\'s second window has no baseline window with the same bounds, so it is not compared',
  )
  assert.deepEqual(pairing.dropped.baseline, [])
  assert.equal(validateArtifact(WINDOW_SERIES_KIND, baseline).status, 'ok', 're-numbering an ordinal does not break the shape')
})

test('a series the adapter refuses stays refused: no window is a data failure, not an empty comparison', () => {
  const headerOnly = EVENTS.subarray(0, 12 + 72 + 4)
  const parsed = parseEventFile(headerOnly, { window_steps: 10 })

  assert.equal(parsed.ok, false)
  assert.equal(parsed.error_class, 'data')
  assert.match(parsed.reason, /no finite scalar point/)

  // The failure is not something the pairing has to interpret: there is no series to pair.
  const pairing = pairWindows(undefined, seriesFrom(10))
  assert.equal(pairing.status, 'missing', 'nothing was handed over, and that is a missing measurement, not a malformed one')
  assert.match(pairing.message, /no candidate window series/)
})