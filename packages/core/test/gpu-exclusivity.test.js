/**
 * Guards ticket 16's GPU-exclusivity decision: **the cluster does not reserve the cards** (measured,
 * ticket 14: two 8-card jobs ran at the same time on the same eight H20s and neither was queued), so
 * the run has to say which of two things it is doing, and the answer has to be checked at boot:
 *
 *   `executor.gpu_exclusivity: single_job`  — at most one training job is in flight at a time.
 *   `executor.cuda_visible_devices: "2,3"`  — each submission writes its own device list.
 *
 * Three rules are pinned here:
 *
 *   - **Both claims at once are refused**, because they are two answers to "who owns the cards" and
 *     a run that believes both is a run that will pin devices *and* dispatch a second job.
 *   - **Neither claim is warned about by name** on an executor that rents GPUs — legal but dangerous
 *     is the existing pattern for an uncapped spend, and the warning lives in `warnings.js` so the
 *     boot log and the dashboard read the same list (CODING_STANDARDS §3: the page is the surface).
 *   - **The choice is honoured, not just declared**: `single_job` holds a second dispatch at
 *     SUBMIT_QUEUED, and the device list reaches the job's environment through the plan.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { gpuHolder } from '../lib/jobs.js'
import { createCandidate, tick } from '../lib/loop.js'
import { planForConfig } from '../lib/ports.js'
import { overview } from '../lib/projection.js'
import { Store } from '../lib/store.js'

const AT = 1_761_091_200_000
const LOCAL = { kind: 'local', command: ['node', 'metric.mjs'] }
const RAY = { kind: 'ray', base_url: 'http://10.92.7.207:8258' }

const PACK = Object.freeze({
  dir: '/packs/config-only-domain',
  name: 'config-only-domain',
  metricContract: { name: 'config-only-score', primary: 'score', direction: 'higher', objectives: { score: 'up' } },
  priors: { search_space: {}, priors: [], hypothesis_classes: [] },
  surface: { files: ['src/thing.json'], keys: ['width'], symbols: [] },
  promptsDir: '/packs/config-only-domain/prompts',
  prompts: new Map(),
  executor: { kind: 'local', command: ['node', 'score.mjs'] },
})

const resolve = (raw) => resolveConfig({ domain: 'a-domain-pack', ...raw }, { loadDomain: () => PACK })

test('the two ways to own the cards cannot both be claimed', () => {
  const resolved = resolve({ workspace: 'w', executor: { ...RAY, gpu_exclusivity: 'single_job', cuda_visible_devices: '0,1' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /gpu_exclusivity/)
  assert.match(resolved.problem, /cuda_visible_devices/)
  assert.match(resolved.problem, /two different claims|keep one/i)
})

test('claiming CUDA_VISIBLE_DEVICES without saying which devices is refused', () => {
  const resolved = resolve({ workspace: 'w', executor: { ...RAY, gpu_exclusivity: 'cuda_visible_devices' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /cuda_visible_devices/)
  assert.match(resolved.problem, /would claim exclusivity and write nothing/)
})

test('an exclusivity value outside the two choices is refused, and both choices are named', () => {
  const resolved = resolve({ workspace: 'w', executor: { ...RAY, gpu_exclusivity: 'shared' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /gpu_exclusivity must be one of single_job, cuda_visible_devices/)
})

test('a device list that is not a list of indices is refused rather than passed to the job', () => {
  const resolved = resolve({ workspace: 'w', executor: { ...RAY, cuda_visible_devices: 'all of them' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /device indices/)
})

test('declaring neither is legal on a laptop and said out loud on a cluster', () => {
  const local = resolve({ workspace: 'w', executor: LOCAL })
  assert.equal(local.ok, true, local.problems?.join('; '))
  assert.deepEqual(local.warnings.filter((warning) => warning.code === 'gpu_exclusivity_undeclared'), [])

  const ray = resolve({ workspace: 'w', executor: RAY })
  assert.equal(ray.ok, true, 'legal but dangerous is a warning, not a refusal')
  const warning = ray.warnings.find((entry) => entry.code === 'gpu_exclusivity_undeclared')
  assert.ok(warning, 'an undeclared exclusivity on a real cluster must be named')
  assert.match(warning.message, /gpu_exclusivity: single_job/)
  assert.match(warning.message, /cuda_visible_devices/)
})

test('the undeclared-exclusivity warning is on the page a person reads', () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-gpu-')))
  const page = overview(store, { config: { executor: RAY } })
  const warning = page.warnings.find((entry) => entry.code === 'gpu_exclusivity_undeclared')
  assert.ok(warning, 'a warning nobody renders reads as done in every test that only inspects the payload')
  assert.equal(warning.where, 'dashboard.overview')
  store.close()
})

test('with single_job, a second training job waits for the first to finish', async () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-gpu-')))
  const jobs = new Map()
  let counter = 0
  const cluster = {
    async submit({ submissionId, candidateId }) {
      counter += 1
      const job = { job_id: `job-${counter}`, submission_id: submissionId, candidate_id: candidateId, state: 'running' }
      jobs.set(job.job_id, job)
      return { job_id: job.job_id, state: 'running', harness: 'fake' }
    },
    async find(candidateId) {
      return [...jobs.values()].find((job) => job.candidate_id === candidateId)
    },
    async poll(jobId) {
      const job = jobs.get(jobId)
      return job === undefined ? { state: 'lost' } : { state: job.state, metrics: job.metrics }
    },
    async collect() {
      return { state: 'running', metrics: undefined, artifacts: [] }
    },
    async cancel(jobId) {
      Object.assign(jobs.get(jobId), { state: 'failed' })
      return { accepted: true, state_after: 'failed' }
    },
  }
  const clock = {
    t: AT,
    now() {
      return this.t
    },
  }
  const ports = {
    store,
    clock,
    platform: cluster,
    harness: {
      land: ({ candidateId }) => ({ engine: 'fake', parent_id: 'baseline-0', parent_commit: 'aaa111', files_changed: 1, candidateId }),
    },
    judge: {
      verify: ({ candidateId, now }) => ({
        candidate_id: candidateId,
        passed: true,
        checks: [{ name: 'static_imports', result: 'pass' }],
        reviewer: { verdict: 'accept', rationale: 'no behaviour change outside the target module' },
        decided_at_ms: now,
      }),
      analyze: ({ candidateId, now }) => ({
        candidate_id: candidateId,
        verdict: 'improved',
        observed: { metric: 'auc', value: 0.7 },
        concluded: { metric: 'auc', value: 0.7 },
        root_cause: 'wider table',
        at_ms: now,
      }),
    },
    config: { executor: { ...LOCAL, gpu_exclusivity: 'single_job' } },
  }
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  createCandidate(ports, { candidateId: 'r1-h2', round: 1, hypothesis: 'drop the dropout' })

  for (let index = 0; index < 12; index += 1) {
    await tick(ports)
    clock.t += 1_000
  }

  assert.equal(jobs.size, 1, 'one training job at a time is what single_job asked for')
  const phases = ['r1-h1', 'r1-h2'].map((id) => store.getState(id, 'phase').phase)
  assert.ok(phases.includes('MONITOR_POLL'), 'the first candidate is running')
  assert.ok(phases.includes('SUBMIT_QUEUED'), 'the second is held at SUBMIT_QUEUED, not dispatched')

  // Let the first finish: the held candidate is then allowed to go.
  for (const job of jobs.values()) Object.assign(job, { state: 'succeeded', metrics: { auc: 0.71 } })
  // The poller backs off (1s, 2s, 4s …), so "the first job finished" takes a few ticks to be noticed.
  for (let index = 0; index < 30; index += 1) {
    await tick(ports)
    clock.t += 1_000
  }
  assert.equal(jobs.size, 2, 'the second job goes once nothing of ours is in flight')
  store.close()
})

test('"who is holding the cards" is one rule, asked of two traces, and a candidate never holds itself', () => {
  // The loop holds a candidate at SUBMIT_QUEUED on this rule, and the overview page names the same
  // reason for the same candidate. Two derivations of it would eventually disagree about whose job is
  // running, so there is one function and this test states what it answers.
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-gpu-holder-')))
  const submitted = (jobId, candidateId) =>
    store.putJob({
      job_id: jobId,
      candidate_id: candidateId,
      submission_id: `reprise:candidate=${candidateId}:round=1`,
      harness: 'fake',
      submitted_at_ms: AT,
      deadline_ms: AT + 60_000,
      last_polled_at_ms: null,
      next_poll_at_ms: 0,
      state: 'running',
      error_class: null,
      attempts: 0,
      round: 1,
      marker: null,
      outcome: null,
      kind: 'candidate',
    })

  // Trace 1: a candidate past the queue with no ledger row yet — the window between reserving the
  // money and the cluster answering. Only a phase can see it.
  store.setState('r1-h1', 'phase', { phase: 'MONITOR_POLL' })
  store.setState('r1-h2', 'phase', { phase: 'SUBMIT_QUEUED' })
  assert.equal(gpuHolder(store, 'r1-h2'), 'r1-h1', 'the candidate that already has a job out holds the cards')
  assert.equal(gpuHolder(store, 'r1-h1'), undefined, 'a candidate is never its own holder')

  // Trace 2: a ledger row of ours that is still open while its candidate is no longer in a job phase
  // (an earlier run's job, or a candidate that finished before the cluster did).
  store.setState('r1-h1', 'phase', { phase: 'DONE' })
  submitted('job-1', 'r1-h1')
  assert.equal(gpuHolder(store, 'r1-h2'), 'r1-h1', 'an open ledger row is the only trace of a job still running')

  // Nothing of ours in flight: nobody holds them, which is not the same as "unknown".
  store.updateJob('job-1', { outcome: 'succeeded', state: 'succeeded' })
  assert.equal(gpuHolder(store, 'r1-h2'), undefined)
  store.close()
})

test('the plan names the job and, when that is the choice, its own device list', () => {
  const devices = planForConfig(
    { executor: { ...RAY, gpu_exclusivity: 'cuda_visible_devices', cuda_visible_devices: '2,3' } },
    { workspaceDir: '/w' },
  )
  const planned = devices({ candidateId: 'r2-h1', round: 2 })
  assert.equal(planned.metadata.marker, 'reprise:candidate=r2-h1:round=2', 'the marker travels in metadata, which the listing keeps')
  assert.equal(planned.runtimeEnv.env_vars.CUDA_VISIBLE_DEVICES, '2,3', 'the submission writes its own device list')

  const single = planForConfig({ executor: { ...RAY, gpu_exclusivity: 'single_job' } }, { workspaceDir: '/w' })
  assert.equal(
    single({ candidateId: 'r2-h1', round: 2 }).runtimeEnv.env_vars.CUDA_VISIBLE_DEVICES,
    undefined,
    'single_job takes the whole node when it runs; pinning half of it would be a third claim',
  )

  const local = planForConfig({ executor: { ...LOCAL, cuda_visible_devices: '4' } }, { workspaceDir: '/w' })
  assert.equal(local({ candidateId: 'r2-h1', round: 2 }).env.CUDA_VISIBLE_DEVICES, '4', 'the laptop path needs the same declaration')
})
