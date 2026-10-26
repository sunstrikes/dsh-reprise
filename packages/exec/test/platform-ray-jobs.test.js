/**
 * Guards ticket 16's half of the Ray adapter: the two things the job ledger needs from the cluster.
 *
 *  1. **The submission carries the round**, because that is what the plan turns into the job's marker
 *     (`reprise:candidate=<id>:round=<n>`). Without it the marker names half a job and two attempts
 *     of one candidate are indistinguishable in the listing.
 *  2. **The adapter can read the cluster's job listing** (`GET /api/v0/jobs`), tolerantly: rows with
 *     `job_id: null` are kept (measured: 42 of 129 rows on the live dashboard had one), and a listing
 *     it could not read answers `ok: false` rather than an empty list — "we could not look" and
 *     "there are none" are the two answers a cleanup acts differently on.
 *
 * What this file does NOT decide is whose jobs those are: that is `packages/core/lib/jobs.js`, which
 * reads markers. The adapter's job is to hand over the cluster's own words unchanged.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRayPlatform } from '../lib/platform-ray.js'
import { createFakeRay } from './platform-fixtures/ray-fake.js'

function world({ request } = {}) {
  const fake = createFakeRay()
  const plans = []
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: request ?? fake.request,
    plan: (input) => {
      plans.push(input)
      fake.script(input.submissionId, { outcome: 'succeeded', metrics: { val_loss: 0.5 } })
      return {
        entrypoint: ['python', '-m', 'train'],
        runtimeEnv: { env_vars: {} },
        metadata: { marker: `reprise:candidate=${input.candidateId}:round=${input.round}` },
        numGpus: 0,
      }
    },
    name: 'ray-test',
  })
  return { fake, platform, plans }
}

test('the submission carries the round, so the plan can write the job\u2019s marker', async () => {
  const { platform, plans, fake } = world()
  await platform.submit({ submissionId: 'r2-h1', candidateId: 'r2-h1', gpuHours: 0.5, round: 2 })

  assert.equal(plans[0].round, 2)
  const posted = fake.requests.find((entry) => entry.method === 'POST' && entry.path === '/api/jobs/')
  assert.equal(JSON.parse(posted.body).metadata.marker, 'reprise:candidate=r2-h1:round=2')
})

test('the listing comes back as the cluster said it, null job ids included', async () => {
  const { platform, fake } = world()
  await platform.submit({ submissionId: 'r1-h1', candidateId: 'r1-h1', gpuHours: 0.5, round: 1 })
  // Two rows that are not ours, one of them without a job id — both measured shapes.
  fake.listing.push(
    { job_id: 'raysubmit_9001', submission_id: 'autotrain-smoke-1792741140', status: 'RUNNING', metadata: { owner: 'someone' } },
    { job_id: null, submission_id: 'someone-elses-work', status: 'FAILED', metadata: {} },
  )

  const listing = await platform.list()
  assert.equal(listing.ok, true)
  assert.equal(listing.jobs.length, 3)

  const ours = listing.jobs.find((job) => job.submission_id === 'r1-h1')
  assert.equal(ours.metadata.marker, 'reprise:candidate=r1-h1:round=1')
  assert.equal(ours.status, 'PENDING')

  const nullId = listing.jobs.find((job) => job.submission_id === 'someone-elses-work')
  assert.equal(nullId.job_id, null, 'a null job id is kept as null: the submission id is the reference')
})

test('a listing the dashboard refused says so instead of pretending the cluster is empty', async () => {
  const fake = createFakeRay()
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: async ({ url }) => {
      const path = new URL(url).pathname
      if (path === '/api/v0/jobs') return { status: 503, headers: {}, text: 'the dashboard is restarting' }
      return fake.request({ url, method: 'GET' })
    },
    plan: () => ({ entrypoint: ['python', '-m', 'train'], metadata: {} }),
    name: 'ray-test',
  })

  const listing = await platform.list()
  assert.equal(listing.ok, false)
  assert.equal(listing.jobs, undefined)
  assert.match(listing.message, /503/)
})

test('the listing survives a document shape the adapter has not seen', async () => {
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: async () => ({ status: 200, headers: {}, text: JSON.stringify({ result: true, data: { result: { result: [{ job_id: 'j1', submission_id: 's1', status: 'RUNNING' }] } } }) }),
    plan: () => ({ entrypoint: ['x'], metadata: {} }),
    name: 'ray-test',
  })
  const listing = await platform.list()
  assert.equal(listing.ok, true)
  assert.deepEqual(listing.jobs.map((job) => job.submission_id), ['s1'])
})
// ---------------------------------------------------------------- the idempotency key carries the round

/**
 * The ledger's vocabulary for a job that can be recognised in a listing that has no `metadata`:
 * `reprise:candidate=<id>:round=<n>` is both the marker and the submission id. These tests hold the
 * adapter to it, and to the tolerance crash recovery needs: `find(candidateId)` is asked without the
 * round, because the round is exactly what the process that crashed remembers and we do not.
 */
const ROUND_ID = 'reprise:candidate=r1-h1:round=2'

/** The same world, but with the ledger's ids: `submissionIdFor` is what `find` probes with. */
function ledgerWorld() {
  const fake = createFakeRay()
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: fake.request,
    plan: () => ({ entrypoint: ['python', '-m', 'train'], metadata: {} }),
    // Core passes this: the round-less family root, because that is the only part `find` knows.
    submissionIdFor: (candidateId) => `reprise:candidate=${candidateId}`,
    // This file is about identities, not about the metrics contract: a job that reports nothing is
    // still a job, so `collect` may call it succeeded and the assertions stay about routing.
    metricsRequired: false,
    name: 'ray-test',
  })
  return { fake, platform }
}

test('a submission id with colons reaches the cluster encoded, and routing survives it', async () => {
  const { fake, platform } = ledgerWorld()
  fake.script(ROUND_ID, { outcome: 'succeeded', metrics: { val_loss: 0.5 } })

  const submitted = await platform.submit({ submissionId: ROUND_ID, candidateId: 'r1-h1', gpuHours: 0.5, round: 2 })
  assert.equal(fake.job(submitted.job_id).submission_id, ROUND_ID, 'the fake routed the id it was given')

  // The id is a usable job reference on its own — that is exactly what a listing row with
  // `job_id: null` leaves us with (80 of 167 measured rows) — so polling *by the id* has to route.
  const polled = await platform.poll(ROUND_ID)
  assert.equal(polled.state, 'running')
  const collected = await platform.collect(ROUND_ID)
  assert.equal(collected.state, 'succeeded', 'poll and collect address the job by paths built from that id')

  // A colon is legal in a path segment but meaningless to a router that splits first: the wire has to
  // carry it percent-encoded, which is what the real dashboard needs to resolve the job.
  // `/api/jobs/` (no id) is the submit endpoint itself: the ids below are the ones built from the key.
  const jobPaths = fake.requests
    .filter((entry) => entry.path.startsWith('/api/jobs/') && entry.path !== '/api/jobs/')
    .map((entry) => entry.path)
  assert.ok(jobPaths.length > 0)
  for (const path of jobPaths) assert.ok(!path.includes(':'), `${path} must not carry a raw colon on the wire`)
  assert.match(encodeURIComponent(ROUND_ID), /%3A/)
  assert.ok(
    jobPaths.includes(`/api/jobs/${encodeURIComponent(ROUND_ID)}`),
    'the colon-bearing id reached the dashboard percent-encoded, which is what a router needs to resolve it',
  )
  assert.ok(
    fake.requests.some((entry) => entry.path === `/api/jobs/${encodeURIComponent(ROUND_ID)}`),
    'the id core submits is the id the cluster is asked about',
  )
})

test('find() resolves a job submitted with a round from the candidate id alone, through the listing', async () => {
  const { fake, platform } = ledgerWorld()
  fake.script(ROUND_ID, { outcome: 'running' })
  await platform.submit({ submissionId: ROUND_ID, candidateId: 'r1-h1', gpuHours: 0.5, round: 2 })

  // The exact round-less id was never submitted, so the adapter has to fall back to the listing —
  // where the row's submission id is the only identity there is (the live listing carries no metadata).
  const found = await platform.find('r1-h1')
  assert.notEqual(found, undefined, 'recovery finds the job it submitted before the crash')
  assert.equal(found.submission_id, ROUND_ID, 'and it reports the id the job really runs under')
  assert.equal(found.job_id, fake.job(ROUND_ID).job_id)
  assert.equal(found.state, 'running')
  assert.ok(
    fake.requests.some((entry) => entry.path === `/api/jobs/${encodeURIComponent('reprise:candidate=r1-h1')}`),
    'the exact round-less form is asked for first: one request is cheaper than the whole listing',
  )
})

test('find() prefers an exact hit over the listing, so a job listed under a round is still found by its key', async () => {
  const { fake, platform } = ledgerWorld()
  const exact = 'reprise:candidate=r9-h9'
  fake.script(exact, { outcome: 'running' })
  fake.script(ROUND_ID, { outcome: 'running' })

  const submitted = await platform.submit({ submissionId: exact, candidateId: 'r9-h9', gpuHours: 0.5, round: 1 })
  // Another round of the same candidate is listed too: the exact hit is the job the key names.
  fake.script(ROUND_ID, { outcome: 'running' })
  await platform.submit({ submissionId: ROUND_ID, candidateId: 'r9-h9', gpuHours: 0.5, round: 2 })

  const found = await platform.find('r9-h9')
  assert.equal(found.submission_id, exact)
  assert.equal(found.job_id, submitted.job_id)
})

test('the same candidate and round submit to one job; another round is another job', async () => {
  const { fake, platform } = ledgerWorld()
  fake.script(ROUND_ID, { outcome: 'running' })

  const first = await platform.submit({ submissionId: ROUND_ID, candidateId: 'r1-h1', gpuHours: 0.5, round: 2 })
  const again = await platform.submit({ submissionId: ROUND_ID, candidateId: 'r1-h1', gpuHours: 0.5, round: 2 })
  assert.equal(again.job_id, first.job_id, 'a retry of the same round is the same job')
  assert.equal(again.duplicate, true)

  const nextRound = await platform.submit({
    submissionId: 'reprise:candidate=r1-h1:round=3',
    candidateId: 'r1-h1',
    gpuHours: 0.5,
    round: 3,
  })
  assert.notEqual(nextRound.job_id, first.job_id, 'a new round is a new job, not the finished one from before')
  assert.equal(fake.jobs.size, 2)
})

// ------------------------------------------------------------------ envelopes a listing may arrive in

/** A platform whose dashboard answers one fixed document, whatever it is asked. */
function listingFrom(document, { status = 200, text } = {}) {
  return createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: async () => ({ status, headers: {}, text: text ?? JSON.stringify(document) }),
    plan: () => ({ entrypoint: ['x'], metadata: {} }),
    name: 'ray-test',
  })
}

const A_ROW = () => ({ job_id: 'j1', submission_id: 's1', status: 'RUNNING' })

/**
 * Every envelope the dashboard is known to answer `/api/v0/jobs` with, each with the reason it is on
 * the list. The first is the one measured on the live cluster; the rest are the shorthand forms the
 * `result`-unwrapping in front of a dashboard produces, and they used to come back as one junk row.
 */
const LISTING_ENVELOPES = [
  [
    'the StateApiResponse wrapper Ray 2.59 really sends',
    () => ({ result: true, msg: '', data: { result: { result: [A_ROW()], total: 1, num_after_truncation: 1, partial_failure_warning: '' } } }),
  ],
  ['the same wrapper without the outer `data`', () => ({ result: { result: [A_ROW()] } })],
  ['a bare `result` list', () => ({ result: [A_ROW()] })],
  ['a bare `jobs` list', () => ({ jobs: [A_ROW()] })],
  ['a bare array of rows', () => [A_ROW()]],
]

for (const [label, document] of LISTING_ENVELOPES) {
  test(`the listing reads rows out of ${label}`, async () => {
    const listing = await listingFrom(document()).list()
    assert.equal(listing.ok, true, `${label} is a listing this adapter recognises`)
    assert.deepEqual(listing.jobs.map((job) => job.submission_id), ['s1'], `${label}: the rows arrive unchanged`)
    assert.equal(listing.jobs[0].job_id, 'j1')
  })
}

/**
 * A 200 whose document is not a listing. These are the shapes a dashboard upgrade, a proxy and a
 * truncated body produce; every one of them used to answer `{ok: true, jobs: [<the envelope>]}`,
 * which reads downstream as "one job" or "no jobs" — the two readings an orphan sweep and the
 * `single_job` exclusivity hold must never be able to make by accident.
 */
/** The last element of each case is what the refusal must name: the shape the dashboard sent. */
const NOT_A_LISTING = [
  ['an empty object', () => ({}), /an object with no keys/],
  ['a `total` with no rows', () => ({ result: true, msg: '', data: { result: { total: 0, num_after_truncation: 0 } } }), /"data"/],
  ['rows that are not objects', () => ({ result: true, msg: '', data: { result: { result: ['j1', 'j2'] } } }), /none of them is an object/],
  ['a `result: true` with no envelope', () => ({ result: true, msg: 'ok' }), /"result", "msg"/],
]

for (const [label, document, fragment] of NOT_A_LISTING) {
  test(`a 200 carrying ${label} is "we could not read the listing", never an empty cluster`, async () => {
    const listing = await listingFrom(document()).list()
    assert.equal(listing.ok, false, `${label} must not be accepted as a listing`)
    assert.equal(listing.jobs, undefined, 'no rows may travel with a refusal')
    assert.match(listing.message, /cannot (be )?read/, 'the answer has to say the listing could not be read')
    assert.match(listing.message, fragment, 'and name what it was, so the next person can see it')
  })
}

test('a 200 with no body at all is a refusal too, and it says so', async () => {
  const listing = await listingFrom(undefined, { text: '' }).list()
  assert.equal(listing.ok, false)
  assert.match(listing.message, /cannot read/)
  assert.match(listing.message, /empty body/)
})

test('the refusal names the keys it actually got', async () => {
  const listing = await listingFrom({ detail: 'upstream connect error' }).list()
  assert.equal(listing.ok, false)
  assert.match(listing.message, /"detail"/, 'the shape, quoted: guessing from a stack trace is the slow path')
})
