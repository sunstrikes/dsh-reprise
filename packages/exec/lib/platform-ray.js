/**
 * The Ray executor: Ray OSS jobs over the dashboard HTTP API, with the transport injected.
 *
 * Two things here are not stylistic:
 *
 *  1. **The transport is a required port, and it is `node:http`, not `globalThis.fetch`.** There is
 *     no Ray cluster on a laptop and there will not be one in CI, so the only way this file can be
 *     tested is against a fake that replays the shapes the dashboard really returns. And `fetch`
 *     cannot talk to this dashboard at all: undici sends `sec-fetch-mode: cors` on every request,
 *     Ray's CSRF guard reads that as browser traffic and refuses anything but a `GET` with
 *     `405 '<METHOD>' method not allowed for browser traffic` (measured 2026-10-24; see
 *     `lib/ray-http.js`).
 *  2. **Failure classification reads `/api/v0/tasks`, not `JobDetails.error_type`.** In OSS Ray the
 *     job-level `error_type` is a `TODO` in the dashboard handler and is never populated; a
 *     classifier built on it is a classifier that always answers "unknown" while looking
 *     authoritative. `TaskState.error_type` is populated, so it is the primary source and a log
 *     regex is only the fallback for driver-side death with no task record.
 *
 * Metrics are not a cluster capability. Ray has no progress API, so the job writes
 * `{ metrics: {...} }` to the path we hand it in `REPRISE_METRICS_PATH` (a shared mount, in a
 * real deployment) and we read that file. A run that exits successfully without producing it is
 * reported as a `data` failure, not as a success with empty metrics: an empty metric set becomes a
 * candidate score, and a made-up score is worse than a failed run.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_MAX_ARCHIVE_BYTES,
  FACT_PLANE_EXCLUSIONS,
  PackageRefusedError,
  packCandidate,
  packageNameFor,
} from './archive.js'
import { DEFAULTS, TERMINAL_STATES, resolveJobId, safeSlug } from './platform.js'
import { createHttpRequest, isBrowserTraffic } from './ray-http.js'
import { parseWindowLog } from './window-samples.js'

const CLIP = 2_048

function clip(text, limit = CLIP) {
  if (typeof text !== 'string') return undefined
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Task-level `ErrorType` (Ray `common.proto`) to the closed error classes. Anything absent from
 * this table is left unclassified on purpose: `NODE_DIED` / `WORKER_DIED` / `TASK_UNSCHEDULABLE_ERROR`
 * are the cluster's fault, and reporting them as `code` would make the next round debug code that
 * never ran.
 */
const TASK_ERROR_CLASSES = Object.freeze({
  OUT_OF_MEMORY: 'oom',
  TASK_EXECUTION_EXCEPTION: 'code',
  // The runtime environment is part of what was submitted: a broken one is a configuration defect.
  RUNTIME_ENV_SETUP_FAILED: 'data',
})

const LOG_SIGNATURES = [
  ['oom', /out of memory|OutOfMemory|OOMKilled|MemoryError|std::bad_alloc|CUDA error: out of memory/i],
  ['data', /FileNotFoundError|No such file or directory|JSONDecodeError|TOMLDecodeError|EmptyDataError|PermissionError/i],
  ['code', /Traceback \(most recent call last\)|SyntaxError|AssertionError|ModuleNotFoundError|ImportError|Segmentation fault/i],
]

/**
 * The windowed sample series a job summarised in its driver log, when it printed one.
 *
 * `parseWindowLog` refuses with a reason (`error_class: 'data'`) rather than answering with an empty
 * series, and a refusal here is not this adapter's business: `collect()` reports the job's own
 * outcome, and the kernel's sample reader decides what a missing series means for the run. What the
 * adapter must not do is invent one, or throw on a log that simply never printed the marker.
 */
function windowsFrom(logs) {
  if (typeof logs !== 'string' || logs === '') return undefined
  const parsed = parseWindowLog(logs)
  return parsed?.ok === true ? parsed.series : undefined
}

/** What a failed job's logs say, when the task records say nothing. */
export function classifyRayLogs(logs) {
  if (typeof logs !== 'string' || logs === '') return undefined
  for (const [errorClass, pattern] of LOG_SIGNATURES) if (pattern.test(logs)) return errorClass
  return undefined
}

/** The marker the shipped verifier prints on the node; the only word the unpacked tree gets to say. */
const INVENTORY_MARKER = 'REPRISE_INVENTORY '

/**
 * Read the node's own verdict on the unpack, if it left one.
 *
 * Returns `undefined` for a job that shipped no package or printed nothing — an absent verdict is not
 * evidence of anything, and guessing one would turn "we did not look" into "the tree was fine".
 */
export function parseInventoryMarker(logs) {
  if (typeof logs !== 'string') return undefined
  const line = logs
    .split('\n')
    .reverse()
    .find((candidate) => candidate.trimStart().startsWith(INVENTORY_MARKER))
  if (line === undefined) return undefined
  try {
    const parsed = JSON.parse(line.trimStart().slice(INVENTORY_MARKER.length))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * POSIX-quote one argv element. The package entrypoint has to become a single shell command line
 * (the verifier runs first, then the training), and an argument with a space or a quote in it must
 * reach the job unchanged — a silently re-split path is a training command that reads the wrong file.
 */
function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * Make "check the tree, then train" one entrypoint. `&&` rather than `;` on purpose: a job that
 * trains after the check failed is a number computed from a tree nobody described.
 */
function entrypointWithCheck(entrypoint, verify) {
  if (verify === undefined) return entrypoint
  const check = verify.command.map(shellQuote).join(' ')
  const training = Array.isArray(entrypoint) ? entrypoint.map(shellQuote).join(' ') : String(entrypoint)
  return `${check} && ${training}`
}

/**
 * Ray's `JobSubmitRequest.__post_init__` (`job/common.py`) rejects a submission unless **every**
 * metadata value is a `str`:
 *
 *     TypeError: metadata values must be strings, got <class 'float'>
 *
 * and the head turns that into a 400 before any job exists. `gpu_hours: 0.1` was exactly that — the
 * first live acceptance run got past the package upload and died here.
 *
 * So the object is normalised at the seam rather than field by field: numbers and booleans become
 * their decimal/`true`/`false` text (they round-trip, and the ledger and a human both read them),
 * `undefined`/`null` are **omitted** (Ray accepts a missing key; it does not accept `null`), and a
 * value with no faithful text form — an object, an array — is a caller bug that throws *here*, with
 * the key named, instead of becoming a 400 nobody can trace back to a plan.
 */
export function stringMetadata(entries, { owner = 'plan' } = {}) {
  const out = {}
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      out[key] = value
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value)
      continue
    }
    const shape = Array.isArray(value) ? 'an array' : typeof value === 'object' ? 'an object' : `a ${typeof value}`
    throw new TypeError(
      `${owner} metadata.${key} is ${shape}; Ray requires every job metadata value to be a string, ` +
        'and there is no faithful text form for this one — send a string',
    )
  }
  return out
}

/** Environment variables as the text the cluster passes to the driver: strings, absent keys dropped. */
function envVars(declared, metricsPath) {
  const merged = { ...(declared ?? {}), ...(metricsPath === undefined ? {} : { REPRISE_METRICS_PATH: metricsPath }) }
  return Object.fromEntries(
    Object.entries(merged)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  )
}

/** Job status strings Ray's dashboard can answer with. */
const JOB_STATUS_STATES = Object.freeze({
  PENDING: 'running',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  STOPPED: 'failed', // stopped: someone ended it, so `canceled` — never a candidate defect
})

/**
 * @param {{
 *   request?: (request: {method: string, url: string, headers?: object, body?: Buffer}) =>
 *     Promise<{status: number, headers: object, text: string}>,
 *   plan: (input: {candidateId: string, submissionId: string, gpuHours?: number}) =>
 *     {entrypoint: string[]|string, runtimeEnv?: object, metadata?: object, numGpus?: number},
 *   baseUrl?: string,
 *   metricsDir?: string,
 *   artifactsDir?: string,
 *   now?: () => number,
 *   name?: string,
 *   limits?: object,
 *   submissionIdFor?: (candidateId: string) => string,
 *   metricsRequired?: boolean,
 *   packaging?: false | {exclusions?: object[], maxBytes?: number, verify?: false | {command: string[]},
 *     git?: Function},
 * }} options `plan` names the tree to ship (`worktreeDir` + `baseRef`); `packaging` says how it is
 *   packed (`false` for a deployment whose nodes already have the code some other way)
 */
export function createRayPlatform({
  request: requestImpl,
  plan,
  baseUrl = 'http://127.0.0.1:8265',
  metricsDir,
  artifactsDir,
  now = Date.now,
  name = 'ray',
  limits = {},
  submissionIdFor = (candidateId) => candidateId,
  metricsRequired = true,
  packaging = {},
} = {}) {
  // `node:http` by default; injected in every test. See the module header for why it is not `fetch`.
  const send = requestImpl ?? createHttpRequest()
  if (typeof send !== 'function') {
    throw new TypeError('createRayPlatform needs a request() transport — there is no cluster in the test suite')
  }
  if (typeof plan !== 'function') throw new TypeError('createRayPlatform needs a plan() that says what to submit')

  const root = baseUrl.replace(/\/+$/, '')
  const limitsFor = () => ({ ...DEFAULTS, ...limits })
  const packOptions = packaging === false ? undefined : {
    exclusions: packaging.exclusions ?? FACT_PLANE_EXCLUSIONS,
    maxBytes: packaging.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    verify: packaging.verify === undefined ? { command: ['python3'] } : packaging.verify,
    git: packaging.git,
  }
  /**
   * Jobs whose code we shipped. Needed at observation time because the marker the node prints only
   * exists for a packaged job, and reading every driver log on every terminal poll would drag the
   * whole log over the wire for runs that never had a package.
   */
  const packaged = new Set()
  const metricsPathFor = (submissionId) =>
    metricsDir === undefined ? undefined : join(metricsDir, `${safeSlug(submissionId)}.metrics.json`)

  /**
   * One call over the transport. A JSON body when the caller hands an object, raw bytes when it hands
   * a Buffer (the package upload), and a transport failure that comes back as `status: 0` rather than
   * a throw — "we could not ask" is a legitimate answer for a read, and the writers treat a non-2xx
   * as a refusal either way.
   */
  async function call(method, path, body, extraHeaders = {}) {
    const headers = { accept: 'application/json', ...extraHeaders }
    let payload
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) payload = Buffer.from(body)
      else {
        payload = Buffer.from(JSON.stringify(body), 'utf8')
        headers['content-type'] = 'application/json'
      }
    }
    let response
    try {
      response = await send({ method, url: `${root}${path}`, headers, body: payload })
    } catch (error) {
      // A dashboard we cannot reach is "we do not know", which is a first-class answer here.
      return { status: 0, json: undefined, text: '', transport_error: String(error) }
    }
    const text = typeof response?.text === 'string' ? response.text : ''
    let json
    try {
      json = text === '' ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response?.status ?? 0, json, text }
  }

  /**
   * A write the dashboard refused, said plainly.
   *
   * `405` is not a cluster limit and not a candidate defect: Ray's dashboard answers it when it reads
   * the request as browser traffic, which on Node means a transport that sends `Sec-Fetch-*` (global
   * `fetch` does, `node:http` does not). Naming that cause is the difference between a ten-minute fix
   * and an afternoon — this adapter lost its first live run to that body text.
   */
  function refusedWrite(prefix, response) {
    const detail = clip(response.text) ?? response.transport_error ?? ''
    const hint =
      response.status === 405
        ? ' — the dashboard refused this client as browser traffic; the transport must not send a Mozilla user-agent or any Referer/Origin/Sec-Fetch-* header (node:http does not, global fetch sends sec-fetch-mode: cors)'
        : ''
    return new Error(`${prefix}: ${response.status} ${detail}${hint}`.trimEnd())
  }

  /**
   * Upload one package. Raw bytes, `application/zip`, flat name — the three things the measured
   * endpoint accepts (`PUT /api/packages/gcs/<name>.zip`); a name with a slash matches no route.
   */
  async function uploadPackage(packageName, bytes) {
    return call('PUT', `/api/packages/gcs/${packageName}`, bytes, { 'content-type': 'application/zip' })
  }

  /**
   * The job this submission id already owns, if the cluster can still show it.
   *
   * Measured on the live cluster (Ray 2.59, 2026-10-24): `GET /api/jobs/<submission_id>` answers
   * **200** for a finished job, and 404 for an id the cluster never accepted — so this read is the
   * duplicate check, not a guess. The same route also answers for jobs whose details document
   * reports `job_id: null` (42 of 129 rows had one), and `/api/jobs/<submission_id>/logs` resolves
   * too, which is why the submission id below is a *usable* job reference rather than a placeholder.
   *
   * Why a read before the write: a crash-and-retry, or two ticks racing on one candidate, must not
   * re-pack a tree and re-upload it every time, and — the reason the ticket gives — must not produce
   * a second job. The `metadata.candidate_id` check is the same one `find()` makes, so a slug
   * collision cannot make us adopt another candidate's run.
   */
  async function resolveExistingSubmission(submissionId, candidateId) {
    const response = await jobDetails(`/api/jobs/${encodeURIComponent(submissionId)}`)
    if (response.status !== 200) return undefined
    const details = response.json ?? {}
    const metadataCandidate = details.metadata?.candidate_id
    if (metadataCandidate !== undefined && metadataCandidate !== candidateId) return undefined
    const mapped = JOB_STATUS_STATES[String(details.status ?? '').toUpperCase()]
    // `job_id` can be null upstream; the submission id is the id the dashboard resolves, so it is a
    // reference that can be polled, not a missing one.
    return { job_id: details.job_id ?? submissionId, state: mapped ?? 'unknown' }
  }

  /** Ray's state API wraps rows: `{ result, msg, data: { result: { result: [...] } } }`. */
  function stateApiRows(document) {
    const rows = document?.data?.result?.result
    if (Array.isArray(rows)) return rows
    if (rows !== null && typeof rows === 'object') return [rows]
    return []
  }

  function jobDetails(path) {
    return call('GET', path)
  }

  /**
   * Every job the cluster knows about — the legacy read-only listing (`GET /api/v0/jobs`).
   *
   * It is the only way to answer "is one of our jobs still running that the ledger never recorded",
   * because a listing is the cluster's own state and there is no per-job route for "everything".
   * Two things about its shape, both measured on Ray 2.59: it arrives in the same StateApiResponse
   * envelope as `/api/v0/tasks`, and a row's `job_id` may be `null` while `submission_id` is always
   * there. So the fields this adapter promises are exactly those two, plus `status` and `metadata`
   * (where our marker travels) — anything else is passed through if present and never required.
   *
   * "We could not read it" is an answer: `{ok: false}` with the reason, never an empty list, because
   * an empty list reads as "nothing of ours is running" to everything downstream.
   */
  function listingRows(document) {
    const rows = document?.data?.result?.result ?? document?.result?.result ?? document?.jobs ?? document
    if (!Array.isArray(rows)) return rows !== null && typeof rows === 'object' ? [rows] : []
    return rows.filter((row) => row !== null && typeof row === 'object')
  }

  async function fetchLogs(jobId) {
    const response = await call('GET', `/api/jobs/${encodeURIComponent(jobId)}/logs`)
    if (response.status !== 200) return undefined
    return typeof response.json?.logs === 'string' ? response.json.logs : undefined
  }

  /**
   * The populated error source. `TaskState.error_type` is a string enum; empty, `NIL` and null all
   * mean "the task did not fail with a typed error".
   */
  async function taskError(jobId) {
    const query = `filter_keys=job_id&filter_values=${encodeURIComponent(jobId)}&limit=1000`
    const response = await call('GET', `/api/v0/tasks?${query}`)
    if (response.status !== 200) return undefined
    const rows = stateApiRows(response.json)
    const typed = rows.find(
      (row) => typeof row?.error_type === 'string' && row.error_type !== '' && row.error_type !== 'NIL',
    )
    if (typed === undefined) return { rows: rows.length, error_type: null }
    return { rows: rows.length, error_type: typed.error_type, error_message: typed.error_message, state: typed.state }
  }

  async function classifyFailure(jobId, details, observedLogs) {
    const task = await taskError(jobId)
    const fromTask = task?.error_type === null || task?.error_type === undefined ? undefined : TASK_ERROR_CLASSES[task.error_type]
    if (fromTask !== undefined) {
      return {
        error_class: fromTask,
        error_detail: {
          source: 'task_state',
          type: task.error_type,
          message: clip(task.error_message) ?? clip(details?.message),
          tasks_seen: task.rows,
        },
      }
    }

    const logs = observedLogs ?? (await fetchLogs(jobId))
    const fromLogs = classifyRayLogs(logs)
    return {
      // No guesses: an unclassified failure is handed to the analyze phase with the evidence intact,
      // because inventing `code` here would make the next round debug code that never ran.
      error_class: fromLogs,
      error_detail: {
        source: fromLogs === undefined ? 'job_details' : 'logs',
        type: task?.error_type ?? null,
        message: clip(fromLogs === undefined ? details?.message : logs) ?? 'the job failed without leaving a message',
        driver_exit_code: details?.driver_exit_code ?? null,
        tasks_seen: task?.rows ?? 0,
      },
    }
  }

  function metricsFor(jobId, details, logs) {
    const submissionId = details?.submission_id ?? jobId
    const path = metricsPathFor(submissionId)
    if (path !== undefined) {
      const document = readJson(path)
      if (document !== undefined) {
        if (typeof document.metrics === 'object' && document.metrics !== null) return { metrics: document.metrics, uri: `file://${path}` }
        const values = Object.values(document)
        if (values.length > 0 && values.every((value) => typeof value === 'number')) return { metrics: document, uri: `file://${path}` }
      }
    }
    // Second chance: a job that only printed where it wrote. Still the job's own numbers.
    if (typeof logs === 'string') {
      const line = logs
        .split('\n')
        .reverse()
        .find((candidate) => candidate.trimStart().startsWith('REPRISE_METRICS '))
      if (line !== undefined) {
        try {
          const parsed = JSON.parse(line.trimStart().slice('REPRISE_METRICS '.length))
          if (typeof parsed === 'object' && parsed !== null) return { metrics: parsed.metrics ?? parsed, uri: 'ray:driver.log' }
        } catch {}
      }
    }
    return { metrics: undefined, uri: undefined }
  }

  /**
   * The node's own answer about the unpacked tree, when it disagrees with the package.
   *
   * `conflict`, not `invalid`: nothing the candidate produced broke its schema — the tree that
   * arrived is not the tree that was packed, which is the fact plane contradicting itself. The error
   * class stays inside the closed vocabulary as `data`, because the shipped code *is* the job's input
   * data on a cluster whose nodes cannot fetch it. Training never started (`&&`), so there is no
   * partial result to read and no retry that would produce a different tree.
   */
  function divergenceOf(logs, submissionId, timing) {
    const verdict = parseInventoryMarker(logs)
    if (verdict === undefined || verdict.ok !== false) return undefined
    return {
      state: 'failed',
      submission_id: submissionId,
      error_class: 'data',
      conflict: true,
      timing,
      error_detail: {
        source: 'node_inventory',
        message:
          'the tree the node unpacked is not the tree that was packed; the job stopped before training ' +
          '(run "git diff --name-only" in the candidate worktree and pack again)',
        missing: verdict.missing ?? [],
        altered: verdict.altered ?? [],
        untracked: verdict.untracked ?? [],
        checked: verdict.checked ?? 0,
      },
    }
  }

  /**
   * Every answer about a job names the job. `collect(pollResult)` is the natural next call after a
   * poll, and it can only resolve an id the poll actually carried.
   */
  async function observeWithId(jobRef) {
    const answer = await observe(jobRef)
    return answer.job_id === undefined ? { job_id: jobRef, ...answer } : answer
  }

  async function observe(jobRef) {
    const response = await jobDetails(`/api/jobs/${encodeURIComponent(jobRef)}`)
    if (response.status === 404) {
      return { state: 'lost', error_detail: { message: `ray does not know job ${jobRef}`, http_status: 404 } }
    }
    if (response.status !== 200) {
      return {
        state: 'unknown',
        error_detail: {
          message: response.transport_error ?? `ray answered ${response.status}`,
          http_status: response.status,
          body: clip(response.text),
        },
      }
    }

    const details = response.json ?? {}
    const mapped = JOB_STATUS_STATES[String(details.status ?? '').toUpperCase()]
    const timing = {
      submitted_at_ms: typeof details.start_time === 'number' ? details.start_time : undefined,
      ended_at_ms: typeof details.end_time === 'number' ? details.end_time : undefined,
    }
    const submissionId = details.submission_id ?? jobRef
    if (mapped === undefined) {
      // An unknown status string is not evidence of anything. Guessing is how a dashboard upgrade
      // silently turns into wrong decisions.
      return {
        state: 'unknown',
        timing,
        error_detail: { message: `ray reported an unrecognised job status ${JSON.stringify(details.status)}`, job_id: details.job_id },
      }
    }

    if (mapped === 'succeeded') {
      // The metrics file is the primary source; logs are only read when it is absent, or when we
      // shipped this job's tree and therefore have a verdict to read. A packaged job prints the
      // marker before the training command runs, so a "succeeded" job whose tree diverged is caught
      // here rather than becoming a number.
      let { metrics } = metricsFor(jobRef, details, undefined)
      let logs
      if (metrics === undefined || packaged.has(details.job_id ?? jobRef) || packaged.has(jobRef)) {
        logs = await fetchLogs(details.job_id ?? jobRef)
        metrics = metricsFor(jobRef, details, logs).metrics
      }
      const divergent = divergenceOf(logs, submissionId, timing)
      if (divergent !== undefined) return divergent
      if (metrics !== undefined || metricsRequired === false) {
        return { state: 'succeeded', submission_id: submissionId, metrics, timing }
      }
      return {
        state: 'failed',
        submission_id: submissionId,
        error_class: 'data',
        timing,
        error_detail: {
          message: 'the job succeeded but wrote no metrics JSON; a run without a measurement is not a result',
          metrics_path: metricsPathFor(submissionId),
        },
      }
    }

    if (mapped === 'failed') {
      if (String(details.status ?? '').toUpperCase() === 'STOPPED') {
        return {
          state: 'failed',
          submission_id: submissionId,
          error_class: 'canceled',
          timing,
          error_detail: { message: 'the job was stopped; it did not fail on its own', driver_exit_code: details.driver_exit_code ?? null },
        }
      }
      const logs = await fetchLogs(details.job_id ?? jobRef)
      const divergent = divergenceOf(logs, submissionId, timing)
      if (divergent !== undefined) return divergent
      const classified = await classifyFailure(details.job_id ?? jobRef, details, logs)
      return { state: 'failed', submission_id: submissionId, ...classified, timing }
    }

    return { state: 'running', submission_id: submissionId, timing }
  }

  const wallDeadlineFrom = (submittedAt) => submittedAt + limitsFor().max_wall_ms

  return {
    name,

    async submit({ submissionId, candidateId, gpuHours, round } = {}) {
      if (typeof submissionId !== 'string' || submissionId === '') {
        throw new TypeError('submit needs a submissionId — it is the idempotency key')
      }

      // Read before write: a submission id the cluster already owns is that job, and neither a
      // second package upload nor a second job may follow from it (ticket 15's last bullet). The
      // POST-time 409/400 handling below stays, for the race where the job exists but is not visible
      // yet — that is user story 15's grace window, not a different situation.
      const existingJob = await resolveExistingSubmission(submissionId, candidateId)
      if (existingJob !== undefined) {
        packaged.add(existingJob.job_id)
        return {
          ...existingJob,
          harness: name,
          duplicate: true,
          deadline_ms: limitsFor().max_wall_ms,
        }
      }

      // `round` is what the plan needs to write the job's marker (ticket 16): the ledger view matches
      // our jobs in the cluster's listing by that marker, so it has to reach the submission.
      const planned = plan({ candidateId, submissionId, gpuHours, round }) ?? {}
      if (planned.entrypoint === undefined) {
        throw new TypeError(`plan(${candidateId}) produced no entrypoint; there is nothing to submit`)
      }

      // The code goes with the job. Everything below happens before the POST, because a submission
      // whose tree cannot be shipped is a conclusion — not a job that fails on the node.
      let ship
      if (planned.worktreeDir !== undefined && packOptions !== undefined) {
        if (planned.runtimeEnv?.working_dir !== undefined) {
          throw new TypeError(
            `plan(${candidateId}) set runtime_env.working_dir, but the adapter owns it: it is the package ` +
              'this submit just uploaded, and a second claim about where the job runs is how a job trains on the wrong tree',
          )
        }
        const packed = packCandidate({
          worktreeDir: planned.worktreeDir,
          baseRef: planned.baseRef,
          exclusions: packOptions.exclusions,
          maxBytes: packOptions.maxBytes,
          verify: packOptions.verify,
          git: packOptions.git,
        })
        if (packed.ok === false) {
          throw new PackageRefusedError({
            conclusion: packed.conclusion,
            message: packed.message,
            inventory: packed.inventory,
            conflict: packed.conflict,
            largest: packed.largest,
          })
        }

        const packageName = packageNameFor({ submissionId, sha256: packed.sha256 })
        const uploaded = await uploadPackage(packageName, packed.archive)
        if (uploaded.status !== 200 && uploaded.status !== 201) {
          // Nothing was created, so this stays a plain throw: the caller holds the candidate and
          // retries later, and the tree is packed again when it does.
          throw refusedWrite(`ray refused the package ${packageName}`, uploaded)
        }

        ship = {
          packageName,
          workingDir: `gcs://${packageName}`,
          entrypoint: entrypointWithCheck(planned.entrypoint, packed.verify),
          receipt: {
            name: packageName,
            uri: `gcs://${packageName}`,
            bytes: packed.bytes,
            sha256: packed.sha256,
            base_ref: planned.baseRef,
            changed: packed.inventory.changed,
            untracked: packed.inventory.untracked,
            deleted: packed.inventory.deleted,
            excluded: packed.inventory.excluded,
            verified_by: packed.verify === undefined ? 'none' : 'node-inventory-check',
          },
        }
      }

      // A packaged job cannot write to a laptop path, and being told to try is how a healthy run
      // becomes a `data` failure on the node. Its report comes back on the driver log instead.
      const metricsPath = ship === undefined ? metricsPathFor(submissionId) : undefined
      const body = {
        entrypoint: ship === undefined ? planned.entrypoint : ship.entrypoint,
        submission_id: submissionId,
        runtime_env: {
          ...(planned.runtimeEnv ?? {}),
          ...(ship === undefined ? {} : { working_dir: ship.workingDir }),
          // `env_vars` is the same hazard as `metadata`: Ray hands these to the driver as strings and
          // a number from a plan is a 400 at submit time rather than a wrong environment at run time.
          ...(Object.keys(envVars(planned.runtimeEnv?.env_vars, metricsPath)).length === 0
            ? {}
            : { env_vars: envVars(planned.runtimeEnv?.env_vars, metricsPath) }),
        },
        // Every value here is a string by the time it is serialised: Ray 400s the whole submission
        // otherwise, and an unknown `gpu_hours` is *omitted* rather than sent as `null`.
        metadata: stringMetadata({
          ...(planned.metadata ?? {}),
          candidate_id: candidateId,
          gpu_hours: gpuHours,
          submission_id: submissionId,
          ...(ship === undefined ? {} : { package: ship.packageName }),
        }),
      }
      if (planned.numGpus !== undefined) body.entrypoint_num_gpus = planned.numGpus

      const response = await call('POST', '/api/jobs/', body)
      const alreadyExists =
        response.status === 409 ||
        (response.status === 400 && /already exists/i.test(response.text ?? ''))

      if (alreadyExists) {
        // submission_id is the idempotency key, so "already exists" is success with an older id.
        // Resolving the existing job and going straight to polling is the whole point: resubmitting
        // onto another cluster is how one candidate ends up with two GPU bills.
        const existing = await jobDetails(`/api/jobs/${encodeURIComponent(submissionId)}`)
        const details = existing.status === 200 ? existing.json : undefined
        const jobId = details?.job_id ?? submissionId
        packaged.add(jobId)
        return {
          job_id: jobId,
          state: JOB_STATUS_STATES[String(details?.status ?? 'RUNNING').toUpperCase()] ?? 'running',
          harness: name,
          duplicate: true,
          deadline_ms: limitsFor().max_wall_ms,
          ...(ship === undefined ? {} : { packaging: ship.receipt }),
        }
      }

      if (response.status !== 200 && response.status !== 201) {
        // Submit failures are not job failures: nothing was created, so this throws and the caller
        // holds the candidate instead of inventing a job id the cluster has never heard of.
        throw refusedWrite('ray rejected the submission', response)
      }

      const jobId = response.json?.job_id ?? submissionId
      if (ship !== undefined) packaged.add(jobId)
      return {
        job_id: jobId,
        state: 'running',
        harness: name,
        deadline_ms: limitsFor().max_wall_ms,
        ...(ship === undefined ? {} : { packaging: ship.receipt }),
      }
    },

    poll(jobId) {
      return observeWithId(resolveJobId(jobId, { method: 'poll' }))
    },

    async collect(jobId) {
      // An id or the poll result that just finished — see `resolveJobId`: interpolating the result
      // object into the URL is how a job that had just succeeded came back as `lost`.
      const ref = resolveJobId(jobId, { method: 'collect' })
      const observed = await observeWithId(ref)
      const artifacts = []

      // The metrics file is named after the submission id (that is what the job was told to write
      // to), not after the cluster's job id. Getting this wrong would silently produce "no
      // metrics" for every successful job.
      const metricsPath = metricsPathFor(observed.submission_id ?? ref)
      if (metricsPath !== undefined && existsSync(metricsPath)) {
        artifacts.push({ name: 'metrics.json', uri: `file://${metricsPath}`, bytes: statSync(metricsPath).size })
      }

      // The driver log is the only channel back from a cluster with no shared filesystem, so it is
      // read for two reasons: to keep it as an artifact when a directory was configured, and to
      // recover the windowed sample series the job summarised itself (`REPRISE_WINDOWS`). Reading it
      // only for the artifact would leave every cluster baseline without windows — the samples exist
      // in the log and nowhere else.
      const logs = await fetchLogs(ref)
      if (logs !== undefined) {
        if (artifactsDir !== undefined) {
          mkdirSync(artifactsDir, { recursive: true })
          const path = join(artifactsDir, `${safeSlug(ref)}.driver.log`)
          writeFileSync(path, logs)
          artifacts.push({ name: 'driver.log', uri: `file://${path}`, bytes: Buffer.byteLength(logs) })
        }
      }
      const series = windowsFrom(logs)

      if (!TERMINAL_STATES.includes(observed.state)) {
        return { state: observed.state, metrics: undefined, artifacts, ...(series === undefined ? {} : { window_series: series }) }
      }
      return {
        state: observed.state,
        metrics: observed.state === 'succeeded' ? observed.metrics : undefined,
        error_class: observed.error_class,
        error_detail: observed.error_detail,
        artifacts,
        ...(series === undefined ? {} : { window_series: series }),
      }
    },

    async find(candidateId) {
      // Recovering after a crash is the reason this method exists: our memory of the submission is
      // gone, so we ask by the idempotency key we chose at submit time.
      const submissionId = submissionIdFor(candidateId)
      const response = await jobDetails(`/api/jobs/${encodeURIComponent(submissionId)}`)
      if (response.status !== 200) return undefined
      const details = response.json ?? {}
      const metadataCandidate = details.metadata?.candidate_id
      if (metadataCandidate !== undefined && metadataCandidate !== candidateId) return undefined
      const mapped = JOB_STATUS_STATES[String(details.status ?? '').toUpperCase()]
      const submittedAt = typeof details.start_time === 'number' ? details.start_time : now()
      return {
        job_id: details.job_id ?? submissionId,
        state: mapped ?? 'unknown',
        harness: name,
        submitted_at_ms: submittedAt,
        deadline_ms: wallDeadlineFrom(submittedAt),
      }
    },

    /**
     * The cluster's whole job listing. Optional capability: `submit`/`poll`/`collect`/`find`/`cancel`
     * stay the port, and a caller that needs it asks `platform.list` (see `jobs.js` in core, which
     * turns the answer into "ours / orphan / foreign" — this adapter does not decide that).
     */
    async list() {
      const response = await call('GET', '/api/v0/jobs')
      if (response.status !== 200) {
        return {
          ok: false,
          status: response.status,
          message: response.transport_error ?? `the dashboard answered ${response.status} for the job listing`,
        }
      }
      return { ok: true, jobs: listingRows(response.json) }
    },

    async cancel(jobId) {
      jobId = resolveJobId(jobId, { method: 'cancel' })
      const response = await call('POST', `/api/jobs/${encodeURIComponent(jobId)}/stop`)
      if (response.status === 404) return { accepted: false, state_after: 'lost' }
      if (response.status !== 200) {
        const observed = await observe(jobId)
        return { accepted: false, state_after: observed.state }
      }
      const observed = await observe(jobId)
      return { accepted: response.json?.stopped !== false, state_after: observed.state }
    },
  }
}