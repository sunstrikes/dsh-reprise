/**
 * Guards the local executor beyond what the shared conformance suite can see (ticket 08, "五分钟路径
 * 的一半" + spec "执行面": `cwd` 必须写死成候选 worktree).
 *
 * Three things are only true of *this* implementation and would otherwise be asserted nowhere:
 *
 *  1. a real command, computing a real number from synthetic input, on a machine with no cluster
 *     and no GPU — the thing a new user is promised in the first five minutes;
 *  2. the outcome survives our own process: a second platform instance over the same directory picks
 *     the job up, which is what "restart does not re-run the candidate" means locally;
 *  3. `cwd` is the plan's directory, not the framework's. The predecessor ran every harness without
 *     `cwd`, so "bound to the worktree" was a prompt-level promise; here it is a process fact.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cancelJob, collectJob, findJob, pollJob, submitJob } from '../lib/platform.js'
import { createLocalPlatform } from '../lib/platform-local.js'

const TERMINAL = ['succeeded', 'failed', 'lost']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'reprise-local-'))
  const rootDir = join(root, 'jobs')
  mkdirSync(rootDir, { recursive: true })
  return { root, rootDir }
}

function scriptFile(dir, name, source) {
  const path = join(dir, `${name}.mjs`)
  writeFileSync(path, source)
  return path
}

async function pollUntilTerminal(platform, jobId, { tries = 400, delayMs = 10 } = {}) {
  let last
  for (let index = 0; index < tries; index += 1) {
    last = await pollJob(platform, jobId)
    if (TERMINAL.includes(last.state)) return last
    await sleep(delayMs)
  }
  throw new Error(`job ${jobId} never finished (last: ${last?.state})`)
}

test('a synthetic metric comes out of a real process with no cluster and no GPU', async () => {
  const { root, rootDir } = workspace()
  const path = scriptFile(
    root,
    'proxy',
    `import { writeFileSync } from 'node:fs'
// The synthetic input is the point: eight deterministic samples, no dataset, no CUDA, no cluster.
const samples = Array.from({ length: 8 }, (_, index) => 0.5 + index * 0.01)
const valLoss = samples.reduce((sum, value) => sum + value, 0) / samples.length
writeFileSync(process.env.REPRISE_METRICS_PATH, JSON.stringify({
  metrics: { val_loss: valLoss, params: 128 * 128 * 4, gpu_hours_used: 0 },
}))
`,
  )

  const started = Date.now()
  const platform = createLocalPlatform({ rootDir, plan: () => ({ command: [process.execPath, path], cwd: root }) })
  const submitted = await submitJob(platform, { submissionId: 'cand_smoke', candidateId: 'cand_smoke', gpuHours: 0 })
  const done = await pollUntilTerminal(platform, submitted.job_id)
  const collected = await collectJob(platform, submitted.job_id)
  const elapsed = Date.now() - started

  assert.equal(done.state, 'succeeded')
  assert.equal(collected.metrics.val_loss, 0.535, 'the number must be the one the process computed')
  assert.equal(collected.metrics.params, 65536)
  assert.equal(collected.metrics.gpu_hours_used, 0, 'the smoke path must not need a GPU hour to be believable')
  assert.ok(elapsed < 5_000, `the first-five-minutes path must stay seconds-scale, took ${elapsed}ms`)
  assert.ok(
    collected.artifacts.some((artifact) => artifact.name === 'driver.log'),
    'the driver log is an artifact: "why did this run say 0.535" must be answerable from the job directory',
  )
})

test('a second platform instance adopts a running job instead of restarting it', async () => {
  const { root, rootDir } = workspace()
  const path = scriptFile(
    root,
    'slow',
    `import { writeFileSync } from 'node:fs'
await new Promise((resolve) => setTimeout(resolve, 250))
writeFileSync(process.env.REPRISE_METRICS_PATH, JSON.stringify({ metrics: { val_loss: 0.42 } }))
`,
  )

  // Instance A is the process that dies right after submitting — the crash window the whole recovery
  // story is built on.
  const before = createLocalPlatform({ rootDir, plan: () => ({ command: [process.execPath, path], cwd: root }) })
  const submitted = await submitJob(before, { submissionId: 'cand_slow', candidateId: 'cand_slow', gpuHours: 0.1 })

  // Instance B has no memory of anything: it reads the job directory the way a restarted harness does.
  const after = createLocalPlatform({ rootDir, plan: () => ({}) })

  const adopted = await findJob(after, 'cand_slow')
  assert.equal(adopted.job_id, submitted.job_id, 'recovery must find the job by candidate, not submit a new one')
  assert.equal(adopted.state, 'running', 'a job that is still running must be adoptable, not re-run')

  const running = await pollJob(after, submitted.job_id)
  assert.equal(running.state, 'running')

  const done = await pollUntilTerminal(after, submitted.job_id)
  assert.equal(done.state, 'succeeded')
  assert.equal(done.metrics.val_loss, 0.42, 'the adopted view must see the metrics the job wrote after the restart')
})

test('cancel really kills the process, it does not just relabel it', async () => {
  const { root, rootDir } = workspace()
  const path = scriptFile(root, 'hang', `await new Promise((resolve) => setTimeout(resolve, 60_000))\n`)
  const platform = createLocalPlatform({ rootDir, plan: () => ({ command: [process.execPath, path], cwd: root }) })
  const submitted = await submitJob(platform, { submissionId: 'cand_hang', candidateId: 'cand_hang', gpuHours: 0.1 })

  const record = JSON.parse(readFileSync(join(rootDir, submitted.job_id, 'job.json'), 'utf8'))
  assert.equal(platform.poll(submitted.job_id).state, 'running')

  const canceled = await cancelJob(platform, submitted.job_id)
  assert.equal(canceled.accepted, true)

  const after = platform.poll(submitted.job_id)
  assert.equal(after.state, 'failed')
  assert.equal(after.error_class, 'canceled')
  assert.throws(() => process.kill(record.pid, 0), /ESRCH/, 'stop means the subprocess is gone, not that our table says so')
})

test('a job that exits 0 without a measurement is a data failure, not a success', async () => {
  const { root, rootDir } = workspace()
  const path = scriptFile(root, 'quiet', `process.stdout.write('trained, forgot to measure\\n')\n`)
  const platform = createLocalPlatform({ rootDir, plan: () => ({ command: [process.execPath, path], cwd: root }) })
  const submitted = await submitJob(platform, { submissionId: 'cand_quiet', candidateId: 'cand_quiet', gpuHours: 0.1 })

  const done = await pollUntilTerminal(platform, submitted.job_id)
  assert.equal(done.state, 'failed', 'an empty metric set would become a candidate score')
  assert.equal(done.error_class, 'data', 'the job broke its side of the metrics contract, not its code')
  assert.match(done.error_detail.message, /no metrics JSON/)
})

test('a non-zero exit wins over a metrics file the job managed to write', async () => {
  const { root, rootDir } = workspace()
  const path = scriptFile(
    root,
    'lichecked',
    `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.REPRISE_METRICS_PATH, JSON.stringify({ metrics: { val_loss: 0.1 } }))
process.stderr.write('RuntimeError: diverged at step 900\\n')
process.exit(3)
`,
  )
  const platform = createLocalPlatform({ rootDir, plan: () => ({ command: [process.execPath, path], cwd: root }) })
  const submitted = await submitJob(platform, { submissionId: 'cand_exit3', candidateId: 'cand_exit3', gpuHours: 0.1 })

  const done = await pollUntilTerminal(platform, submitted.job_id)
  assert.equal(done.state, 'failed', 'a partial metric from a crashed run is not a result')
  assert.equal(done.metrics, undefined)
  assert.equal(done.error_class, 'code')
  assert.equal(done.error_detail.exit_code, 3)
})

test('the job runs in the plan cwd — the worktree, not the framework', async () => {
  const { root, rootDir } = workspace()
  const candidateTree = join(root, 'worktrees', 'round_0001', 'cand_01')
  mkdirSync(candidateTree, { recursive: true })
  // Compare resolved paths: /tmp is a symlink on macOS, and a test that only passes on one machine
  // is worse than no test.
  const expected = realpathSync(candidateTree)
  const path = scriptFile(
    root,
    'pwd',
    `import { writeFileSync } from 'node:fs'
const ok = process.cwd() === process.env.EXPECTED_CWD ? 1 : 0
writeFileSync(process.env.REPRISE_METRICS_PATH, JSON.stringify({ metrics: { cwd_is_candidate_tree: ok } }))
`,
  )
  const platform = createLocalPlatform({
    rootDir,
    plan: () => ({ command: [process.execPath, path], cwd: candidateTree, env: { EXPECTED_CWD: expected } }),
  })
  const submitted = await submitJob(platform, { submissionId: 'cand_pwd', candidateId: 'cand_pwd', gpuHours: 0 })

  const done = await pollUntilTerminal(platform, submitted.job_id)
  assert.equal(done.state, 'succeeded')
  assert.equal(
    done.metrics.cwd_is_candidate_tree,
    1,
    'a job that runs in the framework cwd edits the wrong tree; the predecessor only promised this in a prompt',
  )
})

test('a plan with nothing to run throws instead of recording a phantom job', () => {
  const { rootDir } = workspace()
  const platform = createLocalPlatform({ rootDir, plan: () => ({}) })
  assert.throws(
    () => platform.submit({ submissionId: 'cand_empty', candidateId: 'cand_empty', gpuHours: 0.1 }),
    /produced no command/,
  )
  assert.equal(platform.find('cand_empty'), undefined, 'a failed submit must leave no job behind to adopt')
})
test('two submission ids that slug the same still get distinct jobs', async () => {
  const { root, rootDir } = workspace()
  const path = scriptFile(
    root,
    'quick',
    `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.REPRISE_METRICS_PATH, JSON.stringify({ metrics: { val_loss: 0.5 } }))
`,
  )
  const platform = createLocalPlatform({ rootDir, plan: () => ({ command: [process.execPath, path], cwd: root }) })

  // `/` and `:` both slug to `-`. A collision here would answer "duplicate" for a *different*
  // candidate's job, i.e. hand the loop another candidate's result.
  const slashed = await submitJob(platform, { submissionId: 'cand/1', candidateId: 'cand_slash', gpuHours: 0 })
  const coloned = await submitJob(platform, { submissionId: 'cand:1', candidateId: 'cand_colon', gpuHours: 0 })

  assert.notEqual(slashed.job_id, coloned.job_id)
  assert.equal(coloned.duplicate, undefined, 'a different submission id is not a duplicate')
  assert.equal((await pollUntilTerminal(platform, slashed.job_id)).state, 'succeeded')
  assert.equal((await pollUntilTerminal(platform, coloned.job_id)).state, 'succeeded')
})
