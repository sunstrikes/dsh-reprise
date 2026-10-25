/**
 * Guards the four observability panels at the surface the ticket names (ticket 29; spec 展示层
 * "v1 无写端点"; Testing Decisions "客户端 DOM 渲染 —— v1 只测路由返回的 JSON 形状").
 *
 * Each test asks one question the way a person would, through the route a browser calls:
 *
 *   总览        how many cards does this run hold, and is anything waiting? An unread listing is
 *               `null` — an unreadable cluster is never drawn as "0 cards".
 *   候选详情    which gate steps passed, which failed, and which were never reached? `missing` is
 *               its own answer, not a failure.
 *   结论页      what did we measure, against what, and what did the domain publish?
 *   调用审计    which judgements were asked, and — opened one at a time — what was the prompt and
 *               what came back, verbatim?
 *
 * The workspace is a real one (SQLite plus artifact files) with the loop's own tick driving it, and
 * every handler is called with the *directory*: no session, no store handle, nothing live.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Store } from '../../core/lib/store.js'
import { createCandidate, tick } from '../../core/lib/loop.js'
import { loadDomainPack } from '../../core/lib/domain.js'
import { buildQuestion, modelCallName, modelCallRecord } from '@dsh-reprise/exec/model'
import { fileArtifacts } from '../../core/lib/artifacts.js'
import { openWorkspace, runCandidate, seedMetrics } from '../../core/test/support/fake-ports.js'
import { callHandler, callsHandler, candidateHandler, conclusionHandler, overviewHandler } from '../lib/routes.js'

const GENERATIVE_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'generative-recommenders')

const CONTRACT = { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_rounds: 0 } }

const EXECUTOR = { kind: 'local', command: ['node', 'train.mjs'], num_gpus: 2 }

/** Record what a host records at INIT: the contract, the stop rules and the executor (for the cards). */
function seed(store, config, executor = EXECUTOR) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', { ...workspace, metrics: config.metrics, stop: config.stop, executor })
}

const phaseOf = (ports, candidateId) => ports.store.getState(candidateId, 'phase')?.phase

/** Tick until `done()`, advancing the clock so gate backoff and poll deadlines elapse. */
async function untilDone(ports, done, what, { limit = 20 } = {}) {
  for (let index = 0; index < limit; index += 1) {
    await tick(ports)
    if (done()) return
    ports.clock.advance(10_000)
  }
  throw new Error(`fixture never reached ${what}`)
}

// ------------------------------------------------------------------- 总览

test('the overview route answers "how many cards, is anything waiting" from the ledger, and never invents 0 cards', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, executor: EXECUTOR } })
  seed(ports.store, CONTRACT)
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => ports.store.jobFor('c1') !== undefined, 'a submitted job')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = overviewHandler(dir, {})
  const cluster = answer.data.cluster

  assert.equal(cluster.read, false, 'the page has no platform port, and it says the listing was not read')
  assert.match(cluster.reason, /listing/i)
  assert.equal(cluster.cards.perJob, 2)
  assert.equal(cluster.cards.inUse, null, 'unknown, never 0 — "0 cards" is the answer somebody acts on')
  assert.equal(cluster.cards.floor, 2, 'what our own ledger supports, stated as a floor')
  assert.deepEqual(cluster.jobs.open, ['c1'])
  assert.equal(cluster.queue.count, 0, 'nothing is waiting for the cards here')
})

// --------------------------------------------------------------- 候选详情

test('the candidate route lists every gate step, and a gate that never ran is missing rather than failed', async () => {
  const ports = openWorkspace({ config: CONTRACT })
  seed(ports.store, CONTRACT)
  // An implementer that refuses the task: the candidate stops at LAND, before any gate exists.
  ports.harness = { land: () => ({ ok: false, error_class: 'deterministic_fail', message: 'no module named evals' }) }
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => phaseOf(ports, 'c1') === 'REJECTED', 'a rejection at LAND')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = candidateHandler(dir, { candidate: 'c1' })
  const chain = answer.data.gateChain

  assert.equal(chain.reached, false)
  assert.equal(chain.stoppedAt, 'LAND')
  assert.deepEqual(
    chain.chain.map((step) => step.status),
    ['missing', 'missing', 'missing', 'missing', 'missing', 'missing', 'missing'],
    'a reader must see "nobody looked", not a wall of red',
  )
  assert.equal(chain.chain.some((step) => step.status === 'failed'), false)
})

test('the candidate route carries the per-check result of the attempt that decided', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'reprise-ui-gate-'))
  const records = fileArtifacts(join(workspace, 'artifacts'))
  const ports = openWorkspace({
    config: CONTRACT,
    dir: workspace,
    judge: judgeWithAttempts(
      [
        { verdict: 'reject', rationale: 'the diff moves the eval split', concerns: [] },
        { verdict: 'accept', rationale: 'only the knob moved', concerns: [] },
      ],
      records,
    ),
  })
  seed(ports.store, CONTRACT)
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => phaseOf(ports, 'c1') === 'SUBMIT_QUEUED', 'SUBMIT_QUEUED')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const chain = candidateHandler(dir, { candidate: 'c1' }).data.gateChain

  assert.deepEqual(
    chain.attempts.map((attempt) => attempt.attempt),
    [1, 2],
    'both attempts are on the page: "it refused once and then passed" is the answer, not just the verdict',
  )
  assert.equal(chain.attempts[0].review.verdict, 'reject')
  assert.equal(chain.attempts[1].review.verdict, 'accept')
  assert.equal(chain.chain.every((step) => step.status === 'passed'), true)
})

// --------------------------------------------------------------- 结论页

test('the conclusion route prints the number we measured next to the number the pack published', async () => {
  const pack = loadDomainPack(GENERATIVE_PACK_DIR)
  const published = pack.metricContract.published
  const reference = published.rows.find((row) => row.method === published.reference)
  const ports = openWorkspace({ config: { metrics: pack.metricContract, stop: { max_rounds: 0 } } })
  seedMetrics(ports.store, pack.metricContract)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { 'hr@10': 0.3001, 'ndcg@10': 0.17 } })
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = conclusionHandler(dir, {})
  const comparison = answer.data.comparison

  assert.equal(comparison.measured.value, 0.3001)
  assert.equal(comparison.published.method, 'HSTU')
  assert.equal(comparison.published.value, reference.metrics['hr@10'], 'the published side is the pack\'s own number')
  assert.equal(comparison.published.source.file, published.source.file)
  assert.equal(Number(comparison.publishedChange.toFixed(4)), Number((0.3001 - reference.metrics['hr@10']).toFixed(4)))
})

// --------------------------------------------------------------- 调用审计

/** A record filed the way the model port files it, in the workspace's artifact directory. */
function fileCall(dir, { callSite, subject = null, ref = null, prompt, facts = {}, answer = null, response = '', errorClass = null }) {
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  const question = buildQuestion({ call_site: callSite, subject, ref, prompt, facts, answer_schema: '{"a": 1}' })
  artifacts.write(
    modelCallName({ call_site: callSite, subject, ref }),
    modelCallRecord({ question, answer, response, error_class: errorClass }),
  )
}

test('the audit route lists the calls and opens one of them into its prompt and response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-ui-audit-'))
  const store = Store.open(dir)
  store.close()
  fileCall(dir, { callSite: 'round_plan', subject: 'round-1', prompt: 'Plan round 1.', answer: { hypotheses: [] }, response: '{"hypotheses":[]}' })
  fileCall(dir, { callSite: 'verify', subject: 'r1-h1', ref: 'a1', prompt: 'Review this diff.', answer: { verdict: 'reject' }, response: '{"verdict":"reject"}' })

  const list = callsHandler(dir, {})
  assert.deepEqual(list.data.calls.map((call) => call.ref), ['model_call:round_plan:round-1', 'model_call:verify:r1-h1:a1'])
  assert.equal(list.data.count, 2)
  assert.equal(list.data.call_site, null, 'no filter means every call site')

  const filtered = callsHandler(dir, { site: 'verify' })
  assert.deepEqual(filtered.data.calls.map((call) => call.ref), ['model_call:verify:r1-h1:a1'])

  const opened = callHandler(dir, { ref: 'model_call:verify:r1-h1:a1' })
  assert.equal(opened.view, 'call')
  assert.equal(opened.data.prompt, 'Review this diff.', 'the prompt the model read, verbatim')
  assert.equal(opened.data.response, '{"verdict":"reject"}', 'and the words it returned')
  assert.deepEqual(opened.data.answer, { verdict: 'reject' })
})

test('the audit routes refuse a bad query as a 400 and a non-record as a missing page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-ui-audit-empty-'))
  const store = Store.open(dir)
  store.close()

  assert.throws(() => callHandler(dir, {}), /ref/)
  // A path dressed as a reference is not one of our records, and the answer says "no such record"
  // rather than opening a file.
  const escaped = callHandler(dir, { ref: 'model_call:../../workspace' })
  assert.equal(escaped.data, null)
  assert.equal(escaped.missing, true)

  assert.deepEqual(callsHandler(dir, {}).data, { calls: [], count: 0, call_site: null, reason: null })
})

/**
 * A judge whose verdicts come from a script, filing each attempt's record where the real judge does.
 *
 * The loop's gate tests already cover the real judge; what this fixture owes the *route* test is a
 * workspace whose attempt records exist on disk, so the panel reads them the way it will in a run.
 */
function judgeWithAttempts(answers, artifacts) {
  let calls = 0
  return {
    async verify({ candidateId, now }) {
      const next = answers[Math.min(calls, answers.length - 1)]
      calls += 1
      const attempt = calls
      const artifact = {
        schema_version: 1,
        candidate_id: candidateId,
        attempt,
        passed: next.verdict === 'accept',
        checks: [
          { name: 'hypothesis_recorded', result: 'pass' },
          { name: 'round_recorded', result: 'pass' },
          { name: 'parent_binding_frozen', result: 'pass' },
          { name: 'syntax', result: 'pass' },
          { name: 'allowed_surface', result: 'pass' },
          { name: 'conflict_markers', result: 'pass' },
        ],
        reviewer: next,
        decided_at_ms: now,
      }
      artifacts.write(`verify_verdict:${candidateId}`, artifact)
      artifacts.write(`verify_verdict:${candidateId}:a${attempt}`, artifact)
      return artifact
    },
    async analyze() {
      throw new Error('not used by this fixture')
    },
  }
}