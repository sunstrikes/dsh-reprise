/**
 * Windowed samples on their way into the fact plane — one path, used by the baseline and by every
 * candidate.
 *
 * The shape is the contract's (`window_series`: an ordinal, a half-open interval and a metric table
 * per window). What this module owns is the two steps around it:
 *
 *   1. **Finding the document.** An executor answers in whatever medium it speaks. An adapter that
 *      has already parsed the run's samples hands the document back as `window_series`; a job that
 *      reported its series on the driver log (the only channel back from a cluster with no shared
 *      filesystem) leaves the log behind, and the log is parsed by `@dsh-reprise/exec` — this module
 *      never learns the medium, it only decides which artifact to hand that parser.
 *   2. **Recording it as a fact.** The document is written to an artifact and an event points at it,
 *      because an artifact with no fact is a file nobody can tell was collected.
 *
 * Two things this module deliberately does *not* do: it never fabricates a series out of a single
 * final number (a one-window series made from the metric table would make "window 0" mean "the run"),
 * and it never decides what a window *means* — which metric counts, and how windows collapse to one
 * number, are the metric contract's business and stay out of the kernel.
 *
 * Both subjects record the **same** event type and the **same** artifact name shape, because the
 * only reason to collect samples is to pair a candidate against its baseline window by window, and
 * pairing two differently-shaped series is impossible (see `pairWindows` in the contract).
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { validateArtifact } from '@dsh-reprise/contract'
import { WINDOW_MARKER, parseWindowLog } from '@dsh-reprise/exec/windows'

/** The event that records "these samples were collected". One type for both subjects, on purpose. */
export const WINDOW_SAMPLES_EVENT = 'window_samples'

/**
 * The artifact name a subject's samples are written under.
 *
 * Named by subject rather than by job id: a crash-and-resubmit produces a second job for the same
 * subject, and two artifacts for one set of facts would leave a reader choosing between them.
 */
export const windowSamplesArtifact = (subject) => `${subject}/window_samples`

/** A file URI, which is how an executor's collected artifact names a file this process can read. */
function logTextFrom(artifacts) {
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const uri = artifact?.uri
    const name = artifact?.name ?? ''
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue
    if (!/driver\.log$/.test(name) && !/driver\.log$/.test(uri)) continue
    try {
      return readFileSync(fileURLToPath(uri), 'utf8')
    } catch {
      // An unreadable log is reported as "no samples", with the same reason vocabulary as an absent
      // one: we collected no window, and saying which file we could not read is the caller's job.
      return undefined
    }
  }
  return undefined
}

/** Whatever text an executor answer carries its driver log in, if any. */
function logTextOf(answer) {
  for (const key of ['logs', 'driver_log', 'log']) {
    const value = answer?.[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return logTextFrom(answer?.artifacts)
}

/**
 * The window series an executor answer carries, and whether it is usable.
 *
 * `status` is the contract's vocabulary, because four states are what a caller has to distinguish:
 * `ok` (a document that satisfies the shape), `missing` (the run reported no window at all),
 * `invalid` (a window that breaks the shape, including an empty list — a run that measured nothing
 * is not a result), `conflict` (two accounts of one window, which is the fact plane disagreeing with
 * itself rather than a malformed document).
 *
 * @param {any} answer a poll or collect answer
 * @returns {{status: 'ok'|'missing'|'invalid'|'conflict', message: string, series?: object, source: string}}
 */
export function seriesOf(answer) {
  const document = answer?.window_series
  if (document !== undefined && document !== null) {
    const verdict = validateArtifact('window_series', document)
    if (verdict.status === 'ok') return { status: 'ok', message: '', series: document, source: 'document' }
    return { status: verdict.status, message: verdict.message, series: document, source: 'document' }
  }

  const text = logTextOf(answer)
  if (text === undefined) {
    return {
      status: 'missing',
      message: 'the job reported no window series: neither a window_series document nor a driver log holding one',
      source: 'none',
    }
  }

  // "No marker" and "a marker that does not parse" are different answers: the first is a run that
  // measured nothing, the second is a document that is there and unusable.
  if (!text.includes(WINDOW_MARKER)) {
    return {
      status: 'missing',
      message: `the driver log holds no ${WINDOW_MARKER} line, so the job reported no window at all`,
      source: 'driver-log',
    }
  }

  const parsed = parseWindowLog(text)
  if (parsed.ok !== true) return { status: 'invalid', message: parsed.reason, source: 'driver-log' }

  const verdict = validateArtifact('window_series', parsed.series)
  if (verdict.status === 'ok') return { status: 'ok', message: '', series: parsed.series, source: 'driver-log' }
  return { status: verdict.status, message: verdict.message, series: parsed.series, source: 'driver-log' }
}

/** The metric names a series measured, sorted — the vocabulary it speaks, for the event and a reader. */
const metricNames = (series) => {
  const names = new Set()
  for (const window of Array.isArray(series?.windows) ? series.windows : []) {
    for (const name of Object.keys(window?.metrics ?? {})) names.add(name)
  }
  return [...names].sort()
}

/**
 * Read a subject's recorded series back; `undefined` when it never recorded one.
 *
 * The fact is the link, and the artifact is the evidence — so this reads the *last* `window_samples`
 * fact for the subject and then the document it points at. Only the last: a resubmitted job rewrites
 * the same artifact name, and a reader that merged two accounts would be inventing a series nobody
 * measured. A missing artifact document (a restored fact plane without its files) is reported as "no
 * series" rather than thrown, because a tick that cannot read evidence must not crash the run.
 *
 * This is the seam the stop rules read (`stop.js`: "the last window carries no finite number", "the
 * trailing N windows all regressed"), and the baseline's series is read the same way as a
 * candidate's — one reader, so a comparison cannot be built from two different interpretations.
 *
 * @param {{store: any, artifacts?: any}} ports
 * @param {string} subject a candidate id, or the reserved baseline subject
 * @returns {{schema_version?: number, unit?: string, windows?: unknown[]} | undefined}
 */
export function windowSamplesOf({ store, artifacts }, subject) {
  const facts = store.eventsFor(subject).filter((event) => event.event_type === WINDOW_SAMPLES_EVENT)
  const last = facts[facts.length - 1]
  if (last === undefined) return undefined
  const name = last.payload?.artifact
  if (typeof name !== 'string' || name === '') return undefined
  const document = artifacts?.read?.(name)
  return document ?? undefined
}

/**
 * Write the series as an artifact and append the fact that points at it.
 *
 * @param {{store: any, clock: {now: () => number}, artifacts?: any}} ports
 * @param {{
 *   subject: string, subjectKind: 'baseline'|'candidate', jobId: string,
 *   series: object, source: string, metric?: {name: string, value: number} | null,
 * }} collected
 * @returns {{artifact: string, path: string, sha256: string, unit: string, windows: number, seq: number}}
 */
export function recordWindowSamples(ports, { subject, subjectKind, jobId, series, source, metric = null }) {
  const { store, clock, artifacts } = ports
  const name = windowSamplesArtifact(subject)
  const written = artifacts === undefined ? { path: name, sha256: '' } : artifacts.write(name, series)

  const ref = {
    artifact: name,
    path: written.path,
    sha256: written.sha256,
    unit: series.unit,
    windows: series.windows.length,
  }

  const { local_seq: seq } = store.appendEvent({
    candidate_id: subject,
    wall_clock_ms: clock.now(),
    event_type: WINDOW_SAMPLES_EVENT,
    payload: {
      subject_kind: subjectKind,
      job_id: jobId,
      source,
      unit: series.unit,
      windows: series.windows.length,
      metrics: metricNames(series),
      artifact: ref.artifact,
      sha256: ref.sha256,
      metric: metric === null ? null : { name: metric.name, value: metric.value },
    },
  })

  return { ...ref, seq }
}