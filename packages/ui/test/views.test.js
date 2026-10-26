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
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { CANDIDATE_PHASES } from '@dsh-reprise/contract'

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

  const answer = await overviewHandler(dir, {})

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

  const answer = await overviewHandler(dir, {})

  assert.equal(answer.data.spend.limitGpuHours, 0, 'the default is 0, and 0 means unlimited — not "free"')
  assert.equal(answer.data.spend.settledGpuHours, 0.5)
  assert.ok(
    answer.notes.some((note) => /never recorded a budget/.test(note)),
    'a silent 0 would read as "no limit configured" when the truth is "nobody recorded the limit"',
  )
})

test('a workspace whose facts have not started yet is answered as a page of zeros, not as a failure', async () => {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', {}) })
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = await overviewHandler(dir, {})
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

test('a workspace that never existed is answered as empty too — a fresh install opens the page', async () => {
  const answer = await overviewHandler('/tmp/reprise-ui-does-not-exist-' + String(Date.now()), {})

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

test('a round best carries the metric it is measured in, so no renderer has to guess one', async () => {
  // Ticket #2: the page printed `undefined=0.7211` because `rounds()[i].best` was `{candidate_id,
  // value}` while three renderers (page, panel, dump) all wrote `best.metric`. The projection has the
  // metric contract in hand where it builds the round history, so the fix belongs there and not in a
  // `${best.metric ?? '?'}` in each of the three.
  const { dir } = await concludedWorkspace()

  const rows = roundsHandler(dir, {}).data

  assert.deepEqual(
    rows.map((entry) => entry.best.metric),
    ['auc', 'auc'],
    'every round best names its metric',
  )
  assert.equal(roundsHandler(dir, {}).data[1].best.candidate_id, 'r2-c1', 'and still names the candidate that set it')
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
  assert.equal(answer.data.against.best.metric, 'auc', 'a previous best without its metric is a bare number')
  assert.equal(answer.data.stopped.stopped, true)
  assert.equal(answer.data.stopped.rule, 'max_rounds', 'the conclusion is the recorded rule, in the words recorded then')
})

/**
 * One finished candidate and nothing else: a best result, and nothing comparable to measure it
 * against. This is the state the conclusion line has to render as "no comparable baseline" instead of
 * a dash (`ticket #2` checkbox 6).
 */
async function singleResultWorkspace() {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { budget: { gpu_hours_limit: 4 }, stop: { max_rounds: 0 } }) })
  seed(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirname(ports.store.path)
  ports.store.close()
  return dir
}

/** A workspace with a frozen baseline on disk, which is what makes the comparison a baseline claim. */
async function frozenBaselineWorkspace(value) {
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { budget: { gpu_hours_limit: 4 }, stop: { max_rounds: 0 } }) })
  seed(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7401 } })
  const dir = dirname(ports.store.path)
  ports.store.close()
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ metric: 'auc', value }))
  return dir
}

test('the comparison publishes the change as a percentage, so no renderer divides two numbers itself', async () => {
  // The page paints "＋5.73%" and the panel will paint the same number. Neither may compute it: the
  // division is a derivation, and two derivations of one number is how a page and a dump start
  // disagreeing. 0.0401 spread over a 0.7 comparison group is 5.728571%.
  const { dir } = await concludedWorkspace()

  const comparison = conclusionHandler(dir, {}).data.comparison

  assert.equal(comparison.group.kind, 'previous-best', 'fixture: the previous round is the only thing to compare against')
  assert.equal(comparison.change, 0.0401)
  assert.equal(comparison.changePercent, 5.728571, 'the same change, as a percentage of the group')
  assert.equal(comparison.measured.round, 2, 'and what we measured says which round it came from')
})

test('against a frozen baseline the percentage is a different claim, and the comparison names which one', async () => {
  // 0.0201 over a frozen 0.72 is 2.791667%. Same shape as the previous-best case above and a
  // different sentence on the page: "against the frozen baseline", never "against the previous best".
  const dir = await frozenBaselineWorkspace(0.72)

  const comparison = conclusionHandler(dir, {}).data.comparison

  assert.equal(comparison.group.kind, 'baseline')
  assert.equal(comparison.group.value, 0.72)
  assert.equal(comparison.change, 0.0201)
  assert.equal(comparison.changePercent, 2.791667)
})

test('a run with nothing to compare against says so: no group, and no percentage invented for it', async () => {
  const dir = await singleResultWorkspace()

  const comparison = conclusionHandler(dir, {}).data.comparison

  assert.equal(comparison.measured.candidate_id, 'r1-c1', 'there is a result')
  assert.equal(comparison.group, null, 'and nothing to measure it against')
  assert.equal(comparison.change, null)
  assert.equal(comparison.changePercent, null, 'a percentage against no group is a made-up number')
  assert.equal(comparison.better, null)
})

// --------------------------------------- the retired cards' data (ticket #7)

/**
 * Ticket #7 deletes the page's last two pre-redesign cards. What must not be deleted is the
 * projection underneath them: the Web UI panel (#6) and `dump` read the same answer, and a field
 * removed to make a renderer tidy is a field three surfaces lose.
 *
 * The inventory below is the fields those two cards drew, written out rather than read from the
 * payload — a test that asserts a constant it imports proves nothing about the day the constant is
 * edited. Every line here is a fact that was on screen yesterday and has to be *reachable* today,
 * wherever it now lives (the masthead capsule, the strips under the conclusion, the readings row, the
 * conclusion region).
 */
test('the two retired cards retired rendering, not data: every field they read is still answered', async () => {
  const { dir } = await concludedWorkspace({ stop: { max_rounds: 2 }, conclude: true })

  const overview = (await overviewHandler(dir, {})).data
  const final = conclusionHandler(dir, {}).data

  for (const key of ['workspace', 'rounds', 'candidates', 'spend', 'best', 'frontier', 'metricContract', 'warnings', 'cluster', 'stop']) {
    assert.ok(key in overview, `the overview still publishes ${key}`)
  }
  // The six-cell card's first line: which phase the workspace is in, and whether it is still running.
  assert.ok('phase' in overview.workspace, 'the workspace phase, now the masthead capsule')
  assert.equal(overview.stop.stopped, true, 'and the state word beside it')
  // Its spend line, including the one number that has nowhere else to go: the token count.
  for (const key of ['settledGpuHours', 'inFlightGpuHours', 'limitGpuHours', 'tokens']) {
    assert.ok(key in overview.spend, `the spend reading ${key}`)
  }
  assert.ok(overview.spend.budget !== null, 'and the bar materials the readings cell draws')
  // Its cluster line: the card count, the per-job claim and the ledger floor's own words.
  for (const key of ['perJob', 'inUse', 'floor', 'floorAbsent']) {
    assert.ok(key in overview.cluster.cards, `the cluster card field ${key}`)
  }
  assert.ok('count' in overview.cluster.queue, 'and how many candidates are waiting')
  // Its warning list, which `未声明 GPU 独占` only reaches a reader through.
  assert.ok(Array.isArray(overview.warnings), 'warnings are still published')
  // The candidates' names, not only their count: the readings cell lists what is in flight.
  assert.ok(Array.isArray(overview.candidates.inFlight))

  // The measured/published card: the absolute change beside the percentage, the number the domain
  // published and our distance from it, and which direction each objective runs.
  for (const key of ['measured', 'group', 'change', 'changePercent', 'better', 'published', 'publishedChange', 'publishedAbsent']) {
    assert.ok(key in final.comparison, `the comparison still publishes ${key}`)
  }
  assert.ok(Array.isArray(final.objectives) && final.objectives.length > 0, 'the objectives are still named')
  for (const objective of final.objectives) {
    assert.equal(typeof objective.direction, 'string', `every objective still says which way ${objective.name} runs`)
    assert.equal(typeof objective.kind, 'string', 'and which one is primary')
  }
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
// --------------------------------------------- the staircase's inputs (ticket #3)

/**
 * The chart itself is drawn by the browser, so what these tests can hold is the other half of the
 * contract: that the two views carry every number the drawing needs, that they are the same rounds,
 * and that the frame the page is given contains every mark it can place inside it.
 */
test('the rounds view carries the step series and a shape per candidate; the conclusion carries the frame', async () => {
  const { dir } = await concludedWorkspace()

  const rows = roundsHandler(dir, {}).data
  const ladder = conclusionHandler(dir, {}).data.ladder

  assert.deepEqual(
    rows.map((entry) => ({ round: entry.round, verdict: entry.verdict, after: entry.cumulative.value })),
    [
      { round: 1, verdict: 'raised', after: 0.7 },
      { round: 2, verdict: 'raised', after: 0.7401 },
    ],
    'each round says what it did to the best, and what the best then stood at',
  )
  assert.deepEqual(
    rows.flatMap((entry) => entry.candidates).map((candidate) => `${candidate.candidate_id}:${candidate.shape}`),
    ['r1-c1:done', 'r2-c1:frontier'],
    'and each candidate arrives with the shape the rail draws — round 2 both leads and is the last round',
  )

  assert.equal(ladder.metric, 'auc', 'the frame names the metric it is drawn on')
  assert.equal(ladder.baseline, null, 'this fixture recorded no frozen baseline')
  assert.match(ladder.baselineAbsent, /no frozen baseline/i)

  // The frame must contain every mark: a value outside `axis` would be drawn off the top or the
  // bottom of the plot, which is the silent failure a chart is prone to.
  const plotted = rows.map((entry) => entry.cumulative.value)
  assert.ok(ladder.axis.bottom < Math.min(...plotted), 'the lowest mark sits above the bottom edge')
  assert.ok(ladder.axis.top > Math.max(...plotted), 'and the highest sits below the top edge')
  assert.equal(ladder.rounds.length, rows.length, 'the chart and the rail are the same rounds, not two lists')
})

test('a baseline recorded in another metric is not the same absence as no baseline, and says which it is', async () => {
  // `standingBaseline()` is the one reader of "is there a baseline", and it refuses a baseline measured
  // in a different metric rather than comparing two quantities. The two cases read differently on
  // both surfaces: "no frozen baseline" sends a reader looking for a file that is not there, and
  // "the frozen baseline records logloss, not auc" sends them to the file that *is* there.
  const ports = openWorkspace({ config: config({ auc: 'up' }, 'auc', { stop: { max_rounds: 0 } }) })
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7401 } })
  const dir = dirname(ports.store.path)
  ports.store.close()
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ metric: 'logloss', value: 0.62 }))

  const ladder = conclusionHandler(dir, {}).data.ladder

  assert.equal(ladder.baseline, null, 'a baseline in another metric is not a baseline for this one')
  assert.match(ladder.baselineAbsent, /records logloss, not auc/, 'and the sentence names both metrics')
})

// ---------------------------------- the candidate inspector's payload (ticket #5)

test('the candidate route hands the page the whole path, the shape word and the hypothesis', async () => {
  // The page cannot import the contract, so the phase order has to arrive in the payload; and it must
  // not keep a second copy of "which shape is this candidate" either. Both are asserted here at the
  // route, because the route is what the browser actually reads.
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

  const detail = candidateHandler(dir, { candidate: 'r1-c2' }).data

  assert.deepEqual(detail.phasePath.map((step) => step.phase), CANDIDATE_PHASES, 'all eight phases, in the kernel\'s order')
  assert.deepEqual(
    detail.phasePath.filter((step) => step.reached).map((step) => step.phase),
    ['LAND', 'BUILD', 'VERIFY'],
    'walked, here, and never reached are three answers the payload keeps apart',
  )
  assert.equal(detail.phasePath.find((step) => step.phase === 'VERIFY').status, 'invalid')
  assert.equal(detail.shape, 'invalid', 'the coarse square the rail draws travels with the detail, decided once')
  assert.equal(detail.hypothesis, 'hypothesis of r1-c2', 'and the identity row has the sentence to open with')
})
