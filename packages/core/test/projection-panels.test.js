/**
 * Guards the two panels the dashboard must answer without a session: what the run is doing to the
 * cluster right now (ticket 29 「总览：当前占几张卡、有没有在排队」) and what a candidate's gate chain
 * concluded (ticket 29 「候选详情：门禁链逐道显示通过 / 未通过 / 缺席——缺席不等于未通过」).
 *
 * Both are computed here, in `projection.js`, because the web page and `dump` must read one
 * derivation. Two properties are load-bearing and neither is obvious from the shapes:
 *
 * 1. **An unreadable listing is never "0 cards".** The dashboard is session-free and has no platform
 *    port, so it cannot ask the cluster what is really running. `jobReport()` answers `read: false`
 *    for that, and this file holds the page to it: the card count is `null` (unknown) beside the
 *    floor our own ledger supports, never `0`.
 * 2. **Absent is not failed.** A gate check a candidate never reached is `missing`; one that ran and
 *    refused is `failed`. Collapsing them blames the candidate for a gate that never ran, which is
 *    the one thing the candidate panel exists to prevent (CODING_STANDARDS §2).
 *
 * The seam is the projection function itself — the module `dump` and the HTTP routes both call — and
 * the fixture is a real SQLite workspace driven by the real tick loop with fake ports.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { fileArtifacts } from '../lib/artifacts.js'
import { createCandidate, tick } from '../lib/loop.js'
import { candidateDetail, overview } from '../lib/projection.js'
import { Store } from '../lib/store.js'
import { judgeFor } from './support/domain.js'
import { FakeClock, fakePlatform, openWorkspace } from './support/fake-ports.js'

const CONFIG = {
  metrics: { primary: 'auc', objectives: { auc: 'up' } },
  stop: { max_rounds: 0 },
  executor: { kind: 'local', command: ['node', 'train.mjs'], num_gpus: 2 },
}

const phaseOf = (ports, candidateId) => ports.store.getState(candidateId, 'phase')?.phase

/** Tick until `done()` says so, advancing the clock so gate backoff and poll deadlines elapse. */
async function until(ports, done, what, { limit = 20 } = {}) {
  for (let index = 0; index < limit; index += 1) {
    await tick(ports)
    if (done()) return
    ports.clock.advance(10_000)
  }
  throw new Error(`fixture never reached ${what} (last action: ${JSON.stringify(ports.store.getState('c1', 'phase'))})`)
}

/** One candidate walked to the queue, then to a submitted job — the state the overview reports on. */
async function withOneJob(config = CONFIG) {
  const ports = openWorkspace({ config })
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await until(ports, () => phaseOf(ports, 'c1') === 'SUBMIT_QUEUED', 'SUBMIT_QUEUED')
  await until(ports, () => ports.store.jobFor('c1') !== undefined, 'a submitted job')
  return ports
}

// ---------------------------------------------------------------- 总览: the cards

test('the overview counts the cards our own jobs claim and says it could not ask the cluster', async () => {
  const ports = await withOneJob()

  const page = overview(ports.store, { config: CONFIG })

  assert.equal(page.cluster.read, false, 'a dashboard with no platform port has not read the cluster listing')
  assert.match(page.cluster.reason, /listing/i, 'and it says so in words, not as an empty list')
  assert.equal(page.cluster.cards.perJob, 2, 'the executor entry is where "how many cards one job claims" is data')
  assert.equal(page.cluster.cards.inUse, null, 'an unread listing is unknown — never 0 cards')
  assert.equal(page.cluster.cards.floor, 2, 'what our own ledger supports: one open job times two cards')
  assert.deepEqual(page.cluster.jobs.open, ['c1'], 'the open job is named, so a reader can go and look at it')
  ports.store.close()
})

test('a workspace with no jobs still refuses to claim zero cards when the listing was not read', async () => {
  const ports = openWorkspace({ config: CONFIG })

  const page = overview(ports.store, { config: CONFIG })

  assert.equal(page.cluster.read, false)
  assert.equal(page.cluster.cards.inUse, null, 'nothing recorded is not the same fact as nothing running')
  assert.equal(page.cluster.cards.floor, 0, 'and the ledger floor is stated beside it, as a floor')
  assert.deepEqual(page.cluster.jobs.open, [])
  ports.store.close()
})

test('a listing that was read turns the floor into a count, and strangers are named rather than counted', async () => {
  const ports = await withOneJob()
  const listing = {
    ok: true,
    jobs: [
      { job_id: 'job-1', submission_id: 'c1', status: 'RUNNING', metadata: { marker: 'reprise:candidate=c1:round=1' } },
      // our marker, no ledger row: ours but unrecorded (ticket 16's orphan)
      { job_id: null, submission_id: 'sub-orphan', status: 'RUNNING', metadata: { marker: 'reprise:candidate=c2:round=1' } },
      // somebody else's job: it occupies cards, but it is not ours to stop or to count
      { job_id: 'job-9', submission_id: 'other-team', status: 'RUNNING', metadata: {} },
    ],
  }

  const page = overview(ports.store, { config: CONFIG, listing })

  assert.equal(page.cluster.read, true)
  assert.equal(page.cluster.cards.inUse, 4, 'our recorded job and our orphan, two cards each')
  assert.deepEqual(page.cluster.orphans.map((job) => job.reference), ['sub-orphan'])
  assert.equal(page.cluster.foreign.length, 1, 'a job carrying no marker of ours is reported, never adopted')
  ports.store.close()
})

test('a listing the executor refused is answered as unread, with its own words', async () => {
  const ports = await withOneJob()

  const page = overview(ports.store, { config: CONFIG, listing: { ok: false, message: 'the dashboard refused this client' } })

  assert.equal(page.cluster.read, false)
  assert.equal(page.cluster.reason, 'the dashboard refused this client')
  assert.equal(page.cluster.cards.inUse, null)
  assert.equal(page.cluster.cards.floor, 2, 'the ledger floor survives an unreadable listing')
  assert.equal(page.cluster.orphans, null, 'no opinion is null, not an empty list that reads as "there are none"')
  ports.store.close()
})

// --------------------------------------------------------------- 总览: the queue

test('a candidate held at SUBMIT_QUEUED is queued work, with the reason the run is holding it', async () => {
  const config = {
    ...CONFIG,
    metrics: { primary: 'auc', objectives: { auc: 'up' } },
    // The choice that makes two training jobs impossible at once (ticket 16), which is why the second
    // candidate waits at the gate instead of starting a job.
    executor: { kind: 'local', command: ['node', 'train.mjs'], num_gpus: 2, gpu_exclusivity: 'single_job' },
  }
  const ports = await withOneJob(config)
  createCandidate(ports, { candidateId: 'c2', round: 1, hypothesis: 'halve the heads' })
  await until(ports, () => phaseOf(ports, 'c2') === 'SUBMIT_QUEUED', 'c2 at SUBMIT_QUEUED')

  const page = overview(ports.store, { config, listing: undefined })

  assert.equal(page.cluster.queue.count, 1, 'one candidate is waiting for the cards')
  assert.deepEqual(page.cluster.queue.waiting, [{ candidate_id: 'c2', reason: 'single_job_gpu' }])
  assert.deepEqual(page.cluster.jobs.open, ['c1'], 'the holder is a job fact, not a phase')
  ports.store.close()
})
// ------------------------------------------------------- 候选详情: the gate chain

/** A git-free worktree holding exactly the files the harness claims to have changed. */
function worktreeOf(files) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-panels-tree-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content, 'utf8')
  }
  return dir
}

/** A harness that lands the given files, the way the CLI adapter reports git's answer. */
const harnessOf = (files) => ({
  land: ({ candidateId }) => ({
    ok: true,
    engine: 'fake-harness',
    parent_id: 'baseline-0',
    parent_commit: 'aaa1111',
    files,
    files_changed: files.length,
    candidateId,
  }),
})

/** A model port answering from a script: one object per call, the last answer repeating. */
function scriptedModel(answers) {
  let calls = 0
  return async () => {
    const next = answers[Math.min(calls, answers.length - 1)]
    calls += 1
    return next
  }
}

/**
 * A workspace already at LAND, with the real judge and real artifact files.
 *
 * Real on purpose: the chain is a reading of the records the judge wrote, so a fake judge would be
 * testing the fixture. `fileArtifacts` puts `verify_verdict:c1:aN` where the projection looks for it.
 */
function gateRig({ files = { 'model/structure.json': '{"hidden_units": 64}\n' }, answers, harness } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-panels-store-'))
  const store = Store.open(dir)
  const tree = worktreeOf(files)
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  const judge = judgeFor({
    model: scriptedModel(answers ?? [{ verdict: 'accept', rationale: 'only the knob moved' }]),
    surface: { files: ['model/structure.json'] },
    artifacts,
  })
  const ports = {
    store,
    clock: new FakeClock(),
    platform: fakePlatform(),
    harness: harness ?? harnessOf(Object.keys(files)),
    judge,
    artifacts,
    config: { ...CONFIG, gate: { base_ms: 1_000, max_ms: 8_000, max_attempts: 3 } },
  }
  store.setState('c1', 'phase', {
    phase: 'LAND',
    round: 1,
    hypothesis: 'widen the embedding table to 2^22',
    worktree_dir: tree,
  })
  return { ports, store, artifacts }
}

test('a candidate that never reached the gate reports every step as missing, never as failed', async () => {
  const rig = gateRig({
    harness: { land: () => ({ ok: false, error_class: 'deterministic_fail', message: 'the implementer refused: no module named evals' }) },
  })
  await until(rig.ports, () => phaseOf(rig.ports, 'c1') === 'REJECTED', 'a rejection at LAND')

  const detail = candidateDetail(rig.store, 'c1', { config: rig.ports.config, artifacts: rig.artifacts })

  assert.equal(detail.phase, 'REJECTED', 'fixture: rejected before the gate')
  assert.equal(detail.gateChain.reached, false, 'no gate ran, and the panel says so')
  assert.equal(detail.gateChain.stoppedAt, 'LAND', 'it stopped at the phase that refused it')
  assert.deepEqual(
    detail.gateChain.chain.map((step) => `${step.name}:${step.status}`),
    [
      'hypothesis_recorded:missing',
      'round_recorded:missing',
      'parent_binding_frozen:missing',
      'syntax:missing',
      'allowed_surface:missing',
      'conflict_markers:missing',
      'adversarial_review:missing',
    ],
    'a gate that never ran is absent — rendering it as failed would blame the candidate for a check nobody performed',
  )
  assert.deepEqual(detail.gateChain.attempts, [])
  rig.store.close()
})

test('a review that refused once and then accepted shows both attempts, and the latest chain passes', async () => {
  const rig = gateRig({
    answers: [
      { verdict: 'reject', rationale: 'the diff moves the evaluation split', concerns: ['evals/'] },
      { verdict: 'accept', rationale: 'only the knob moved', concerns: [] },
    ],
  })
  await until(rig.ports, () => phaseOf(rig.ports, 'c1') === 'SUBMIT_QUEUED', 'SUBMIT_QUEUED')

  const detail = candidateDetail(rig.store, 'c1', { config: rig.ports.config, artifacts: rig.artifacts })

  assert.equal(detail.gateChain.reached, true)
  assert.deepEqual(
    detail.gateChain.attempts.map((attempt) => [attempt.attempt, attempt.passed, attempt.review.verdict]),
    [
      [1, false, 'reject'],
      [2, true, 'accept'],
    ],
    'the first attempt is not erased by the second: "it refused once" is part of the answer',
  )
  assert.match(detail.gateChain.attempts[0].review.rationale, /moves the evaluation split/)
  assert.deepEqual(
    detail.gateChain.chain.map((step) => step.status),
    ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed'],
    'the chain reports the attempt that decided, and every step of it passed',
  )
  assert.equal(detail.gateChain.chain.at(-1).name, 'adversarial_review', 'the review is the last gate in the chain')
  rig.store.close()
})

test('a check that ran and refused is failed even when the review approved — the chain shows both, side by side', async () => {
  const rig = gateRig({
    files: { 'model/structure.json': '<<<<<<< HEAD\n{"hidden_units": 64}\n=======\n{"hidden_units": 32}\n>>>>>>> other\n' },
    answers: [{ verdict: 'accept', rationale: 'looks fine to me', concerns: [] }],
  })
  await until(rig.ports, () => phaseOf(rig.ports, 'c1') === 'REJECTED', 'the conflict rejection')

  const detail = candidateDetail(rig.store, 'c1', { config: rig.ports.config, artifacts: rig.artifacts })

  const byName = new Map(detail.gateChain.chain.map((step) => [step.name, step]))
  assert.equal(byName.get('conflict_markers').status, 'failed', 'the check that refused is failed')
  assert.match(byName.get('conflict_markers').detail ?? '', /residual markers/)
  assert.equal(byName.get('syntax').status, 'failed', 'the same file no longer parses, and that check failed too')
  assert.equal(byName.get('allowed_surface').status, 'passed', 'and the checks that passed still say passed')
  assert.equal(byName.get('adversarial_review').status, 'passed', 'the review approved, which is why this is a conflict')
  assert.equal(detail.gateChain.chain.filter((step) => step.status === 'missing').length, 0, 'nothing here is absent')
  rig.store.close()
})
