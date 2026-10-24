/**
 * Guards the wire the Ray adapter speaks over (ticket 15, the first live acceptance run).
 *
 * The measured failure it must not repeat: Ray 2.59's dashboard CSRF guard
 * (`dashboard/optional_utils.py::is_browser_request`) calls a request browser traffic when its
 * `User-Agent` starts with `Mozilla` **or any `Referer` / `Origin` / `Sec-Fetch-*` header is
 * present**, and refuses everything but a `GET` with `405 '<METHOD>' method not allowed for browser
 * traffic`. Node's global `fetch` sends `sec-fetch-mode: cors` on every request, so the package `PUT`
 * and the job `POST` were both refused before the cluster read them.
 *
 * Four things are asserted here, and the first three are about the header set rather than the code
 * path, because the header set is what the server decides on:
 *
 *  1. **A plain request goes out**: our own user agent, no `Sec-Fetch-*`, no `Referer`, no `Origin`,
 *     a correct `content-length`, and the body arrives byte for byte.
 *  2. **A caller cannot reintroduce the bug**: browser-only headers supplied to the transport are
 *     dropped before they reach the socket.
 *  3. **The answer is returned, not swallowed**: a 405 is a value the adapter can name, and a dead
 *     socket is a rejection (never a hang and never an empty success).
 *  4. **The whole submission works over the real transport against a dashboard that runs the guard**
 *     — a miniature dashboard on localhost, the adapter's default transport, no fake. If `fetch`
 *     ever comes back, this is the test that fails.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createRayPlatform } from '../lib/platform-ray.js'
import { submitJob, pollJob } from '../lib/platform.js'
import { createHttpRequest, isBrowserTraffic } from '../lib/ray-http.js'
import { createFakeRay } from './platform-fixtures/ray-fake.js'
import { makeRunner } from './support.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Start an HTTP server on an ephemeral port; returns its base URL and a teardown hook. */
async function serve(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => server.close())
  return `http://127.0.0.1:${port}`
}

/** Read a request to the end and hand the handler a Buffer body. */
function readBody(request, callback) {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => callback(Buffer.concat(chunks)))
}

function echo(handler) {
  return (request, response) => {
    readBody(request, (body) => {
      const { status, payload } = handler(request, body)
      response.writeHead(status, JSON_HEADERS)
      response.end(JSON.stringify(payload))
    })
  }
}

test('the transport sends a plain request: our user agent, no browser headers, the body intact', async (t) => {
  let seen
  const base = await serve(
    t,
    echo((request, body) => {
      seen = { method: request.method, headers: request.headers, body: body.toString('utf8') }
      return { status: 200, payload: { ok: true } }
    }),
  )

  const send = createHttpRequest()
  const answer = await send({
    method: 'PUT',
    url: `${base}/api/packages/gcs/pkg.zip`,
    headers: { 'content-type': 'application/zip', accept: 'application/json' },
    body: Buffer.from('PK\u0003\u0004 payload', 'latin1'),
  })

  assert.equal(answer.status, 200)
  assert.equal(seen.method, 'PUT')
  assert.equal(seen.body, 'PK\u0003\u0004 payload')
  assert.equal(seen.headers['content-length'], String(Buffer.byteLength('PK\u0003\u0004 payload', 'latin1')))
  assert.ok(seen.headers['user-agent'], 'a request with no user agent is a request nobody can attribute')
  assert.equal(seen.headers['user-agent'].startsWith('Mozilla'), false, 'a Mozilla agent is refused as browser traffic')
  assert.equal(isBrowserTraffic(seen.headers), false, 'this is the exact predicate the dashboard guard uses')
  for (const name of ['sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'referer', 'origin']) {
    assert.equal(seen.headers[name], undefined, `${name} never goes on the wire: the guard reads its mere presence as a browser`)
  }
})

test('browser-only headers a caller supplies are dropped before they reach the socket', async (t) => {
  let seen
  const base = await serve(
    t,
    echo((request) => {
      seen = request.headers
      return { status: 200, payload: {} }
    }),
  )

  await createHttpRequest()({
    method: 'POST',
    url: `${base}/api/jobs/`,
    headers: { 'Sec-Fetch-Mode': 'cors', Referer: 'http://example.invalid/', Origin: 'http://example.invalid', 'user-agent': 'Mozilla/5.0' },
    body: Buffer.from('{}'),
  })

  assert.equal(seen['sec-fetch-mode'], undefined)
  assert.equal(seen.referer, undefined)
  assert.equal(seen.origin, undefined)
  assert.equal(seen['user-agent'].startsWith('Mozilla'), false, 'the transport owns the agent: it is how the guard decides')
})

test('a 405 comes back as an answer, and a dead socket rejects instead of hanging or answering empty', async (t) => {
  const base = await serve(t, (request, response) => {
    response.writeHead(405, JSON_HEADERS)
    response.end(JSON.stringify({ detail: `'${request.method}' method not allowed for browser traffic.` }))
  })
  const send = createHttpRequest({ timeout_ms: 2_000 })

  const answer = await send({ method: 'PUT', url: `${base}/api/packages/gcs/x.zip`, body: Buffer.from('x') })
  assert.equal(answer.status, 405)
  assert.match(answer.text, /method not allowed for browser traffic/, 'the body is what lets the adapter name the failure')

  // A closed port: the OS refuses, which must reject rather than resolve as "no answer".
  const dead = createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))
  await assert.rejects(
    () => send({ method: 'GET', url: `http://127.0.0.1:${deadPort}/api/jobs/` }),
    /ECONNREFUSED|connect|socket/i,
    'a transport failure has to reach the caller as a rejection',
  )
})

test('a whole submission goes through the real transport to a dashboard that runs the guard', async (t) => {
  // The miniature dashboard: the same guard, the package store, and a job that succeeds once.
  const packages = new Map()
  const jobs = new Map()
  const base = await serve(t, (request, response) => {
    const browserish = Object.entries(request.headers).some(
      ([name, value]) =>
        name.toLowerCase() === 'referer' ||
        name.toLowerCase() === 'origin' ||
        name.toLowerCase().startsWith('sec-fetch-') ||
        (name.toLowerCase() === 'user-agent' && String(value).startsWith('Mozilla')),
    )
    if (request.method !== 'GET' && browserish) {
      response.writeHead(405, JSON_HEADERS)
      response.end(JSON.stringify({ detail: `'${request.method}' method not allowed for browser traffic.` }))
      return
    }
    const url = new URL(request.url, base)
    readBody(request, (body) => {
      const reply = (status, payload) => {
        response.writeHead(status, JSON_HEADERS)
        response.end(JSON.stringify(payload))
      }
      const packageMatch = url.pathname.match(/^\/api\/packages\/gcs\/([^/]+)$/)
      if (request.method === 'PUT' && packageMatch) {
        packages.set(packageMatch[1], body)
        return reply(200, { [packageMatch[1]]: `gcs://${packageMatch[1]}` })
      }
      if (request.method === 'POST' && url.pathname === '/api/jobs/') {
        const submitted = JSON.parse(body.toString('utf8') || '{}')
        const name = String(submitted.runtime_env?.working_dir ?? '').replace('gcs://', '')
        if (!packages.has(name)) return reply(400, { detail: `package ${name} was never uploaded` })
        if ([...jobs.values()].some((job) => job.submission_id === submitted.submission_id)) {
          return reply(400, { detail: `Job with submission_id ${submitted.submission_id} already exists` })
        }
        const job = { job_id: `job-${jobs.size + 1}`, submission_id: submitted.submission_id, polls: 0 }
        jobs.set(job.job_id, job)
        return reply(200, { job_id: job.job_id, submission_id: job.submission_id })
      }
      const logsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/logs$/)
      if (request.method === 'GET' && logsMatch) {
        return reply(200, { logs: 'training…\nREPRISE_METRICS {"metrics":{"auc":0.641}}\n' })
      }
      const detailsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/)
      if (request.method === 'GET' && detailsMatch) {
        const job = jobs.get(detailsMatch[1]) ?? [...jobs.values()].find((candidate) => candidate.submission_id === detailsMatch[1])
        if (job === undefined) return reply(404, { detail: `Job '${detailsMatch[1]}' does not exist` })
        job.polls += 1
        const status = job.polls > 1 ? 'SUCCEEDED' : 'RUNNING'
        return reply(200, { job_id: job.job_id, submission_id: job.submission_id, status, start_time: 1_700_000_000_000, end_time: null })
      }
      return reply(500, { detail: `unexpected ${request.method} ${url.pathname}` })
    })
  })

  const runner = makeRunner(t)
  writeFileSync(join(runner.worktreeDir, 'config.py'), 'learning_rate = 2e-3\n')
  mkdirSync(join(runner.worktreeDir, 'model'))
  writeFileSync(join(runner.worktreeDir, 'model', 'head.py'), '# a brand new module\n')

  const platform = createRayPlatform({
    baseUrl: base, // no injected transport: this is the real node:http wire
    plan: ({ candidateId }) => ({
      entrypoint: ['python3', 'train.py'],
      worktreeDir: runner.worktreeDir,
      baseRef: runner.base,
      metadata: { candidate_id: candidateId },
      numGpus: 1,
    }),
  })

  const submitted = await submitJob(platform, { submissionId: 'r1-live', candidateId: 'r1-live', gpuHours: 0.1 })
  assert.equal(packages.size, 1, 'the package reached the dashboard over the real transport')
  assert.deepEqual(submitted.packaging.untracked, ['model/head.py'])

  let last
  for (let index = 0; index < 20; index += 1) {
    last = await pollJob(platform, submitted.job_id)
    if (last.state === 'succeeded') break
  }
  assert.equal(last.state, 'succeeded', 'the job the guard would have refused is now submitted, polled and read')
  assert.deepEqual(last.metrics, { auc: 0.641 })
})

test('a dashboard that refuses a write as browser traffic is a named failure, not a lost job', async () => {
  // A transport that behaves like undici: it adds `Sec-Fetch-Mode` to everything it sends. The fake
  // dashboard runs the guard, so every write is answered 405 — the adapter must say so.
  const fake = createFakeRay()
  const browserish = async (request) =>
    fake.request({ ...request, headers: { ...(request.headers ?? {}), 'sec-fetch-mode': 'cors' } })

  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: browserish,
    plan: () => ({ entrypoint: ['python3', 'train.py'], metadata: {} }),
  })

  const error = await submitJob(platform, { submissionId: 'r1-guard', candidateId: 'r1-guard' }).then(
    () => undefined,
    (failure) => failure,
  )

  assert.ok(error, 'a refused write must not resolve: a resolved submit with no job is a lost candidate')
  assert.match(error.message, /405/)
  assert.match(error.message, /browser traffic/, 'the message has to name the cause; the first live run lost half a day to this body text')
  assert.equal(fake.jobs.size, 0, 'nothing was created, so the caller may retry once the transport is fixed')
})