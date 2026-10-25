/**
 * The local executor: a real subprocess, a real exit code, a real metrics file — no cluster, no
 * GPU, no network. This is one half of the "first five minutes" path: a person who has just cloned
 * the repository can drive the whole loop and read a number that came out of a process they can
 * see, before they spend a minute of cluster time.
 *
 * The "platform" is a job directory under `rootDir`:
 *
 *   job.json      what we submitted (survives our own crashes, so `find` can adopt)
 *   spec.json     what the supervisor must run
 *   started.json  when the job really started (wall-clock limits measure from here)
 *   status.json   how it ended — written by the job side, never inferred from our memory
 *   metrics.json  what the job measured, in the shape `{ metrics: { ... } }`
 *   driver.log    stdout + stderr
 *
 * A absent `status.json` with a dead supervisor is `unknown`, and a absent job directory is `lost`.
 * Those two are different on purpose; see `platform.js`.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, TERMINAL_STATES, resolveJobId, safeSlug } from './platform.js'

const SUPERVISOR = fileURLToPath(new URL('./local-runner.js', import.meta.url))
const STDERR_CLIP = 2_048

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

function clip(text, limit = STDERR_CLIP) {
  if (typeof text !== 'string') return undefined
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

function alive(pid) {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not ours; ESRCH means it is gone.
    return error?.code === 'EPERM'
  }
}

/**
 * Failure signatures for a job that only left stdout/stderr behind. Order matters: an OOM kill
 * usually also prints a traceback, and calling that a code error sends the next round hunting for
 * a bug in code that was fine.
 */
const OOM_SIGNATURE = /out of memory|OutOfMemory|OOMKilled|MemoryError|std::bad_alloc|CUDA error: out of memory/i
const DATA_SIGNATURE =
  /FileNotFoundError|No such file or directory|JSONDecodeError|json\.decoder\.JSONDecodeError|TOMLDecodeError|yaml\.(parser|scanner)|EmptyDataError|IsADirectoryError|PermissionError|Dataset .* is empty/i

export function classifyLocalFailure(status) {
  // A SIGKILL we did not send is, in practice, the kernel's OOM killer on this class of workload.
  // It is a heuristic, and it is stated here rather than hidden: the alternative is calling every
  // OOM kill a code error.
  if (status.signal === 'SIGKILL') return 'oom'
  const text = status.stderr_tail ?? ''
  if (OOM_SIGNATURE.test(text)) return 'oom'
  if (DATA_SIGNATURE.test(text)) return 'data'
  return 'code'
}

/**
 * @param {{
 *   rootDir: string,
 *   plan: (input: {candidateId: string, submissionId: string, gpuHours?: number, spec?: object}) =>
 *     {command: string[], cwd?: string, env?: object},
 *   now?: () => number,
 *   name?: string,
 *   limits?: object,
 *   metricsRequired?: boolean,
 * }} options
 */
export function createLocalPlatform({
  rootDir,
  plan,
  now = Date.now,
  name = 'local',
  limits = {},
  metricsRequired = true,
} = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('createLocalPlatform needs a rootDir')
  if (typeof plan !== 'function') throw new TypeError('createLocalPlatform needs a plan() that says what to run')

  mkdirSync(rootDir, { recursive: true })
  const limitsFor = () => ({ ...DEFAULTS, ...limits })
  const dirFor = (jobId) => join(rootDir, safeSlug(jobId))
  const recordPath = (jobId) => join(dirFor(jobId), 'job.json')

  function readMetrics(jobId) {
    const document = readJson(join(dirFor(jobId), 'metrics.json'))
    if (document === undefined) return undefined
    // `{ metrics: {...} }` is the contract; a flat object of numbers is accepted because that is
    // what a hand-written script tends to produce, and refusing it would only teach people to
    // wrap it for no reason. Anything else is not metrics and is reported as absent.
    if (typeof document.metrics === 'object' && document.metrics !== null) return document.metrics
    const values = Object.values(document)
    if (values.length > 0 && values.every((value) => typeof value === 'number')) return document
    return undefined
  }

  function observe(jobId) {
    const record = readJson(recordPath(jobId))
    if (record === undefined) {
      return { state: 'lost', error_detail: { message: `no local job record for ${jobId}` } }
    }
    const directory = dirFor(jobId)
    const started = readJson(join(directory, 'started.json'))
    const status = readJson(join(directory, 'status.json'))
    const metrics = readMetrics(jobId)
    const timing = {
      submitted_at_ms: record.submitted_at_ms,
      started_at_ms: started?.started_at_ms,
      ended_at_ms: status?.ended_at_ms,
    }
    const withMetrics = metrics === undefined ? {} : { metrics }

    if (status !== undefined) {
      if (status.canceled === true) {
        return {
          state: 'failed',
          error_class: 'canceled',
          error_detail: { message: 'stopped on request, not a candidate defect', signal: status.signal ?? null },
          timing,
        }
      }
      if (status.exit_code === 0 && (status.signal ?? null) === null) {
        if (metrics !== undefined || metricsRequired === false) {
          return { state: 'succeeded', ...withMetrics, timing }
        }
        return {
          state: 'failed',
          error_class: 'data',
          error_detail: {
            message: 'the job exited 0 but wrote no metrics JSON; a run without a measurement is not a result',
            metrics_path: join(directory, 'metrics.json'),
          },
          timing,
        }
      }
      return {
        state: 'failed',
        error_class: classifyLocalFailure(status),
        error_detail: {
          message: clip(status.stderr_tail) ?? 'the job failed without writing to stderr',
          signal: status.signal ?? null,
          exit_code: status.exit_code ?? null,
          log: join(directory, 'driver.log'),
        },
        timing,
      }
    }

    if (alive(record.pid)) return { state: 'running', ...withMetrics, timing }

    return {
      state: 'unknown',
      ...withMetrics,
      timing,
      error_detail: {
        message: 'the supervisor died without recording how the job ended',
        job_dir: directory,
      },
    }
  }

  /** Every answer about a job names the job, so `collect(pollResult)` can resolve it. */
  function withId(jobId) {
    const answer = observe(jobId)
    return answer.job_id === undefined ? { job_id: jobId, ...answer } : answer
  }

  function artifactsFor(jobId) {
    const directory = dirFor(jobId)
    const artifacts = []
    for (const fileName of ['metrics.json', 'driver.log', 'status.json']) {
      const path = join(directory, fileName)
      if (!existsSync(path)) continue
      artifacts.push({ name: fileName, uri: `file://${path}`, bytes: statSync(path).size })
    }
    return artifacts
  }

  async function waitForExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!alive(pid)) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return !alive(pid)
  }

  function signalGroup(pid, signal) {
    // The supervisor is spawned detached, so its pid is the process-group id: one kill reaches the
    // supervisor and the job it started.
    try {
      process.kill(-pid, signal)
      return
    } catch {}
    try {
      process.kill(pid, signal)
    } catch {}
  }

  return {
    name,

    submit({ submissionId, candidateId, gpuHours, spec } = {}) {
      if (typeof submissionId !== 'string' || submissionId === '') {
        throw new TypeError('submit needs a submissionId — it is the idempotency key')
      }
      const jobId = `local_${safeSlug(submissionId)}`
      const existing = readJson(recordPath(jobId))
      if (existing !== undefined) {
        // The directory name is derived from the submission id, so a mismatch here means the slug
        // collided. Refusing is the only safe answer: reporting `duplicate` would hand the caller
        // another candidate's job.
        if (existing.submission_id !== submissionId) {
          throw new Error(`local job id collision: ${jobId} belongs to ${existing.submission_id}, not ${submissionId}`)
        }
        return { job_id: jobId, state: observe(jobId).state, harness: name, duplicate: true }
      }

      const planned = plan({ candidateId, submissionId, gpuHours, spec }) ?? {}
      if (!Array.isArray(planned.command) || planned.command.length === 0) {
        throw new TypeError(`plan(${candidateId}) produced no command; a local job needs something to run`)
      }

      const directory = dirFor(jobId)
      mkdirSync(directory, { recursive: true })
      const cwd = planned.cwd ?? rootDir
      const metricsPath = join(directory, 'metrics.json')
      writeJson(join(directory, 'spec.json'), {
        command: planned.command,
        cwd,
        env: planned.env ?? {},
        metricsPath,
        jobId,
        candidateId,
        submissionId,
      })

      const submittedAt = now()
      const deadlineMs = limitsFor().max_wall_ms
      const child = spawn(process.execPath, [SUPERVISOR, directory], {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      // Detached and unreferenced: the job outlives this process on purpose, and the test process
      // must be able to exit without waiting for it.
      child.unref()

      writeJson(recordPath(jobId), {
        job_id: jobId,
        submission_id: submissionId,
        candidate_id: candidateId,
        gpu_hours: gpuHours ?? null,
        harness: name,
        pid: child.pid ?? null,
        submitted_at_ms: submittedAt,
        deadline_ms: submittedAt + deadlineMs,
        command: planned.command,
        cwd,
      })

      return { job_id: jobId, state: 'running', harness: name, deadline_ms: deadlineMs }
    },

    poll(jobId) {
      return withId(resolveJobId(jobId, { method: 'poll' }))
    },

    collect(jobId) {
      // An id or the poll result that just finished; anything else throws rather than reading as
      // `lost`. See `resolveJobId` in `platform.js`.
      jobId = resolveJobId(jobId, { method: 'collect' })
      const record = readJson(recordPath(jobId))
      if (record === undefined) return { state: 'lost', artifacts: [] }
      const observed = withId(jobId)
      const artifacts = artifactsFor(jobId)
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

    find(candidateId) {
      const matches = []
      for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const record = readJson(join(rootDir, entry.name, 'job.json'))
        if (record?.candidate_id !== candidateId) continue
        matches.push(record)
      }
      if (matches.length === 0) return undefined
      matches.sort((left, right) => (left.submitted_at_ms ?? 0) - (right.submitted_at_ms ?? 0))
      const newest = matches.at(-1)
      return {
        job_id: newest.job_id,
        // The key the job was submitted under, for the same reason the Ray adapter reports it: crash
        // recovery adopts the identity the platform holds rather than re-deriving one that may name
        // a different attempt of the same candidate.
        submission_id: newest.submission_id,
        state: observe(newest.job_id).state,
        harness: newest.harness ?? name,
        submitted_at_ms: newest.submitted_at_ms,
        deadline_ms: newest.deadline_ms,
      }
    },

    async cancel(jobId) {
      jobId = resolveJobId(jobId, { method: 'cancel' })
      const record = readJson(recordPath(jobId))
      if (record === undefined) return { accepted: false, state_after: 'lost' }
      const before = observe(jobId)
      if (TERMINAL_STATES.includes(before.state)) return { accepted: false, state_after: before.state }

      const { kill_grace_ms } = limitsFor()
      if (typeof record.pid === 'number') {
        signalGroup(record.pid, 'SIGTERM')
        if (!(await waitForExit(record.pid, kill_grace_ms))) {
          signalGroup(record.pid, 'SIGKILL')
          await waitForExit(record.pid, kill_grace_ms)
        }
      }

      // If the supervisor had time to record facts, keep them and only add the attribution. If it
      // did not, record the minimum ourselves: "we stopped it" must never become "we lost it".
      const statusPath = join(dirFor(jobId), 'status.json')
      const status = readJson(statusPath) ?? { exit_code: null, signal: 'SIGKILL', ended_at_ms: now() }
      writeJson(statusPath, { ...status, canceled: true })

      return { accepted: true, state_after: observe(jobId).state }
    },
  }
}