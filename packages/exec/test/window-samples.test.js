/**
 * The windowed-sample adapters: a tensorboard event file and a driver-log payload become one row per
 * window, and nothing that produced no window is allowed to look like a success.
 *
 * Contract guarded (spec "事实面": artifacts are files validated by a validator; "契约": four states;
 * cluster note "19 / 27": the windowed samples come back through the log and a truncated or absent
 * payload must be a `data` failure); ticket 19, "窗口化样本". Four properties:
 *
 *   1. **A real event file parses into the contract's shape.** `test/fixtures/tensorboard/scalars-4x3.tfevents`
 *      is not invented: it was written by `torch.utils.tensorboard.SummaryWriter` on the GPU node
 *      (4 steps × 3 tags) and came back through the driver log. Expectations below are `fround()`
 *      of the numbers the writer was given, because a tensorboard scalar is a float32 — deriving
 *      them any other way would make this test assert the parser against itself.
 *   2. **The same window parsed twice is byte-identical.** Determinism is checked as text equality.
 *   3. **A parse that finds no window is a `data` failure with a reason** — a clipped log, a record
 *      that lost its checksum, a file holding only its `file_version`.
 *   4. **Windows are configured, not guessed.** `window_steps` is required and a window's value is
 *      the mean of the finite points inside it.
 *
 * What is *not* checked here: whether the windows are individually well-formed. That is the
 * contract's validator, and `packages/core/test/windowed-samples.test.js` pins that this adapter's
 * output passes it.
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'

import { WINDOW_MARKER, parseEventFile, parseWindowLog, windowsFromPoints } from '../lib/window-samples.js'

const FIXTURE = new URL('./fixtures/tensorboard/scalars-4x3.tfevents', import.meta.url)
const EVENTS = readFileSync(FIXTURE)

/**
 * A float32 round trip: the writer stored `0.28` as a float, so the exact double a reader must report
 * is `Math.fround(0.28)`. Written as a helper so the expectation is derived from the recorded value,
 * not from the parser.
 */
const stored = Math.fround

const seriesOf = (result) => {
  assert.equal(result.ok, true, `expected a series, got: ${result.reason}`)
  return result.series
}

test('the recorded event file parses into one sample per window, with each tag in the window it was written', () => {
  const series = seriesOf(parseEventFile(EVENTS, { window_steps: 10 }))

  assert.equal(series.unit, 'step', 'the windows are counted in training steps, which is what a tensorboard step is')
  assert.deepEqual(
    series.windows.map((window) => [window.index, window.start, window.end]),
    [
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
      [3, 30, 40],
    ],
    'four steps recorded, four windows, and the bounds are the half-open intervals they cover',
  )

  assert.deepEqual(series.windows[0].metrics, {
    'eval/hr@10': stored(0.28),
    'eval/ndcg@10': stored(0.16),
    'train/loss': stored(1),
  })
  assert.deepEqual(series.windows[3].metrics, {
    'eval/hr@10': stored(0.292),
    'eval/ndcg@10': stored(0.166),
    'train/loss': stored(0.25),
  })

  // Key order is part of "the same window parses to the same samples": a table written in hash
  // order would compare unequal to itself across runs.
  for (const window of series.windows) {
    assert.deepEqual(Object.keys(window.metrics), ['eval/hr@10', 'eval/ndcg@10', 'train/loss'])
  }
})

test('the same window parsed twice is byte-identical', () => {
  const first = seriesOf(parseEventFile(EVENTS, { window_steps: 10 }))
  const second = seriesOf(parseEventFile(EVENTS, { window_steps: 10 }))
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'a parser with a clock or a random order would fail here')
  assert.deepEqual(second, first)
})

test('a window holds the mean of the finite points inside it, so a wider window keeps every step', () => {
  const series = seriesOf(parseEventFile(EVENTS, { window_steps: 20 }))

  assert.deepEqual(
    series.windows.map((window) => [window.start, window.end]),
    [
      [0, 20],
      [20, 40],
    ],
  )
  // Steps 0 and 10 fall in the first window; the mean of the two recorded values is what it reports.
  assert.equal(series.windows[0].metrics['eval/hr@10'], (stored(0.28) + stored(0.284)) / 2)
  assert.equal(series.windows[1].metrics['eval/hr@10'], (stored(0.288) + stored(0.292)) / 2)
  assert.equal(series.windows[0].metrics['train/loss'], (stored(1) + stored(0.5)) / 2)
})

test('a non-finite point is not a measurement: it is left out of the window instead of poisoning it', () => {
  const result = windowsFromPoints(
    [
      { tag: 'metric_a', step: 0, value: 2 },
      { tag: 'metric_a', step: 1, value: Number.NaN },
      { tag: 'metric_b', step: 2, value: Number.POSITIVE_INFINITY },
    ],
    { window_steps: 10 },
  )
  const series = seriesOf(result)

  assert.equal(series.windows.length, 1)
  assert.deepEqual(series.windows[0].metrics, { metric_a: 2 }, 'a tag with no finite point in the window is absent from it')
})

test('a window of no steps is refused at the seam, because a window is a choice and not a default', () => {
  for (const windowSteps of [0, -5, 2.5, undefined, '10']) {
    assert.throws(
      () => parseEventFile(EVENTS, { window_steps: windowSteps }),
      (error) => error instanceof TypeError && /window_steps/.test(error.message),
      `${JSON.stringify(windowSteps)} must not become a window size`,
    )
  }
})

test('a clipped event file is a data failure naming the byte, not a short series', () => {
  const clipped = EVENTS.subarray(0, EVENTS.length - 5)
  const result = parseEventFile(clipped, { window_steps: 10 })

  assert.equal(result.ok, false)
  assert.equal(result.error_class, 'data', 'a truncated payload is the world giving us garbage, not a candidate defect')
  assert.match(result.reason, /ends mid-record/)
  assert.match(result.reason, /byte \d+/, 'the reason has to say where, or nobody can fix the log capture')
})

test('a record whose bytes changed in transit is a data failure, not a number nobody can vouch for', () => {
  const corrupted = Buffer.from(EVENTS)
  // Inside the last record's payload: framing survives, so only the checksum can catch this.
  corrupted[corrupted.length - 30] ^= 0xff
  const result = parseEventFile(corrupted, { window_steps: 10 })

  assert.equal(result.ok, false)
  assert.equal(result.error_class, 'data')
  assert.match(result.reason, /checksum/)
})

test('an event file that holds only its file_version is a data failure: no measurement is not an empty success', () => {
  // The first record is the writer's `brain.Event:2` header; keeping only it leaves a well-formed
  // file with no scalar summary anywhere in it.
  const headerOnly = EVENTS.subarray(0, 12 + 72 + 4)
  const result = parseEventFile(headerOnly, { window_steps: 10 })

  assert.equal(result.ok, false)
  assert.equal(result.error_class, 'data')
  assert.match(result.reason, /no finite scalar point/)
  assert.match(result.reason, /1 record\(s\)/, 'the reason counts what it did read, so "empty file" and "no scalars" differ')
})

test('the fixture really is the recorded file, not something this test wrote', () => {
  assert.equal(statSync(FIXTURE).size, 666, 'the cluster job returned 666 bytes; a regenerated fixture would change this')
})

// ---------------------------------------------------------------- the driver-log channel

const LOG = [
  'epoch 0 loss 1.0',
  `${WINDOW_MARKER} {"schema_version":1,"unit":"step","windows":[{"index":0,"start":0,"end":10,"metrics":{"metric_a":1.5}},{"index":1,"start":10,"end":20,"metrics":{"metric_a":1.25}}]}`,
  'done',
].join('\n')

test('the driver log carries the whole series on one marker line, and it comes back unchanged', () => {
  const series = seriesOf(parseWindowLog(LOG))
  assert.deepEqual(
    series.windows.map((window) => [window.index, window.start, window.end]),
    [
      [0, 0, 10],
      [1, 10, 20],
    ],
  )
  assert.equal(series.unit, 'step')
  assert.deepEqual(series.windows[1].metrics, { metric_a: 1.25 })
})

test('a log with no marker line is a data failure that counts what it read', () => {
  const result = parseWindowLog('epoch 0 loss 1.0\ndone')
  assert.equal(result.ok, false)
  assert.equal(result.error_class, 'data')
  assert.match(result.reason, /no REPRISE_WINDOWS line/)
  assert.match(result.reason, /2 line\(s\) read/)
})

test('a clipped marker line is a data failure, not an empty result', () => {
  const clipped = `${WINDOW_MARKER} {"schema_version":1,"unit":"step","windows":[{"index":0,`
  const result = parseWindowLog(clipped)
  assert.equal(result.ok, false)
  assert.equal(result.error_class, 'data')
  assert.match(result.reason, /not JSON/)
  assert.match(result.reason, /line 1/)
})

test('a payload that holds no window is a data failure with the reason', () => {
  for (const payload of ['{"unit":"step","windows":[]}', '{"unit":"step"}', '{"unit":"step","windows":"two"}']) {
    const result = parseWindowLog(`${WINDOW_MARKER} ${payload}`)
    assert.equal(result.ok, false, payload)
    assert.equal(result.error_class, 'data')
    assert.match(result.reason, /holds no window/)
  }
})

test('the same series printed twice is the same run; two different ones are a failure', () => {
  const repeated = parseWindowLog(`${LOG}\n${LOG.split('\n')[1]}`)
  assert.equal(repeated.ok, true, 'a resumed job may print its series again — the same payload is the same run')
  assert.deepEqual(repeated.series, seriesOf(parseWindowLog(LOG)))

  const disagreeing = `${WINDOW_MARKER} {"unit":"step","windows":[{"index":0,"start":0,"end":10,"metrics":{"metric_a":1.5}}]}
${WINDOW_MARKER} {"unit":"step","windows":[{"index":0,"start":0,"end":10,"metrics":{"metric_a":1.6}}]}`
  const result = parseWindowLog(disagreeing)
  assert.equal(result.ok, false)
  assert.match(result.reason, /two REPRISE_WINDOWS payloads disagree/)
  assert.match(result.reason, /lines 1 and 2/)
})

test('the marker is read wherever it starts a line, and ordinary output around it is ignored', () => {
  const noisy = `\u001b[32mtrainer\u001b[0m: step 40\n  ${WINDOW_MARKER} ${JSON.stringify({
    unit: 'step',
    windows: [{ index: 0, start: 0, end: 40, metrics: { metric_a: 1 } }],
  })}\nreprise: done`
  const series = seriesOf(parseWindowLog(noisy))
  assert.equal(series.windows.length, 1)
})