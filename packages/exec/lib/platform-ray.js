/**
 * The Ray executor: Ray OSS jobs over the dashboard HTTP API, with `fetch` injected.
 *
 * Two things here are not stylistic:
 *
 *  1. **`fetch` is a required port, not `globalThis.fetch`.** There is no Ray cluster on a laptop
 *     and there will not be one in CI, so the only way this file can be tested is against a fake
 *     that replays the shapes the dashboard really returns. An implementation that reaches for the
 *     ambient network cannot be held to its contract.
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

import { DEFAULTS, TERMINAL_STATES, safeSlug } from './platform.js'

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

/** What a failed job's logs say, when the task records say nothing. */
export function classifyRayLogs(logs) {
  if (typeof logs !== 'string' || logs === '') return undefined
  for (const [errorClass, pattern] of LOG_SIGNATURES) if (pattern.test(logs)) return errorClass
  return undefined
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
 *   fetch: typeof globalThis.fetch,
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
 * }} options
 */
export function createRayPlatform({
  fetch: fetchImpl,
  plan,
  baseUrl = 'http://127.0.0.1:8265',
  metricsDir,
  artifactsDir,
  now = Date.now,
  name = 'ray',
  limits = {},
  submissionIdFor = (candidateId) => candidateId,
  metricsRequired = true,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new TypeError('createRayPlatform needs an injected fetch — there is no cluster in the test suite')
  }
  if (typeof plan !== 'function') throw new TypeError('createRayPlatform needs a plan() that says what to submit')

  const root = baseUrl.replace(/\/+$/, '')
  const limitsFor = () => ({ ...DEFAULTS, ...limits })
  const metricsPathFor = (submissionId) =>
    metricsDir === undefined ? undefined : join(metricsDir, `${safeSlug(submissionId)}.metrics.json`)

  async function request(method, path, body) {
    const init = { method, headers: { accept: 'application/json' } }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await doFetch(`${root}${path}`, init)
    } catch (error) {
      // A dashboard we cannot reach is "we do not know", which is a first-class answer here.
      return { status: 0, json: undefined, text: '', transport_error: String(error) }
    }
    const text = typeof response.text === 'function' ? await response.text() : ''
    let json
    try {
      json = text === '' ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json, text }
  }

  /** Ray's state API wraps rows: `{ result, msg, data: { result: { result: [...] } } }`. */
  function stateApiRows(document) {
    const rows = document?.data?.result?.result
    if (Array.isArray(rows)) return rows
    if (rows !== null && typeof rows === 'object') return [rows]
    return []
  }

  function jobDetails(path) {
    return request('GET', path)
  }

  async function fetchLogs(jobId) {
    const response = await request('GET', `/api/jobs/${encodeURIComponent(jobId)}/logs`)
    if (response.status !== 200) return undefined
    return typeof response.json?.logs === 'string' ? response.json.logs : undefined
  }

  /**
   * The populated error source. `TaskState.error_type` is a string enum; empty, `NIL` and null all
   * mean "the task did not fail with a typed error".
   */
  async function taskError(jobId) {
    const query = `filter_keys=job_id&filter_values=${encodeURIComponent(jobId)}&limit=1000`
    const response = await request('GET', `/api/v0/tasks?${query}`)
    if (response.status !== 200) return undefined
    const rows = stateApiRows(response.json)
    const typed = rows.find(
      (row) => typeof row?.error_type === 'string' && row.error_type !== '' && row.error_type !== 'NIL',
    )
    if (typed === undefined) return { rows: rows.length, error_type: null }
    return { rows: rows.length, error_type: typed.error_type, error_message: typed.error_message, state: typed.state }
  }

  async function classifyFailure(jobId, details) {
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

    const logs = await fetchLogs(jobId)
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
      // The metrics file is the primary source; logs are only read when it is absent, so an ordinary
      // poll of a finished job does not drag the whole driver log over the wire.
      let { metrics } = metricsFor(jobRef, details, undefined)
      if (metrics === undefined) {
        metrics = metricsFor(jobRef, details, await fetchLogs(details.job_id ?? jobRef)).metrics
      }
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
      const classified = await classifyFailure(details.job_id ?? jobRef, details)
      return { state: 'failed', submission_id: submissionId, ...classified, timing }
    }

    return { state: 'running', submission_id: submissionId, timing }
  }

  const wallDeadlineFrom = (submittedAt) => submittedAt + limitsFor().max_wall_ms

  return {
    name,

    async submit({ submissionId, candidateId, gpuHours } = {}) {
      if (typeof submissionId !== 'string' || submissionId === '') {
        throw new TypeError('submit needs a submissionId — it is the idempotency key')
      }
      const planned = plan({ candidateId, submissionId, gpuHours }) ?? {}
      if (planned.entrypoint === undefined) {
        throw new TypeError(`plan(${candidateId}) produced no entrypoint; there is nothing to submit`)
      }

      const metricsPath = metricsPathFor(submissionId)
      const body = {
        entrypoint: planned.entrypoint,
        submission_id: submissionId,
        runtime_env: {
          ...(planned.runtimeEnv ?? {}),
          ...(metricsPath === undefined
            ? {}
            : { env_vars: { ...(planned.runtimeEnv?.env_vars ?? {}), REPRISE_METRICS_PATH: metricsPath } }),
        },
        metadata: {
          ...(planned.metadata ?? {}),
          candidate_id: candidateId,
          gpu_hours: gpuHours ?? null,
          submission_id: submissionId,
        },
      }
      if (planned.numGpus !== undefined) body.entrypoint_num_gpus = planned.numGpus

      const response = await request('POST', '/api/jobs/', body)
      const alreadyExists =
        response.status === 409 ||
        (response.status === 400 && /already exists/i.test(response.text ?? ''))

      if (alreadyExists) {
        // submission_id is the idempotency key, so "already exists" is success with an older id.
        // Resolving the existing job and going straight to polling is the whole point: resubmitting
        // onto another cluster is how one candidate ends up with two GPU bills.
        const existing = await jobDetails(`/api/jobs/${encodeURIComponent(submissionId)}`)
        const details = existing.status === 200 ? existing.json : undefined
        return {
          job_id: details?.job_id ?? submissionId,
          state: JOB_STATUS_STATES[String(details?.status ?? 'RUNNING').toUpperCase()] ?? 'running',
          harness: name,
          duplicate: true,
          deadline_ms: limitsFor().max_wall_ms,
        }
      }

      if (response.status !== 200 && response.status !== 201) {
        // Submit failures are not job failures: nothing was created, so this throws and the caller
        // holds the candidate instead of inventing a job id the cluster has never heard of.
        throw new Error(`ray rejected the submission: ${response.status} ${clip(response.text) ?? response.transport_error ?? ''}`)
      }

      return {
        job_id: response.json?.job_id ?? submissionId,
        state: 'running',
        harness: name,
        deadline_ms: limitsFor().max_wall_ms,
      }
    },

    poll(jobId) {
      return observe(jobId)
    },

    async collect(jobId) {
      const observed = await observe(jobId)
      const artifacts = []

      // The metrics file is named after the submission id (that is what the job was told to write
      // to), not after the cluster's job id. Getting this wrong would silently produce "no
      // metrics" for every successful job.
      const metricsPath = metricsPathFor(observed.submission_id ?? jobId)
      if (metricsPath !== undefined && existsSync(metricsPath)) {
        artifacts.push({ name: 'metrics.json', uri: `file://${metricsPath}`, bytes: statSync(metricsPath).size })
      }

      if (artifactsDir !== undefined) {
        const logs = await fetchLogs(jobId)
        if (logs !== undefined) {
          mkdirSync(artifactsDir, { recursive: true })
          const path = join(artifactsDir, `${safeSlug(jobId)}.driver.log`)
          writeFileSync(path, logs)
          artifacts.push({ name: 'driver.log', uri: `file://${path}`, bytes: Buffer.byteLength(logs) })
        }
      }

      if (!TERMINAL_STATES.includes(observed.state)) {
        return { state: observed.state, metrics: undefined, artifacts }
      }
      return {
        state: observed.state,
        metrics: observed.state === 'succeeded' ? observed.metrics : undefined,
        error_class: observed.error_class,
        error_detail: observed.error_detail,
        artifacts,
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

    async cancel(jobId) {
      const response = await request('POST', `/api/jobs/${encodeURIComponent(jobId)}/stop`)
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