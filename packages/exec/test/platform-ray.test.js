/**
 * Guards the Ray-specific half of ticket 08: the decisions that only exist because the backend is
 * Ray OSS, and that the shared conformance suite deliberately cannot see.
 *
 *  1. **Failure classification comes from `/api/v0/tasks`, not `JobDetails.error_type`.** In OSS Ray
 *     the job-level field is a `TODO` and never populated, so a classifier reading it always answers
 *     "unknown" while looking authoritative. The fake deliberately *lies* in that field to prove
 *     which source the implementation actually trusts.
 *  2. **A duplicate `submission_id` must not become a second job.** Ray answers 400 with an
 *     `already exists` detail (a 409 in front of a proxy), and the old behaviour — retry onto another
 *     cluster — is how one candidate ends up with two GPU bills.
 *  3. **A dashboard we cannot reach is `unknown`, never `lost`, and it recovers.** That is user story
 *     15: a job submitted a second before a crash may not be visible yet.
 *  4. **`STOPPED` is `canceled`, and a failure with no evidence carries no `error_class`.** Blaming
 *     the candidate for a stop or for a node death sends the next round debugging code that never ran.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findJob, pollJob, submitJob } from '../lib/platform.js'
import { classifyRayLogs, createRayPlatform } from '../lib/platform-ray.js'
import { createFakeRay } from './platform-fixtures/ray-fake.js'

const TERMINAL = ['succeeded', 'failed', 'lost']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function rayWorld({ duplicateResponse } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reprise-ray-'))
  const metricsDir = join(root, 'metrics')
  mkdirSync(metricsDir, { recursive: true })
  // A real job writes its own metrics file when it is done; the fake writes the one the script
  // declared, so "succeeded" and "has metrics" stay two separate facts.
  const fake = createFakeRay({
    duplicateResponse,
    onSucceeded: (job) => {
      if (job.script.metrics === undefined) return
      writeFileSync(join(metricsDir, `${job.submission_id}.metrics.json`), JSON.stringify({ metrics: job.script.metrics }))
    },
  })
  return { root, metricsDir, fake }
}

function makePlatform({ fake, metricsDir, fetch: fetchImpl, plan }) {
  return createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    fetch: fetchImpl ?? fake.fetch,
    plan: plan ?? (() => ({ entrypoint: ['python', '-m', 'train'], metadata: {} })),
    metricsDir,
    name: 'ray-test',
  })
}

async function pollUntilTerminal(platform, jobId, { tries = 200, delayMs = 5 } = {}) {
  let last
  for (let index = 0; index < tries; index += 1) {
    last = await pollJob(platform, jobId)
    if (TERMINAL.includes(last.state)) return last
    await sleep(delayMs)
  }
  throw new Error(`job ${jobId} never finished (last: ${last?.state})`)
}

test('classification reads the task state even when JobDetails.error_type says otherwise', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({
    fake,
    metricsDir,
    plan: () => {
      // The decoy: the dashboard claims an OOM, the task says the entrypoint raised. OSS Ray would
      // leave this field null, which is exactly why trusting it is invisible in production.
      fake.script('cand_code', {
        outcome: 'code',
        detailsErrorType: 'OUT_OF_MEMORY',
        taskErrorType: 'TASK_EXECUTION_EXCEPTION',
      })
      return { entrypoint: ['python', '-m', 'train'], metadata: { candidate_id: 'cand_code' } }
    },
  })

  const submitted = await submitJob(platform, { submissionId: 'cand_code', candidateId: 'cand_code', gpuHours: 1 })
  const done = await pollUntilTerminal(platform, submitted.job_id)

  assert.equal(done.state, 'failed')
  assert.equal(done.error_class, 'code', 'the task record is the populated source; JobDetails.error_type is a TODO upstream')
  assert.equal(done.error_detail.source, 'task_state')
  assert.equal(done.error_detail.type, 'TASK_EXECUTION_EXCEPTION')
})

test('a data failure that only the driver log knows about is still classified', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  fake.script('cand_data', {
    outcome: 'data',
    taskErrorType: null,
    logs: "FileNotFoundError: [Errno 2] No such file or directory: 'data/train.parquet'\n",
  })
  const submitted = await submitJob(platform, { submissionId: 'cand_data', candidateId: 'cand_data', gpuHours: 1 })
  const done = await pollUntilTerminal(platform, submitted.job_id)

  assert.equal(done.error_class, 'data')
  assert.equal(done.error_detail.source, 'logs', 'the log regex is the fallback, and it must say so')
})

test('a failure with no evidence carries no error_class instead of blaming the code', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  fake.script('cand_opaque', {
    outcome: 'code',
    taskErrorType: null,
    logs: 'driver exited\n',
  })
  const submitted = await submitJob(platform, { submissionId: 'cand_opaque', candidateId: 'cand_opaque', gpuHours: 1 })
  const done = await pollUntilTerminal(platform, submitted.job_id)

  assert.equal(done.state, 'failed')
  assert.equal(
    done.error_class,
    undefined,
    'inventing "code" here makes the next round debug code that never ran; the analyze phase decides',
  )
  assert.equal(done.error_detail.source, 'job_details', 'the evidence is kept for whoever does decide')
})

test('the cluster failing is not the candidate failing', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  // NODE_DIED is infrastructure. It is deliberately absent from the classification table.
  fake.script('cand_node', { outcome: 'code', taskErrorType: 'NODE_DIED', logs: 'node lost\n' })
  const submitted = await submitJob(platform, { submissionId: 'cand_node', candidateId: 'cand_node', gpuHours: 1 })
  const done = await pollUntilTerminal(platform, submitted.job_id)

  assert.equal(done.state, 'failed')
  assert.equal(done.error_class, undefined)
  assert.equal(done.error_detail.type, 'NODE_DIED')
})

test('a job stopped outside our process is canceled, not a code failure', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  fake.script('cand_stop', { outcome: 'succeeded', hang: true })
  const submitted = await submitJob(platform, { submissionId: 'cand_stop', candidateId: 'cand_stop', gpuHours: 1 })
  assert.equal((await pollJob(platform, submitted.job_id)).state, 'running')

  // Someone else's `ray job stop`: our executor never issued this cancel.
  fake.job(submitted.job_id).status = 'STOPPED'

  const done = await pollJob(platform, submitted.job_id)
  assert.equal(done.state, 'failed')
  assert.equal(done.error_class, 'canceled')
})

test('a duplicate submission_id is answered by a read, not by a second job', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  const request = { submissionId: 'cand_twice', candidateId: 'cand_twice', gpuHours: 1 }
  fake.script('cand_twice', { outcome: 'succeeded', metrics: { val_loss: 0.5 } })

  const first = await submitJob(platform, request)
  const second = await submitJob(platform, request)

  assert.equal(second.duplicate, true, 'the caller must be told it was a duplicate')
  assert.equal(second.job_id, first.job_id, 'same submission_id means the same job')
  assert.equal(fake.jobs.size, 1, 'a duplicate must never create a second job')
  assert.equal(
    fake.requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/jobs/').length,
    1,
    'a submission id the cluster already owns is resolved without writing: no second POST, no second GPU bill',
  )

  const done = await pollUntilTerminal(platform, second.job_id)
  assert.equal(done.state, 'succeeded', 'going straight to polling after a duplicate must work')
})

test('a duplicate the dashboard cannot show yet is still one job, on both real Ray shapes', async () => {
  for (const duplicateResponse of ['ray-400', 'plain-409']) {
    const { metricsDir, fake } = rayWorld({ duplicateResponse })
    const platform = makePlatform({ fake, metricsDir })
    const request = { submissionId: 'cand_race', candidateId: 'cand_race', gpuHours: 1 }
    // The grace window: the job exists, the details route cannot see it yet, so the pre-check misses
    // and the POST is the one that finds out. Ray answers 400 `already exists` (OSS) or 409 (a proxy).
    fake.script('cand_race', { outcome: 'succeeded', metrics: { val_loss: 0.5 }, hideFromDetails: 1 })

    const first = await submitJob(platform, request)
    const second = await submitJob(platform, request)

    assert.equal(second.duplicate, true, `${duplicateResponse}: the caller must be told it was a duplicate`)
    assert.equal(second.job_id, first.job_id, `${duplicateResponse}: same submission_id means the same job`)
    assert.equal(fake.jobs.size, 1, `${duplicateResponse}: a duplicate must never create a second job`)
  }
})

test('an unreachable dashboard is unknown, and the job is picked up again when it answers', async () => {
  const { metricsDir, fake } = rayWorld()
  let failures = 0
  const flaky = async (input, init) => {
    // Only the job-details read fails: a dashboard that is briefly down is not a cluster that forgot.
    if (failures > 0 && String(input).includes('/api/jobs/raysubmit')) {
      failures -= 1
      throw new TypeError('fetch failed')
    }
    return fake.fetch(input, init)
  }
  const platform = makePlatform({ fake, metricsDir, fetch: flaky })
  fake.script('cand_flaky', { outcome: 'succeeded', metrics: { val_loss: 0.3 } })
  const submitted = await submitJob(platform, { submissionId: 'cand_flaky', candidateId: 'cand_flaky', gpuHours: 1 })

  failures = 2
  const blind = await pollJob(platform, submitted.job_id)
  assert.equal(blind.state, 'unknown', 'not knowing is not the platform saying the job is gone')
  assert.equal(blind.error_class, undefined, 'no evidence, no classification')

  const done = await pollUntilTerminal(platform, submitted.job_id)
  assert.equal(done.state, 'succeeded', 'an unknown poll must never be the end of the job')
})

test('recovery asks the cluster by submission_id — the executor keeps no local truth', async () => {
  const { metricsDir, fake } = rayWorld()
  const request = { submissionId: 'cand_recover', candidateId: 'cand_recover', gpuHours: 1 }

  const before = makePlatform({ fake, metricsDir })
  fake.script('cand_recover', { outcome: 'succeeded', hang: true })
  const submitted = await submitJob(before, request)

  // A second instance with no memory at all: this is the restarted process.
  const after = makePlatform({ fake, metricsDir })
  const adopted = await findJob(after, 'cand_recover')

  assert.equal(adopted.job_id, submitted.job_id, 'recovery must find the job, not resubmit it')
  assert.equal(adopted.state, 'running')
  assert.equal(typeof adopted.deadline_ms, 'number')
})

test('a job that succeeds without writing metrics is a data failure', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  fake.script('cand_nometrics', { outcome: 'succeeded', metrics: undefined })
  const submitted = await submitJob(platform, { submissionId: 'cand_nometrics', candidateId: 'cand_nometrics', gpuHours: 1 })
  const done = await pollUntilTerminal(platform, submitted.job_id)

  assert.equal(done.state, 'failed', 'an empty metric set becomes a candidate score')
  assert.equal(done.error_class, 'data')
})

test('the submitted body carries the idempotency key, the candidate, and where to write metrics', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  await submitJob(platform, { submissionId: 'cand_body', candidateId: 'cand_body', gpuHours: 2.5 })

  const post = fake.requests.find((entry) => entry.method === 'POST' && entry.path === '/api/jobs/')
  const body = JSON.parse(post.body)
  assert.equal(body.submission_id, 'cand_body', 'submission_id is the idempotency key; a uuid would make 409s meaningless')
  assert.equal(body.metadata.candidate_id, 'cand_body', 'recovery matches on metadata.candidate_id')
  assert.equal(body.metadata.gpu_hours, 2.5, 'the ledger and the cluster must agree on what was reserved')
  assert.ok(
    String(body.runtime_env.env_vars.REPRISE_METRICS_PATH).startsWith(metricsDir),
    'the job must be told where to write its metrics: Ray has no metrics API to read them from',
  )
})

test('a rejected submit throws instead of inventing a job id', async () => {
  const { metricsDir, fake } = rayWorld()
  const rejecting = async (input, init) => {
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ detail: 'no resources available' }), { status: 500 })
    }
    return fake.fetch(input, init)
  }
  const platform = makePlatform({ fake, metricsDir, fetch: rejecting })

  await assert.rejects(
    () => submitJob(platform, { submissionId: 'cand_reject', candidateId: 'cand_reject', gpuHours: 1 }),
    /ray rejected the submission: 500/,
    'a job id nobody at the cluster knows about would be polled until the round times out',
  )
})

test('an unrecognised job status is unknown, never assumed running', async () => {
  const { metricsDir, fake } = rayWorld()
  const platform = makePlatform({ fake, metricsDir })
  fake.script('cand_weird', { outcome: 'succeeded', hang: true })
  const submitted = await submitJob(platform, { submissionId: 'cand_weird', candidateId: 'cand_weird', gpuHours: 1 })

  fake.job(submitted.job_id).status = 'PENDING_WITH_NEW_NAME'

  const observed = await pollJob(platform, submitted.job_id)
  assert.equal(observed.state, 'unknown', 'a dashboard upgrade must not silently become "still running forever"')
})

test('log signatures are only consulted when the task records say nothing', () => {
  assert.equal(classifyRayLogs('CUDA error: out of memory'), 'oom')
  assert.equal(classifyRayLogs('FileNotFoundError: missing shard'), 'data')
  assert.equal(classifyRayLogs('Traceback (most recent call last):'), 'code')
  assert.equal(classifyRayLogs('everything is fine'), undefined)
  assert.equal(classifyRayLogs(''), undefined)
})