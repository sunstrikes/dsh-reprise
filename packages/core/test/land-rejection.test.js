/**
 * Contract (CODING_STANDARDS §2): the four states describe the facts, not the mood.
 *
 * `ok` / `missing` / `invalid` / `conflict` answer "is this fact present and trustworthy". A LAND
 * whose implementer *process* failed has no malformed artifact anywhere: `invalid` means "an
 * artifact exists and breaks its schema". Filing "the harness exited 1" as `invalid` sends the next
 * reader hunting for a broken document that never existed, and it destroys the only distinction the
 * contract exists to protect.
 *
 * So a harness failure is a rejection that carries a message and **no** four-state `status`. The one
 * failure at LAND that is genuinely one of the four states is a cross-check disagreement: two
 * accounts of the same edit — the implementer's report and git's diff — and neither wins, which the
 * contract calls `conflict`. That stays, because it is a fact about the artifact plane rather than
 * about a process.
 *
 * An outage is neither: no model answered, so nothing is rejected at all (the candidate waits).
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

/** A failed landing, as the port reports it: a class, a message, and whatever git still saw. */
const failed = (overrides = {}) => ({
  ok: false,
  engine: 'fake-implementer',
  prompt: `implement "${HYPOTHESIS}" inside ${WORKTREE}`,
  output: '',
  parent_id: 'baseline',
  parent_commit: '364874c79a2e1372c1170cfc3e78c449577914e2',
  base_ref: 'HEAD',
  files: [],
  files_changed: 0,
  cross_check: null,
  retryable: false,
  conflict: false,
  ...overrides,
})

function atLandWith(result) {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'reprise-land-'))
  const store = Store.open(workspaceDir)
  const clock = new FakeClock()
  const artifacts = fileArtifacts(join(workspaceDir, 'artifacts'))
  const harness = {
    engine: 'fake-implementer',
    calls: 0,
    async land(request) {
      this.calls += 1
      recordLandCall(artifacts, { ...request, worktreeDir: request.worktreeDir ?? WORKTREE }, result)
      return result
    },
  }
  const ports = { store, clock, harness, artifacts, worktreeDir: WORKTREE }
  createCandidate(ports, { candidateId: CANDIDATE, round: 1, hypothesis: HYPOTHESIS })
  return { ports, harness }
}

const rejectionOf = (store) => {
  const events = store.eventsFor(CANDIDATE).filter((event) => event.event_type === 'candidate_rejected')
  assert.equal(events.length, 1, 'the candidate was rejected exactly once')
  return events[0]
}

test('an implementer that exits non-zero is a rejection with a message and no four-state status', async () => {
  // The acceptance's own rejection, verbatim: the process failed, and the tree it refused to touch
  // is not malformed.
  const { ports, harness } = atLandWith(
    failed({
      error_class: 'deterministic_fail',
      message:
        "the harness exited 1: hypothesis r1-h1: 'hstu_encoder.num_blocks = 2' not found in configs/ml-1m/hstu-short.gin",
    }),
  )

  await tick(ports)

  assert.equal(ports.store.getState(CANDIDATE, 'phase').phase, 'REJECTED')
  assert.equal(harness.calls, 1, 'a deterministic failure is not retried')
  const rejection = rejectionOf(ports.store)
  assert.equal(rejection.payload.phase, 'LAND')
  assert.equal(
    'status' in rejection.payload,
    false,
    'nothing was malformed: the four states do not apply to a process that exited non-zero',
  )
  assert.match(rejection.payload.reject_reason, /exited 1/)
  assert.match(rejection.payload.reject_reason, /not found in configs\/ml-1m\/hstu-short\.gin/)
  assert.equal(rejection.payload.error_class, 'deterministic_fail', 'the class is kept: it is what tells the operator where to look')
  ports.store.close()
})

test('a harness refusal is a rejection with no four-state status either', async () => {
  const { ports } = atLandWith(failed({ error_class: 'refusal', message: 'the harness refused the task' }))

  await tick(ports)

  const rejection = rejectionOf(ports.store)
  assert.equal('status' in rejection.payload, false, 'a refusal is bad news, not a broken document')
  assert.match(rejection.payload.reject_reason, /refused the task/)
  ports.store.close()
})

test('a cross-check disagreement is still a conflict: two accounts of one edit, and neither wins', async () => {
  const { ports } = atLandWith(
    failed({
      error_class: 'cross_check_mismatch',
      conflict: true,
      message: `the harness report disagrees with git: git changed ${GIN} but the harness never reported it`,
      files: [GIN],
      files_changed: 1,
      cross_check: { status: 'mismatch' },
    }),
  )

  await tick(ports)

  const rejection = rejectionOf(ports.store)
  assert.equal(rejection.payload.status, 'conflict', 'a real contradiction keeps its four-state name')
  assert.match(rejection.payload.reject_reason, /disagrees with git/)
  ports.store.close()
})

test('no model answering is not a rejection at all', async () => {
  const { ports } = atLandWith(
    failed({
      error_class: 'harness_unavailable',
      message: 'the harness binary is not installed: spawn claude ENOENT',
    }),
  )

  await tick(ports)

  assert.equal(ports.store.getState(CANDIDATE, 'phase').phase, 'LAND', 'a provider outage leaves the candidate where it is')
  assert.equal(
    ports.store.eventsFor(CANDIDATE).some((event) => event.event_type === 'candidate_rejected'),
    false,
  )
  ports.store.close()
})