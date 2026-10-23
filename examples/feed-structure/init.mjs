#!/usr/bin/env node
/**
 * Step 2 of the five-minute path: build a workspace you can run.
 *
 * Three things happen, and all three are real:
 *
 *   1. **A model repository.** `examples/feed-structure/lab/` is copied into the workspace and
 *      committed, because that is what a candidate worktree has to branch from. In your own project
 *      this is *your* training repository; here it is a toy one so the copy is honest and readable.
 *   2. **A frozen priors manifest.** What the run started from, as sha256 over the committed files —
 *      a fact, not a memory. The loop never re-derives it.
 *   3. **A measured baseline.** `metric.mjs` is submitted through the real local executor
 *      (`packages/exec/lib/platform-local.js`): a supervisor process, a real exit code, a real
 *      metrics file. If the baseline were typed in by hand, every later comparison would be against
 *      a number nobody measured.
 *
 * Re-running rebuilds all three — but only into a workspace with no fact plane yet, so a run you
 * care about cannot be silently overwritten.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectJob, pollJob, submitJob } from '../../packages/exec/lib/platform.js'
import { createLocalPlatform } from '../../packages/exec/lib/platform-local.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAB = join(HERE, 'lab')
const METRIC = 'auc'
const TERMINAL = ['succeeded', 'failed', 'lost']

const say = (line = '') => process.stdout.write(`${line}\n`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(result.stderr ?? result.error?.message ?? '').trim()}`)
  }
  return result.stdout.trim()
}

async function measureBaseline(workspace) {
  const platform = createLocalPlatform({
    rootDir: join(workspace, 'baseline-job'),
    // The command runs *inside the model repository*: the baseline is the untouched tree.
    plan: () => ({ command: ['node', 'metric.mjs'], cwd: join(workspace, 'model-repo') }),
  })

  const submittedAt = Date.now()
  const submitted = await submitJob(platform, { submissionId: 'baseline', candidateId: 'baseline', gpuHours: 0 })
  let polled
  for (let attempt = 0; attempt < 400; attempt += 1) {
    polled = await pollJob(platform, submitted.job_id)
    if (TERMINAL.includes(polled.state)) break
    if (Date.now() - submittedAt > 120_000) {
      await platform.cancel(submitted.job_id)
      throw new Error('the baseline job did not finish within 120s')
    }
    await sleep(25)
  }
  if (polled?.state !== 'succeeded') {
    const collected = await collectJob(platform, submitted.job_id).catch(() => undefined)
    throw new Error(
      `the baseline job ended ${polled?.state} (${polled?.error_class ?? 'no error class'})` +
        `${collected === undefined ? '' : `; artifacts: ${JSON.stringify(collected.artifacts)}`}`,
    )
  }

  const value = polled.metrics?.[METRIC]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`the baseline job reported no ${METRIC}: ${JSON.stringify(polled.metrics ?? null)}`)
  }
  const collected = await collectJob(platform, submitted.job_id).catch(() => ({ artifacts: [] }))
  return { value, metrics: polled.metrics, job_id: submitted.job_id, artifacts: collected.artifacts ?? [] }
}

function freezeManifest(workspace, repoDir) {
  const files = {}
  for (const path of git(['ls-files'], repoDir).split('\n').filter(Boolean)) files[path] = sha256(join(repoDir, path))
  const manifest = {
    frozen_at_ms: Date.now(),
    base_commit: git(['rev-parse', 'HEAD'], repoDir),
    files,
    inputs: {
      'priors.json': sha256(join(HERE, 'priors.json')),
      'hypotheses.json': sha256(join(HERE, 'hypotheses.json')),
      'metric-contract.json': sha256(join(HERE, 'metric-contract.json')),
    },
  }
  const path = join(workspace, 'priors.manifest.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path, files: Object.keys(files).length, baseCommit: manifest.base_commit }
}

async function main() {
  const workspace = resolve(process.argv[2] ?? '.workspace/feed')
  const forbidden = ['--force', '-f'].includes(process.argv[3])
  if (existsSync(join(workspace, 'workspace.db')) && !forbidden) {
    say(`refusing: ${workspace} already holds a fact plane (workspace.db).`)
    say('  Pick another directory, delete that one, or re-run with --force to rebuild it from scratch.')
    return 2
  }

  mkdirSync(workspace, { recursive: true })
  const repoDir = join(workspace, 'model-repo')
  rmSync(repoDir, { recursive: true, force: true })
  cpSync(LAB, repoDir, { recursive: true })

  git(['init', '-q', '-b', 'main'], repoDir)
  git(['add', '-A'], repoDir)
  git(['-c', 'user.name=feed-structure example', '-c', 'user.email=example@localhost', 'commit', '-q', '-m', 'feed-structure: baseline model'], repoDir)

  const manifest = freezeManifest(workspace, repoDir)
  say(`workspace   ${workspace}`)
  say(`model repo  ${repoDir}  (${manifest.baseCommit.slice(0, 12)}, ${manifest.files} file(s))`)
  say(`frozen      ${manifest.path}`)

  const baseline = await measureBaseline(workspace)
  const baselinePath = join(workspace, 'baseline.json')
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        metric: METRIC,
        value: baseline.value,
        frozen_at_ms: Date.now(),
        evidence: { platform: 'local', job_id: baseline.job_id, metrics: baseline.metrics, artifacts: baseline.artifacts },
      },
      null,
      2,
    )}\n`,
  )
  say(`baseline    ${METRIC}=${baseline.value}   (measured by a real local subprocess, job ${baseline.job_id})`)
  say('')
  say('next: node packages/core/lib/cli/run.js --config examples/feed-structure/config.json')
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`init failed: ${error?.message ?? error}\n`)
  process.exitCode = 1
}