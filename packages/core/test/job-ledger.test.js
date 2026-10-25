/**
 * Guards ticket 16: the cluster job ledger.
 *
 * The cluster is shared and its cards are not isolated (measured, ticket 14: two 8-card jobs ran at
 * the same time on the same eight cards), so "which jobs are ours, which should be collected" has to
 * have a definite answer that is not "go and look at the dashboard". Four contracts live here:
 *
 *  1. **A submitted job is a fact with an identity the cluster can be asked about.** The ledger row
 *     carries the candidate id and the round, and the marker written into the job's `metadata` says
 *     the same thing — `metadata` and `submission_id` are the two fields that survive in the
 *     cluster's listing, and a listing row's `job_id` may be `null`.
 *  2. **"Ours" and "orphan" are a view** over those facts plus a live listing, never a copy of the
 *     listing cached as if it were a fact. An orphan is a job carrying *our* marker with no ledger
 *     row; a job with somebody else's identity is foreign, and no code path here may offer to stop
 *     it.
 *  3. **Collecting an orphan is an explicit action.** A tick that stops jobs it does not recognise is
 *     how somebody else's training dies.
 *  4. **`canceled` and `failed` are two different facts.** A job someone else stopped says nothing
 *     about the candidate's code, and recording it as a failure sends the next round debugging code
 *     that never ran.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCandidate, reconcile, tick } from '../lib/loop.js'
import { Store } from '../lib/store.js'
import { jobsCommand } from '../lib/cli/jobs.js'
import { jobMarker, jobReport, parseMarker, readListing, reapOrphans, submissionIdFor } from '../lib/jobs.js'

const AT = 1_761_091_200_000

/** The job carrying our marker that this workspace never recorded: r8-h8's eighth-round attempt. */
const ORPHAN_ID = 'reprise:candidate=r8-h8:round=8'

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
 * A cluster that outlives us: its jobs are keyed by the cluster's id, its listing is its own words,
 * and every write it receives is recorded so a test can assert nobody stopped anything by accident.
 */
function fakeCluster({ foreign = [] } = {}) {
  const jobs = new Map()
  const stops = []
  let counter = 0

  const listing = () => [
    ...[...jobs.values()].map((job) => ({
      job_id: job.job_id,
      submission_id: job.submission_id,
      status: job.status,
      metadata: job.metadata,
    })),
    ...foreign,
  ]

  return {
    jobs,
    stops,
    foreign,
    async submit(request) {
      for (const job of jobs.values()) {
        if (job.submission_id === request.submissionId) {
          return { job_id: job.job_id, state: job.state, harness: 'fake', duplicate: true }
        }
      }
      counter += 1
      const job = {
        job_id: `job-${counter}`,
        submission_id: request.submissionId,
        candidate_id: request.candidateId,
        round: request.round,
        metadata: request.metadata,
        state: 'running',
        status: 'RUNNING',
      }
      jobs.set(job.job_id, job)
      return { job_id: job.job_id, state: 'running', harness: 'fake' }
    },
    async find(candidateId) {
      return [...jobs.values()].find((job) => job.candidate_id === candidateId && job.state !== 'lost')
    },
    async poll(jobId) {
      const job = jobs.get(jobId)
      if (job === undefined) return { state: 'lost' }
      return { state: job.state, metrics: job.metrics, error_class: job.error_class }
    },
    async cancel(jobId) {
      stops.push(jobId)
      const job = jobs.get(jobId)
      if (job === undefined) return { accepted: false, state_after: 'lost' }
      Object.assign(job, { state: 'failed', status: 'STOPPED', error_class: 'canceled' })
      return { accepted: true, state_after: 'failed' }
    },
    async list() {
      return { ok: true, jobs: listing() }
    },
    finish(jobId, metrics = { auc: 0.7123 }) {
      Object.assign(jobs.get(jobId), { state: 'succeeded', status: 'SUCCEEDED', metrics })
    },
    fail(jobId, errorClass) {
      Object.assign(jobs.get(jobId), { state: 'failed', status: 'FAILED', error_class: errorClass })
    },
  }
}

const fakeHarness = {
  land({ candidateId }) {
    return { engine: 'fake-harness', parent_id: 'baseline-0', parent_commit: 'aaa111', files_changed: 2, candidateId }
  },
}

const verdictOf = ({ candidateId, now }) => ({
  candidate_id: candidateId,
  passed: true,
  checks: [{ name: 'static_imports', result: 'pass' }],
  reviewer: { verdict: 'accept', rationale: 'no behaviour change outside the target module' },
  decided_at_ms: now,
})

const reportOf = ({ candidateId, now }) => ({
  candidate_id: candidateId,
  verdict: 'improved',
  observed: { metric: 'auc', value: 0.7123 },
  concluded: { metric: 'auc', value: 0.7123 },
  root_cause: 'the wider embedding table reduced collisions on rare features',
  at_ms: now,
})

function setup({ config = {}, cluster = fakeCluster() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-jobs-'))
  const store = Store.open(dir)
  const ports = {
    store,
    clock: new FakeClock(),
    platform: cluster,
    harness: fakeHarness,
    judge: { verify: verdictOf, analyze: reportOf },
    config,
  }
  return { ...ports, cluster, dir }
}

/** Advance one candidate to a phase. One tick is one step, so the phase list is the itinerary. */
async function tickTo(ports, candidateId, phase, { maxTicks = 20 } = {}) {
  for (let index = 0; index < maxTicks; index += 1) {
    if (ports.store.getState(candidateId, 'phase')?.phase === phase) return
    await tick(ports)
    ports.clock.advance(1_000)
  }
  throw new Error(`${candidateId} never reached ${phase} (now ${ports.store.getState(candidateId, 'phase')?.phase})`)
}

test('the marker names the candidate and the round, and reads back as the same two values', () => {
  const marker = jobMarker({ candidateId: 'r2-h1', round: 2 })
  assert.equal(marker, 'reprise:candidate=r2-h1:round=2')
  assert.deepEqual(parseMarker(marker), { candidateId: 'r2-h1', round: 2 })
  assert.equal(parseMarker('autotrain-smoke-1792741140'), undefined, 'somebody else\u2019s job is not ours')
  assert.equal(parseMarker(undefined), undefined)
  assert.throws(() => jobMarker({ candidateId: 'r2-h1' }), TypeError, 'a marker without a round names half a job')
})

test('a submitted job is a ledger fact carrying its candidate id, its round and its marker', async () => {
  const ports = setup()
  createCandidate(ports, { candidateId: 'r2-h1', round: 2, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r2-h1', 'MONITOR_POLL')

  const row = ports.store.jobFor('r2-h1')
  assert.equal(row.round, 2, 'the round is part of what a job is, not something re-derived later')
  assert.equal(row.marker, 'reprise:candidate=r2-h1:round=2')

  const submitted = [...ports.cluster.jobs.values()].at(-1)
  assert.equal(submitted.round, 2, 'the round reaches the plan, so the marker can be built there')
  assert.equal(
    submitted.submission_id,
    'reprise:candidate=r2-h1:round=2',
    'the idempotency key is the marker: on the live cluster the listing answers with a submission id and no metadata at all',
  )
  assert.equal(row.submission_id, submitted.submission_id, 'the ledger records the key the cluster was given')
  assert.equal(row.marker, row.submission_id, 'and the marker is that same string, so the listing and the ledger name one job')
  assert.equal(row.outcome, null, 'a job still running has no outcome yet')
  ports.store.close()
})
test('the view finds our jobs in the listing and calls a marker we never recorded an orphan', async () => {
  const cluster = fakeCluster({
    foreign: [
      // The cluster already held 106 jobs from other work when this was measured. They are not
      // orphans: nobody here wrote their identity, so nothing here may offer to stop them.
      { job_id: 'raysubmit_9001', submission_id: 'autotrain-smoke-1792741140', status: 'RUNNING', metadata: {} },
      // A row whose `job_id` is null — measured on the live dashboard, 42 of 129 rows had one.
      { job_id: null, submission_id: 'someone-elses-work', status: 'RUNNING' },
    ],
  })
  const ports = setup({ cluster })
  createCandidate(ports, { candidateId: 'r2-h1', round: 2, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r2-h1', 'MONITOR_POLL')

  // A job carrying our marker that the ledger never recorded, and whose cluster id is null: the
  // submission id is the reference, because that is the field the listing always has.
  cluster.jobs.set('raysubmit_9100', {
    job_id: null,
    submission_id: ORPHAN_ID,
    candidate_id: 'r8-h8',
    round: 8,
    metadata: { marker: jobMarker({ candidateId: 'r8-h8', round: 8 }) },
    state: 'running',
    status: 'RUNNING',
  })

  const report = jobReport({ rows: ports.store.allJobs(), listing: await cluster.list() })

  assert.equal(report.read, true)
  assert.deepEqual(report.ours.map((job) => job.submission_id), ['reprise:candidate=r2-h1:round=2'])
  assert.equal(report.ours[0].round, 2)
  assert.equal(report.ours[0].outcome, null, 'a running job has no outcome')
  assert.deepEqual(report.orphans.map((job) => job.submission_id), [ORPHAN_ID])
  assert.equal(report.orphans[0].job_id, null)
  assert.equal(report.orphans[0].reference, ORPHAN_ID, 'a null job id still names the job: the dashboard resolves the submission id')
  assert.deepEqual(
    report.foreign.map((job) => job.submission_id).sort(),
    ['autotrain-smoke-1792741140', 'someone-elses-work'],
  )
  ports.store.close()
})

test('a listing we could not read reports that we did not look, not an empty cluster', async () => {
  const ports = setup({ cluster: fakeCluster({ foreign: [] }) })
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r1-h1', 'MONITOR_POLL')

  const report = jobReport({
    rows: ports.store.allJobs(),
    listing: { ok: false, message: 'the dashboard answered 503' },
  })
  assert.equal(report.read, false)
  assert.match(report.reason, /503/)
  assert.deepEqual(report.orphans, [], '"we could not look" must never be handed back as "there are none"')
  assert.equal(report.ledger.length, 1, 'the ledger half of the view is still readable without the cluster')
  ports.store.close()
})

/** A job carrying our marker that this workspace never recorded: a crash, or a deleted workspace. */
function orphan(cluster, { candidateId = 'r8-h8', round = 8, jobId = 'raysubmit_9100' } = {}) {
  const job = {
    job_id: jobId,
    submission_id: submissionIdFor({ candidateId, round }),
    candidate_id: candidateId,
    round,
    metadata: { marker: submissionIdFor({ candidateId, round }) },
    state: 'running',
    status: 'RUNNING',
  }
  cluster.jobs.set(jobId, job)
  return job
}

test('a tick never stops a job it does not recognise — cleanup is an explicit action', async () => {
  const cluster = fakeCluster({ foreign: [{ job_id: 'raysubmit_9001', submission_id: 'autotrain-smoke-1792741140', status: 'RUNNING', metadata: {} }] })
  const ports = setup({ cluster })
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r1-h1', 'MONITOR_POLL')
  orphan(cluster)

  for (let index = 0; index < 5; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }

  assert.deepEqual(cluster.stops, [], 'a tick that stops jobs it does not recognise is how somebody else\u2019s training dies')
  assert.deepEqual(ports.store.ops().filter((op) => op.op === 'orphan_reaped'), [])
  ports.store.close()
})

test('reaping stops exactly the orphan it was asked about, and refuses everything else', async () => {
  const cluster = fakeCluster({
    foreign: [{ job_id: 'raysubmit_9001', submission_id: 'autotrain-smoke-1792741140', status: 'RUNNING', metadata: {} }],
  })
  const ports = setup({ cluster })
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r1-h1', 'MONITOR_POLL')
  orphan(cluster)
  const ourJobId = ports.store.jobFor('r1-h1').job_id

  const report = jobReport({ rows: ports.store.allJobs(), listing: await cluster.list() })
  const result = await reapOrphans({
    platform: cluster,
    store: ports.store,
    report,
    jobIds: [ORPHAN_ID, 'raysubmit_9001', ourJobId, 'raysubmit_does-not-exist'],
    now: ports.clock.now(),
  })

  assert.deepEqual(result.stopped.map((entry) => entry.submission_id), [ORPHAN_ID], 'the orphan, addressed by its submission id')
  assert.deepEqual(cluster.stops, ['raysubmit_9100'], 'one stop, for the orphan only')

  const refused = Object.fromEntries(result.refusals.map((entry) => [entry.job_id, entry.reason]))
  assert.match(refused.raysubmit_9001, /not ours/, 'another team\u2019s job carries no marker of ours')
  assert.match(refused[ourJobId], /ledger knows/, 'a job the ledger knows is collected through its candidate, not here')
  assert.match(refused['raysubmit_does-not-exist'], /not in the cluster listing/)

  const ops = ports.store.ops().filter((op) => op.op === 'orphan_reaped')
  assert.equal(ops.length, 1, 'the stop is a fact recorded on our side of the wire')
  assert.equal(JSON.parse(ops[0].detail).submission_id, ORPHAN_ID)
  ports.store.close()
})

test('reaping a job that has already finished refuses instead of pretending to stop it', async () => {
  const cluster = fakeCluster()
  const ports = setup({ cluster })
  const job = orphan(cluster)
  job.state = 'succeeded'
  job.status = 'SUCCEEDED'

  const report = jobReport({ rows: [], listing: await cluster.list() })
  const result = await reapOrphans({ platform: cluster, store: ports.store, report, jobIds: [job.job_id], now: ports.clock.now() })

  assert.deepEqual(result.stopped, [])
  assert.match(result.refusals[0].reason, /already finished/)
  assert.deepEqual(cluster.stops, [])
  ports.store.close()
})

test('an executor that cannot list its jobs says so instead of reporting no orphans', async () => {
  const cluster = fakeCluster()
  delete cluster.list
  const listing = await readListing(cluster)
  assert.equal(listing.ok, false)
  assert.match(listing.message, /cannot list/)
})

test('a job somebody else stopped and a job that broke are two different facts', async () => {
  const cluster = fakeCluster()
  const ports = setup({ cluster })
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  createCandidate(ports, { candidateId: 'r1-h2', round: 1, hypothesis: 'drop the dropout' })
  for (let index = 0; index < 10; index += 1) {
    const both = ['r1-h1', 'r1-h2'].every((id) => ports.store.getState(id, 'phase')?.phase === 'MONITOR_POLL')
    if (both) break
    await tick(ports)
    ports.clock.advance(1_000)
  }

  const stoppedBySomeone = ports.store.jobFor('r1-h1')
  const broke = ports.store.jobFor('r1-h2')
  // The cluster's own words: one job was stopped (`STOPPED` → failed + `canceled`), the other failed
  // with a code class.
  cluster.fail(stoppedBySomeone.job_id, 'canceled')
  cluster.jobs.get(stoppedBySomeone.job_id).status = 'STOPPED'
  cluster.fail(broke.job_id, 'code')

  for (let index = 0; index < 6; index += 1) {
    const both = ['r1-h1', 'r1-h2'].every((id) => ports.store.getState(id, 'phase')?.phase === 'REJECTED')
    if (both) break
    await tick(ports)
    ports.clock.advance(1_000)
  }

  const stoppedRow = ports.store.jobFor('r1-h1')
  const brokeRow = ports.store.jobFor('r1-h2')
  assert.equal(stoppedRow.outcome, 'canceled', 'being stopped is not failing')
  assert.equal(brokeRow.outcome, 'failed')

  // The view keys on the outcome, so "which jobs failed" never answers with a stopped one.
  const report = jobReport({ rows: ports.store.allJobs(), listing: await cluster.list() })
  assert.deepEqual(
    report.ours.filter((job) => job.outcome === 'failed').map((job) => job.submission_id),
    ['reprise:candidate=r1-h2:round=1'],
  )
  assert.deepEqual(
    report.ours.filter((job) => job.outcome === 'canceled').map((job) => job.submission_id),
    ['reprise:candidate=r1-h1:round=1'],
  )

  // And neither is recorded as a candidate defect: no four-state status, and the reason a person
  // reads says which of the two happened.
  for (const candidateId of ['r1-h1', 'r1-h2']) {
    const rejection = ports.store.eventsFor(candidateId).at(-1)
    assert.equal(rejection.event_type, 'candidate_rejected')
    assert.equal(rejection.payload.status, undefined, 'nothing was malformed, so no four-state status belongs here')
    assert.equal(rejection.payload.outcome, candidateId === 'r1-h1' ? 'canceled' : 'failed')
  }
  const stoppedReason = ports.store.eventsFor('r1-h1').at(-1).payload.reject_reason
  assert.match(stoppedReason, /stopped, and not by us/)
  ports.store.close()
})

test('a restart that sees a stopped job does not guess what kind of end it was', async () => {
  const cluster = fakeCluster()
  const ports = setup({ cluster })
  createCandidate(ports, { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r1-h1', 'MONITOR_POLL')
  const jobId = ports.store.jobFor('r1-h1').job_id

  // Somebody stopped it while our process was down. `find()` can only say "failed".
  cluster.fail(jobId, 'canceled')
  const repairs = await reconcile(ports)

  assert.deepEqual(repairs.filter((repair) => repair.action === 'corrected job state').length, 1)
  assert.equal(ports.store.jobFor('r1-h1').state, 'failed')
  assert.equal(
    ports.store.jobFor('r1-h1').outcome,
    null,
    'a bare "failed" from find() cannot say whether someone stopped it; the next poll can',
  )

  // …and that poll is what records the truth.
  await tick(ports)
  assert.equal(ports.store.jobFor('r1-h1').outcome, 'canceled')
  assert.equal(ports.store.eventsFor('r1-h1').at(-1).payload.outcome, 'canceled')
  ports.store.close()
})

test('the jobs command puts the orphan on screen, and stops only what it is told to', async () => {
  const cluster = fakeCluster({
    foreign: [{ job_id: 'raysubmit_9001', submission_id: 'autotrain-smoke-1792741140', status: 'RUNNING', metadata: {} }],
  })
  const ports = setup({ cluster })
  createCandidate(ports, { candidateId: 'r2-h1', round: 2, hypothesis: 'widen the embedding table' })
  await tickTo(ports, 'r2-h1', 'MONITOR_POLL')
  orphan(cluster)

  const config = { workspaceDir: ports.dir, executor: { kind: 'ray', base_url: 'http://ray.fake:8265' } }
  const printed = []
  const out = (line) => printed.push(line)
  const listed = await jobsCommand(['list'], { out, config, platform: cluster, now: ports.clock.now() })

  assert.equal(listed.code, 0)
  const text = printed.join('\n')
  assert.match(text, /orphans \(1\)/)
  assert.match(text, new RegExp(ORPHAN_ID), 'the orphan is visible, with the reference that would stop it')
  assert.match(text, /not ours \(1\)/)
  assert.match(text, /autotrain-smoke-1792741140/)

  printed.length = 0
  const reaped = await jobsCommand(['reap', '--job', ORPHAN_ID, '--job', 'raysubmit_9001'], {
    out,
    config,
    platform: cluster,
    now: ports.clock.now(),
  })
  assert.equal(reaped.code, 1, 'one stop and one refusal is a partial success, and the exit code says so')
  assert.deepEqual(cluster.stops, ['raysubmit_9100'])
  assert.match(printed.join('\n'), /refused .*raysubmit_9001: not ours/)
  ports.store.close()
})

test('an executor that cannot list its jobs says so in the command output', async () => {
  const cluster = fakeCluster()
  delete cluster.list
  const ports = setup({ cluster })
  const printed = []
  const result = await jobsCommand(['list'], {
    out: (line) => printed.push(line),
    config: { workspaceDir: ports.dir, executor: { kind: 'local', command: ['node', 'x.mjs'] } },
    platform: cluster,
    now: ports.clock.now(),
  })

  assert.equal(result.code, 1, 'not knowing what is running upstream is not success')
  assert.match(printed.join('\n'), /NOT READ/)
  assert.match(printed.join('\n'), /cannot list/)
  ports.store.close()
})
