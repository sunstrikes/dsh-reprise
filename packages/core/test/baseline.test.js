/**
 * The denominator, produced by the executor (ticket 30).
 *
 * What this file guards, in the order the tickets state it:
 *
 * 1. **BASELINE runs the baseline the way a candidate runs.** It goes through the same platform port
 *    (`submit` → `poll` → `collect`), not by reading a number out of a file. Asserted by observing
 *    the port was called — a `baseline.json` that happens to hold the right number is not evidence
 *    that anything ran.
 * 2. **The samples land in the fact plane in the contract's shape** (`window_series`: window ordinal,
 *    bounds, metric table) and with the same event/artifact shape a candidate's samples get, because
 *    pairing a candidate with a baseline needs one shape, not two.
 * 3. **A frozen baseline is frozen.** A second boot reads the frozen value and re-submits nothing,
 *    even when the executor would now report a different number.
 * 4. **A baseline that cannot run stops the workspace with a named reason** — a failed job, no
 *    metric, no window, a malformed series, a contradictory series — instead of continuing with an
 *    empty denominator. A failed run is a stop with a message (no four-state status); a malformed
 *    series is `invalid`; two accounts of one window are `conflict`.
 * 5. **The baseline job is marked in the ledger**, so it cannot be mistaken for a candidate and
 *    dispatched twice (the seam ticket 16's marker work reads).
 * 6. **The baseline job spends budget like any other job**: reserved on dispatch, settled on
 *    completion — there is no free lane.
 *
 * Driven at the `stepWorkspace` / `tick` seam with injected ports (`support/fake-ports.js`,
 * `support/samples.js`), on a real SQLite file in a temp directory. No host, no cluster, no model.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { pairWindows, validateArtifact } from '@dsh-reprise/contract'

import { fileArtifacts } from '../lib/artifacts.js'
import { BASELINE_SUBJECT } from '../lib/baseline.js'
import { renderDump } from '../lib/cli/dump.js'
import { createCandidate, tick } from '../lib/loop.js'
import { readRoundsState, stepWorkspace } from '../lib/rounds.js'
import { Store } from '../lib/store.js'
import { judgeFor } from './support/domain.js'
import { fakePlatform } from './support/fake-ports.js'
import { BASELINE_SERIES, CANDIDATE_SERIES, CONTRADICTORY_SERIES, EMPTY_SERIES, MALFORMED_SERIES } from './support/samples.js'

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

/**
 * A round workflow with **no** typed-in baseline: the run has to measure its own denominator, which
 * is the case ticket 30 is about. A configured `rounds.baseline` still wins where it is set, and the
 * tests that assert that are `rounds.test.js`'s.
 */
const CONFIG = {
  rounds: {
    metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
    max_rounds: 1,
    candidates_per_round: 1,
    retry: { base_ms: 1_000, max_ms: 8_000, max_attempts: 2 },
  },
  budget: { candidate_gpu_hours: 0.5, gpu_hours_limit: 0 },
}

/** A judge that answers nothing: BASELINE must never need one, and a call would be the bug. */
function silentJudge() {
  return {
    plan: async () => assert.fail('BASELINE must not consult a model'),
    reflect: async () => assert.fail('BASELINE must not consult a model'),
    land: async () => assert.fail('BASELINE must not consult a model'),
    verify: async () => assert.fail('BASELINE must not consult a model'),
    analyze: async () => assert.fail('BASELINE must not consult a model'),
  }
}

/**
 * A candidate implementer that lands one file. The commit is a real seven-character hash because the
 * gate's `parent_binding_frozen` check regexes it — a fake that fails a check the test is not about
 * would turn every candidate into a rejection.
 */
const fakeHarness = {
  land({ candidateId }) {
    return { engine: 'fake-harness', parent_id: 'baseline-0', parent_commit: 'aaa1111', files_changed: 1, candidateId }
  },
}

/** A workspace whose fact plane is a real SQLite file; `dir` reopens it as a second boot would. */
function setup({ config = CONFIG, dir, platform, judge, artifacts } = {}) {
  const workspaceDir = dir ?? mkdtempSync(join(tmpdir(), 'reprise-baseline-'))
  const store = Store.open(workspaceDir)
  const clock = new FakeClock()
  const fake = platform ?? fakePlatform()
  return {
    workspaceDir,
    store,
    clock,
    platform: fake,
    harness: fakeHarness,
    judge: judge ?? silentJudge(),
    config,
    artifacts: artifacts ?? fileArtifacts(join(workspaceDir, 'artifacts')),
  }
}

const step = (ports) => stepWorkspace(ports)

/** INIT → BASELINE, without depending on how many steps that takes. */
async function toBaseline(ports) {
  await step(ports)
  assert.equal(readRoundsState(ports.store).phase, 'BASELINE')
  return step(ports)
}

/** The baseline job the platform is running, whatever it is called. */
const runningBaseline = (platform) => [...platform.jobs.values()].find((job) => job.state === 'running')

// ------------------------------------------------------------- bullets 1 and 2

test('BASELINE submits the baseline through the platform port and freezes the samples it collected', async () => {
  const ports = setup()
  await step(ports) // INIT
  const dispatched = await step(ports) // BASELINE, first sight

  assert.match(dispatched.action, /baseline submitted/)
  assert.equal(ports.platform.submits.length, 1, 'the denominator is measured by a job, not read from a file')
  assert.deepEqual(
    { submission: ports.platform.submits[0].submissionId, candidate: ports.platform.submits[0].candidateId },
    { submission: 'baseline', candidate: '_baseline' },
    'the submission carries the baseline id the ledger and the cluster will both show',
  )

  // The job reports its windows; the next step collects them and freezes the baseline.
  const job = runningBaseline(ports.platform)
  ports.platform.finish(job.job_id, { auc: 0.71, logloss: 0.58 }, { series: BASELINE_SERIES })
  ports.clock.advance(5_000)
  const frozen = await step(ports)

  assert.match(frozen.action, /baseline frozen -> round_plan/)
  assert.equal(readRoundsState(ports.store).phase, 'ROUND_PLAN')

  const baseline = readRoundsState(ports.store).baseline
  assert.equal(baseline.metric, 'auc')
  assert.equal(
    baseline.value,
    0.71,
    'the frozen value is the number the job reported, the same field a candidate is ranked on — not a mean this kernel invented',
  )
  assert.equal(baseline.unit, 'epoch')
  assert.equal(baseline.windows, 3)
  assert.equal(baseline.source, 'executor', 'a measured denominator says so, so a typed-in one is distinguishable')
  assert.equal(baseline.job_id, job.job_id)

  // Bullet 2: the series is in the fact plane, as an artifact the event points at, in the contract's
  // shape — window ordinal, bounds, metric table.
  const series = ports.artifacts.read(baseline.window_series.artifact)
  assert.deepEqual(validateArtifact('window_series', series), { status: 'ok', message: '' })
  assert.deepEqual(
    series.windows.map((window) => [window.index, window.start, window.end]),
    [
      [0, 0, 1],
      [1, 1, 2],
      [2, 2, 3],
    ],
  )
  assert.deepEqual(Object.keys(series.windows[0].metrics).sort(), ['auc', 'logloss'])

  assert.equal(BASELINE_SUBJECT, '_baseline', 'the baseline writes under a subject no candidate id can look like')
  const collected = ports.store.eventsFor(BASELINE_SUBJECT).filter((event) => event.event_type === 'window_samples')
  assert.equal(collected.length, 1, 'the samples are a fact, not a file nobody recorded')
  assert.equal(collected[0].payload.subject_kind, 'baseline')
  assert.equal(collected[0].payload.unit, 'epoch')
  assert.equal(collected[0].payload.windows, 3)
  assert.equal(collected[0].payload.artifact, baseline.window_series.artifact)
  assert.deepEqual(collected[0].payload.metrics, ['auc', 'logloss'])
  ports.store.close()
})
// ------------------------------------------------------------------- bullet 3

test('a second boot reads the frozen baseline and re-runs nothing, even when the phase is re-entered', async () => {
  const first = setup()
  await step(first) // INIT
  await step(first) // BASELINE: submit
  const job = runningBaseline(first.platform)
  first.platform.finish(job.job_id, { auc: 0.71 }, { series: BASELINE_SERIES })
  first.clock.advance(5_000)
  await step(first) // collect + freeze
  const frozen = readRoundsState(first.store).baseline
  first.store.close()

  // A second start of the *same* workspace: fresh ports, the same fact plane on disk. The executor
  // would happily report a different number now; the frozen denominator must win over it.
  const second = setup({ dir: first.workspaceDir })
  // Re-enter BASELINE deliberately — the phase may be reached again by a rebuilt state row or a
  // resumed old workspace, and that is exactly when a silent re-measurement would rewrite history.
  second.store.setState(undefined, 'rounds', { ...readRoundsState(second.store), phase: 'BASELINE' })

  const result = await tick(second)
  const baselineAction = result.actions.find((action) => /baseline already frozen/.test(action.action))
  assert.ok(baselineAction, `the BASELINE step reported reading the frozen value: ${JSON.stringify(result.actions)}`)
  assert.match(baselineAction.action, /baseline already frozen \(auc=0\.71\)/)
  assert.equal(second.platform.submits.length, 0, 'a frozen baseline is not a job to run again')
  assert.deepEqual(readRoundsState(second.store).baseline, frozen, 'the frozen record is untouched')
  assert.equal(readRoundsState(second.store).phase, 'ROUND_PLAN', 'and the workspace moves on rather than waiting')
  second.store.close()
})

// ------------------------------------------------------------------- bullet 4

/**
 * The four-state discipline, kept apart on purpose: a job that failed, a run that measured nothing
 * and a run that reported no window are all *bad news with no malformed artifact*, so `status` stays
 * undefined. A window that breaks the shape is `invalid`; two accounts of one window are `conflict`.
 */
const BASELINE_FAILURES = [
  {
    name: 'the job failed',
    finish: (platform, job) => platform.fail(job.job_id, 'oom'),
    rule: 'baseline_run_failed',
    message: /ended failed \(oom\)/,
  },
  {
    name: 'the job reported no metric',
    finish: (platform, job) => platform.finish(job.job_id, {}, { series: BASELINE_SERIES }),
    rule: 'baseline_no_metrics',
    message: /reported no "auc"/,
  },
  {
    name: 'the job reported no window at all',
    finish: (platform, job) => platform.finish(job.job_id, { auc: 0.71 }),
    rule: 'baseline_no_windows',
    message: /no usable window samples \(missing\)/,
  },
  {
    name: 'the window list is empty',
    finish: (platform, job) => platform.finish(job.job_id, { auc: 0.71 }, { series: EMPTY_SERIES }),
    rule: 'baseline_samples_invalid',
    status: 'invalid',
    message: /windows must not be empty/,
  },
  {
    name: 'a window breaks the shape',
    finish: (platform, job) => platform.finish(job.job_id, { auc: 0.71 }, { series: MALFORMED_SERIES }),
    rule: 'baseline_samples_invalid',
    status: 'invalid',
    message: /end must be greater/,
  },
  {
    name: 'two windows claim the same interval',
    finish: (platform, job) => platform.finish(job.job_id, { auc: 0.71 }, { series: CONTRADICTORY_SERIES }),
    rule: 'baseline_samples_conflict',
    status: 'conflict',
    message: /both claim the window/,
  },
]

test('a baseline that cannot run stops the workspace with a named reason, never an empty denominator', async (t) => {
  for (const failure of BASELINE_FAILURES) {
    await t.test(failure.name, async () => {
      const ports = setup()
      await step(ports) // INIT
      await step(ports) // BASELINE: submit
      const job = runningBaseline(ports.platform)
      failure.finish(ports.platform, job)
      ports.clock.advance(5_000)
      await step(ports) // poll: terminal, and nothing usable

      const workspace = ports.store.getState(undefined, 'workspace')
      assert.equal(workspace.phase, 'FINALIZE', `a baseline that cannot run ends the run (${failure.name})`)
      assert.equal(workspace.stopped.rule, failure.rule, `the reason is named (${failure.name})`)
      assert.match(workspace.stopped.message, failure.message)
      assert.equal(workspace.stopped.status, failure.status, `four-state status is ${String(failure.status)} (${failure.name})`)
      assert.equal(workspace.stopped.job_id ?? workspace.stopped.detail?.job_id, job.job_id, 'the stop names the job')

      // The event carries the same conclusion: a stop is a fact before it is a state.
      const recorded = ports.store
        .eventsFor('_workspace')
        .filter((event) => event.event_type === 'workspace_stopped')
      assert.equal(recorded.length, 1)
      assert.equal(recorded[0].payload.rule, failure.rule)

      // Nothing was frozen, and no candidate was blamed for a workspace-level failure.
      assert.equal(readRoundsState(ports.store).phase, 'BASELINE', 'the phase does not advance past a denominator it does not have')
      assert.equal(readRoundsState(ports.store).baseline, undefined, 'no baseline was invented from an unusable run')
      assert.deepEqual(ports.store.candidateIds(), [], 'a baseline failure is not a candidate rejection')

      // And the next tick reports the conclusion instead of doing more work.
      ports.clock.advance(10_000)
      const after = await tick(ports)
      assert.equal(after.stopped?.stopped, true)
      assert.equal(ports.platform.submits.length, 1, 'a stopped workspace submits nothing more')
      ports.store.close()
    })
  }
})

// ------------------------------------------------------------------- bullets 5 and 6

test('the ledger says a job is the baseline, so nothing can dispatch or count it as a candidate', async () => {
  const ports = setup()
  await step(ports) // INIT
  await step(ports) // BASELINE: submit
  const job = runningBaseline(ports.platform)

  const row = ports.store.jobFor(BASELINE_SUBJECT)
  assert.equal(row.kind, 'baseline', 'the ledger marks what the job is for, not only who it belongs to')
  assert.equal(row.submission_id, 'baseline', 'and the cluster-visible key says so too (ticket 16 reads this)')
  assert.equal(row.candidate_id, '_baseline')
  assert.deepEqual(ports.store.candidateIds(), [], 'a baseline job is not a candidate the phase machine steps')

  ports.platform.finish(job.job_id, { auc: 0.71 }, { series: BASELINE_SERIES })
  ports.clock.advance(5_000)
  await step(ports)

  // A candidate's job, for contrast: same ledger, different kind.
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  ports.store.putJob({
    job_id: 'job-candidate',
    candidate_id: 'r1-h1',
    submission_id: 'r1-h1',
    harness: 'fake-harness',
    submitted_at_ms: AT,
    deadline_ms: AT + 60_000,
    state: 'running',
  })
  assert.equal(ports.store.jobFor('r1-h1').kind, 'candidate', 'a row written without a kind is a candidate row')

  // The surface a person reads: `dump` says which one is the denominator and which job measured it.
  const dumped = renderDump(ports.store, 'r1-h1')
  assert.match(dumped, /baseline/)
  assert.match(dumped, /auc=0\.71/)
  assert.match(dumped, new RegExp(`measured by job ${job.job_id} \\(kind=baseline\\)`))
  assert.match(dumped, /3 window\(s\) of unit epoch/)
  ports.store.close()
})

test('the baseline job spends budget like any other job: reserved on dispatch, settled on completion', async () => {
  const ports = setup()
  await step(ports) // INIT
  await step(ports) // BASELINE: submit
  assert.equal(ports.store.totals().inFlightGpuHours, 0.5, 'the dispatched baseline is reserved, not free')
  assert.equal(ports.store.totals().settledGpuHours, 0)

  const job = runningBaseline(ports.platform)
  ports.platform.finish(job.job_id, { auc: 0.71 }, { series: BASELINE_SERIES })
  ports.clock.advance(5_000)
  await step(ports)

  assert.equal(ports.store.totals().inFlightGpuHours, 0, 'completion settles the reservation')
  assert.equal(ports.store.totals().settledGpuHours, 0.5)
  ports.store.close()
})

test('an exhausted budget holds the baseline instead of running it for free', async () => {
  const ports = setup({ config: { ...CONFIG, budget: { candidate_gpu_hours: 0.5, gpu_hours_limit: 0.4 } } })
  await step(ports) // INIT
  // Hours already promised to a candidate put the run over the hard limit before the baseline runs.
  ports.store.reserve('r0-h9', 0.5, AT)

  const held = await step(ports)
  assert.match(held.action, /baseline held by (soft|hard) limit/)
  assert.equal(ports.platform.submits.length, 0, 'the baseline is new work, so the limit stops it too')
  assert.equal(readRoundsState(ports.store).phase, 'BASELINE')
  assert.ok(readRoundsState(ports.store).next_action_at > AT, 'and it retries later rather than every tick')
  ports.store.close()
})

test('a candidate records its samples in the same shape the baseline does, so the two can be paired', async () => {
  const model = async (request) => {
    const answers = {
      round_plan: { hypotheses: [{ id: 'h1', statement: 'widen the embedding table to 2^22', expected_files: ['model/embedding.py'] }] },
      round_reflect: {
        summary: 'capacity helped',
        lessons: [{ statement: 'capacity pays above a rare-feature rate', evidence: 'r1-h1' }],
        next_round_focus: ['measure the rare-feature rate'],
      },
      verify: { verdict: 'accept', rationale: 'one module, no evaluation changes' },
      cand_analyze: { root_cause: 'the wider table removed collisions on rare features' },
    }
    return answers[request.call_site]
  }
  const ports = setup({
    config: { ...CONFIG, rounds: { ...CONFIG.rounds, candidates_per_round: 1 } },
    judge: judgeFor({ model, metric: CONFIG.rounds.metric }),
  })

  // The baseline runs and freezes, then the round plans one candidate that also reports windows.
  let rounds
  for (let index = 0; index < 40; index += 1) {
    await tick(ports)
    for (const job of ports.platform.jobs.values()) {
      if (job.state !== 'running') continue
      const isBaseline = job.candidate_id === BASELINE_SUBJECT
      ports.platform.finish(
        job.job_id,
        isBaseline ? { auc: 0.71 } : { auc: 0.74 },
        { series: isBaseline ? BASELINE_SERIES : CANDIDATE_SERIES },
      )
    }
    rounds = readRoundsState(ports.store)
    if (ports.store.getState('r1-h1', 'phase')?.phase === 'DONE') break
    ports.clock.advance(10_000)
  }

  const samplesEvent = (subject) =>
    ports.store.eventsFor(subject).filter((event) => event.event_type === 'window_samples')
  const baselineSamples = samplesEvent(BASELINE_SUBJECT)[0]
  const candidateSamples = samplesEvent('r1-h1')[0]
  assert.ok(baselineSamples !== undefined, 'the baseline has samples')
  assert.ok(candidateSamples !== undefined, 'and so does the candidate')

  // One event shape for both subjects, differing only in which subject it is about.
  assert.deepEqual(Object.keys(candidateSamples.payload).sort(), Object.keys(baselineSamples.payload).sort())
  assert.equal(candidateSamples.payload.subject_kind, 'candidate')
  assert.equal(baselineSamples.payload.subject_kind, 'baseline')

  // One document shape for both, and the contract accepts both: the same keys, window by window.
  const baselineSeries = ports.artifacts.read(baselineSamples.payload.artifact)
  const candidateSeries = ports.artifacts.read(candidateSamples.payload.artifact)
  assert.deepEqual(validateArtifact('window_series', candidateSeries), { status: 'ok', message: '' })
  assert.deepEqual(Object.keys(candidateSeries).sort(), Object.keys(baselineSeries).sort())
  assert.deepEqual(Object.keys(candidateSeries.windows[0]).sort(), Object.keys(baselineSeries.windows[0]).sort())

  // And the point of the shape: they pair window by window, which is the comparison ticket 19 exists
  // to make possible. A single final number could never answer this.
  const pairing = pairWindows(candidateSeries, baselineSeries)
  assert.equal(pairing.status, 'ok', pairing.message)
  assert.deepEqual(
    pairing.pairs.map((pair) => [pair.start, pair.end, pair.candidate.metrics.auc, pair.baseline.metrics.auc]),
    [
      [0, 1, 0.7, 0.69],
      [1, 2, 0.72, 0.7],
      [2, 3, 0.74, 0.71],
    ],
  )
  assert.equal(rounds.baseline.source, 'executor', 'the denominator the pairing uses was measured, not announced')
  ports.store.close()
})
