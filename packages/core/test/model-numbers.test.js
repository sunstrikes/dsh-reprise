/**
 * Guards the decision "no model output may reach a numeric decision" (spec: 相位机; issue 06 AC 1).
 *
 * The claim under test is *not* "the model does not give scores" — it is the stronger "given a
 * score, the kernel does not take it". Each test therefore makes the model's number arrive in a
 * perfectly valid artifact, asserts the artifact is in the fact stream, and then asserts the
 * frontier and the stop decision still use the platform's number. If these tests go red, some code
 * path started reading an analyze report as a measurement.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ranking } from '../lib/ranking.js'
import { WORKSPACE_SUBJECT } from '../lib/stop.js'
import { tick } from '../lib/loop.js'
import { fakeJudge, openWorkspace, reportOf, runCandidate } from './support/fake-ports.js'

const AUC = { metrics: { primary: 'auc', objectives: { auc: 'up' } } }

/** A judge whose CAND_ANALYZE report claims a good result, with a valid echo of a number it invented. */
const boastingJudge = (value) =>
  fakeJudge({ analyze: (context) => reportOf(context, { metric: 'auc', value, verdict: 'improved' }) })

/** Every number the facts hold for one candidate's analyze event — the evidence of what reached disk. */
const analyzePayloads = (store, candidateId) =>
  store.eventsFor(candidateId).filter((event) => event.event_type === 'cand_analyze').map((event) => event.payload)

test("a model's claimed metric is in the facts but not in the objective vector", async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.6821 }, judge: boastingJudge(0.99) })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.70 } })

  const [analysis] = analyzePayloads(ports.store, 'c1')
  assert.ok(analysis !== undefined, 'the analysis event exists, so the report really was written to the facts')
  assert.equal(
    ports.store.getState('c1', 'phase').phase,
    'DONE',
    'and it passed the contract — the kernel consumed the artifact that carried 0.99, it did not merely ignore it',
  )
  const view = ranking(ports.store, AUC)
  const c1 = view.candidates.find((row) => row.candidate_id === 'c1')

  assert.deepEqual(c1.vector, { auc: 0.6821 }, 'the vector carries the platform number, not the one the model wrote')
  assert.equal(c1.metrics.auc, 0.6821)
  assert.equal(view.best.candidate_id, 'c2', 'the superior claim did not make c1 the best candidate')
  assert.equal(view.best.value, 0.7)
  assert.equal(JSON.stringify(view).includes('0.99'), false, 'the model number appears nowhere in the derived view')
  ports.store.close()
})

test('a model-provided number cannot keep a run alive', async () => {
  const config = { ...AUC, stop: { max_no_improvement_rounds: 1, max_rounds: 0 } }
  const ports = openWorkspace({ config })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7301 } })
  // Round 2 is worse on the platform and better on paper. The paper is not a fact.
  await runCandidate(ports, {
    candidateId: 'r2-c1',
    round: 2,
    metrics: { auc: 0.6902 },
    judge: boastingJudge(0.99),
  })

  const result = await tick(ports)

  assert.equal(result.stopped.rule, 'max_no_improvement_rounds', 'the platform numbers say round 2 did not improve')
  assert.equal(result.stopped.best.candidate_id, 'r1-c1')
  assert.equal(result.stopped.best.value, 0.7301, 'the recorded best is the measured one')
  const stopFacts = JSON.stringify(ports.store.eventsFor(WORKSPACE_SUBJECT))
  assert.equal(stopFacts.includes('0.99'), false, 'nothing in the stop decision came from the model, including its number')
  ports.store.close()
})

test('a model-provided number cannot shorten a run either: a pessimistic claim does not count as a regression', async () => {
  const config = { ...AUC, stop: { max_no_improvement_rounds: 1, max_rounds: 0 } }
  const ports = openWorkspace({ config })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.70 } })
  // Round 2 measured better, but the model calls it a regression with a lower number. Stopping here
  // would throw away the best candidate of the run on the strength of an opinion.
  await runCandidate(ports, {
    candidateId: 'r2-c1',
    round: 2,
    metrics: { auc: 0.7501 },
    judge: fakeJudge({ analyze: (context) => reportOf(context, { metric: 'auc', value: 0.61, verdict: 'regressed' }) }),
  })

  const result = await tick(ports)

  assert.equal(result.stopped?.stopped, false, 'the measured improvement is what decides, not the verdict word or its number')
  assert.equal(ranking(ports.store, AUC).best.candidate_id, 'r2-c1')
  ports.store.close()
})

test('a metric the platform never reported cannot be invented by the analysis', async () => {
  const ports = openWorkspace()
  // The job ran but reported no metric at all; the analysis "knows" the answer anyway.
  await runCandidate(ports, { candidateId: 'c1', metrics: {}, judge: boastingJudge(0.99) })

  const view = ranking(ports.store, AUC)

  assert.deepEqual(view.candidates[0].metrics, {}, 'no platform metric means no metric — the model cannot supply one')
  assert.deepEqual(
    view.incomplete,
    [{ candidate_id: 'c1', missing: ['auc'] }],
    'the candidate is reported as unrankable rather than being ranked on the only number available',
  )
  assert.equal(view.best, undefined, 'an all-claims frontier has no best candidate')
  ports.store.close()
})

test('the verdict word an analysis chooses is not a comparison', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.6802 }, judge: boastingJudge(0.6802) })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.7301 }, judge: boastingJudge(0.7301) })

  const [first] = analyzePayloads(ports.store, 'c1')
  const view = ranking(ports.store, AUC)

  assert.equal(first.verdict, 'improved', '"improved" is what the model said about round 1')
  assert.equal(
    view.best.candidate_id,
    'c2',
    'the word "improved" on a worse candidate does not outrank a better measured number',
  )
  ports.store.close()
})