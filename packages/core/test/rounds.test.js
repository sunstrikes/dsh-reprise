/**
 * The workspace phases: INIT → BASELINE → ROUND_PLAN → FINALIZE.
 *
 * What this file guards: one tick advances the workspace by at most one step; the two phases that
 * consult a model (ROUND_PLAN, ROUND_REFLECT) may only advance the phase through an artifact the
 * contract accepts; and the phases that do not consult a model call it exactly zero times. The
 * candidate machine is exercised by loop.test.js — here candidates are only *finished* directly, so
 * these tests stay about round bookkeeping.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { artifactKinds, validateArtifact } from '@dsh-reprise/contract'

import { createCandidate } from '../lib/loop.js'
import { judgeFor } from './support/domain.js'
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

/** A model port with a call log, driven by a per-call-site script. */
function scripted(answers) {
  const calls = []
  const model = async (request) => {
    calls.push(request)
    const answer = answers[request.call_site]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(request) : answer
  }
  return { model, calls, sites: () => calls.map((call) => call.call_site), get count() { return calls.length } }
}

const GOLDEN_PLAN = (round) => ({
  hypotheses: [
    { id: 'h1', statement: `round ${round}: widen the embedding table to 2^22`, expected_files: ['model/embedding.py'] },
    { id: 'h2', statement: `round ${round}: share the projection across heads`, expected_files: ['model/attention.py'] },
  ],
})

const GOLDEN_REFLECT = {
  summary: 'graduation 1: capacity helped, the projection change did not',
  lessons: [{ statement: 'capacity only pays above a rare-feature rate', evidence: 'candidate r1-h1' }],
  next_round_focus: ['measure the rare-feature rate first'],
}

const CONFIG = {
  rounds: {
    metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
    baseline: { metric: 'auc', value: 0.7012 },
    max_rounds: 2,
    candidates_per_round: 2,
    retry: { base_ms: 1_000, max_ms: 8_000, max_attempts: 2 },
  },
}

/** A workspace ready to step, with its fact plane on a real SQLite file in a temp directory. */
function setup({ config = CONFIG, answers = {}, baseline, judge, artifacts } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-rounds-')))
  const clock = new FakeClock()
  const model = scripted({
    round_plan: GOLDEN_PLAN(1),
    round_reflect: GOLDEN_REFLECT,
    ...answers,
  })
  const realJudge = judge ?? judgeFor({
    model: model.model,
    metric: CONFIG.rounds.metric,
    baseline: config?.rounds?.baseline?.value,
  })
  const ports = { store, clock, judge: realJudge, config, model, baseline, artifacts }
  return { ...ports, store }
}

const step = (ports) => stepWorkspace(ports)

/** Walk the workspace to the plan of round 1 without depending on how many ticks that takes. */
async function toRoundOne(ports) {
  await step(ports) // INIT -> BASELINE
  await step(ports) // BASELINE -> ROUND_PLAN
  await step(ports) // plan round 1
  return readRoundsState(ports.store)
}

const finish = (store, candidateId, phase = 'DONE') => {
  const state = store.getState(candidateId, 'phase')
  store.setState(candidateId, 'phase', { ...state, phase })
}

test('the round artifact kinds are registered with the contract, and registering twice is harmless', async () => {
  // Importing the module twice must not throw on a duplicate definition: the registry is the
  // contract's, and this ticket registers into it from core.
  const again = await import('../lib/artifact-kinds.js')
  assert.deepEqual([...again.ROUND_ARTIFACT_KINDS], ['round_reflect', 'land_hypothesis'])
  for (const kind of again.ROUND_ARTIFACT_KINDS) {
    assert.ok(artifactKinds().includes(kind), `${kind} is a kind the contract can validate`)
    assert.notEqual(validateArtifact(kind, {}).message, `unknown artifact kind "${kind}"`)
  }
})

// ------------------------------------------------------------------- INIT

test('INIT and BASELINE are deterministic: no model call, and the baseline is frozen, not asked for', async () => {
  const ports = setup()

  const init = await step(ports)
  assert.match(init.action, /init -> baseline/)
  assert.equal(init.phase, 'BASELINE')
  assert.equal(ports.model.count, 0, 'starting a workspace is not a judgement')

  const baseline = await step(ports)
  assert.match(baseline.action, /baseline frozen -> round_plan/)
  assert.equal(baseline.phase, 'ROUND_PLAN')
  assert.equal(ports.model.count, 0, 'freezing evidence the run already produced is not a judgement')

  const state = readRoundsState(ports.store)
  assert.equal(state.round, 0, 'no round has been planned yet')
  assert.deepEqual(state.baseline, { metric: 'auc', value: 0.7012, frozen_at_ms: AT })
  assert.equal(state.plan, undefined)
  ports.store.close()
})

test('a workspace with no baseline evidence waits instead of inventing one', async () => {
  const ports = setup({ config: { rounds: { ...CONFIG.rounds, baseline: undefined } } })
  await step(ports)
  const waiting = await step(ports)

  assert.match(waiting.action, /waiting_for_baseline/)
  assert.equal(readRoundsState(ports.store).phase, 'BASELINE')
  assert.equal(ports.model.count, 0)

  // Evidence arriving later is picked up by the next tick, with no restart and no model call.
  const late = setup({ config: { rounds: { ...CONFIG.rounds, baseline: undefined } }, baseline: { read: () => ({ metric: 'auc', value: 0.7005 }) } })
  await step(late)
  const advanced = await step(late)
  assert.equal(advanced.phase, 'ROUND_PLAN')
  assert.equal(readRoundsState(late.store).baseline.value, 0.7005)
  assert.equal(late.model.count, 0, 'where the number came from is the run\'s business, not the model\'s')
  late.store.close()
  ports.store.close()
})

test('an unusable round configuration pauses the workspace instead of running it wrongly', async () => {
  const ports = setup({ config: { rounds: { ...CONFIG.rounds, metric: { direction: 'sideways' }, max_rounds: 0 } } })
  const result = await step(ports)

  assert.match(result.action, /config_invalid/)
  assert.equal(readRoundsState(ports.store).phase, 'INIT', 'nothing advanced on a configuration the run cannot honour')
  const paused = ports.store.getState(undefined, 'workspace').paused
  assert.equal(paused.reason, 'round_config_invalid')
  assert.equal(paused.automatic, false, 'only a human can decide what the metric is supposed to be')
  ports.store.close()
})

test('the workspace step does nothing at all when no round workflow is configured', async () => {
  const ports = setup({ config: null })
  const result = await step(ports)
  assert.equal(result.action, 'skipped')
  assert.equal(readRoundsState(ports.store), undefined, 'no state is written for a workflow that does not exist')
  assert.equal(ports.model.count, 0)
  ports.store.close()
})

test('the metric contract is frozen at init, so a mid-run config edit cannot redefine "better"', async () => {
  const ports = setup()
  await step(ports) // INIT
  await step(ports) // BASELINE

  // Somebody edits the config while the run is going: a different metric, the other direction.
  ports.config = { rounds: { ...CONFIG.rounds, metric: { name: 'loss', direction: 'lower', contract_ref: 'other.json' } } }
  await step(ports) // plan

  const facts = ports.model.calls.at(-1).facts
  assert.equal(facts.metric_contract.name, 'auc', 'the baseline was frozen against auc; it cannot become loss')
  assert.equal(facts.metric_contract.direction, 'higher')
  assert.equal(readRoundsState(ports.store).metric.name, 'auc')
  ports.store.close()
})

// -------------------------------------------------------------- ROUND_PLAN

test('a planned round becomes one candidate per hypothesis, with its landing briefed from the skill', async () => {
  const ports = setup()
  const state = await toRoundOne(ports)

  assert.equal(state.phase, 'ROUND_PLAN')
  assert.equal(state.round, 1)
  assert.deepEqual(ports.store.candidateIds(), ['r1-h1', 'r1-h2'])

  const candidate = ports.store.getState('r1-h1', 'phase')
  assert.equal(candidate.phase, 'LAND')
  assert.equal(candidate.round, 1)
  assert.match(candidate.hypothesis, /widen the embedding table/)

  const landing = ports.store.getState('r1-h1', 'land')
  assert.deepEqual(validateArtifact('land_hypothesis', landing.artifact), { status: 'ok', message: '' })
  assert.match(landing.prompt, /LAND — implement exactly one hypothesis/, 'the implementer brief is the markdown skill')

  // The exit artifact is a file, and the plan on disk is the one the contract accepted.
  const plan = JSON.parse(readFileSync(state.plan.path, 'utf8'))
  assert.deepEqual(validateArtifact('candidate_plan', plan), { status: 'ok', message: '' })
  assert.equal(state.plan.sha256.length, 64)
  assert.deepEqual(ports.model.sites(), ['round_plan'], 'one plan, one model call')
  ports.store.close()
})

test('re-stepping an accepted plan creates nothing twice and asks the model nothing again', async () => {
  const ports = setup()
  await toRoundOne(ports)
  const callsAfterPlan = ports.model.count

  const again = await step(ports)
  assert.match(again.action, /waiting for round 1/)
  assert.equal(ports.store.candidateIds().length, 2, 'the same hypotheses are not a second candidate each')
  assert.equal(ports.model.count, callsAfterPlan)
  ports.store.close()
})

test('a plan the contract refuses does not advance the phase, and the message names the missing field', async () => {
  const ports = setup({
    answers: { round_plan: { hypotheses: [{ id: 'h1', expected_files: ['a.py'] }] } },
  })
  await step(ports)
  await step(ports)
  const refused = await step(ports)

  assert.match(refused.action, /refused:invalid/)
  assert.match(refused.message, /hypotheses\[0\]\.statement/)
  const state = readRoundsState(ports.store)
  assert.equal(state.phase, 'ROUND_PLAN')
  assert.equal(state.round, 0, 'a rejected plan is not a round')
  assert.deepEqual(ports.store.candidateIds(), [], 'nothing is created from an artifact nobody accepted')
  assert.ok(
    ports.store.ops().some((record) => record.op === 'round_artifact_refused' && record.detail.includes('hypotheses[0].statement')),
    'the refusal is a queryable fact, not only a log line',
  )
  ports.store.close()
})

test('a second refused artifact in a row pauses the workspace for a human', async () => {
  const ports = setup({
    answers: { round_plan: { hypotheses: [{ id: 'h1', expected_files: ['a.py'] }] } },
  })
  await step(ports)
  await step(ports)
  await step(ports) // first refusal
  ports.clock.advance(5_000)
  const second = await step(ports) // second refusal, and the retry budget is spent

  assert.match(second.action, /refused:invalid/)
  assert.equal(ports.store.getState(undefined, 'workspace').paused.reason, 'round_artifact_refused')
  ports.store.close()
})

test('a refused artifact is retried after the backoff instead of spinning every tick', async () => {
  const ports = setup({
    answers: { round_plan: { hypotheses: [{ id: 'h1', expected_files: ['a.py'] }] } },
  })
  await step(ports)
  await step(ports)
  await step(ports)
  const callsAfterRefusal = ports.model.count

  const early = await step(ports)
  assert.equal(early.action, 'waiting')
  assert.equal(ports.model.count, callsAfterRefusal, 'a refused artifact does not earn a model call per tick')

  ports.clock.advance(5_000)
  await step(ports)
  assert.equal(ports.model.count, callsAfterRefusal + 1)
  ports.store.close()
})

test('two hypotheses sharing an id are a conflict, and no candidate is created', async () => {
  const ports = setup({
    answers: {
      round_plan: {
        hypotheses: [
          { id: 'h1', statement: 'widen the table', expected_files: ['a.py'] },
          { id: 'h1', statement: 'share the projection', expected_files: ['b.py'] },
        ],
      },
    },
  })
  await step(ports)
  await step(ports)
  const refused = await step(ports)

  assert.match(refused.action, /refused:conflict/)
  assert.deepEqual(ports.store.candidateIds(), [])
  ports.store.close()
})

test('a hypothesis that names no file never becomes a candidate', async () => {
  const ports = setup({
    answers: { round_plan: { hypotheses: [{ id: 'h1', statement: 'make the model better', expected_files: [] }] } },
  })
  await step(ports)
  await step(ports)
  const refused = await step(ports)

  assert.match(refused.action, /refused:invalid/)
  assert.match(refused.message, /expected_files/)
  assert.deepEqual(ports.store.candidateIds(), [])
  ports.store.close()
})

test('a plan that would create more candidates than the round affords is refused', async () => {
  const ports = setup({
    answers: {
      round_plan: {
        hypotheses: [1, 2, 3].map((index) => ({ id: `h${index}`, statement: `idea ${index}`, expected_files: [`f${index}.py`] })),
      },
    },
  })
  await step(ports)
  await step(ports)
  const refused = await step(ports)

  assert.match(refused.action, /refused:invalid/)
  assert.match(refused.message, /candidates_per_round/)
  assert.deepEqual(ports.store.candidateIds(), [])
  ports.store.close()
})

test('a judge port that throws is a refused artifact, not a crashed loop', async () => {
  const ports = setup({
    judge: {
      plan: async () => {
        throw new Error('skill file disappeared')
      },
      reflect: async () => ({}),
      land: async () => ({ artifact: {}, prompt: '' }),
    },
  })
  await step(ports)
  await step(ports)
  const refused = await step(ports)

  assert.match(refused.action, /refused:invalid/)
  assert.match(refused.message, /skill file disappeared/)
  assert.equal(readRoundsState(ports.store).phase, 'ROUND_PLAN')
  ports.store.close()
})

// ------------------------------------------------------------ ROUND_REFLECT

test('a finished round is reflected on exactly once, from structured facts', async () => {
  const ports = setup()
  await toRoundOne(ports)
  finish(ports.store, 'r1-h1')
  finish(ports.store, 'r1-h2', 'REJECTED')

  const reflected = await step(ports)
  assert.match(reflected.action, /reflected round 1/)
  assert.equal(readRoundsState(ports.store).reflection.round, 1)
  const artifact = JSON.parse(readFileSync(readRoundsState(ports.store).reflection.path, 'utf8'))
  assert.deepEqual(validateArtifact('round_reflect', artifact), { status: 'ok', message: '' })

  const facts = ports.model.calls.at(-1).facts
  assert.deepEqual(facts.candidates.map((candidate) => [candidate.candidate_id, candidate.phase]), [
    ['r1-h1', 'DONE'],
    ['r1-h2', 'REJECTED'],
  ])
  assert.equal(facts.baseline.value, 0.7012)

  const callsAfterReflection = ports.model.count
  const again = await step(ports)
  assert.match(again.action, /round 1 closed/)
  assert.equal(ports.model.count, callsAfterReflection, 'a round is reflected on once')
  ports.store.close()
})

test('a reflection the contract refuses keeps the round open', async () => {
  const ports = setup({ answers: { round_reflect: { lessons: [], next_round_focus: ['try again'] } } })
  await toRoundOne(ports)
  finish(ports.store, 'r1-h1')
  finish(ports.store, 'r1-h2')

  const refused = await step(ports)
  assert.match(refused.action, /refused:missing/)
  assert.match(refused.message, /summary/)
  assert.equal(readRoundsState(ports.store).reflection, undefined)
  assert.equal(readRoundsState(ports.store).phase, 'ROUND_PLAN')
  ports.store.close()
})

test('a round is not reflected on while any of its candidates is still running', async () => {
  const ports = setup()
  await toRoundOne(ports)
  finish(ports.store, 'r1-h1')

  const waiting = await step(ports)
  assert.match(waiting.action, /waiting for round 1 \(1 candidate/)
  assert.equal(readRoundsState(ports.store).reflection, undefined)
  ports.store.close()
})

test('a model-authored stop flag does not stop the search — the round budget does', async () => {
  const ports = setup({
    answers: { round_reflect: { ...GOLDEN_REFLECT, stop: true, score: 0.99 } },
  })
  await toRoundOne(ports)
  finish(ports.store, 'r1-h1')
  finish(ports.store, 'r1-h2')
  await step(ports) // reflect round 1
  await step(ports) // close round 1
  const planned = await step(ports) // plan round 2

  assert.match(planned.action, /planned round 2/, 'the model does not get to end the run')
  assert.equal(readRoundsState(ports.store).round, 2)
  assert.equal(ports.store.getState(undefined, 'workspace')?.paused ?? null, null, 'a recommendation in prose is not a decision')
  ports.store.close()
})

test('lowering the round budget mid-run stops before the next plan, without asking a model', async () => {
  const ports = setup()
  await toRoundOne(ports)
  finish(ports.store, 'r1-h1')
  finish(ports.store, 'r1-h2')
  await step(ports) // reflect
  await step(ports) // close round 1
  const callsBefore = ports.model.count

  // The operator decides this run is done after one round.
  ports.config = { rounds: { ...CONFIG.rounds, max_rounds: 1 } }
  const finalize = await step(ports)

  assert.equal(finalize.phase, 'FINALIZE', 'a lower round budget is honoured before the next plan is bought')
  assert.equal(ports.model.count, callsBefore, 'and it costs nothing to honour')
  ports.store.close()
})

// ---------------------------------------------------------------- FINALIZE

test('after the round budget is spent the workspace finalises, and finalising calls no model', async () => {
  const ports = setup()
  await toRoundOne(ports)
  finish(ports.store, 'r1-h1')
  finish(ports.store, 'r1-h2')
  await step(ports) // reflect round 1
  await step(ports) // close round 1
  await step(ports) // plan round 2
  finish(ports.store, 'r2-h1')
  finish(ports.store, 'r2-h2')
  await step(ports) // reflect round 2
  const callsBeforeFinalize = ports.model.count

  const finalize = await step(ports)
  assert.equal(finalize.phase, 'FINALIZE')
  assert.equal(ports.model.count, callsBeforeFinalize, 'deciding the search is over is not a judgement call')

  const done = await step(ports)
  assert.match(done.action, /finalized/)
  const state = readRoundsState(ports.store)
  assert.equal(state.phase, 'FINALIZE')
  assert.equal(state.finalized_at_ms, ports.clock.now())
  assert.ok(ports.store.ops().some((record) => record.op === 'workspace_finalized'))

  const after = await step(ports)
  assert.match(after.action, /finalized/)
  assert.equal(ports.model.count, callsBeforeFinalize, 'a finished workspace is inert')
  ports.store.close()
})

test('the round workflow survives a restart: the phase and the plan come back from the fact plane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-rounds-restart-'))
  const clock = new FakeClock()
  const model = scripted({ round_plan: GOLDEN_PLAN(1), round_reflect: GOLDEN_REFLECT })
  const judge = judgeFor({ model: model.model, metric: CONFIG.rounds.metric, baseline: 0.7012 })

  const first = Store.open(dir)
  const ports = { store: first, clock, judge, config: CONFIG, model }
  await toRoundOne(ports)
  first.close()

  const reopened = Store.open(dir)
  const restartPorts = { store: reopened, clock, judge, config: CONFIG, model }
  const callsBefore = model.count
  const state = readRoundsState(reopened)
  assert.equal(state.phase, 'ROUND_PLAN')
  assert.equal(state.round, 1)

  const waiting = await stepWorkspace(restartPorts)
  assert.match(waiting.action, /waiting for round 1/)
  assert.equal(model.count, callsBefore, 'the plan is on disk, so a restart does not re-plan the round')
  assert.deepEqual(reopened.candidateIds(), ['r1-h1', 'r1-h2'])
  reopened.close()
})

test('a candidate created by another path is never mistaken for a round candidate', async () => {
  const ports = setup()
  createCandidate(ports, { candidateId: 'manual-1', round: 9, hypothesis: 'hand-made candidate' })
  const state = await toRoundOne(ports)
  finish(ports.store, 'r1-h1')
  finish(ports.store, 'r1-h2')

  // Only round 1's candidates decide whether round 1 is over, so reflection can happen even while
  // a hand-made candidate from elsewhere is still running.
  const reflected = await step(ports)
  assert.match(reflected.action, /reflected round 1/)
  assert.equal(ports.store.getState('manual-1', 'phase').phase, 'LAND')
  assert.equal(readRoundsState(ports.store).plan.round, 1)
  assert.ok(state.plan !== undefined)
  ports.store.close()
})
// ------------------------------------------------------------- parents

/**
 * A finished candidate with the number it finished on: what the frontier needs to see it.
 *
 * Both halves matter. `metrics_collected` is the only source of a metric value, and `cand_analyze`
 * is what makes the derived row say `done` — a candidate the analysis never reached is not a parent,
 * however good its number looks.
 */
const finishWithMetrics = (store, candidateId, metrics, verdict = 'improved') => {
  store.appendEvent({
    candidate_id: candidateId,
    wall_clock_ms: AT,
    event_type: 'metrics_collected',
    payload: { metrics },
  })
  store.appendEvent({
    candidate_id: candidateId,
    wall_clock_ms: AT,
    event_type: 'cand_analyze',
    payload: { verdict, observed: { metric: 'auc', value: Object.values(metrics)[0] } },
  })
  finish(store, candidateId)
}

test('a planned round freezes one parent snapshot, and every candidate names the parent it starts from', async () => {
  const ports = setup()
  const state = await toRoundOne(ports)

  const frozen = state.plan.parent_snapshot
  assert.match(frozen.address, /^[0-9a-f]{64}$/, 'the snapshot is identified by a content address, not by its position in a log')
  const onDisk = JSON.parse(readFileSync(frozen.path, 'utf8'))
  assert.equal(onDisk.address, frozen.address, 'the bytes on disk name themselves, so a moved file is still identifiable')
  assert.equal(onDisk.content.round, 1)
  assert.deepEqual(onDisk.content.parents, ['baseline'], 'round 1 has nothing comparable yet, so it starts from the baseline')
  assert.equal(onDisk.content.empty, true)

  // Every candidate carries the parent it will be branched from, where LAND reads it.
  for (const candidateId of ['r1-h1', 'r1-h2']) {
    assert.equal(ports.store.getState(candidateId, 'phase').parent_id, 'baseline')
  }

  // And the decision is on the workspace's own log, next to the plan it belongs to.
  const accepted = ports.store.ops(20).find((op) => op.op === 'round_plan_accepted')
  const detail = JSON.parse(accepted.detail)
  assert.deepEqual(detail.parents, ['baseline'])
  assert.equal(detail.parent_snapshot, frozen.address)
  ports.store.close()
})

test('a round after a finished candidate starts from that candidate, not from the baseline again', async () => {
  const ports = setup()
  await toRoundOne(ports)
  // r1-h1 beat the baseline (0.7012) on auc; r1-h2 also beat it but by less. Both finished.
  finishWithMetrics(ports.store, 'r1-h1', { auc: 0.73 })
  finishWithMetrics(ports.store, 'r1-h2', { auc: 0.72 })

  await step(ports) // reflect round 1
  await step(ports) // close round 1
  const planned = await step(ports) // plan round 2
  assert.match(planned.action, /planned round 2/)

  const state = readRoundsState(ports.store)
  const frozen = state.plan.parent_snapshot
  const onDisk = JSON.parse(readFileSync(frozen.path, 'utf8'))
  assert.equal(onDisk.content.round, 2)
  assert.deepEqual(onDisk.content.parents, ['r1-h1'], 'the non-dominated candidate leads the roster; the baseline does not repeat')
  assert.deepEqual(
    onDisk.content.frontier.map((member) => member.candidate_id),
    ['baseline', 'r1-h1'],
    'the baseline is still in the set — it is the reference point, not a participant in the roster',
  )
  assert.equal(ports.store.getState('r2-h1', 'phase').parent_id, 'r1-h1')
  assert.equal(ports.store.getState('r2-h2', 'phase').parent_id, 'r1-h1', 'one parent, two hypotheses: both build on it')
  ports.store.close()
})

test('the same facts planned twice freeze the same address: the snapshot is content-addressed, not minted', async () => {
  const first = setup()
  await toRoundOne(first)
  finishWithMetrics(first.store, 'r1-h1', { auc: 0.73 })
  finishWithMetrics(first.store, 'r1-h2', { auc: 0.72 })
  await step(first) // reflect
  await step(first) // close
  await step(first) // plan round 2
  const a = readRoundsState(first.store).plan.parent_snapshot.address
  first.store.close()

  // A second workspace with the same facts and the same checkpoints reaches the same address: no
  // clock, no random id, no counter anywhere in it.
  const second = setup()
  await toRoundOne(second)
  finishWithMetrics(second.store, 'r1-h1', { auc: 0.73 })
  finishWithMetrics(second.store, 'r1-h2', { auc: 0.72 })
  await step(second)
  await step(second)
  await step(second)
  const b = readRoundsState(second.store).plan.parent_snapshot.address
  second.store.close()

  assert.equal(a, b)
})
