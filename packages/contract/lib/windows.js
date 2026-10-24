/**
 * Windowed samples: metrics summarised one row per window, so any later decision can pair a
 * candidate against its baseline window by window instead of against a single number.
 *
 * Why this is a shape and not a parser: training output arrives in whatever medium the executor
 * speaks (a tensorboard event file, a marker line in the driver log, a JSON document inside the job
 * package). Reading that medium is the adapter's job, in `packages/exec`. What crosses into the
 * fact plane is *this* document — six names, no domain vocabulary in sight:
 *
 * ```json
 * {
 *   "schema_version": 1,
 *   "unit": "step",
 *   "windows": [
 *     { "index": 0, "start": 0, "end": 10, "metrics": { "metric_a": 1.5, "metric_b": 0.25 } },
 *     { "index": 1, "start": 10, "end": 20, "metrics": { "metric_a": 1.25 } }
 *   ]
 * }
 * ```
 *
 * | field | type | meaning |
 * |---|---|---|
 * | `unit` | non-empty string | the progress unit `start`/`end` are counted in (`"step"`, `"epoch"`, `"second"`). Two series in different units are not comparable, and pairing says so instead of comparing 10 to 10. |
 * | `windows[].index` | non-negative integer | the window's ordinal in the run, strictly increasing. Gaps are allowed (an adapter may drop a window it could not read); a repeat is not. |
 * | `windows[].start` | non-negative integer | the first unit **inside** the window |
 * | `windows[].end` | non-negative integer | the first unit **after** the window, so a window is the half-open interval `[start, end)` and has a non-zero length |
 * | `windows[].metrics` | object of finite numbers | what this window measured, keyed by the metric's own name. The kernel never learns which names mean anything: which metric is primary, and whether a run is read as the mean of its windows or as its last window, are the metric contract's business. |
 *
 * `schema_version` is this document's, not the database's, for the same reason every other
 * artifact's is (see `artifact.js`): the document is carried away by git and read by tools outside
 * this process.
 *
 * Four-state rules worth stating, because they are the ones a validator exists to keep apart:
 *
 *  - an empty `windows` list is **invalid**, never an empty success — a run that produced no window
 *    produced no measurement, and an adapter that cannot find one must report a `data` failure;
 *  - a window repeated with the *same* numbers is **invalid** (a series holds one row per window);
 *  - the same bounds claiming *different* numbers is a **conflict** — two accounts of one window,
 *    which is a finding about the fact plane rather than a malformed document.
 *
 * @module
 */

import { artifactKinds, checkField, defineArtifact, isCount, isNonEmptyString, isPlainObject } from './artifact.js'

/** The artifact kind name. Adapters and consumers quote it; nothing here quotes a metric name. */
export const WINDOW_SERIES_KIND = 'window_series'

/** The document version this kernel writes and reads. */
export const WINDOW_SERIES_VERSION = 1

/**
 * The pairing key for a window: its bounds, in the form a `Map` can hold.
 *
 * Deliberately not the index — two runs number their windows from their own first step, and "window
 * 3" of a candidate is not "window 3" of the baseline unless the bounds agree. Windows are paired
 * by what they cover, never by where they sit in an array.
 */
export const windowKey = (window) => `${window?.start}:${window?.end}`

/**
 * `checkField` for a field inside a list, where the message has to name the position as well as the
 * field: `windows[3].index is required` is actionable, `index is required` is not.
 */
function checkWindowField(findings, window, at, field, predicate, why) {
  if (!(field in window) || window[field] === undefined || window[field] === null) {
    findings.missing.push(`${at}.${field} is required`)
    return
  }
  if (!predicate(window[field])) findings.invalid.push(`${at}.${field} ${why}`)
}

/** A stable signature for a window's measurements, used only to tell "repeated" from "contradicted". */
function metricsSignature(metrics) {
  const names = Object.keys(metrics).sort()
  return JSON.stringify(names.map((name) => [name, metrics[name]]))
}

/**
 * The validator. Three lists, never a boolean, and every message names the field and the position
 * so an operator reading a rejected artifact can fix it without opening this file.
 *
 * @param {unknown} value
 * @returns {{ missing?: string[], invalid?: string[], conflict?: string[] }}
 */
export function checkWindowSeries(value) {
  if (!isPlainObject(value)) return { invalid: ['window_series must be an object'] }
  const findings = { missing: [], invalid: [], conflict: [] }

  checkField(
    findings,
    value,
    'unit',
    isNonEmptyString,
    'must name the unit the window bounds are counted in (for example "step")',
  )
  checkField(findings, value, 'windows', Array.isArray, 'must be an array of window samples')

  const windows = Array.isArray(value.windows) ? value.windows : []
  if (Array.isArray(value.windows) && windows.length === 0) {
    findings.invalid.push('windows must not be empty — a run that produced no window produced no measurement')
  }

  /** @type {Map<string, { position: number, signature: string }>} */
  const seen = new Map()
  let previousIndex
  let previousStart

  for (const [position, window] of windows.entries()) {
    const at = `windows[${position}]`
    if (!isPlainObject(window)) {
      findings.invalid.push(`${at} must be an object`)
      continue
    }

    checkWindowField(findings, window, at, 'index', isCount, 'must be a non-negative integer window ordinal')
    checkWindowField(findings, window, at, 'start', isCount, 'must be a non-negative integer, the first unit inside the window')
    checkWindowField(findings, window, at, 'end', isCount, 'must be a non-negative integer, the first unit after the window')
    checkWindowField(findings, window, at, 'metrics', isPlainObject, 'must be an object of metric name -> finite number')

    // Ordinals identify the row, so they are the one ordering a series must have.
    if (isCount(window.index)) {
      if (previousIndex !== undefined && window.index <= previousIndex) {
        findings.invalid.push(`${at}.index must be greater than ${previousIndex} — a series is ordered by window ordinal`)
      }
      previousIndex = window.index
    }

    // Bounds may not run backwards, but a repeated pair is a documented case (see below), so this
    // check is non-decreasing rather than strictly increasing.
    if (isCount(window.start)) {
      if (previousStart !== undefined && window.start < previousStart) {
        findings.invalid.push(`${at}.start must not go backwards: ${window.start} follows ${previousStart}`)
      }
      previousStart = window.start
    }

    if (isCount(window.start) && isCount(window.end) && window.end <= window.start) {
      findings.invalid.push(`${at}.end must be greater than ${at}.start (${window.start}) — a window has a length`)
    }

    if (isPlainObject(window.metrics)) {
      const names = Object.keys(window.metrics)
      if (names.length === 0) {
        findings.invalid.push(`${at}.metrics must not be empty — a window with no measurement is not a sample`)
      }
      for (const name of names) {
        if (name.trim() === '') findings.invalid.push(`${at}.metrics must not hold an empty metric name`)
        const measured = window.metrics[name]
        if (typeof measured !== 'number' || !Number.isFinite(measured)) {
          findings.invalid.push(`${at}.metrics.${name} must be a finite number`)
        }
      }
    }

    if (isCount(window.start) && isCount(window.end) && window.end > window.start) {
      const key = windowKey(window)
      const earlier = seen.get(key)
      if (earlier === undefined) {
        const signature = isPlainObject(window.metrics) ? metricsSignature(window.metrics) : ''
        seen.set(key, { position, signature })
      } else if (earlier.signature === (isPlainObject(window.metrics) ? metricsSignature(window.metrics) : '')) {
        findings.invalid.push(`${at} repeats the window [${window.start}, ${window.end}) — a series holds one row per window`)
      } else {
        findings.conflict.push(
          `${at} and windows[${earlier.position}] both claim the window [${window.start}, ${window.end}) with different metrics`,
        )
      }
    }
  }

  return findings
}

// Registered through the contract's own seam, and guarded because a second `defineArtifact` for one
// kind throws — a host may load this module through both the package index and a direct import.
if (!artifactKinds().includes(WINDOW_SERIES_KIND)) {
  defineArtifact({
    kind: WINDOW_SERIES_KIND,
    description: 'One row per window: what this run measured over each interval, so runs are compared window by window',
    schemaVersion: WINDOW_SERIES_VERSION,
    check: checkWindowSeries,
  })
}

/** The windows of a value, or `undefined` when the value is not shaped like a series at all. */
function windowsOf(series) {
  if (!isPlainObject(series) || !Array.isArray(series.windows)) return undefined
  if (!series.windows.every(isPlainObject)) return undefined
  return series.windows
}

/** Every metric name the series measured, sorted — the vocabulary this series speaks. */
function metricNames(windows) {
  const names = new Set()
  for (const window of windows) {
    if (!isPlainObject(window.metrics)) continue
    for (const name of Object.keys(window.metrics)) names.add(name)
  }
  return [...names].sort()
}

/** The metric names both of these two windows measured, sorted. */
function sharedMetricNames(left, right) {
  if (!isPlainObject(left.metrics) || !isPlainObject(right.metrics)) return []
  const inRight = new Set(Object.keys(right.metrics))
  return Object.keys(left.metrics)
    .filter((name) => inRight.has(name))
    .sort()
}

function describe(window) {
  return { index: window.index, start: window.start, end: window.end }
}

function describeNames(names) {
  return names.length === 0 ? 'none' : names.join(', ')
}

/**
 * Pair a candidate's window series with its baseline's, by window bounds, keeping only the
 * intersection.
 *
 * Why the intersection and not a join: a comparison that pairs window 3 with window 3 of a baseline
 * which evaluated at different steps compares two different amounts of training and calls the
 * difference an improvement. Two windows are comparable only when they cover the same interval, so
 * a window whose bounds the other side never reported is **dropped and named**, not paired with the
 * nearest thing.
 *
 * `comparable` is false when nothing can be compared (no window lines up, or the lined-up windows
 * share no metric). `reason` says which, in a sentence a caller can log — this is a `data` problem
 * in the language of the platform port, never an equal result. Both series are expected to have
 * passed `validateArtifact('window_series', …)` first; this function reports what it could not read
 * rather than throwing, because a log that cannot be paired must not crash a tick.
 *
 * @param {{unit?: string, windows?: unknown[]}} candidate
 * @param {{unit?: string, windows?: unknown[]}} baseline
 * @returns {{
 *   unit: string | null,
 *   pairs: Array<{ start: number, end: number, candidate: { index: number, metrics: object }, baseline: { index: number, metrics: object }, metrics: string[] }>,
 *   dropped: { candidate: Array<{ index: number, start: number, end: number }>, baseline: Array<{ index: number, start: number, end: number }> },
 *   metrics: { common: string[], candidate_only: string[], baseline_only: string[] },
 *   comparable: boolean,
 *   reason: string | undefined,
 * }}
 */
export function pairWindows(candidate, baseline) {
  const candidateWindows = windowsOf(candidate)
  const baselineWindows = windowsOf(baseline)
  const refusal = {
    unit: null,
    pairs: [],
    dropped: { candidate: [], baseline: [] },
    metrics: { common: [], candidate_only: [], baseline_only: [] },
    comparable: false,
    reason: undefined,
  }

  if (candidateWindows === undefined) {
    return { ...refusal, reason: 'the candidate side is not a window series: it holds no windows array' }
  }
  if (baselineWindows === undefined) {
    return { ...refusal, reason: 'the baseline side is not a window series: it holds no windows array' }
  }
  if (candidate.unit !== baseline.unit) {
    return {
      ...refusal,
      dropped: { candidate: candidateWindows.map(describe), baseline: baselineWindows.map(describe) },
      metrics: {
        common: [],
        candidate_only: metricNames(candidateWindows),
        baseline_only: metricNames(baselineWindows),
      },
      reason: `the candidate is counted in ${JSON.stringify(candidate.unit)} and the baseline in ${JSON.stringify(baseline.unit)}: two units cannot be paired, so neither window list means what the other says`,
    }
  }

  /** @type {Map<string, object>} */
  const baselineByBounds = new Map()
  for (const window of baselineWindows) {
    const key = windowKey(window)
    // First account wins. Duplicates within one series are the validator's business, not ours.
    if (!baselineByBounds.has(key)) baselineByBounds.set(key, window)
  }

  const pairs = []
  const droppedCandidate = []
  const paired = new Set()
  for (const window of candidateWindows) {
    const key = windowKey(window)
    const match = baselineByBounds.get(key)
    if (match === undefined) {
      droppedCandidate.push(describe(window))
      continue
    }
    paired.add(key)
    pairs.push({
      start: window.start,
      end: window.end,
      candidate: { index: window.index, metrics: window.metrics },
      baseline: { index: match.index, metrics: match.metrics },
      metrics: sharedMetricNames(window, match),
    })
  }
  const droppedBaseline = baselineWindows.filter((window) => !paired.has(windowKey(window))).map(describe)

  const candidateNames = metricNames(candidateWindows)
  const baselineNames = metricNames(baselineWindows)
  const common = candidateNames.filter((name) => baselineNames.includes(name))
  const result = {
    unit: candidate.unit,
    pairs,
    dropped: { candidate: droppedCandidate, baseline: droppedBaseline },
    metrics: {
      common,
      candidate_only: candidateNames.filter((name) => !common.includes(name)),
      baseline_only: baselineNames.filter((name) => !common.includes(name)),
    },
    comparable: pairs.length > 0 && common.length > 0,
    reason: undefined,
  }

  if (pairs.length === 0) {
    return {
      ...result,
      reason: `the two runs share no window: ${candidateWindows.length} candidate window(s) and ${baselineWindows.length} baseline window(s) have no bounds in common, so one of them was measured over different intervals`,
    }
  }
  if (common.length === 0) {
    return {
      ...result,
      reason: `the paired windows share no metric name (candidate: ${describeNames(candidateNames)}; baseline: ${describeNames(baselineNames)})`,
    }
  }
  return result
}