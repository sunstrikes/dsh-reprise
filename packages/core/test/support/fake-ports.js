/**
 * Shared fake ports for the kernel tests.
 *
 * Not a `*.test.js` file on purpose: `node --test test/*.test.js` must not run it, and every test
 * module that needs a workspace should build the *same* one. A kernel that reaches the network, the
 * system clock, or a model would be untestable; the fakes are how "code owns the control flow" is
 * asserted rather than assumed.
 *
 * Not a delivery of the kernel: nothing under `lib/` may import this.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../../lib/store.js'
import { createCandidate, tick } from '../../lib/loop.js'

/** A fixed epoch millisecond — every test starts at the same instant, so dumps are comparable. */
export const AT = 1_761_091_200_000

export class FakeClock {
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
 * A stand-in external platform with its own state, so it survives our process dying.
 *
 * `submits` is the call log, and it exists for one assertion that has no side channel: "the baseline
 * was produced by the executor" is a claim about a call that was made, and no file read can prove it.
 * A job may carry a `window_series` document, because that is what a real adapter hands back once it
 * has read the run's samples.
 */
export function fakePlatform() {
  const jobs = new Map()
  const submits = []
  let counter = 0
  return {
    jobs,
    submits,
    submit(request) {
      const { submissionId, candidateId } = request
      submits.push(request)
      for (const job of jobs.values()) {
        if (job.submission_id === submissionId) {
          return { job_id: job.job_id, duplicate: true, harness: 'fake', state: job.state }
        }
      }
      counter += 1
      const job = { job_id: `job-${counter}`, submission_id: submissionId, candidate_id: candidateId, state: 'running' }
      jobs.set(job.job_id, job)
      return { job_id: job.job_id, harness: 'fake-harness', state: 'running' }
    },
    find(candidateId) {
      return [...jobs.values()].find((job) => job.candidate_id === candidateId)
    },
    poll(jobId) {
      const job = jobs.get(jobId)
      if (job === undefined) return { state: 'lost' }
      return { state: job.state, metrics: job.metrics, window_series: job.window_series, error_class: job.error_class }
    },
    collect(jobId) {
      const job = jobs.get(jobId)
      if (job === undefined) return { state: 'lost', artifacts: [] }
      return { state: job.state, metrics: job.metrics, window_series: job.window_series, error_class: job.error_class, artifacts: [] }
    },
    /** Let a job finish, as a real one would: its metric table, and its windowed samples if any. */
    finish(jobId, metrics, { series } = {}) {
      Object.assign(jobs.get(jobId), { state: 'succeeded', metrics, ...(series === undefined ? {} : { window_series: series }) })
    },
    fail(jobId, errorClass) {
      Object.assign(jobs.get(jobId), { state: 'failed', error_class: errorClass })
    },
    get size() {
      return jobs.size
    },
  }
}

export const fakeHarness = {
  land({ candidateId }) {
    return {
      engine: 'fake-harness',
      parent_id: 'baseline-0',
      parent_commit: 'aaa111',
      files_changed: 2,
      candidateId,
    }
  },
}

export function verdictOf({ candidateId, now }) {
  return {
    candidate_id: candidateId,
    passed: true,
    checks: [{ name: 'static_imports', result: 'pass' }],
    reviewer: { verdict: 'accept', rationale: 'no behaviour change outside the target module' },
    decided_at_ms: now,
  }
}

/**
 * A CAND_ANALYZE report. `observed`/`concluded` must agree or the contract rejects it as a
 * conflict — which is why tests that want to prove "the model's number is ignored" must make the
 * two agree: the report has to be *valid* to prove that validity alone is not enough.
 */
export function reportOf({ candidateId, state, now }, { metric = 'auc', value, verdict = 'improved' } = {}) {
  // Echo whatever the platform reported by default: the report is a *statement about* the facts,
  // and the default judge is meant to be uninteresting.
  const echoed = value ?? state?.metrics?.[metric] ?? 0
  return {
    candidate_id: candidateId,
    verdict,
    observed: { metric, value: echoed },
    concluded: { metric, value: echoed },
    root_cause: 'the wider embedding table reduced collisions on rare features',
    at_ms: now,
  }
}

export function fakeJudge(overrides = {}) {
  return { verify: verdictOf, analyze: reportOf, ...overrides }
}

/** A fresh workspace with fake ports. `config` reaches `tick` unchanged. */
export function openWorkspace({ config, judge, dir, clock } = {}) {
  const store = Store.open(dir ?? mkdtempSync(join(tmpdir(), 'reprise-views-')))
  const fakeClock = clock ?? new FakeClock()
  const platform = fakePlatform()
  return {
    store,
    clock: fakeClock,
    platform,
    harness: fakeHarness,
    judge: judge ?? fakeJudge(),
    config,
  }
}

/** Seed the workspace-wide metric contract, the way a host would record the run's configuration. */
export function seedMetrics(store, metrics) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', { ...workspace, metrics })
}

/**
 * Record the part of the run configuration a reader needs to interpret the run after the fact:
 * the metric contract (which decides "better") and the stop rules (which decide "enough").
 *
 * The kernel's `tick` takes this from its live config, but `dump` has only the workspace directory —
 * so a workspace that never recorded them cannot explain its own ranking. Where that recording
 * belongs is a host concern (the config→workspace seam); `dump --config` is the escape hatch.
 */
export function seedConfig(store, config) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', {
    ...workspace,
    ...(config?.metrics === undefined ? {} : { metrics: config.metrics }),
    ...(config?.stop === undefined ? {} : { stop: config.stop }),
  })
}

/**
 * Strip the run configuration the kernel now records into the workspace, leaving a workspace
 * shaped like one written before that existed. The fallback paths that read it must still work:
 * an old workspace is exactly the case they exist for.
 */
export function forgetRecordedConfig(store, keys) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const stripped = { ...workspace }
  for (const key of keys) delete stripped[key]
  store.setState(undefined, 'workspace', stripped)
  return stripped
}

/**
 * Drive one candidate to a terminal phase, letting the platform finish its job with `metrics`.
 * Returns the terminal phase; throws when a stop rule or pause cut the run short, because a test
 * that silently gets a half-finished candidate would prove nothing.
 */
export async function runCandidate(ports, { candidateId, round = 1, metrics = { auc: 0.7123 }, judge } = {}) {
  const withJudge = judge === undefined ? ports : { ...ports, judge }
  createCandidate(withJudge, { candidateId, round, hypothesis: `hypothesis of ${candidateId}` })

  for (let index = 0; index < 40; index += 1) {
    const result = await tick(withJudge)
    if (result.paused) throw new Error(`${candidateId}: the workspace paused (${result.paused.reason}) mid-candidate`)
    if (result.stopped?.stopped) {
      throw new Error(`${candidateId}: the workspace stopped (${result.stopped.rule}) mid-candidate`)
    }
    for (const job of withJudge.platform.jobs.values()) {
      if (job.candidate_id === candidateId && job.state === 'running') withJudge.platform.finish(job.job_id, metrics)
    }
    const phase = withJudge.store.getState(candidateId, 'phase')?.phase
    if (phase === 'DONE' || phase === 'REJECTED') return phase
    withJudge.clock.advance(10_000)
  }
  throw new Error(`${candidateId} never reached a terminal phase`)
}