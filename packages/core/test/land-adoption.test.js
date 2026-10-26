/**
 * Contract: LAND is idempotent — a landing the loop already performed is adopted, not performed again.
 *
 * LAND is the one phase whose work happens in the outside world: a child process edits a worktree
 * this loop owns. So "run it again" is not free. The second run meets a tree that already carries
 * the first run's edit, and ticket 28 measured the consequence on a real workspace:
 *
 *   `candidate_created` → `candidate_rejected phase=LAND`, "the harness exited 1: hypothesis r1-h1:
 *   'hstu_encoder.num_blocks = 2' not found in configs/ml-1m/hstu-short.gin"
 *
 * — the implementer was asked twice, and refused the second time because the line it had been told
 * to change already held the new value. The candidate was rejected for its own progress.
 *
 * What makes the second run unnecessary is the landing's own record: the port files it the moment
 * the child exits, carrying the prompt the implementer was given, the answer it produced and the
 * diff inventory git reported. It is written before the kernel can record anything else — earlier
 * than `land_done`, earlier than the frozen parent binding — so any crash after the implementer
 * finished leaves it behind. A LAND that finds one for its own candidate and round has already done
 * its work, and continues from it: the same identity, the same inventory, no second invocation.
 *
 * The measure is the count of implementer invocations at the tick seam, because that is the seam a
 * resumed LAND is observable at and the count is what the defect was.
 *
 * The reading is deliberately narrow: a record for a *different* round, or no record at all, means
 * this phase has not done its work yet — and then running the implementer is correct.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fileArtifacts } from '../lib/artifacts.js'
import { createCandidate, tick } from '../lib/loop.js'
import { recordLandCall } from '../lib/ports.js'
import { Store } from '../lib/store.js'

const AT = 1_761_091_200_000
const CANDIDATE = 'r1-h1'
const HYPOTHESIS = 'raise hstu_encoder.num_blocks from 2 to 3 in configs/ml-1m/hstu-short.gin'
const GIN = 'configs/ml-1m/hstu-short.gin'
const PARENT_COMMIT = '364874c79a2e1372c1170cfc3e78c449577914e2'
const WORKTREE = '/tmp/reprise-land-r1-h1'

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

/** What the port hands back when the implementer did its work and its stream was readable. */
const landed = (overrides = {}) => ({
  ok: true,
  engine: 'fake-implementer',
  prompt: `implement "${HYPOTHESIS}" inside ${WORKTREE}`,
  output: `{"files": ["${GIN}"]}`,
  parent_id: 'baseline',
  parent_commit: PARENT_COMMIT,
  base_ref: 'HEAD',
  files: [GIN],
  files_changed: 1,
  cross_check: { status: 'match' },
  ...overrides,
})

/**
 * The implementer port with the one behaviour of the real port these tests depend on: it files the
 * landing's own record the moment the child exits (`recordLandCall`), and it counts its runs.
 *
 * `dieOnFirstCall` is the simulated SIGKILL: the host goes away while the child is running, so
 * nothing comes back and nothing is recorded — the state a resumed LAND must be able to tell apart
 * from "the landing already happened".
 */
function implementer({ artifacts, results, dieOnFirstCall = false }) {
  const calls = []
  return {
    engine: 'fake-implementer',
    get calls() {
      return calls.length
    },
    async land(request) {
      calls.push(request)
      if (dieOnFirstCall && calls.length === 1) {
        throw new Error('the host was killed while the implementer was running')
      }
      const result = Array.isArray(results) ? results[Math.min(calls.length - 1, results.length - 1)] : results
      if (artifacts !== undefined) recordLandCall(artifacts, { ...request, worktreeDir: request.worktreeDir ?? WORKTREE }, result)
      return result
    },
  }
}

function fakeJudge() {
  return {
    verify: ({ candidateId, now }) => ({
      candidate_id: candidateId,
      passed: true,
      checks: [{ name: 'static_imports', result: 'pass' }],
      reviewer: { verdict: 'accept', rationale: 'the diff is the gin line and nothing else' },
      decided_at_ms: now,
    }),
  }
}

/** Open the workspace the loop runs in. `dir` reopens the same one, which is what a restart does. */
function open({ dir, record = true, results, dieOnFirstCall = false } = {}) {
  const workspaceDir = dir ?? mkdtempSync(join(tmpdir(), 'reprise-land-'))
  const store = Store.open(workspaceDir)
  const clock = new FakeClock()
  const artifacts = record ? fileArtifacts(join(workspaceDir, 'artifacts')) : undefined
  const harness = implementer({ artifacts, results, dieOnFirstCall })
  const ports = { store, clock, harness, artifacts, judge: fakeJudge(), worktreeDir: WORKTREE }
  return { ports, workspaceDir, harness, clock, artifacts }
}

/** A workspace with one candidate standing at LAND, exactly as the round planner leaves it. */
function atLand(options = {}) {
  const opened = open(options)
  createCandidate(opened.ports, { candidateId: CANDIDATE, round: 1, hypothesis: HYPOTHESIS })
  return opened
}

const phaseOf = (store) => store.getState(CANDIDATE, 'phase')?.phase
const eventsOf = (store) => store.eventsFor(CANDIDATE).map((event) => event.event_type)
const landDones = (store) => store.eventsFor(CANDIDATE).filter((event) => event.event_type === 'land_done')

/** The row the crash left behind: nothing after the landing was launched ever reached the store. */
function rewindToLand(store) {
  store.setState(CANDIDATE, 'phase', { phase: 'LAND', round: 1, hypothesis: HYPOTHESIS, next_action_at: 0 })
  store.setAppliedSeq(CANDIDATE, 1)
}

test('a retried LAND adopts the landing its first attempt recorded instead of running the implementer again', async () => {
  // The acceptance's own shape: a `command` implementer prints its own words, the port cannot read
  // them as a stream, and the answer is filed as an outage — which the loop retries.
  const { ports, workspaceDir, harness } = atLand({
    results: landed({
      ok: false,
      error_class: 'unparseable_output',
      message: 'the harness wrote 1 line(s) but none was a JSON event: applied blocks3',
      output: 'applied blocks3: hstu_encoder.num_blocks = 2 -> 3',
      cross_check: null,
      retryable: false,
    }),
  })

  await tick(ports)
  assert.equal(harness.calls, 1, 'the first attempt ran the implementer')
  assert.equal(phaseOf(ports.store), 'LAND', 'an unreadable answer is an outage: the candidate waits')
  assert.equal(landDones(ports.store).length, 0, 'and no landing fact was written yet')

  // The retry, a minute later, in the same process. The tree already carries the edit.
  ports.clock.advance(61_000)
  const { actions } = await tick(ports)

  assert.equal(harness.calls, 1, 'the implementer was not asked to make the same edit a second time')
  assert.match(actions[0].action, /adopted/i, 'the step says what it did')
  assert.equal(phaseOf(ports.store), 'BUILD', 'the candidate continues past LAND')

  const [done] = landDones(ports.store)
  assert.deepEqual(done.payload.files, [GIN], 'the adopted landing carries the diff inventory the first attempt measured')
  assert.equal(done.payload.adopted, true, 'and the fact says it was adopted rather than landed twice')
  assert.equal(
    ports.store.binding(CANDIDATE, 'parent_binding').parent_commit,
    PARENT_COMMIT,
    'the identity the first attempt established is the one recorded',
  )
  assert.ok(fileArtifacts(join(workspaceDir, 'artifacts')).read(`model_call:land:${CANDIDATE}`), 'the record is still the audit trail')
  ports.store.close()
})

test('a crash after the landing, before its state row advanced, resumes from the recorded landing', async () => {
  const first = atLand({ results: landed() })
  await tick(first.ports)
  assert.equal(first.harness.calls, 1)
  assert.equal(landDones(first.ports.store).length, 1, 'the landing fact is on disk')
  assert.equal(phaseOf(first.ports.store), 'BUILD')

  // The crash: the event stream and the worktree survived, the state row is whatever it was before
  // the landmark was recorded. Reopening the same workspace is exactly what a restart does.
  rewindToLand(first.ports.store)
  first.ports.store.close()

  const restarted = open({ dir: first.workspaceDir, results: landed() })
  await tick(restarted.ports)

  assert.equal(restarted.harness.calls, 0, 'the resumed LAND invoked the implementer zero times')
  assert.equal(phaseOf(restarted.ports.store), 'BUILD', 'and continued from the recorded landing')
  assert.equal(landDones(restarted.ports.store).length, 1, 'the same landing identity, recorded once — not a second one')

  // It really continues: the next two ticks walk it through BUILD and gate two on the adopted diff.
  for (const expected of ['VERIFY', 'SUBMIT_QUEUED']) {
    restarted.clock.advance(1_000)
    await tick(restarted.ports)
    assert.equal(phaseOf(restarted.ports.store), expected)
  }
  restarted.ports.store.close()
})

test('a resumed LAND adopts the landing recorded before the crash, with no state row to tell it so', async () => {
  const first = atLand({
    results: landed({
      ok: false,
      error_class: 'unparseable_output',
      message: 'the harness wrote 1 line(s) but none was a JSON event: applied blocks3',
      output: 'applied blocks3: hstu_encoder.num_blocks = 2 -> 3',
      cross_check: null,
    }),
  })
  await tick(first.ports)
  assert.equal(first.harness.calls, 1)
  assert.equal(landDones(first.ports.store).length, 0, 'the attempt was filed as an outage, so no land_done exists')

  rewindToLand(first.ports.store)
  first.ports.store.close()

  const restarted = open({ dir: first.workspaceDir, results: landed() })
  await tick(restarted.ports)

  assert.equal(restarted.harness.calls, 0, 'the implementer was not invoked again')
  assert.equal(phaseOf(restarted.ports.store), 'BUILD')
  assert.deepEqual(landDones(restarted.ports.store)[0].payload.files, [GIN])
  restarted.ports.store.close()
})

test('with nothing recorded, the resumed LAND runs the implementer — once', async () => {
  const first = atLand({ results: landed(), dieOnFirstCall: true })
  // The host dies inside the implementer: no landing fact can exist, because nothing came back.
  await assert.rejects(() => tick(first.ports), /killed while the implementer was running/)
  assert.equal(first.harness.calls, 1)
  assert.equal(phaseOf(first.ports.store), 'LAND')
  first.ports.store.close()

  const restarted = open({ dir: first.workspaceDir, results: landed() })
  await tick(restarted.ports)

  assert.equal(restarted.harness.calls, 1, 'nothing was recorded, so running the implementer is correct — and only once')
  assert.equal(phaseOf(restarted.ports.store), 'BUILD')
  assert.equal(landDones(restarted.ports.store).length, 1)
  restarted.ports.store.close()
})

test('a landing recorded for a different round is not adopted', async () => {
  const { ports, harness } = atLand({ results: landed() })
  await tick(ports)
  assert.equal(phaseOf(ports.store), 'BUILD')
  assert.deepEqual(eventsOf(ports.store), ['candidate_created', 'land_done'])

  // The same candidate, back at LAND for round 2: the round-1 landing is not this round's work.
  ports.store.setState(CANDIDATE, 'phase', { phase: 'LAND', round: 2, hypothesis: HYPOTHESIS, next_action_at: 0 })
  ports.clock.advance(1_000)
  await tick(ports)

  assert.equal(harness.calls, 2, 'a new round lands again')
  assert.equal(landDones(ports.store).length, 2)
  ports.store.close()
})