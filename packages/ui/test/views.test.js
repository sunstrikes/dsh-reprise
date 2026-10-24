/**
 * Guards the decision "the dashboard is a read-only projection of the workspace's facts, and it is
 * the same projection `dump` prints" (spec 展示层; ticket 11 AC 3/4/6).
 *
 * The seam is the view function `(store, query) → envelope` behind each route, exercised through the
 * plain handlers `(workspace, query) → JSON`. What this file owns:
 *
 *   - each of the four views answers from the workspace *directory*, with no store handle open and
 *     no session anywhere: closing every session must not blind the dashboard;
 *   - the numbers are the facts' numbers — the fixture says two candidates settled half an hour each,
 *     so the page says one settled GPU hour, and it says it next to the limit;
 *   - an empty workspace is answered as empty rather than as a 500, because "nothing has happened
 *     yet" is a state the dashboard has to render on day one;
 *   - a candidate nobody has written facts for is reported as missing, in the same words `dump` uses.
 *
 * The agreement with `dump` itself lives in `dump-agreement.test.js`; this file never re-derives an
 * expected value the way the code under test would.
 */

import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'

import { tick } from '../../core/lib/loop.js'
import { candidateHandler, conclusionHandler, overviewHandler, roundsHandler } from '../lib/routes.js'
import { AT, fakeJudge, forgetRecordedConfig, openWorkspace, runCandidate, seedConfig } from '../../core/test/support/fake-ports.js'

const config = (objectives, primary, extra = {}) => ({ metrics: { primary, objectives }, ...extra })

/**
 * Record what a reader needs to interpret the run after the fact.
 *
 * `seedConfig` covers the metric contract and the stop policy; the budget is the third key the
 * dashboard reads, and a run that never records it falls back to "0 = unlimited" — see the note
 * test below. Recording it here is what a host does when the run starts (the config→workspace seam
 * ticket 06 named and deferred).
 */
function seed(store, runConfig) {
  seedConfig(store, runConfig)
  if (runConfig?.budget === undefined) return
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', { ...workspace, budget: runConfig.budget })
}

/**
 * A workspace with two finished rounds and its config recorded, then **no open store** — the state
 * the dashboard sees when the process that ran the loop has exited.
 *
 * `conclude: true` ticks once more so a stop rule fires; the words it recorded are what the
 * conclusion page has to show.
 */
async function concludedWorkspace({ stop = { max_rounds: 0 }, conclude = false } = {}) {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { budget: { gpu_hours_limit: 4 }, stop }) })
  seed(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })
  if (conclude) await tick(ports)
  const dir = dirname(ports.store.path)
  ports.store.close()
  return { dir }
}

test('the overview answers from the workspace directory alone, with every store handle and session closed', async () => {
  const { dir } = await concludedWorkspace()

  const answer = overviewHandler(dir, {})

  assert.equal(answer.view, 'overview')
  assert.ok(answer.data !== null, 'the page still exists after the process that ran the loop exited')
  assert.equal(answer.data.workspace.startedAtMs, AT, 'the run recorded when it started, and the page shows it')
  // Known gap, recorded here so it cannot be forgotten: the kernel writes a workspace phase only
  // when it concludes (`FINALIZE`), so a *running* run has no phase fact and the page says null.
  // User story 2 wants "which phase am I in" for a live run; that fact has to come from the kernel
  // (tickets 04/06), not from a guess in the renderer.
  assert.equal(answer.data.workspace.phase, null)
  assert.equal(answer.data.rounds.completed, 2)
  assert.equal(answer.data.best.candidate_id, 'r2-c1')
  assert.equal(answer.data.best.value, 0.7401, 'the best number is the fact, not a rounded rendering of it')
  assert.equal(answer.data.spend.settledGpuHours, 1, 'two candidates settled half a GPU hour each')
  assert.equal(answer.data.spend.limitGpuHours, 4, 'a spend without its limit answers nothing')
  assert.equal(answer.data.candidates.total, 2)
  assert.deepEqual(answer.data.candidates.inFlight, [], 'nothing is in flight once both are done')
  assert.deepEqual(answer.notes, [], 'nothing about this run needs a warning: its config was recorded')
})

test('a run that never recorded a budget says so instead of showing 0 as if it were a limit', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { budget: { gpu_hours_limit: 4 } }) })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  // Strip what the kernel now records, leaving a workspace shaped like one written before that
  // existed: the metric contract is known, no budget was ever written down.
  forgetRecordedConfig(ports.store, ['budget', 'stop'])
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = overviewHandler(dir, {})

  assert.equal(answer.data.spend.limitGpuHours, 0, 'the default is 0, and 0 means unlimited — not "free"')
  assert.equal(answer.data.spend.settledGpuHours, 0.5)
  assert.ok(
    answer.notes.some((note) => /never recorded a budget/.test(note)),
    'a silent 0 would read as "no limit configured" when the truth is "nobody recorded the limit"',
  )
})

test('a workspace whose facts have not started yet is answered as a page of zeros, not as a failure', () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', {}) })
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = overviewHandler(dir, {})
  assert.equal(answer.view, 'overview')
  assert.equal(answer.data.rounds.completed, 0, 'an empty fact plane is a rendered page, not a 500')
  assert.equal(answer.data.candidates.total, 0)
  assert.equal(answer.data.metricContract.ok, false, 'and it says why nothing can be ranked yet')
  assert.match(answer.data.metricContract.error, /no metric contract/)

  assert.deepEqual(roundsHandler(dir, {}).data, [], 'no round has facts, so the rounds page is empty')
  const final = conclusionHandler(dir, {})
  assert.equal(final.data.best, undefined, 'nothing has been established yet')
  assert.equal(final.data.stopped.stopped, false)

  const detail = candidateHandler(dir, { candidate: 'r9-c9' })
  assert.equal(detail.data, null)
  assert.equal(detail.missing, true, 'a candidate with no facts is reported as missing, not as an empty candidate')
})

test('a workspace that never existed is answered as empty too — a fresh install opens the page', () => {
  const answer = overviewHandler('/tmp/reprise-ui-does-not-exist-' + String(Date.now()), {})

  assert.equal(answer.data, null)
  assert.match(answer.reason, /no facts recorded/)
})

test('the candidate view asks for its id and names the candidate it answered for', async () => {
  const { dir } = await concludedWorkspace()

  assert.throws(() => candidateHandler(dir, {}), /candidate/)
  assert.throws(() => candidateHandler(dir, { candidate: '' }), /candidate/)

  const answer = candidateHandler(dir, { candidate: 'r1-c1' })
  assert.equal(answer.view, 'candidate')
  assert.equal(answer.candidate, 'r1-c1')
  assert.equal(answer.data.candidate_id, 'r1-c1')
  assert.equal(answer.data.phase, 'DONE')
  assert.equal(answer.data.frontier.position, 'dominated', 'round 1 lost to round 2 and the page says so')
})

test('the rounds view lists each round with its candidates and whether it moved the best', async () => {
  const { dir } = await concludedWorkspace()

  const answer = roundsHandler(dir, {})

  assert.deepEqual(
    answer.data.map((entry) => ({ round: entry.round, improving: entry.improving, empty: entry.empty })),
    [
      { round: 1, improving: true, empty: false },
      { round: 2, improving: true, empty: false },
    ],
    'a losing-but-complete round must stay visible as a result',
  )
  assert.deepEqual(answer.data[1].candidates.map((candidate) => candidate.candidate_id), ['r2-c1'])
  assert.equal(answer.data[1].best.value, 0.7401)
})

test('the conclusion view names the best candidate and what it is compared against', async () => {
  const { dir } = await concludedWorkspace({ stop: { max_rounds: 2 }, conclude: true })

  const answer = conclusionHandler(dir, {})

  assert.equal(answer.view, 'conclusion')
  assert.equal(answer.data.best.candidate_id, 'r2-c1')
  assert.equal(answer.data.best.metric, 'auc')
  assert.equal(answer.data.best.value, 0.7401)
  assert.equal(answer.data.against.parent, 'baseline-0', 'the comparison group is a frozen binding, not a memory')
  assert.equal(answer.data.against.best.value, 0.7, 'and the previous best sits next to it')
  assert.equal(answer.data.stopped.stopped, true)
  assert.equal(answer.data.stopped.rule, 'max_rounds', 'the conclusion is the recorded rule, in the words recorded then')
})

test('a rejected candidate carries the four-state verdict that stopped it', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  seed(ports.store, ports.config)
  await runCandidate(ports, {
    candidateId: 'r1-c2',
    round: 1,
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({ candidate_id: candidateId, passed: 'yes-please', checks: [], decided_at_ms: now }),
    }),
  })
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = candidateHandler(dir, { candidate: 'r1-c2' })

  assert.equal(answer.data.phase, 'REJECTED')
  assert.equal(answer.data.rejection.status, 'invalid', 'the gate conclusion, not a summary of it')
  assert.equal(answer.data.rejection.phase, 'VERIFY')
  assert.match(answer.data.rejection.message, /strict boolean/, 'the failure text itself reaches the browser')
  assert.deepEqual(
    answer.data.gates.map((gate) => `${gate.phase}:${gate.status}`),
    ['VERIFY:invalid'],
  )
})