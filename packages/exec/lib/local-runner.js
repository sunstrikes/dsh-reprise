/**
 * Local job supervisor: one detached process per job, whose only purpose is to record how the job
 * ended *on the job side*.
 *
 * Why a supervisor instead of letting the parent remember the exit code: the parent can die. On a
 * laptop the most likely crash is exactly the same one the cluster case is built around — the
 * harness process is killed while a job is running. If the outcome lived only in the parent's
 * memory, every restart would have to call such a job `unknown`; with `status.json` on disk the
 * restart reads the real answer and the candidate continues instead of being re-run.
 *
 * The supervisor writes facts (`exit_code`, `signal`, `stderr_tail`, `canceled`), never an
 * interpretation. Classification lives in `platform-local.js`, so improving it does not require
 * rewriting the status files of jobs that already ran.
 *
 * Usage: `node local-runner.js <jobDir>`; the job directory holds `spec.json` written by the
 * platform.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How much stderr is kept for classification. Enough for a traceback tail, small enough to hold. */
const STDERR_TAIL_BYTES = 8 * 1024
/** Grace between asking a job to stop and killing it outright. */
const CHILD_KILL_GRACE_MS = 1_500

const jobDir = process.argv[2]
if (jobDir === undefined) {
  process.stderr.write('local-runner: usage: node local-runner.js <jobDir>\n')
  process.exit(64)
}

function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

const spec = JSON.parse(readFileSync(join(jobDir, 'spec.json'), 'utf8'))
const log = createWriteStream(join(jobDir, 'driver.log'), { flags: 'a' })
let stderrTail = ''
let finished = false
let canceled = false

const child = spawn(spec.command[0], spec.command.slice(1), {
  cwd: spec.cwd,
  env: {
    ...process.env,
    ...(spec.env ?? {}),
    REPRISE_JOB_ID: spec.jobId,
    REPRISE_CANDIDATE_ID: spec.candidateId,
    REPRISE_SUBMISSION_ID: spec.submissionId,
    REPRISE_METRICS_PATH: spec.metricsPath,
    REPRISE_JOB_DIR: jobDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

writeAtomic(join(jobDir, 'started.json'), {
  started_at_ms: Date.now(),
  pid: child.pid ?? null,
  supervisor_pid: process.pid,
})

child.stdout.on('data', (chunk) => log.write(chunk))
child.stderr.on('data', (chunk) => {
  log.write(chunk)
  stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES)
})

child.on('error', (error) => {
  finish({ exit_code: null, signal: null, supervisor_error: String(error) })
})

child.on('exit', (code, signal) => {
  finish({ exit_code: code, signal })
})

// A stop request is forwarded, then escalated. Recording `canceled` here is what keeps "we stopped
// it" from being read later as "it broke" — the whole reason the class exists.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    canceled = true
    try {
      child.kill('SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, CHILD_KILL_GRACE_MS).unref()
  })
}

function finish(facts) {
  if (finished) return
  finished = true
  try {
    writeAtomic(join(jobDir, 'status.json'), {
      ...facts,
      canceled: canceled || undefined,
      stderr_tail: stderrTail,
      ended_at_ms: Date.now(),
      supervisor_pid: process.pid,
    })
  } catch {
    // The job directory can be gone (a workspace swept out from under a run). There is nothing
    // useful to record then, and a supervisor that crashes on its own bookkeeping hides the real
    // event — the platform will report `lost` from the missing record.
  }
  log.end(() => process.exit(0))
}