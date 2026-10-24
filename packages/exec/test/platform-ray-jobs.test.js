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