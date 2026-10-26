/**
 * The workspace phases wired into the one main seam.
 *
 * loop.test.js proves the candidate machine on its own. These tests prove the two things that only
 * become visible once the workspace step runs inside `tick`:
 *
 * 1. a configured workspace plans a round, the candidates run, the round is reflected on, and the
 *    workspace finalises — all of it from ticks, with no host and no real model;
 * 2. the phases that are not model entries call the model **zero** times, and a model that returns
 *    numbers changes nothing downstream.
 *
 * The VERIFY pair lives here too, because "the review rejects" and "the review accepts over a failed
 * static check" are verdicts about a *candidate*, and the candidate's fate is only observable at the
 * phase machine.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fileArtifacts } from '../lib/artifacts.js'
import { FEED_PROMPTS_DIR, judgeFor } from './support/domain.js'
import { tick } from '../lib/loop.js'
import { readRoundsState } from '../lib/rounds.js'
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

function fakePlatform() {
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
    find(candidateId) {
      return [...jobs.values()].find((job) => job.candidate_id === candidateId)
    },
    poll(jobId) {
      const job = jobs.get(jobId)
      return job === undefined ? { state: 'lost' } : { state: job.state, metrics: job.metrics, error_class: job.error_class }
    },
    finish(jobId, metrics = { auc: 0.7123 }) {
      Object.assign(jobs.get(jobId), { state: 'succeeded', metrics })
    },
    get size() {
      return jobs.size
    },
  }
}

const fakeHarness = {
  land({ candidateId }) {
    return { engine: 'fake-harness', parent_id: 'baseline-0', parent_commit: 'aaa1111', files_changed: 1, candidateId }
  },
}

const ROUND_CONFIG = {
  rounds: {
    metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
    baseline: { metric: 'auc', value: 0.7012 },
    max_rounds: 1,
    candidates_per_round: 2,
    retry: { base_ms: 1_000, max_ms: 8_000, max_attempts: 2 },
  },
}

const PLAN = {
  hypotheses: [
    { id: 'h1', statement: 'widen the embedding table to 2^22', expected_files: ['model/embedding.py'] },
    { id: 'h2', statement: 'share the projection across heads', expected_files: ['model/attention.py'] },
  ],
}

const REFLECT = {
  summary: 'capacity helped; the projection change did not',
  lessons: [{ statement: 'capacity only pays above a rare-feature rate', evidence: 'r1-h1' }],
  next_round_focus: ['measure the rare-feature rate first'],
}

/**
 * A model port that records the *workspace phase it was called in*, read from the fact plane rather
 * than guessed — this is what makes "no model call in a deterministic phase" assertable.
 */
function recordedModel(store, answers) {
  const calls = []
  const model = async (request) => {
    calls.push({ call_site: request.call_site, workspace_phase: readRoundsState(store)?.phase })
    const answer = answers[request.call_site]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(request) : answer
  }
  return { model, calls, sites: () => calls.map((call) => call.call_site) }
}

function setup({ config = ROUND_CONFIG, answers = {}, artifacts } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-workspace-')))
  const clock = new FakeClock()
  const platform = fakePlatform()
  const recorded = recordedModel(store, {
    round_plan: PLAN,
    round_reflect: REFLECT,
    verify: { verdict: 'accept', rationale: 'minimal diff, no evaluation changes' },
    cand_analyze: { root_cause: 'the wider table removed collisions on rare features' },
    ...answers,
  })
  const judge = judgeFor({
    model: recorded.model,
    metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
    baseline: 0.7012,
    ...(artifacts === undefined ? {} : { artifacts }),
  })
  return { store, clock, platform, harness: fakeHarness, judge, config, model: recorded, artifacts }
}

/** Tick until the workspace has finalised, finishing every running job as a platform would. */
async function driveUntilFinalized(ports, { maxTicks = 80 } = {}) {
  const seen = []
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await tick(ports)
    seen.push(...result.actions)
    if (result.paused !== null) return { actions: seen, paused: result.paused }
    for (const job of ports.platform.jobs.values()) {
      if (job.state === 'running') ports.platform.finish(job.job_id)
    }
    if (readRoundsState(ports.store)?.finalized_at_ms !== undefined) return { actions: seen, paused: null, ticks: index + 1 }
    ports.clock.advance(10_000)
  }
  return { actions: seen, paused: null, exhausted: true }
}

test('a configured workspace plans, runs and reflects a round, then finalises — from ticks alone', async () => {
  const ports = setup()
  const { paused } = await driveUntilFinalized(ports)

  assert.equal(paused, null)
  const state = readRoundsState(ports.store)
  assert.equal(state.phase, 'FINALIZE')
  assert.ok(state.finalized_at_ms !== undefined, 'the workspace closed itself without a model deciding it should')

  assert.deepEqual(ports.store.candidateIds(), ['r1-h1', 'r1-h2'])
  for (const candidateId of ['r1-h1', 'r1-h2']) {
    assert.equal(ports.store.getState(candidateId, 'phase').phase, 'DONE', `${candidateId} ran to completion`)
  }

  assert.deepEqual(
    ports.model.sites().sort(),
    ['cand_analyze', 'cand_analyze', 'round_plan', 'round_reflect', 'verify', 'verify'],
    'five call sites exist; each candidate is reviewed and analysed once, and the round is planned and reflected on once',
  )
  ports.store.close()
})

test('the deterministic workspace phases call the model zero times', async () => {
  const ports = setup()
  await driveUntilFinalized(ports)

  const phasesThatConsultAModel = new Set(['round_plan', 'round_reflect'])
  for (const call of ports.model.calls) {
    if (phasesThatConsultAModel.has(call.call_site)) {
      assert.equal(call.workspace_phase, 'ROUND_PLAN', `${call.call_site} belongs to the round phase`)
      continue
    }
    // verify / cand_analyze run inside a round too; what must never happen is a call made while the
    // workspace is initialising, freezing a baseline, or finalising.
    assert.equal(call.workspace_phase, 'ROUND_PLAN', `${call.call_site} was called in ${call.workspace_phase}`)
  }
  assert.ok(ports.model.calls.length > 0, 'the model was consulted at all, so the assertion above is not vacuous')
  ports.store.close()
})

test('a workspace with no round workflow ticks exactly as it did before this module existed', async () => {
  const ports = setup({ config: null })
  ports.store.setState('c1', 'phase', { phase: 'LAND', round: 1, hypothesis: 'widen the embedding table' })
  await tick(ports)

  assert.equal(readRoundsState(ports.store), undefined, 'no workspace phase is invented for a candidate-only run')
  assert.deepEqual(ports.model.sites(), [], 'the candidate reached LAND without consulting a model')
  ports.store.close()
})

// ------------------------------------------------------------------ VERIFY

test('an adversarial review that rejects stops the candidate before anything is submitted', async () => {
  const ports = setup({
    config: null,
    answers: { verify: { verdict: 'reject', rationale: 'it also changes the evaluation split' } },
  })
  ports.store.setState('c1', 'phase', { phase: 'LAND', round: 1, hypothesis: 'widen the embedding table to 2^22' })
  // The gate is retried on a backoff, so the clock has to move for the attempt budget to be spent:
  // reaching REJECTED takes several ticks by design, and one refusal must not be enough.
  for (let index = 0; index < 4; index += 1) {
    await tick(ports)
    ports.clock.advance(10_000)
  }
  assert.equal(ports.store.getState('c1', 'phase').phase, 'VERIFY', 'the first refusal did not kill the candidate')

  for (let index = 0; index < 8; index += 1) {
    await tick(ports)
    ports.clock.advance(10_000)
  }

  const state = ports.store.getState('c1', 'phase')
  assert.equal(state.phase, 'REJECTED')
  assert.equal(ports.platform.size, 0, 'nothing was submitted for a rejected candidate')
  assert.match(state.reject_reason, /did not pass/)
  assert.equal(ports.store.bindings('c1').verify_gate, undefined, 'no gate was frozen for a rejected candidate')

  const rejection = ports.store.eventsFor('c1').at(-1)
  assert.equal(rejection.event_type, 'candidate_rejected')
  assert.equal(rejection.payload.status, undefined, 'a legitimately failed gate is not a malformed artifact')
  assert.equal(rejection.payload.attempts, 3, 'and the run can say how many tries the gate got')
  ports.store.close()
})

test('a review that accepts over a failed static check is recorded as a conflict, and the candidate stops', async () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-workspace-conflict-')))
  const clock = new FakeClock()
  const recorded = recordedModel(store, {
    verify: { verdict: 'accept', rationale: 'I see nothing wrong with it' },
  })
  const judge = judgeFor({
    model: recorded.model,
    staticChecks: () => [
      { name: 'worktree_clean', result: 'fail' },
      { name: 'parent_binding_frozen', result: 'pass' },
    ],
  })
  const ports = { store, clock, platform: fakePlatform(), harness: fakeHarness, judge }
  store.setState('c1', 'phase', { phase: 'LAND', round: 1, hypothesis: 'widen the embedding table to 2^22' })
  for (let index = 0; index < 6; index += 1) await tick(ports)

  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  const rejection = store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, 'conflict', 'two facts that must agree do not')
  assert.match(rejection.payload.blocking_message, /accepted while 1 check\(s\) failed \(worktree_clean\)/)
  assert.equal(ports.platform.size, 0)
  store.close()
})

test('the verdict the gate judged is on disk under the reference the fact plane records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-workspace-artifacts-'))
  const artifacts = fileArtifacts(dir)
  const ports = setup({
    config: null,
    answers: { verify: { verdict: 'accept', rationale: 'minimal diff' } },
    artifacts,
  })
  ports.store.setState('c1', 'phase', { phase: 'LAND', round: 1, hypothesis: 'widen the embedding table to 2^22' })
  for (let index = 0; index < 3; index += 1) await tick(ports)

  const stored = artifacts.read('verify_verdict:c1')
  assert.equal(stored.candidate_id, 'c1')
  assert.equal(stored.passed, true)
  assert.equal(stored.reviewer.verdict, 'accept')
  assert.ok(artifacts.write !== undefined)
  ports.store.close()
})

test('dump names the field a refused artifact got wrong, so a reader can fix it', async () => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-workspace-dump-')))
  const clock = new FakeClock()
  const recorded = recordedModel(store, { verify: { verdict: 'accept', rationale: 'looks fine' } })
  // A check whose result is neither pass nor fail makes the record malformed, and the contract says
  // so. (An empty injected list is no longer enough: gate two always contributes its own three.)
  const judge = judgeFor({ model: recorded.model, staticChecks: () => [{ name: 'worktree_clean', result: 'maybe' }] })
  const ports = { store, clock, platform: fakePlatform(), harness: fakeHarness, judge }
  store.setState('c1', 'phase', { phase: 'LAND', round: 1, hypothesis: 'widen the embedding table to 2^22' })
  for (let index = 0; index < 6; index += 1) await tick(ports)

  const { renderDump } = await import('../lib/cli/dump.js')
  const output = renderDump(store, 'c1')
  assert.match(output, /REJECTED/)
  assert.match(output, /invalid/, 'the four-state conclusion survives to the dump')
  assert.match(output, /result must be "pass" or "fail"/, 'and it names the field, not just "it failed"')
  store.close()
})

// --------------------------------------------------------------- skills

test('swapping one markdown skill changes what the gate decides, with no code change', async () => {
  // The model's answer follows the instruction it was given, which is what a real model does. So the
  // only thing that differs between the two runs below is the text of skills/verify/SKILL.md.
  const run = async (skillsDir) => {
    const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-skill-swap-')))
    const clock = new FakeClock()
    const model = async (request) =>
      request.prompt.includes('REJECT-EVERYTHING')
        ? { verdict: 'reject', rationale: 'the skill told me to reject everything' }
        : { verdict: 'accept', rationale: 'no problems found' }
    const judge = judgeFor({ model, skillsDir })
    store.setState('c1', 'phase', { phase: 'LAND', round: 1, hypothesis: 'widen the embedding table to 2^22' })
    const ports = { store, clock, platform: fakePlatform(), harness: fakeHarness, judge }
    for (let index = 0; index < 12; index += 1) {
      await tick(ports)
      clock.advance(10_000)
    }
    const phase = store.getState('c1', 'phase').phase
    store.close()
    return phase
  }

  assert.notEqual(await run(FEED_PROMPTS_DIR), 'REJECTED', 'the shipped skill lets a clean candidate through')

  const edited = mkdtempSync(join(tmpdir(), 'reprise-skill-swap-pack-'))
  cpSync(FEED_PROMPTS_DIR, edited, { recursive: true })
  const path = join(edited, 'verify', 'SKILL.md')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n\nREJECT-EVERYTHING in this round.\n`)

  assert.equal(await run(edited), 'REJECTED', 'editing markdown changed the gate, without repackaging or touching code')
})

// ------------------------------------------------------------- no numbers

test('numbers a model invents never reach the fact plane or the workspace decision', async () => {
  const ports = setup({
    answers: {
      round_plan: { hypotheses: PLAN.hypotheses, score: 0.5, rank: 1 },
      verify: { verdict: 'accept', rationale: 'fine', score: 0.999, confidence: 1 },
      cand_analyze: { root_cause: 'wider table removed hash collisions', verdict: 'regressed', score: 12345 },
      round_reflect: { ...REFLECT, stop: true, score: 4242, rank: 0 },
    },
  })
  await driveUntilFinalized(ports)

  const state = readRoundsState(ports.store)
  assert.equal(state.phase, 'FINALIZE', 'the round budget ended the run, not the model')
  assert.equal(state.round, 1)

  const analysed = ports.store.eventsFor('r1-h1').find((event) => event.event_type === 'cand_analyze')
  assert.equal(analysed.payload.verdict, 'improved', 'the verdict is arithmetic on the monitor metrics')

  const serialised = JSON.stringify([
    ...ports.store.eventsFor('r1-h1'),
    ...ports.store.eventsFor('r1-h2'),
    state,
  ])
  for (const invented of ['12345', '0.999', '4242', '"rank"']) {
    assert.equal(serialised.includes(invented), false, `the model's ${invented} must not reach the fact plane`)
  }
  ports.store.close()
})