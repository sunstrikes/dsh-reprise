/**
 * Guards ticket 16's half of the Ray adapter: the two things the job ledger needs from the cluster.
 *
 *  1. **The submission carries the round**, because that is what the plan turns into the job's marker
 *     (`reprise:candidate=<id>:round=<n>`). Without it the marker names half a job and two attempts
 *     of one candidate are indistinguishable in the listing.
 *  2. **The adapter can read the cluster's job listing** (`GET /api/v0/jobs`), tolerantly: rows with
 *     `job_id: null` are kept (measured: 42 of 129 rows on the live dashboard had one), and a listing
 *     it could not read answers `ok: false` rather than an empty list — "we could not look" and
 *     "there are none" are the two answers a cleanup acts differently on. **Known envelope, or a
 *     named refusal**: a 200 whose document is not one of the envelopes below is `ok: false` with the
 *     shape in the message. There is no "some object, therefore one job" fallback, because that
 *     answer is indistinguishable from a cluster with nothing of ours running — and the `single_job`
 *     GPU-exclusivity hold reads exactly that answer to decide whether it may dispatch.
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