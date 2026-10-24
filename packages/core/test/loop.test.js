import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Store } from '../lib/store.js'
import { createCandidate, foldEvents, reconcile, tick } from '../lib/loop.js'

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

/** A stand-in external platform with its own state, so it survives our process dying. */
function fakePlatform() {
  const jobs = new Map()
  let counter = 0
  const visible = (job) => job.hidden !== true
  return {
    jobs,
    submit({ submissionId, candidateId }) {
      for (const job of jobs.values()) {
        if (job.submission_id === submissionId) return { job_id: job.job_id, duplicate: true, harness: 'fake', state: job.state }
      }
      counter += 1
      const job = { job_id: `job-${counter}`, submission_id: submissionId, candidate_id: candidateId, state: 'running' }
      jobs.set(job.job_id, job)
      return { job_id: job.job_id, harness: 'fake-harness', state: 'running' }
    },
    find(candidateId) {
      return [...jobs.values()].find((job) => job.candidate_id === candidateId && visible(job))
    },
    poll(jobId) {
      const job = jobs.get(jobId)
      if (job === undefined) return { state: 'lost' }
      return { state: job.state, metrics: job.metrics, error_class: job.error_class }
    },
    finish(jobId, metrics = { auc: 0.7123 }) {
      Object.assign(jobs.get(jobId), { state: 'succeeded', metrics })
    },
    fail(jobId, errorClass) {
      Object.assign(jobs.get(jobId), { state: 'failed', error_class: errorClass })
    },
    hide(candidateId) {
      for (const job of jobs.values()) if (job.candidate_id === candidateId) job.hidden = true
    },
    get size() {
      return jobs.size
    },
  }
}

const fakeHarness = {
  land({ candidateId }) {
    return { engine: 'fake-harness', parent_id: 'baseline-0', parent_commit: 'aaa111', files_changed: 2, candidateId }
  },
}

function goodVerdict({ candidateId, now }) {
  return {
    candidate_id: candidateId,
    passed: true,
    checks: [{ name: 'static_imports', result: 'pass' }],
    reviewer: { verdict: 'accept', rationale: 'no behaviour change outside the target module' },
    decided_at_ms: now,
  }
}

function goodReport({ candidateId, now }) {
  return {
    candidate_id: candidateId,
    verdict: 'improved',
    observed: { metric: 'auc', value: 0.7123 },
    concluded: { metric: 'auc', value: 0.7123 },
    root_cause: 'the wider embedding table reduced collisions on rare features',
    at_ms: now,
  }
}

function fakeJudge(overrides = {}) {
  return {
    verify: goodVerdict,
    analyze: goodReport,
    ...overrides,
  }
}

function setup({ config, judge, crashAt } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-loop-')))
  const clock = new FakeClock()
  const platform = fakePlatform()
  const ports = { store, clock, platform, harness: fakeHarness, judge: judge ?? fakeJudge(), config, crashAt }
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  return ports
}

/** Tick until the candidate reaches a terminal phase, letting the platform finish its jobs. */
async function drive(ports, { maxTicks = 40, finish = true } = {}) {
  const seen = []
  for (let index = 0; index < maxTicks; index += 1) {
    const { actions, paused } = await tick(ports)
    seen.push(...actions)
    if (paused !== null) return { actions: seen, paused }
    if (finish) for (const job of ports.platform.jobs.values()) if (job.state === 'running') ports.platform.finish(job.job_id)
    const phase = ports.store.getState('c1', 'phase')?.phase
    if (phase === 'DONE' || phase === 'REJECTED') return { actions: seen, paused: null, phase }
    ports.clock.advance(10_000)
  }
  return { actions: seen, paused: null, phase: ports.store.getState('c1', 'phase')?.phase }
}

const eventTypes = (store, candidateId = 'c1') => store.eventsFor(candidateId).map((event) => event.event_type)

test('a candidate walks every phase to DONE, driven by code alone', async () => {
  const ports = setup()
  const { phase } = await drive(ports)

  assert.equal(phase, 'DONE')
  assert.deepEqual(eventTypes(ports.store), [
    'candidate_created',
    'land_done',
    'build_skipped',
    'gate_result',
    'budget_reserved',
    'submitted',
    'metrics_collected',
    'cand_analyze',
  ])
  assert.equal(ports.store.totals().inFlightGpuHours, 0, 'the reservation was settled, not left hanging')
  assert.ok(ports.store.totals().settledGpuHours > 0)
  ports.store.close()
})

test('one tick advances a candidate by exactly one step', async () => {
  const ports = setup()
  const phases = []
  for (let index = 0; index < 6; index += 1) {
    const { actions } = await tick(ports)
    assert.equal(actions.length, 1, 'one candidate, one step')
    phases.push(ports.store.getState('c1', 'phase').phase)
    ports.clock.advance(1_000)
  }
  assert.deepEqual(phases, ['BUILD', 'VERIFY', 'SUBMIT_QUEUED', 'SUBMIT', 'MONITOR_POLL', 'MONITOR_POLL'])
  ports.store.close()
})

test('an artifact that breaks its schema is rejected as invalid, with the message', async () => {
  const ports = setup({
    judge: fakeJudge({ verify: ({ candidateId, now }) => ({ ...goodVerdict({ candidateId, now }), passed: 'true' }) }),
  })
  const { phase } = await drive(ports)
  assert.equal(phase, 'REJECTED')

  const rejection = ports.store.eventsFor('c1').at(-1)
  assert.equal(rejection.event_type, 'candidate_rejected')
  assert.equal(rejection.payload.status, 'invalid')
  assert.match(rejection.payload.blocking_message, /passed must be a strict boolean/)
  ports.store.close()
})

test('a gate that passes while the review rejects is a conflict, not a pass', async () => {
  const ports = setup({
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({
        ...goodVerdict({ candidateId, now }),
        reviewer: { verdict: 'reject', rationale: 'silently changes the loss scale' },
      }),
    }),
  })
  const { phase } = await drive(ports)
  assert.equal(phase, 'REJECTED')
  const rejection = ports.store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, 'conflict', 'the four-state distinction survives to the fact plane')
  ports.store.close()
})

test('a failing gate stops the candidate without inventing a job', async () => {
  const ports = setup({
    judge: fakeJudge({ verify: ({ candidateId, now }) => ({ ...goodVerdict({ candidateId, now }), passed: false }) }),
  })
  const { phase } = await drive(ports)
  assert.equal(phase, 'REJECTED')
  assert.equal(ports.platform.size, 0, 'nothing was submitted')
  ports.store.close()
})

test('a crash after submitting adopts the platform job instead of resubmitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-loop-'))
  const store = Store.open(dir)
  const clock = new FakeClock()
  const platform = fakePlatform()
  const config = undefined
  createCandidate({ store, clock }, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })

  // Walk to SUBMIT, then die in the window between platform knowledge and our own record.
  let crashed = false
  for (let index = 0; index < 10 && !crashed; index += 1) {
    try {
      await tick({
        store,
        clock,
        platform,
        harness: fakeHarness,
        judge: fakeJudge(),
        config,
        crashAt: (point) => {
          if (point === 'after_submit') throw new Error('crash: after submit, before the job row')
        },
      })
    } catch (error) {
      assert.match(error.message, /after submit/)
      crashed = true
    }
    clock.advance(1_000)
  }

  assert.ok(crashed, 'the crash window was reached')
  assert.equal(platform.size, 1, 'the platform has the job')
  assert.equal(store.jobFor('c1'), undefined, 'and we do not')
  store.close()

  // Restart.
  const reopened = Store.open(dir)
  const repairs = await reconcile({ store: reopened, clock, platform, config })
  assert.ok(
    repairs.some((repair) => repair.action === 'adopted remote job'),
    'recovery asks the platform before trusting our last row',
  )
  assert.equal(platform.size, 1, 'still exactly one job upstream — nothing was resubmitted')
  assert.equal(reopened.jobFor('c1').job_id, 'job-1')
  assert.equal(reopened.getState('c1', 'phase').phase, 'MONITOR_POLL')

  platform.finish('job-1')
  const { phase } = await (async () => {
    for (let index = 0; index < 10; index += 1) {
      await tick({ store: reopened, clock, platform, harness: fakeHarness, judge: fakeJudge() })
      const current = reopened.getState('c1', 'phase').phase
      if (current === 'DONE' || current === 'REJECTED') return { phase: current }
      clock.advance(10_000)
    }
    return { phase: reopened.getState('c1', 'phase').phase }
  })()
  assert.equal(phase, 'DONE', 'and the restarted loop finishes the candidate')
  reopened.close()
})

test('an event that landed without its state transition is folded back on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-loop-'))
  const store = Store.open(dir)
  const clock = new FakeClock()
  const platform = fakePlatform()
  createCandidate({ store, clock }, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })

  // land_done is written, then the process dies before the phase advances.
  let crashed = false
  try {
    await tick({
      store,
      clock,
      platform,
      harness: fakeHarness,
      judge: fakeJudge(),
      crashAt: (point) => {
        if (point === 'after_event') throw new Error('crash after the event')
      },
    })
  } catch {
    crashed = true
  }
  assert.ok(crashed)

  assert.equal(store.getState('c1', 'phase').phase, 'LAND', 'state never saw the event')
  assert.equal(store.maxSeq('c1'), 2, 'but the fact is on disk')
  assert.equal(store.appliedSeq('c1'), 1, 'and the lag is visible')
  store.close()

  const reopened = Store.open(dir)
  const repairs = await reconcile({ store: reopened, clock, platform })
  assert.ok(repairs.some((repair) => repair.action === 'replayed events'))
  assert.equal(reopened.getState('c1', 'phase').phase, 'BUILD', 'the fold caught the state up')
  assert.equal(reopened.appliedSeq('c1'), reopened.maxSeq('c1'))
  reopened.close()
})

test('folding is idempotent', async () => {
  const ports = setup()
  ports.store.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'land_done', payload: {} })
  assert.equal(foldEvents(ports.store, 'c1').folded, 1)
  assert.equal(foldEvents(ports.store, 'c1').folded, 0, 'nothing left to fold')
  ports.store.close()
})

test('a job the platform cannot see yet gets a grace period, not a death sentence', async () => {
  const ports = setup()
  for (let index = 0; index < 5; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }
  assert.equal(ports.store.jobFor('c1').state, 'running')
  ports.platform.hide('c1')

  const first = await reconcile(ports)
  assert.ok(first.some((repair) => repair.action === 'grace period (not visible upstream yet)'))
  assert.equal(ports.store.jobFor('c1').state, 'unknown')
  assert.notEqual(ports.store.getState('c1', 'phase').phase, 'REJECTED', 'a restart must not kill a live job')

  await reconcile(ports)
  const exhausted = await reconcile(ports)
  assert.deepEqual(exhausted, [], 'after the grace window the loop stops pretending it can see it')
  ports.store.close()
})

test('a running job backs off instead of spinning', async () => {
  const ports = setup()
  for (let index = 0; index < 4; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }
  assert.equal(ports.store.getState('c1', 'phase').phase, 'SUBMIT')
  ports.clock.advance(1_000)
  await tick(ports) // SUBMIT -> MONITOR_POLL
  ports.clock.advance(1_000)

  const firstPoll = (await tick(ports)).actions[0]
  assert.match(firstPoll.action, /still running/)
  const state = ports.store.getState('c1', 'phase')
  assert.ok(state.next_action_at > ports.clock.now(), 'a running job schedules the next look')

  const before = ports.store.maxSeq('c1')
  const early = await tick(ports)
  assert.deepEqual(early.actions, [], 'ticking before the next poll time does nothing')
  assert.equal(ports.store.maxSeq('c1'), before, 'and writes nothing')

  ports.clock.advance(120_000)
  await tick(ports)
  assert.ok(ports.store.getState('c1', 'phase').next_action_at > ports.clock.now(), 'still backing off')
  ports.store.close()
})

test('a job that failed upstream is rejected with its error class', async () => {
  const ports = setup()
  for (let index = 0; index < 5; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }
  const job = ports.store.jobFor('c1')
  ports.platform.fail(job.job_id, 'oom')
  ports.clock.advance(1_000)
  await tick(ports)

  const rejection = ports.store.eventsFor('c1').at(-1)
  assert.equal(rejection.event_type, 'candidate_rejected')
  assert.match(rejection.payload.blocking_message, /oom/)
  ports.store.close()
})

test('the hard budget limit pauses the workspace instead of finalising it', async () => {
  const ports = setup({ config: { budget: { gpu_hours_limit: 0.1, candidate_gpu_hours: 0.5 } } })
  const { paused } = await drive(ports)

  assert.ok(paused, 'the budget gate fired')
  assert.equal(paused.reason, 'budget_exhausted')
  assert.equal(paused.automatic, true)
  assert.notEqual(ports.store.getState('c1', 'phase').phase, 'DONE', 'spending the budget is not finishing the experiment')

  const after = await tick(ports)
  assert.ok(after.paused, 'a paused workspace stays paused until someone resumes it')
  assert.deepEqual(after.actions, [])
  ports.store.close()
})

test('an explicit pause halts everything and is marked as manual', async () => {
  const ports = setup()
  ports.store.setState(undefined, 'workspace', { paused: { reason: 'operator', at_ms: AT }, budget: {} })
  const result = await tick(ports)
  assert.deepEqual(result.actions, [])
  assert.equal(result.paused.reason, 'operator')
  assert.notEqual(result.paused.automatic, true, 'a manual pause is never auto-resumed')
  ports.store.close()
})

test('nothing in the kernel reads the system clock', async () => {
  const ports = setup()
  const wallClock = Date.now
  Date.now = () => {
    throw new Error('the kernel must take time from its clock port')
  }
  try {
    await drive(ports)
  } finally {
    Date.now = wallClock
  }
  assert.equal(ports.store.getState('c1', 'phase').phase, 'DONE')
  ports.store.close()
})
test('a candidate that legitimately fails its checks is rejected without claiming the artifact was malformed', async () => {
  const ports = setup({
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({
        ...goodVerdict({ candidateId, now }),
        passed: false,
        checks: [{ name: 'static_imports', result: 'fail' }],
        reviewer: { verdict: 'reject', rationale: 'drops a feature column' },
      }),
    }),
  })
  const { phase } = await drive(ports)
  assert.equal(phase, 'REJECTED')
  const rejection = ports.store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, undefined, 'nothing was malformed: the four states do not apply here')
  assert.match(rejection.payload.reject_reason, /did not pass/)
  ports.store.close()
})

test('the hypothesis a candidate was created with reaches the harness and the facts', async () => {
  const seen = []
  const ports = setup()
  const harness = { land: (request) => (seen.push(request), fakeHarness.land(request)) }
  let state
  for (let index = 0; index < 2; index += 1) {
    await tick({ ...ports, harness })
    state = ports.store.getState('c1', 'phase')
  }
  assert.equal(seen[0].hypothesis, 'widen the embedding table', 'a real adapter throws on undefined, so this must survive')
  assert.equal(ports.store.eventsFor('c1')[0].payload.hypothesis, 'widen the embedding table')
  ports.store.close()
})

test('losing the state row entirely, the event stream restores phase, round and hypothesis', async () => {
  const ports = setup()
  // Whatever a crash does to the state row, the event is the record of truth.
  ports.store.setState('c1', 'phase', {})
  ports.store.setAppliedSeq('c1', 0)

  foldEvents(ports.store, 'c1')
  const rebuilt = ports.store.getState('c1', 'phase')
  assert.equal(rebuilt.phase, 'LAND')
  assert.equal(rebuilt.round, 1)
  assert.equal(rebuilt.hypothesis, 'widen the embedding table', 'the hypothesis is part of what was created')
  ports.store.close()
})

/**
 * Ticket 15: the platform can refuse a submission for good (a candidate tree too large for the job
 * package, or an archive whose inventory disagrees with the runner's git diff). That is a decision,
 * not a transient fault, and the two must not share a code path — retrying a tree that cannot change
 * only fills the log while the candidate sits in SUBMIT.
 *
 * What is asserted on the surface a person reads: the candidate is REJECTED, the reason names the
 * platform's conclusion, and — per CODING_STANDARDS §2 — the rejection carries **no** four-state
 * `status`, because nothing the candidate produced was malformed.
 */
test('a submission refused for good rejects the candidate on the first attempt, without a four-state status', async () => {
  const ports = setup()
  let attempts = 0
  ports.platform.submit = () => {
    attempts += 1
    // The shape `PackageRefusedError` has: a conclusion an operator can act on, and no retry.
    throw Object.assign(new Error('the candidate tree is 900 bytes, over the 16-byte job-package limit'), {
      name: 'PackageRefusedError',
      conclusion: 'archive_too_large',
      retryable: false,
    })
  }

  const { phase } = await drive(ports, { maxTicks: 20 })

  assert.equal(phase, 'REJECTED')
  const rejection = ports.store.eventsFor('c1').at(-1)
  assert.equal(rejection.event_type, 'candidate_rejected')
  assert.equal(
    rejection.payload.status,
    undefined,
    'a tree that cannot be shipped is bad news, not a malformed artifact: inventing "invalid" sends the next reader hunting for a broken document',
  )
  assert.match(rejection.payload.reject_reason, /archive_too_large/, 'the conclusion is the reason a person reads')
  assert.match(rejection.payload.reject_reason, /over the 16-byte job-package limit/)
  assert.equal(attempts, 1, 'the platform was asked once: waiting does not make a tree smaller')
  assert.equal(ports.platform.size, 0, 'no job was invented on the way out')
  assert.equal(
    ports.store.eventsFor('c1').some((event) => event.event_type === 'submit_refused'),
    false,
    'the retry path was not taken at all',
  )
  ports.store.close()
})

test('a submission the platform cannot answer for is still retried, never rejected', async () => {
  const ports = setup()
  let attempts = 0
  let broken = true
  const realSubmit = ports.platform.submit.bind(ports.platform)
  ports.platform.submit = (request) => {
    attempts += 1
    if (broken) throw new Error('ray rejected the submission: 500 no resources available')
    return realSubmit(request)
  }

  // Walk to SUBMIT, then let the refused tick happen.
  for (let index = 0; index < 20 && ports.store.getState('c1', 'phase')?.phase !== 'SUBMIT'; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }
  assert.equal(ports.store.getState('c1', 'phase')?.phase, 'SUBMIT')

  await tick(ports)
  assert.equal(attempts, 1)
  assert.equal(ports.store.getState('c1', 'phase').phase, 'SUBMIT', 'a cluster that is down is not the candidate being wrong')
  const refused = ports.store.eventsFor('c1').filter((event) => event.event_type === 'submit_refused')
  assert.equal(refused.length, 1)
  assert.match(refused[0].payload.message, /no resources available/)
  assert.equal(
    ports.store.eventsFor('c1').some((event) => event.event_type === 'candidate_rejected'),
    false,
    'rejecting here would throw away a candidate because the cluster was busy',
  )

  // And the backoff really does come back around.
  ports.clock.advance(60_000)
  broken = false
  await tick(ports)
  assert.equal(attempts, 2)
  assert.equal(ports.store.getState('c1', 'phase').phase, 'MONITOR_POLL')
  assert.equal(ports.platform.size, 1)
  ports.store.close()
})
