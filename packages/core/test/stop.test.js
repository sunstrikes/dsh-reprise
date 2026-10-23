/**
 * Guards the decision "whether to stop is a deterministic function of facts, recorded as a fact"
 * (spec: 相位机 / 判停; issue 06).
 *
 * The kernel must be able to answer "why did this run end?" months later, from the event stream
 * alone, and the answer must not depend on any model. So each test here drives real candidates
 * through `tick` and then asserts on two things only: the workspace's FINALIZE state, and the
 * `workspace_stopped` event that names the rule.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_STOP, WORKSPACE_SUBJECT, evaluateStop, stopConfig } from '../lib/stop.js'
import { createCandidate, tick } from '../lib/loop.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

const AUC = { metrics: { primary: 'auc', objectives: { auc: 'up' } } }

/** The last workspace-level stop event, which is the "why" the whole ticket asks to be able to read. */
const stopEvents = (store) => store.eventsFor(WORKSPACE_SUBJECT).filter((event) => event.event_type === 'workspace_stopped')

test('three rounds and nothing left to do is the open-source default stopping point', async () => {
  const ports = openWorkspace({ config: { ...AUC } })
  for (const round of [1, 2, 3]) {
    await runCandidate(ports, { candidateId: `r${round}-c1`, round, metrics: { auc: 0.7 } })
  }

  const result = await tick(ports)

  assert.equal(result.stopped?.rule, 'max_rounds', 'the default maximum round count is what ends a healthy run')
  assert.equal(result.stopped.limit, 3, 'the limit that fired is recorded, not just "we stopped"')
  assert.equal(ports.store.getState(undefined, 'workspace').phase, 'FINALIZE', 'the workspace moves to FINALIZE, not to a fake pause')
  const [event] = stopEvents(ports.store)
  assert.equal(event.payload.rule, 'max_rounds')
  assert.equal(event.payload.observed, 3)
  assert.match(event.payload.message, /round 3/, 'the fact explains itself in words, so a reader needs no code')
  assert.equal(result.actions.length, 1, 'the tick reports the decision it took')
  assert.equal(result.actions[0].action, 'finalize')
  ports.store.close()
})

test('two completed rounds is not yet the default stopping point', async () => {
  const ports = openWorkspace({ config: { ...AUC } })
  for (const round of [1, 2]) {
    await runCandidate(ports, { candidateId: `r${round}-c1`, round, metrics: { auc: 0.7 } })
  }

  const result = await tick(ports)

  assert.equal(result.stopped?.stopped, false, 'stopping early would throw away round 3 that nobody asked to skip')
  assert.equal(ports.store.getState(undefined, 'workspace').phase, undefined)
  assert.deepEqual(stopEvents(ports.store), [], 'and nothing is recorded about stopping')
  ports.store.close()
})

test('a stop rule never fires while a candidate is still in flight', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 1 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  // Round 2 exists but has not finished: finalising now would strand work already paid for.
  createCandidate(ports, { candidateId: 'r2-c1', round: 2, hypothesis: 'a second idea' })

  const result = await tick(ports)

  assert.equal(result.stopped?.stopped, false, 'a live candidate keeps the workspace open')
  assert.equal(ports.store.getState(undefined, 'workspace').phase, undefined)
  assert.notEqual(ports.store.getState('r2-c1', 'phase').phase, 'FINALIZE')
  ports.store.close()
})

test('the same facts stop as soon as the last candidate finishes', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 1 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  assert.equal((await tick(ports)).stopped.rule, 'max_rounds')

  ports.store.close()
})

test('a run that stops improving is stopped, and the reason names the best result and who holds it', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_no_improvement_rounds: 2, max_rounds: 0 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7301 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7188 } })
  assert.equal((await tick(ports)).stopped.stopped, false, 'one flat round is not yet a pattern')

  await runCandidate(ports, { candidateId: 'r3-c1', round: 3, metrics: { auc: 0.7201 } })
  const result = await tick(ports)

  assert.equal(result.stopped.rule, 'max_no_improvement_rounds')
  assert.equal(result.stopped.observed, 2)
  assert.equal(result.stopped.limit, 2)
  assert.equal(result.stopped.best.candidate_id, 'r1-c1', 'the best result is still round 1 — the message must say so')
  assert.equal(result.stopped.best.value, 0.7301)
  assert.match(result.stopped.message, /auc=0\.7301/, 'the number in the message is the fact, not a paraphrase')
  assert.match(result.stopped.message, /r1-c1/, 'and the candidate holding it is named')
  ports.store.close()
})

test('a round that beats the best resets the no-improvement count', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_no_improvement_rounds: 2, max_rounds: 0 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.69 } })
  await runCandidate(ports, { candidateId: 'r3-c1', round: 3, metrics: { auc: 0.75 } })
  await runCandidate(ports, { candidateId: 'r4-c1', round: 4, metrics: { auc: 0.74 } })

  const result = await tick(ports)

  assert.equal(
    result.stopped?.stopped,
    false,
    'a real improvement two rounds ago must not be buried under an older losing streak',
  )
  ports.store.close()
})

test('rounds that produce nothing comparable stop the run for a different reason than "no improvement"', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { consecutive_empty_rounds: 2, max_rounds: 0 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  // Two rounds that die before any job runs: no metric ever reaches the fact plane.
  for (const [round, id] of [
    [2, 'r2-c1'],
    [3, 'r3-c1'],
  ]) {
    await runCandidate(ports, { candidateId: id, round, judge: { verify: () => ({ candidate_id: id, passed: 'maybe' }) } })
  }

  const result = await tick(ports)

  assert.equal(result.stopped.rule, 'consecutive_empty_rounds')
  assert.equal(result.stopped.observed, 2)
  assert.match(result.stopped.message, /no comparable auc/, 'an empty round is "nothing to compare", not "worse than before"')
  ports.store.close()
})

test('the rule that fires is the first rule declared, so precedence is fixed and readable', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 2, consecutive_empty_rounds: 1 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, {
    candidateId: 'r2-c1',
    round: 2,
    judge: { verify: () => ({ candidate_id: 'r2-c1', passed: 'nope' }) },
  })

  const result = await tick(ports)

  assert.equal(
    result.stopped.rule,
    'max_rounds',
    'two rules could fire; the declared order decides, so the record is reproducible instead of racy',
  )
  assert.deepEqual(
    stopEvents(ports.store).map((event) => event.payload.rule),
    ['max_rounds'],
    'exactly one rule is recorded — a stop is one reason, not a vote',
  )
  ports.store.close()
})

test('a finalized workspace is absorbing: no second stop event, no candidate movement', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 1 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await tick(ports)
  const before = ports.store.maxSeq('r1-c1')

  // Something creates work after the conclusion — a late planner, a human, a replay.
  createCandidate(ports, { candidateId: 'r2-c1', round: 2, hypothesis: 'a late idea' })
  const seqAfterCreate = ports.store.maxSeq('r2-c1')

  const result = await tick(ports)

  assert.deepEqual(result.actions, [], 'the stop check runs at workspace level, before any candidate step')
  assert.equal(ports.store.maxSeq('r1-c1'), before, 'no candidate advanced')
  assert.equal(ports.store.maxSeq('r2-c1'), seqAfterCreate, 'the candidate created after FINALIZE did not move either')
  assert.equal(stopEvents(ports.store).length, 1, 'a conclusion is recorded once, not once per tick')
  ports.store.close()
})

test('a rule set to zero is disabled rather than firing immediately', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 0 } } })
  for (const round of [1, 2, 3, 4, 5]) {
    await runCandidate(ports, { candidateId: `r${round}-c1`, round, metrics: { auc: 0.7 } })
  }

  const result = await tick(ports)

  assert.equal(result.stopped?.stopped, false, 'zero means "no limit", the same convention the budget uses')
  assert.equal(DEFAULT_STOP.max_rounds, 3, 'and the default is the open-source three rounds the spec asks for')
  ports.store.close()
})

test('a stop configuration that is not a number is reported and treated as disabled', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 'three' } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })

  const result = await tick(ports)

  assert.equal(result.stopped?.stopped, false, 'a typo must not silently stop a run')
  const config = stopConfig({ stop: { max_rounds: 'three' } })
  assert.match(config.error, /max_rounds/, 'but it must be visible, or the run looks configured and is not')
  ports.store.close()
})

test('the stop decision reports what it was blocked on, so a stuck-looking workspace is explainable', async () => {
  const ports = openWorkspace({ config: { ...AUC, stop: { max_rounds: 1 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  createCandidate(ports, { candidateId: 'r2-c1', round: 2, hypothesis: 'still running' })

  const decision = evaluateStop({ store: ports.store, clock: ports.clock, config: ports.config })

  assert.equal(decision.stopped, false)
  assert.deepEqual(decision.blocked_by, ['r2-c1'], 'the candidate holding the run open is named')
  ports.store.close()
})

test('a workspace with no candidates at all is not "finished"', async () => {
  const ports = openWorkspace({ config: { ...AUC } })

  const result = await tick(ports)

  assert.equal(result.stopped?.stopped, false, 'an empty workspace has not completed three rounds; it has not started')
  assert.deepEqual(result.actions, [])
  ports.store.close()
})