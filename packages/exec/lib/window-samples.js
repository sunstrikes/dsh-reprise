/**
 * The windowed-sample adapters: bytes in, windowed samples out.
 *
 * The kernel accepts exactly one shape for "how did this run evolve" — the `window_series` artifact
 * defined in `@dsh-reprise/contract`, one row per window. How a run *reports* its numbers is the
 * executor's dialect, and nothing about it belongs in the kernel:
 *
 *   - `parseEventFile()` — a tensorboard event file (the recorded fixture
 *     `test/fixtures/tensorboard/scalars-4x3.tfevents` is a real one, written by
 *     `torch.utils.tensorboard.SummaryWriter` on the cluster);
 *   - `parseWindowLog()` — the driver log, which is the only channel back from a cluster with no
 *     shared filesystem: one line per run, `REPRISE_WINDOWS {json}`, carrying the series the job
 *     summarised itself.
 *
 * Three rules these adapters hold, all of them consequences of that missing filesystem:
 *
 * 1. **No window is a `data` failure, never an empty success.** A run that reported nothing did not
 *    measure anything, and the platform port already has a word for that: `error_class: 'data'`.
 *    Every refusal below carries the reason a log line needs.
 * 2. **The same bytes parse to the same samples.** No clock, no randomness, no key order from
 *    object identity: the metrics table is written name-sorted, and windows are emitted in window
 *    order. Re-parsing one window twice yields byte-identical JSON.
 * 3. **Presence is decided here; acceptability is decided by the contract.** These functions answer
 *    "were there windows, and what were they?" — the validator
 *    (`validateArtifact('window_series', …)`) answers "is each one well-formed?". Duplicating the
 *    validator here would create a second authority for the shape, and the two would drift.
 *
 * `windowsFromPoints()` is the one place a windowing rule lives. It is deliberately arithmetic and
 * explicit: a window is `window_steps` steps wide, window *n* covers `[n·w, (n+1)·w)`, and each
 * metric's value in it is the mean of the finite points recorded inside it. Nothing here guesses a
 * window size — it has to be configured, because a window is a choice about the experiment, not
 * something a parser can discover.
 *
 * @module
 */

import { readEventRecords, readScalarPoints } from './window-events.js'

/** The marker a job prints once, on its own line, with the whole series as JSON. */
export const WINDOW_MARKER = 'REPRISE_WINDOWS'

/** The document version the adapters write; the contract package owns the authoritative number. */
export const WINDOW_SAMPLE_VERSION = 1

const refused = (reason) => ({ ok: false, error_class: 'data', reason })

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** A key-sorted JSON text, so "two payloads agree" does not depend on property order. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const names = Object.keys(value).sort()
    return `{${names.map((name) => `${JSON.stringify(name)}:${stableJson(value[name])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function assertWindow({ window_steps: windowSteps, unit }) {
  if (!Number.isSafeInteger(windowSteps) || windowSteps <= 0) {
    throw new TypeError('window_steps must be a positive integer — a window of no steps holds no measurement')
  }
  if (typeof unit !== 'string' || unit.trim() === '') {
    throw new TypeError('unit must be a non-empty string naming what the window bounds are counted in')
  }
}

/**
 * Turn scalar points into windowed samples.
 *
 * A non-finite point (a `nan` loss spike, an `inf` gradient) is **not a measurement** and is left out
 * of its window's mean rather than poisoning it; a tag with no finite point inside a window is
 * absent from that window's metrics table. That is the difference between "this window measured
 * nothing for that tag" and "this window's number is not a number", and only the first is true.
 *
 * @param {Array<{ tag: string, step: number, value: number }>} points
 * @param {{ window_steps: number, unit?: string, source?: string }} options
 * @returns {{ ok: true, series: object } | { ok: false, error_class: 'data', reason: string }}
 */
export function windowsFromPoints(points, { window_steps: windowSteps, unit = 'step', source = 'the payload' } = {}) {
  assertWindow({ window_steps: windowSteps, unit })
  if (!Array.isArray(points)) throw new TypeError('windowsFromPoints needs an array of scalar points')

  /** @type {Map<number, Map<string, number[]>>} */
  const buckets = new Map()
  for (const point of points) {
    if (typeof point?.tag !== 'string' || point.tag.trim() === '') continue
    if (!Number.isSafeInteger(point.step) || point.step < 0) continue
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) continue
    const index = Math.floor(point.step / windowSteps)
    if (!buckets.has(index)) buckets.set(index, new Map())
    const byTag = buckets.get(index)
    if (!byTag.has(point.tag)) byTag.set(point.tag, [])
    byTag.get(point.tag).push(point.value)
  }

  if (buckets.size === 0) {
    return refused(`no finite scalar point was read from ${source} — a run without a measurement is not a result`)
  }

  const windows = [...buckets.keys()]
    .sort((left, right) => left - right)
    .map((index) => {
      const byTag = buckets.get(index)
      /** @type {Record<string, number>} */
      const metrics = {}
      for (const tag of [...byTag.keys()].sort()) {
        const values = byTag.get(tag)
        metrics[tag] = values.reduce((total, value) => total + value, 0) / values.length
      }
      return { index, start: index * windowSteps, end: (index + 1) * windowSteps, metrics }
    })

  return { ok: true, series: { schema_version: WINDOW_SAMPLE_VERSION, unit, windows } }
}

/**
 * Parse a tensorboard event file.
 *
 * `window_steps` is required: the file records when a number was written and at which step, never
 * how wide a window should be.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {{ window_steps: number, unit?: string }} options
 */
export function parseEventFile(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('parseEventFile needs the event file bytes — read the file where the bytes are')
  }
  assertWindow({ window_steps: options.window_steps, unit: options.unit ?? 'step' })

  const framed = readEventRecords(bytes)
  if (!framed.ok) return refused(framed.reason)

  const scalars = readScalarPoints(framed.records)
  if (!scalars.ok) return refused(scalars.reason)

  return windowsFromPoints(scalars.points, {
    window_steps: options.window_steps,
    unit: options.unit ?? 'step',
    source: `the event file (${framed.records.length} record(s), ${scalars.summaries} summary value(s))`,
  })
}

/**
 * Parse the driver log a cluster job's payload comes back through.
 *
 * The job prints one line, `REPRISE_WINDOWS {json}`, holding the whole series. One line rather than
 * one per window, because a log is truncated at the end: a whole-series line either survived intact
 * or is visibly broken, while per-window lines would leave a half series that looks complete.
 *
 * A repeated identical line is the same series printed twice (a resumed job), and is accepted. Two
 * lines that disagree are two accounts of one run, reported as a `data` failure instead of the last
 * one silently winning.
 *
 * @param {string} text
 * @returns {{ ok: true, series: object } | { ok: false, error_class: 'data', reason: string }}
 */
export function parseWindowLog(text) {
  if (typeof text !== 'string') throw new TypeError('parseWindowLog needs the log text')

  const lines = text.split('\n')
  const payloads = []
  for (const [position, line] of lines.entries()) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(WINDOW_MARKER)) continue
    const body = trimmed.slice(WINDOW_MARKER.length).trim()
    try {
      payloads.push({ line: position + 1, payload: JSON.parse(body) })
    } catch (error) {
      return refused(
        `the ${WINDOW_MARKER} payload on line ${position + 1} is not JSON (${messageOf(error)}) — a truncated or clipped payload is a data failure, not an empty result`,
      )
    }
  }

  if (payloads.length === 0) {
    return refused(
      `the log holds no ${WINDOW_MARKER} line (${lines.length} line(s) read) — the job ran but reported no window; a run without a measurement is not a result`,
    )
  }

  const [first] = payloads
  for (const later of payloads.slice(1)) {
    if (stableJson(later.payload) !== stableJson(first.payload)) {
      return refused(
        `two ${WINDOW_MARKER} payloads disagree (lines ${first.line} and ${later.line}) — the log holds two accounts of one run`,
      )
    }
  }

  const windows = first.payload?.windows
  if (!Array.isArray(windows) || windows.length === 0) {
    return refused(
      `the ${WINDOW_MARKER} payload on line ${first.line} holds no window (windows is ${Array.isArray(windows) ? 'empty' : JSON.stringify(windows) ?? String(windows)}) — a run without a measurement is not a result`,
    )
  }

  return { ok: true, series: first.payload }
}