/**
 * Guards the delivery half of ticket 15: the candidate's worktree becomes a package, the package
 * becomes the job's working directory, and the diff the runner's git reports is checked on both sides
 * of the upload.
 *
 * The Ray-specific conformance suite (`platform.test.js`) is deliberately medium-agnostic — it never
 * sees a package. Everything that only exists because the measured cluster has **no shared filesystem
 * and no internet** is here, asserted against the fake's recorded requests rather than against the
 * implementation's own claims:
 *
 *  1. **`PUT /api/packages/gcs/<name>.zip` then `POST /api/jobs/` with `runtime_env.working_dir =
 *     "gcs://<name>.zip"`.** Exactly those two requests, in that order, and the uploaded bytes are a
 *     real archive whose `config.py` is the one the candidate edited. A job submitted without its
 *     package is refused by the fake, the way the head refuses it for real.
 *  2. **No laptop path travels.** The submit body names nothing under the worktree, and a packaged
 *     job is not handed a `REPRISE_METRICS_PATH` it could not open — metrics come back on the driver
 *     log, which is the only channel the cluster measured.
 *  3. **The entrypoint checks the unpack before it trains.** `python3 .reprise/verify_inventory.py &&
 *     <training>`: the `&&` is the difference between "a number from the candidate's tree" and "a
 *     number from whatever arrived".
 *  4. **A tree that cannot be shipped stops the submission with a named conclusion.** Over the size
 *     limit, or a path the archive cannot carry, is `{conclusion, message}` thrown before any upload
 *     and before any job — never a forced run.
 *  5. **One `submission_id` is one package and one job.** Proved by counting requests, not by reading
 *     flags: a second submit writes nothing.
 *  6. **The node's own verdict is read.** When the shipped checker says the unpacked tree diverges,
 *     the observation is a `conflict` — the fact plane disagreeing with itself — and never a success
 *     with a metric attached.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PackageRefusedError } from '../lib/archive.js'
import { pollJob, submitJob } from '../lib/platform.js'
import { createRayPlatform, parseInventoryMarker } from '../lib/platform-ray.js'
import { readZip } from '../lib/zip.js'
import { createFakeRay } from './platform-fixtures/ray-fake.js'
import { makeRunner } from './support.js'

const POST_JOBS = (entry) => entry.method === 'POST' && entry.path === '/api/jobs/'
const PUT_PACKAGE = (entry) => entry.method === 'PUT' && entry.path.startsWith('/api/packages/gcs/')

/** A candidate that changed a tracked configuration file and added a module — the normal shape. */
function candidateWorktree(t) {
  const runner = makeRunner(t)
  writeFileSync(join(runner.worktreeDir, 'config.py'), 'learning_rate = 2e-3\n')
  mkdirSync(join(runner.worktreeDir, 'model'))
  writeFileSync(join(runner.worktreeDir, 'model', 'head.py'), '# a brand new module\n')
  return runner
}

/** A fake cluster plus a platform whose plan names the candidate's worktree. */
function packagedWorld(t, { packaging = {}, entrypoint, worktreeDir, metricsDir } = {}) {
  const runner = candidateWorktree(t)
  const fake = createFakeRay()
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: fake.request,
    metricsDir: metricsDir ?? join(runner.root, 'metrics'),
    plan: ({ candidateId }) => ({
      entrypoint: entrypoint ?? ['python3', 'train.py', '--config', 'config.py'],
      worktreeDir: worktreeDir ?? runner.worktreeDir,
      baseRef: runner.base,
      metadata: { candidate_id: candidateId },
      numGpus: 1,
    }),
    packaging,
    name: 'ray-package',
  })
  return { runner, fake, platform }
}

async function pollUntilTerminal(platform, jobId, { tries = 200, delayMs = 5 } = {}) {
  let last
  for (let index = 0; index < tries; index += 1) {
    last = await pollJob(platform, jobId)
    if (['succeeded', 'failed', 'lost'].includes(last.state)) return last
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`job ${jobId} never finished (last: ${last?.state})`)
}

test('the candidate tree is uploaded as a package and the job is told to run inside it', async (t) => {
  const { runner, fake, platform } = packagedWorld(t)
  fake.script('r1-h2', { outcome: 'succeeded', logs: 'training…\ndone\nREPRISE_METRICS {"metrics":{"auc":0.71}}\n' })

  const submitted = await submitJob(platform, { submissionId: 'r1-h2', candidateId: 'r1-h2', gpuHours: 2 })
  assert.equal(typeof submitted.job_id, 'string')

  const puts = fake.requests.filter(PUT_PACKAGE)
  assert.equal(puts.length, 1, 'exactly one package leaves: code travels with the job, and it travels once')
  const name = puts[0].path.slice('/api/packages/gcs/'.length)
  assert.match(name, /^reprise-r1-h2-[0-9a-f]{12}\.zip$/, 'the package name is flat, content-addressed and ends in .zip')
  assert.ok(fake.packages.has(name), 'the cluster must now hold the package, or the job below would be running nothing')

  // What the node receives: the candidate's configuration, the new module, and the manifest that
  // says so. Read from the bytes the fake stored, not from the packer's return value.
  const unpacked = new Map(readZip(fake.packages.get(name)).map((entry) => [entry.path, entry.content.toString('utf8')]))
  assert.equal(unpacked.get('config.py'), 'learning_rate = 2e-3\n', 'the job must read the configuration the candidate changed')
  assert.equal(unpacked.get('model/head.py'), '# a brand new module\n', 'a candidate that only adds a module is the common case')
  const manifest = JSON.parse(unpacked.get('.reprise/archive.json'))
  assert.deepEqual(manifest.changed, ['config.py'])
  assert.deepEqual(manifest.untracked, ['model/head.py'], 'the manifest names every untracked path the runner\'s git knows about')
  assert.equal(manifest.base_ref, runner.base)

  const post = fake.requests.find(POST_JOBS)
  const body = JSON.parse(post.body)
  assert.equal(body.runtime_env.working_dir, `gcs://${name}`, 'the measured inbound channel: working_dir pointing at the uploaded package')
  assert.equal(body.metadata.package, name, 'the ledger and the cluster must agree on which package this job runs')
  assert.equal(
    JSON.stringify(body).includes(runner.worktreeDir),
    false,
    'no laptop path may reach the cluster: the node has no such directory',
  )
  assert.equal(
    body.runtime_env.env_vars?.REPRISE_METRICS_PATH,
    undefined,
    'a packaged job cannot write to a laptop path; telling it to try is how a healthy run becomes a data failure',
  )
  assert.match(
    String(body.entrypoint),
    /^python3 \.reprise\/verify_inventory\.py && python3 train\.py --config config\.py$/,
    'the unpack is checked before training starts, and the training command survived the wrapper unchanged',
  )

  assert.deepEqual(submitted.packaging.changed, ['config.py'])
  assert.deepEqual(submitted.packaging.untracked, ['model/head.py'])
  assert.equal(submitted.packaging.uri, `gcs://${name}`)
  assert.equal(submitted.packaging.verified_by, 'node-inventory-check')

  const done = await pollUntilTerminal(platform, submitted.job_id)
  assert.equal(done.state, 'succeeded')
  assert.deepEqual(done.metrics, { auc: 0.71 }, 'the metric still comes back through the driver log')
})

test('the node\'s verdict on a divergent unpack is a conflict, never a number', async (t) => {
  const { fake, platform } = packagedWorld(t)
  fake.script('r1-h3', {
    outcome: 'succeeded',
    logs:
      'REPRISE_INVENTORY {"altered":[],"checked":3,"missing":["model/head.py"],"ok":false,"untracked":["model/head.py"]}\n' +
      'reprise: refusing to train on it\n',
  })

  const submitted = await submitJob(platform, { submissionId: 'r1-h3', candidateId: 'r1-h3', gpuHours: 2 })
  const observed = await pollUntilTerminal(platform, submitted.job_id)

  assert.equal(observed.state, 'failed', 'a job whose tree diverged cannot be a success, even if it exits 0')
  assert.equal(observed.conflict, true, 'two accounts of one tree disagreeing is the four-state conflict, not a candidate defect')
  assert.equal(observed.error_class, 'data', 'the shipped code is the job\'s input data; the class stays inside the closed vocabulary')
  assert.equal(observed.error_detail.source, 'node_inventory')
  assert.deepEqual(observed.error_detail.missing, ['model/head.py'], 'the finding names the path, so a human can act on it')
  assert.equal(observed.metrics, undefined, 'a divergent tree must never be handed back a metric')
})

test('an archive over the limit is a named conclusion, and nothing is uploaded or submitted', async (t) => {
  const { fake, platform } = packagedWorld(t, { packaging: { maxBytes: 16 } })

  const error = await submitJob(platform, { submissionId: 'r1-big', candidateId: 'r1-big', gpuHours: 2 }).then(
    () => undefined,
    (failure) => failure,
  )

  assert.ok(error instanceof PackageRefusedError, `expected a named refusal, got ${error}`)
  assert.equal(error.conclusion, 'archive_too_large')
  assert.match(error.message, /over the 16-byte job-package limit/)
  assert.ok(error.largest.length > 0, 'the conclusion names the files that made the tree too big')
  assert.equal(error.retryable, false, 'waiting does not make a tree smaller: the caller must not retry this as if the cluster were down')
  assert.equal(fake.requests.filter(PUT_PACKAGE).length, 0, 'nothing is uploaded')
  assert.equal(fake.requests.filter(POST_JOBS).length, 0, 'nothing is submitted: the conclusion replaces the run')
})

test('a change the archive cannot carry is a conflict that names the path, not a silent drop', async (t) => {
  const runner = candidateWorktree(t)
  symlinkSync('config.py', join(runner.worktreeDir, 'config-link.py'))
  const fake = createFakeRay()
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: fake.request,
    plan: ({ candidateId }) => ({
      entrypoint: ['python3', 'train.py'],
      worktreeDir: runner.worktreeDir,
      baseRef: runner.base,
      metadata: { candidate_id: candidateId },
    }),
  })

  const error = await submitJob(platform, { submissionId: 'r1-link', candidateId: 'r1-link' }).then(
    () => undefined,
    (failure) => failure,
  )

  assert.equal(error?.conclusion, 'inventory_conflict')
  assert.deepEqual(error.conflict, ['config-link.py'])
  assert.equal(fake.requests.filter(POST_JOBS).length, 0)
})

test('one submission_id is one package and one job, however many times it is submitted', async (t) => {
  const { fake, platform } = packagedWorld(t)
  fake.script('r1-h4', { outcome: 'succeeded', logs: 'REPRISE_METRICS {"metrics":{"auc":0.5}}\n' })
  const request = { submissionId: 'r1-h4', candidateId: 'r1-h4', gpuHours: 2 }

  const first = await submitJob(platform, request)
  const second = await submitJob(platform, request)

  assert.equal(second.duplicate, true)
  assert.equal(second.job_id, first.job_id, 'the same submission id is the same job — a second job is a second GPU bill')
  assert.equal(fake.jobs.size, 1)
  assert.equal(fake.requests.filter(POST_JOBS).length, 1, 'the second submit does not write a job')
  assert.equal(fake.requests.filter(PUT_PACKAGE).length, 1, 'and does not re-upload the tree it already shipped')
  assert.equal(fake.packages.size, 1)
})

test('a plan that names its own working_dir is refused: the adapter owns what the job runs in', async (t) => {
  const runner = candidateWorktree(t)
  const fake = createFakeRay()
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: fake.request,
    plan: () => ({
      entrypoint: ['python3', 'train.py'],
      worktreeDir: runner.worktreeDir,
      baseRef: runner.base,
      runtimeEnv: { working_dir: '/worktrees/round_0001/cand' },
    }),
  })

  await assert.rejects(
    () => submitJob(platform, { submissionId: 'r1-cwd', candidateId: 'r1-cwd' }),
    /the adapter owns it/,
    'two claims about where the job runs is how a job trains on a tree nobody packed',
  )
  assert.equal(fake.requests.filter(POST_JOBS).length, 0)
})

test('a plan that names no worktree ships nothing — the shared-code deployment keeps working', async (t) => {
  const runner = candidateWorktree(t)
  const metricsDir = join(runner.root, 'metrics')
  mkdirSync(metricsDir, { recursive: true })
  const fake = createFakeRay({ onSucceeded: (job) => writeFileSync(join(metricsDir, `${job.submission_id}.metrics.json`), '{"metrics":{"auc":0.6}}') })
  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: fake.request,
    metricsDir,
    plan: () => ({ entrypoint: ['python3', 'train.py'], metadata: {} }),
  })
  fake.script('r1-shared', { outcome: 'succeeded', metrics: { auc: 0.6 } })

  const submitted = await submitJob(platform, { submissionId: 'r1-shared', candidateId: 'r1-shared' })

  assert.equal(fake.requests.filter(PUT_PACKAGE).length, 0, 'nothing to ship, nothing uploaded')
  assert.equal(submitted.packaging, undefined)
  const body = JSON.parse(fake.requests.find(POST_JOBS).body)
  assert.equal(body.runtime_env.working_dir, undefined)
  assert.equal(body.entrypoint.join(' '), 'python3 train.py', 'no verifier is prepended when no package travels')
  assert.equal((await pollUntilTerminal(platform, submitted.job_id)).state, 'succeeded')
})

test('the verifier the package carries refuses a tree that changed after packing', async (t) => {
  // Runs the shipped script where a python3 exists — the only interpreter the measured cluster
  // guarantees. On a machine without one the script's contract is exercised by the JS reader above
  // (`compareInventories`), which is the same comparison on this side of the boundary.
  const available = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0
  if (!available) {
    t.skip('no python3 on this machine; the node-side check needs the interpreter the cluster has')
    return
  }

  const { fake, platform } = packagedWorld(t)
  fake.script('r1-v', { outcome: 'succeeded', logs: 'REPRISE_METRICS {"metrics":{"auc":0.4}}\n' })
  await submitJob(platform, { submissionId: 'r1-v', candidateId: 'r1-v' })
  const name = fake.requests.find(PUT_PACKAGE).path.slice('/api/packages/gcs/'.length)

  const root = mkdtempSync(join(tmpdir(), 'reprise-node-'))
  for (const entry of readZip(fake.packages.get(name))) {
    const target = join(root, entry.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, entry.content, { mode: entry.executable ? 0o755 : 0o644 })
  }
  const run = () => spawnSync('python3', ['.reprise/verify_inventory.py'], { cwd: root, encoding: 'utf8' })

  const clean = run()
  assert.equal(clean.status, 0)
  assert.equal(parseInventoryMarker(clean.stdout)?.ok, true, 'the marker line is what the adapter reads back')

  writeFileSync(join(root, 'model', 'head.py'), '# edited after packing\n')
  const altered = run()
  assert.equal(altered.status, 1, 'a changed tree must fail the check, or the training runs on it')
  assert.deepEqual(parseInventoryMarker(altered.stdout)?.altered, ['model/head.py'])
  assert.equal(readFileSync(join(root, 'config.py'), 'utf8'), 'learning_rate = 2e-3\n')
})