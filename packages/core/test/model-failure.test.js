/**
 * "The model is unavailable" is one condition, at all five judgement points.
 *
 * Five places consult a model (LAND, VERIFY, CAND_ANALYZE, ROUND_PLAN, ROUND_REFLECT), and before
 * this file each of them turned an outage into a different fact: the review "rejected", the analysis
 * "found nothing", the plan "named no hypothesis", the landing "failed", and the round workflow spent
 * its retry budget before asking a human to fix a provider. This file holds the line the ticket
 * draws:
 *
 * 1. **one class, five call sites** — every one of them records `model_unavailable`, and it is the
 *    same word in the ops log whichever phase noticed first;
 * 2. **no phase hangs and no candidate dies** — the step returns at once with a backoff, the phase
 *    does not move, and no `candidate_rejected` event is written for something the candidate did not
 *    do;
 * 3. **the candidate's own budgets are untouched** — an outage is not a gate attempt and not a
 *    refused artifact, so it can neither use up the gate's tries nor spend the round's retries.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HARNESS_UNAVAILABLE } from '@dsh-reprise/exec/harness'
import { MODEL_UNAVAILABLE, ModelUnavailable } from '@dsh-reprise/exec/model'

import { createCandidate, tick } from '../lib/loop.js'
import { recordModelUnavailable } from '../lib/model-failure.js'
import { readRoundsState, stepWorkspace } from '../lib/rounds.js'
import { Store } from '../lib/store.js'

const AT = 1_761_091_200_000

class FakeClock {
  constructor(at = AT) {
    this.t = at
  }
  now() {
    return this.t
  }
  advance(ms) {
    this.t += ms
  }
}

/** The condition, as the adapter throws it. */
const outage = (cause = 'binary_missing') =>
  new ModelUnavailable({ cause, message: 'the model command is not installed: reprise-model' })

const fakePlatform = () => {
  const jobs = new Map()
  let counter = 0
  return {
    jobs,
    submit({ submissionId, candidateId }) {
      for (const job of jobs.values()) {
        if (job.submission_id === submissionId) return { job_id: job.job_id, duplicate: true, harness: 'fake', state: job.state }
      }
      counter += 1
      const job = { job_id: `job-${counter}`, submission_id: submissionId, candidate_id: candidateId, state: 'running' }
      jobs.set(job.job_id, job)
      return { job_id: job.job_id, harness: 'fake-harness', state: 'running' }
    },
    find: (candidateId) => [...jobs.values()].find((job) => job.candidate_id === candidateId),
    poll(jobId) {
      const job = jobs.get(jobId)
      return job === undefined ? { state: 'lost' } : { state: job.state, metrics: job.metrics }
    },
    finish(jobId, metrics = { auc: 0.7123 }) {
      Object.assign(jobs.get(jobId), { state: 'succeeded', metrics })
    },
    collect: async () => ({ metrics: { auc: 0.7123 }, artifacts: [] }),
    get size() {
      return jobs.size
    },
  }
}

const okHarness = {
  land: ({ candidateId }) => ({ ok: true, engine: 'fake', parent_id: 'baseline-0', parent_commit: 'aaa111', files: [], files_changed: 0, candidateId }),
}

const okJudge = {
  verify: ({ candidateId, now }) => ({
    candidate_id: candidateId,
    passed: true,
    checks: [{ name: 'static', result: 'pass' }],
    reviewer: { verdict: 'accept', rationale: 'fine' },
    decided_at_ms: now,
  }),
  analyze: ({ candidateId, now }) => ({
    candidate_id: candidateId,
    verdict: 'improved',
    observed: { metric: 'auc', value: 0.7123 },
    concluded: { metric: 'auc', value: 0.7123 },
    root_cause: 'the wider table helped',
    at_ms: now,
  }),
}

function candidateSetup({ judge = okJudge, harness = okHarness } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-outage-')))
  const clock = new FakeClock()
  const ports = { store, clock, platform: fakePlatform(), harness, judge }
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  return ports
}

const outages = (store) => store.ops(50).filter((row) => row.op === MODEL_UNAVAILABLE)
const detailOf = (row) => JSON.parse(row.detail)
const eventTypes = (store, candidateId = 'c1') => store.eventsFor(candidateId).map((event) => event.event_type)

const tickAt = async (ports) => {
  ports.clock.advance(10_000)
  return tick(ports)
}

// --------------------------------------------------------------- candidate phases

test('VERIFY: a review nobody could ask records one outage and leaves the candidate where it was', async () => {
  const ports = candidateSetup({
    judge: { ...okJudge, verify: () => { throw outage('timeout') } },
  })
  await tickAt(ports) // LAND
  await tickAt(ports) // BUILD
  assert.equal(ports.store.getState('c1', 'phase').phase, 'VERIFY')

  const { actions } = await tickAt(ports)

  const action = actions.find((entry) => entry.action === MODEL_UNAVAILABLE)
  assert.ok(action, 'the step reports the outage instead of waiting or rejecting')
  assert.equal(ports.store.getState('c1', 'phase').phase, 'VERIFY', 'the phase did not move')
  assert.equal(eventTypes(ports.store).includes('candidate_rejected'), false, 'a provider outage is not a candidate verdict')
  assert.equal(ports.store.getState('c1', 'phase').gate_attempts, undefined, 'an outage is not a gate attempt')
  assert.ok(ports.store.getState('c1', 'phase').next_action_at > ports.clock.now(), 'the retry is scheduled, not immediate')

  const rows = outages(ports.store)
  assert.equal(rows.length, 1, 'one row per step, not one per retry loop')
  const detail = detailOf(rows[0])
  assert.equal(detail.error_class, MODEL_UNAVAILABLE)
  assert.equal(detail.cause, 'timeout')
  assert.equal(detail.step, 'verify')
  assert.equal(detail.subject, 'c1')
  ports.store.close()
})

test('VERIFY: the next tick before the backoff does nothing at all', async () => {
  const ports = candidateSetup({ judge: { ...okJudge, verify: () => { throw outage() } } })
  await tickAt(ports)
  await tickAt(ports)
  await tickAt(ports)
  const phase = ports.store.getState('c1', 'phase')
  const nextActionAt = phase.next_action_at

  const { actions } = await tick(ports) // no clock advance: still inside the backoff

  assert.deepEqual(actions, [], 'a phase inside its backoff is skipped, not retried')
  assert.equal(outages(ports.store).length, 1, 'and no second outage row is written')
  assert.equal(ports.store.getState('c1', 'phase').next_action_at, nextActionAt)
  ports.store.close()
})

test('CAND_ANALYZE: an analysis nobody could ask is an outage, not an empty finding', async () => {
  const ports = candidateSetup({
    judge: { ...okJudge, analyze: () => { throw outage('exit_non_zero') } },
  })
  for (let index = 0; index < 6; index += 1) {
    await tickAt(ports)
    for (const job of ports.platform.jobs.values()) if (job.state === 'running') ports.platform.finish(job.job_id)
  }
  assert.equal(ports.store.getState('c1', 'phase').phase, 'CAND_ANALYZE')

  await tickAt(ports)

  assert.equal(ports.store.getState('c1', 'phase').phase, 'CAND_ANALYZE')
  assert.equal(eventTypes(ports.store).includes('candidate_rejected'), false)
  assert.equal(eventTypes(ports.store).includes('cand_analyze'), false, 'no report was written for an answer that never arrived')
  const detail = detailOf(outages(ports.store).at(-1))
  assert.equal(detail.step, 'cand_analyze')
  assert.equal(detail.cause, 'exit_non_zero')
  ports.store.close()
})

test('LAND: an implementer binary that is not installed is the same outage, not a rejected candidate', async () => {
  const ports = candidateSetup({
    harness: {
      land: () => ({ ok: false, error_class: HARNESS_UNAVAILABLE, message: 'claude: command not found', files: [], conflict: false }),
    },
  })

  await tickAt(ports)

  assert.equal(ports.store.getState('c1', 'phase').phase, 'LAND', 'the candidate is still waiting to be landed')
  assert.equal(eventTypes(ports.store).includes('land_done'), false)
  assert.equal(eventTypes(ports.store).includes('candidate_rejected'), false)
  const detail = detailOf(outages(ports.store).at(-1))
  assert.equal(detail.step, 'land')
  assert.equal(detail.error_class, MODEL_UNAVAILABLE, 'the adapter vocabulary maps into the one class')
  assert.equal(detail.cause, HARNESS_UNAVAILABLE, 'and the finer cause survives for the operator')
  ports.store.close()
})

test('LAND: a harness that refuses the task is an answer, so the candidate is rejected as before', async () => {
  const ports = candidateSetup({
    harness: { land: () => ({ ok: false, error_class: 'refusal', message: 'I will not rewrite the trainer', files: [], conflict: false }) },
  })

  await tickAt(ports)

  assert.equal(ports.store.getState('c1', 'phase').phase, 'REJECTED', 'a refusal is the model saying no, not an outage')
  assert.equal(outages(ports.store).length, 0)
  ports.store.close()
})

// ---------------------------------------------------------------- workspace phases

const roundsConfig = {
  rounds: {
    metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
    baseline: { metric: 'auc', value: 0.7 },
    max_rounds: 2,
    candidates_per_round: 1,
    retry: { base_ms: 1_000, max_ms: 8_000, max_attempts: 2 },
  },
}

const PLAN = {
  round: 1,
  hypotheses: [{ id: 'h1', statement: 'widen the embedding table', expected_files: ['model/embedding.py'] }],
  metric_contract_ref: 'metric-contract.json',
}

const LANDING = (candidateId) => ({
  artifact: {
    candidate_id: candidateId,
    round: 1,
    hypothesis_id: 'h1',
    statement: 'widen the embedding table',
    expected_files: ['model/embedding.py'],
    metric_contract_ref: 'metric-contract.json',
    frozen_at_ms: AT,
  },
  prompt: 'LAND — implement exactly one hypothesis',
})

function workspaceSetup({ plan = async () => PLAN, reflect } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-outage-ws-')))
  const clock = new FakeClock()
  const judge = {
    plan,
    land: async ({ candidateId }) => LANDING(candidateId),
    reflect: reflect ?? (async () => ({})),
  }
  const ports = { store, clock, judge, config: roundsConfig }
  return { ports, store, clock }
}

test('ROUND_PLAN: no model means one outage row and no round, not a refused artifact', async () => {
  const { ports, store } = workspaceSetup({ plan: async () => { throw outage('binary_missing') } })
  await stepWorkspace(ports) // INIT -> BASELINE
  await stepWorkspace(ports) // BASELINE -> ROUND_PLAN

  const step = await stepWorkspace(ports)

  assert.equal(step.action, MODEL_UNAVAILABLE)
  const state = readRoundsState(store)
  assert.equal(state.plan, undefined, 'no round was planned')
  assert.equal(state.attempts ?? 0, 0, 'the artifact-refusal budget was not spent')
  assert.equal(store.ops(20).some((row) => row.op === 'round_artifact_refused'), false, 'an outage is not a refused artifact')
  assert.ok(state.next_action_at > ports.clock.now())

  const detail = detailOf(outages(store).at(-1))
  assert.equal(detail.step, 'round_plan')
  assert.equal(detail.subject, 'round-1')
  assert.equal(detail.error_class, MODEL_UNAVAILABLE)

  const again = await stepWorkspace(ports)
  assert.equal(again.action, 'waiting', 'inside the backoff the phase does nothing, so a tick stays cheap')
  store.close()
})

test('ROUND_REFLECT: an outage keeps the round open without spending its retries', async () => {
  const { ports, store } = workspaceSetup({
    reflect: async () => {
      throw outage('unparseable_answer')
    },
  })
  await stepWorkspace(ports) // INIT -> BASELINE
  await stepWorkspace(ports) // BASELINE -> ROUND_PLAN
  await stepWorkspace(ports) // plan round 1

  const candidateId = readRoundsState(store).plan === undefined ? undefined : 'r1-h1'
  assert.ok(candidateId, 'the plan created its candidate')
  store.setState(candidateId, 'phase', { ...store.getState(candidateId, 'phase'), phase: 'DONE' })

  const step = await stepWorkspace(ports)

  assert.equal(step.action, MODEL_UNAVAILABLE)
  const state = readRoundsState(store)
  assert.equal(state.reflection, undefined, 'no reflection was recorded')
  assert.equal(state.attempts ?? 0, 0)
  const detail = detailOf(outages(store).at(-1))
  assert.equal(detail.step, 'round_reflect')
  assert.equal(detail.error_class, MODEL_UNAVAILABLE)
  store.close()
})

// -------------------------------------------------------------------- one name

test('all five judgement points report the same closed class, whichever failed', async () => {
  const seen = new Set()

  const candidateVerify = candidateSetup({ judge: { ...okJudge, verify: () => { throw outage() } } })
  await tickAt(candidateVerify)
  await tickAt(candidateVerify)
  await tickAt(candidateVerify)
  for (const row of outages(candidateVerify.store)) seen.add(detailOf(row).error_class)

  const candidateAnalyze = candidateSetup({ judge: { ...okJudge, analyze: () => { throw outage() } } })
  for (let index = 0; index < 7; index += 1) {
    await tickAt(candidateAnalyze)
    for (const job of candidateAnalyze.platform.jobs.values()) if (job.state === 'running') candidateAnalyze.platform.finish(job.job_id)
  }
  for (const row of outages(candidateAnalyze.store)) seen.add(detailOf(row).error_class)

  const candidateLand = candidateSetup({ harness: { land: () => ({ ok: false, error_class: HARNESS_UNAVAILABLE, message: 'gone' }) } })
  await tickAt(candidateLand)
  for (const row of outages(candidateLand.store)) seen.add(detailOf(row).error_class)

  const ws = workspaceSetup({ plan: async () => { throw outage() } })
  await stepWorkspace(ws.ports)
  await stepWorkspace(ws.ports)
  await stepWorkspace(ws.ports)
  for (const row of outages(ws.store)) seen.add(detailOf(row).error_class)

  assert.deepEqual([...seen], [MODEL_UNAVAILABLE], 'one name, five call sites — an operator greps one word')
  assert.equal(seen.size, 1)
  for (const store of [candidateVerify.store, candidateAnalyze.store, candidateLand.store, ws.store]) store.close()
})

test('a machine that could not start the process is retried in seconds, not in minutes', () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-outage-resource-')))
  const failure = { error_class: MODEL_UNAVAILABLE, cause: 'resource_exhausted', message: 'spawn EAGAIN' }

  const first = recordModelUnavailable({ store, now: AT, step: 'verify', failure, attempts: 0 })
  const second = recordModelUnavailable({ store, now: AT, step: 'verify', failure, attempts: 1 })

  assert.equal(first.next_action_at - AT, 1_000, 'a busy host must not look like a dead provider')
  assert.equal(second.next_action_at - AT, 2_000)
  assert.equal(detailOf(store.ops(10)[0]).error_class, MODEL_UNAVAILABLE, 'still the one class')
  store.close()
})

test('the backoff doubles from a minute and is capped, and it is not the candidate retry budget', () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-outage-backoff-')))
  const failure = { error_class: MODEL_UNAVAILABLE, cause: 'timeout', message: 'no answer' }

  const first = recordModelUnavailable({ store, now: AT, step: 'verify', failure, attempts: 0 })
  const second = recordModelUnavailable({ store, now: AT, step: 'verify', failure, attempts: 1 })
  const far = recordModelUnavailable({ store, now: AT, step: 'verify', failure, attempts: 20 })

  assert.equal(first.next_action_at - AT, 60_000)
  assert.equal(second.next_action_at - AT, 120_000)
  assert.equal(far.next_action_at - AT, 3_600_000, 'capped at an hour: an outage is a condition, not a countdown')
  assert.deepEqual(
    store.ops(10).map((row) => row.op),
    [MODEL_UNAVAILABLE, MODEL_UNAVAILABLE, MODEL_UNAVAILABLE],
    'the ops log is where this lives — no candidate event was invented',
  )
  store.close()
})