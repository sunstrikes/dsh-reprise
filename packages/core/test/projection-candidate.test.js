/**
 * Guards the decision "the candidate inspector draws the kernel's own phase path, one entry per
 * phase, and every word on it comes from a fact" (ticket #5; spec §6.7).
 *
 * The page that renders this cannot import `@dsh-reprise/contract`, so it cannot know the phase
 * order: the order arrives in the payload, from `CANDIDATE_PHASES`, or not at all. Three things are
 * therefore published here and nothing about them is left to a renderer:
 *
 *   - **the path**: all eight phases, in the kernel's order, each saying whether the candidate
 *     reached it, whether it is where the candidate is now, and what four-state word (if any) was
 *     recorded at it. `missing` (the fact is not there) and "did not pass" are different answers,
 *     and only a path that names unreached phases can tell the reader which one they are looking at;
 *   - **one entry per phase**: a candidate the contract refused leaves both a `gate_result` and the
 *     `candidate_rejected` that ended it, and both carry the four-state word. The same phase drawn
 *     twice is the defect ticket 29's chain exposed;
 *   - **the hypothesis**: the identity row opens with what the candidate set out to do, which is in
 *     the `candidate_created` payload and nowhere else.
 *
 * What this file deliberately does not assert: how any of it looks. A node test cannot see the
 * drawing, which is why the four shapes are checked in `packages/ui/test/client.test.js` and the
 * rendered page in the ticket's screenshots.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CANDIDATE_PHASES } from '@dsh-reprise/contract'

import { createCandidate } from '../lib/loop.js'
import { candidateDetail, rounds } from '../lib/projection.js'
import { fakeJudge, openWorkspace, runCandidate } from './support/fake-ports.js'

const config = (objectives, primary, extra = {}) => ({ metrics: { primary, objectives }, ...extra })

/** A workspace that will not stop mid-candidate: the run is the fixture, not the stop policy. */
const open = () => openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })

/** A judge whose verify artifact is present but breaks its schema — the `invalid` case. */
const invalidVerdict = () =>
  fakeJudge({
    verify: ({ candidateId, now }) => ({ candidate_id: candidateId, passed: 'yes-please', checks: [], decided_at_ms: now }),
  })

test('the candidate detail publishes the kernel\'s phase path: all eight phases, in the kernel\'s order', async () => {
  const ports = open()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })

  const detail = candidateDetail(ports.store, 'r1-c1', { config: ports.config })

  assert.deepEqual(
    detail.phasePath.map((step) => step.phase),
    CANDIDATE_PHASES,
    'the page draws the path it is handed — a ninth list in the client is a second order to drift from',
  )
  assert.ok(
    detail.phasePath.every((step) => step.reached === true),
    'a finished candidate walked every phase, and the path says so',
  )
  assert.deepEqual(
    detail.phasePath.filter((step) => step.current).map((step) => step.phase),
    ['DONE'],
    'exactly one phase is where the candidate is now',
  )
  ports.store.close()
})

test('the candidate detail carries the hypothesis the candidate was created with', async () => {
  const ports = open()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })

  const detail = candidateDetail(ports.store, 'r1-c1', { config: ports.config })

  assert.equal(
    detail.hypothesis,
    'hypothesis of r1-c1',
    'the identity row opens with what this candidate set out to do, in the words recorded for it',
  )
  ports.store.close()
})

test('a candidate stopped at VERIFY walks three phases and says the other five were never reached', async () => {
  const ports = open()
  await runCandidate(ports, { candidateId: 'r1-c2', round: 1, judge: invalidVerdict() })

  const detail = candidateDetail(ports.store, 'r1-c2', { config: ports.config })
  const walked = detail.phasePath.filter((step) => step.reached)

  assert.deepEqual(
    walked.map((step) => step.phase),
    ['LAND', 'BUILD', 'VERIFY'],
    '"did not pass VERIFY" and "never reached SUBMIT_QUEUED" are different statements',
  )
  const verify = detail.phasePath.find((step) => step.phase === 'VERIFY')
  assert.equal(verify.status, 'invalid', 'the four-state word recorded at the phase travels with it')
  assert.ok(Number.isSafeInteger(verify.seq), 'and so does the fact that recorded it: a seq')
  assert.ok(Number.isSafeInteger(verify.atMs), 'and its wall clock, formatted by the page and never derived')
  assert.equal(verify.eventType, 'candidate_rejected', 'the fact that carried it is named, so the reader can look it up')
  assert.deepEqual(
    detail.phasePath.filter((step) => !step.reached).map((step) => step.status),
    [null, null, null, null, null],
    'an unreached phase has no verdict at all — nothing was judged there',
  )
  assert.deepEqual(
    detail.phasePath.filter((step) => step.current).map((step) => step.phase),
    [],
    'a rejected candidate is not "in" a phase of the path: REJECTED is terminal and off it',
  )
  ports.store.close()
})

test('one phase is one entry: the gate result and the rejection that repeated it are the same fact', async () => {
  // Exactly what the fixture workspace `r3-k1` records: `gate_result` with `VERIFY:invalid` while the
  // candidate lives, then `candidate_rejected` carrying the same phase and the same word. Two events,
  // one conclusion, and a gate list that showed it twice is what ticket #1 measured.
  const ports = open()
  createCandidate(ports, { candidateId: 'r1-c2', round: 1, hypothesis: 'replace the embedding table' })
  ports.store.appendEvent({
    candidate_id: 'r1-c2',
    wall_clock_ms: ports.clock.now(),
    event_type: 'gate_result',
    payload: {
      phase: 'VERIFY',
      status: 'invalid',
      blocking_message: 'metrics.json does not match the artifact schema: field "auc" is a string',
      artifact: 'verify_verdict:r1-c2:a1',
    },
  })
  ports.store.appendEvent({
    candidate_id: 'r1-c2',
    wall_clock_ms: ports.clock.now() + 1_000,
    event_type: 'candidate_rejected',
    payload: {
      phase: 'VERIFY',
      status: 'invalid',
      reject_reason: 'the metrics artifact exists but breaks its schema, so there is no number to compare',
    },
  })

  const detail = candidateDetail(ports.store, 'r1-c2', { config: ports.config })

  assert.deepEqual(
    detail.gates.map((gate) => `${gate.phase}:${gate.status}`),
    ['VERIFY:invalid'],
    'one phase, one entry — the phase is drawn once whatever number of facts repeated it',
  )
  assert.equal(detail.gates[0].eventType, 'gate_result', 'the gate\'s own result is the entry kept: it ran and refused')
  assert.deepEqual(
    detail.phasePath.filter((step) => step.status !== null).map((step) => step.phase),
    ['VERIFY'],
    'and the path does not count the same phase twice either',
  )
  ports.store.close()
})

test('a refusal no gate result recorded still keeps its four-state word on the path', async () => {
  // The other half of the de-duplication: a candidate the kernel stops at LAND records only
  // `candidate_rejected`, and `missing` there means "there was no hypothesis to land" — dropping the
  // word because no `gate_result` exists would erase the four-state conclusion entirely.
  const ports = open()
  createCandidate(ports, { candidateId: 'r1-c3', round: 1, hypothesis: 'a candidate that never lands' })
  ports.store.appendEvent({
    candidate_id: 'r1-c3',
    wall_clock_ms: ports.clock.now(),
    event_type: 'candidate_rejected',
    payload: { phase: 'LAND', status: 'missing', reject_reason: 'this candidate reached LAND with no structural hypothesis' },
  })

  const detail = candidateDetail(ports.store, 'r1-c3', { config: ports.config })

  assert.deepEqual(
    detail.gates.map((gate) => `${gate.phase}:${gate.status}`),
    ['LAND:missing'],
    'a phase whose only fact is the rejection keeps its conclusion',
  )
  assert.equal(detail.phasePath.find((step) => step.phase === 'LAND').status, 'missing')
  assert.deepEqual(
    detail.phasePath.filter((step) => step.reached).map((step) => step.phase),
    ['LAND'],
    'and the path stops where the candidate stopped',
  )
  ports.store.close()
})

test('the inspector\'s shape word is the rail\'s shape: one reading of the same candidate', async () => {
  // The inspector says "completed, on the frontier" in words; the rail draws it as a square with a
  // notch. Both read one `shape`, decided here, so the sentence beside the candidate and the square
  // over its round cannot describe two different things.
  const ports = open()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })
  await runCandidate(ports, { candidateId: 'r2-c2', round: 2, metrics: { auc: 0.69 } })

  const fromRail = new Map(
    rounds(ports.store, { config: ports.config })
      .flatMap((line) => line.candidates)
      .map((candidate) => [candidate.candidate_id, candidate.shape]),
  )
  for (const candidateId of ['r1-c1', 'r2-c1', 'r2-c2']) {
    const detail = candidateDetail(ports.store, candidateId, { config: ports.config })
    assert.equal(detail.shape, fromRail.get(candidateId), `${candidateId}: the inspector and the rail read one shape`)
  }
  assert.equal(candidateDetail(ports.store, 'r2-c1', { config: ports.config }).shape, 'frontier')
  ports.store.close()
})
test('a candidate that finished has no reason it stopped: a gate that passed is not a rejection', async () => {
  // `rejection` is read off "the last four-state fact", and a gate that *passed* carries one of those
  // too — `MONITOR_POLL: ok` on every healthy candidate. The page never grew a block for it until
  // ticket #5, and the block would have announced "why it stopped at MONITOR_POLL" for the best
  // candidate in the run. The question has an answer only for a candidate that stopped.
  const ports = open()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })

  const detail = candidateDetail(ports.store, 'r1-c1', { config: ports.config })

  assert.equal(detail.rejection, undefined, '"why it stopped" is answered only where something stopped')
  assert.equal(
    detail.phasePath.find((step) => step.phase === 'VERIFY').status,
    'ok',
    'the gate that passed still says so on the path — the fact is not hidden, only the claim is dropped',
  )
  ports.store.close()
})
