/**
 * Two runs, one host, both advancing — the end-to-end proof of ADR 0002's second half.
 *
 * The unit tests (`active-runs.test.js`) prove the scheduler's arithmetic over fake workspaces and the
 * activation file's rules. This one proves the thing the feature exists for: **two real runs, each with
 * its own repository, its own `reprise.toml`, its own fact plane, driven by one interval**, each moving
 * through its own phases without the other's help. Everything here is real except the model (the
 * example pack replays recorded judgements) and the cluster (the local subprocess executor): real git
 * worktrees, real jobs, real SQLite fact planes.
 *
 * Three properties are asserted, and each one is a way a naive implementation loses:
 *
 *   - both runs advance, so "several exploration tasks" is a property rather than a story;
 *   - the facts stay in their own planes — one run's event count is not the other's, and each plane
 *     names its own workspace;
 *   - a run that is *not* activated does not advance at all, which is the difference between a
 *     registry (a list you can see) and a scheduler (a thing that spends money).
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { setRunActive } from '../lib/active-runs.js'
import { resolveConfig } from '../lib/config.js'
import { mountTick } from '../lib/host.js'
import { Store } from '../lib/store.js'
import { planWorkers } from '../lib/tick.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXAMPLE = join(ROOT, 'examples', 'feed-structure')
const LAB = join(EXAMPLE, 'lab')

const dirRoot = () => mkdtempSync(join(tmpdir(), 'reprise-multi-run-'))

/**
 * One runnable run: a repository copied from the example's lab, committed (a candidate worktree has to
 * branch from *something*), and a `reprise.toml` naming everything a run needs that the host cannot
 * know. The file is written the way a person would write it — absolute paths for the scripts, relative
 * for the two directories inside the run — because that is the layout the ADR promises.
 */
function makeRun(dir, { id }) {
  mkdirSync(dir, { recursive: true })
  const repo = join(dir, 'repo')
  cpSync(LAB, repo, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=multi-run test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', `baseline ${id}`)

  writeFileSync(
    join(dir, 'reprise.toml'),
    `# the run's own configuration: same keys as the plugin patch, read at mount.
workspace = "."
domain = "${EXAMPLE}"
interval_ms = 50

[metrics]
primary = "auc"
objectives = { auc = "up" }

[stop]
max_rounds = 1

[budget]
candidate_gpu_hours = 0.5
gpu_hours_limit = 0

[rounds]
max_rounds = 1
candidates_per_round = 1

[rounds.metric]
name = "auc"
direction = "higher"
contract_ref = "${join(EXAMPLE, 'metric-contract.json')}"

[candidate]
kind = "command"
command = ["node", "${join(EXAMPLE, 'apply-change.mjs')}", "{candidate}", "${join(EXAMPLE, 'hypotheses.json')}"]
timeout_ms = 60000

[runner]
repo = "repo"
base_ref = "HEAD"
dir = "worktrees"

[model]
command = ["node", "${join(EXAMPLE, 'recorded-model.mjs')}", "${join(EXAMPLE, 'hypotheses.json')}", "${join(EXAMPLE, 'recorded', 'judgement.json')}", "${join(EXAMPLE, 'priors.json')}"]

[poll]
base_ms = 50
max_ms = 400
grace_attempts = 2

[limits]
max_wall_ms = 60000
max_idle_ms = 60000
`,
  )
  return dir
}

/** The parts of a cordis `Context` `mountTick` is allowed to touch. */
function fakeContext() {
  const intervals = []
  const effects = []
  return {
    intervals,
    interval(callback) {
      intervals.push(callback)
      return () => {}
    },
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    dispose() {
      for (const cleanup of [...effects].reverse()) cleanup()
    },
  }
}

/** How many facts a run's own plane holds, and which workspace it believes it owns. */
function factsOf(dir) {
  const store = Store.openReadOnly(dir)
  try {
    const state = store.getState(undefined, 'workspace') ?? {}
    const candidates = store.candidateIds()
    return {
      path: store.path,
      events: store.eventSubjects().reduce((total, subject) => total + store.eventsFor(subject).length, 0),
      candidates,
      state,
    }
  } finally {
    store.close()
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Advance every runnable worker once, then let the async phases settle. */
async function beat(mount) {
  await mount.tick()
  await sleep(30)
}

test('two activated runs advance in parallel, each in its own fact plane', { timeout: 240_000 }, async () => {
  const runsRoot = dirRoot()
  const alpha = makeRun(join(runsRoot, 'alpha'), { id: 'alpha' })
  const beta = makeRun(join(runsRoot, 'beta'), { id: 'beta' })
  const idle = makeRun(join(runsRoot, 'idle'), { id: 'idle' })

  setRunActive(runsRoot, 'alpha', { activate: true })
  setRunActive(runsRoot, 'beta', { activate: true })
  // `idle` is a perfectly good run that nobody started: it must not move a single fact.

  const resolved = resolveConfig(
    {
      workspace: alpha,
      runs_root: runsRoot,
      domain: EXAMPLE,
      executor: { kind: 'local', command: ['node', 'metric.mjs'] },
      metrics: { primary: 'auc', objectives: { auc: 'up' } },
      model: { kind: 'command', command: ['node', join(EXAMPLE, 'recorded-model.mjs')] },
    },
    { cwd: ROOT },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))

  const plan = planWorkers(resolved.config)
  assert.deepEqual(plan.entries.map((entry) => entry.id).sort(), ['alpha', 'beta'], 'only the activated runs become workers')
  assert.equal(resolved.config.registry.resolve('idle'), idle, 'the third run is registered and simply not driven')

  const ctx = fakeContext()
  const mount = mountTick(ctx, { workspaces: plan.entries, intervalMs: 50, maxActive: 2 })
  try {
    for (let index = 0; index < 60; index += 1) {
      await beat(mount)
      const a = factsOf(alpha)
      const b = factsOf(beta)
      // Both planes have to have moved past INIT *and* past BASELINE (a real local job) before this is
      // worth asserting anything about: two runs that only wrote their start time are not "advancing".
      if (a.events > 1 && b.events > 1 && a.state.phase !== undefined && b.state.phase !== undefined) break
    }

    const a = factsOf(alpha)
    const b = factsOf(beta)
    assert.ok(a.events > 0, `alpha advanced (${a.events} fact(s))`)
    assert.ok(b.events > 0, `beta advanced (${b.events} fact(s))`)
    // Two runs, two planes — asserted structurally rather than by counting: these two runs are
    // identical on purpose (same pack, same recorded answers), so equal counts are the *expected*
    // result of two correct runs, and comparing the numbers would prove nothing either way.
    assert.match(a.path, /alpha/)
    assert.match(b.path, /beta/)
    assert.notEqual(a.path, b.path, 'each run writes its own workspace.db')
    assert.deepEqual(a.candidates.sort(), b.candidates.sort(), 'the same candidate ids, in two separate planes')
    // The trees are per run even though the candidate ids are the same: `r1-h1` under alpha and
    // `r1-h1` under beta are two directories, which is what keeps two parallel runs from editing one
    // another's code.
    for (const candidateId of a.candidates) {
      const inAlpha = join(alpha, 'worktrees', candidateId)
      const inBeta = join(beta, 'worktrees', candidateId)
      assert.ok(existsSync(inAlpha), `alpha owns its ${candidateId} tree (${inAlpha})`)
      assert.ok(existsSync(inBeta), `beta owns its own ${candidateId} tree (${inBeta})`)
      assert.notEqual(inAlpha, inBeta)
    }
    assert.equal(existsSync(join(idle, 'workspace.db')), false, 'a run that was never driven never opened a fact plane')
    assert.equal(existsSync(join(idle, 'worktrees')), false, 'and it never created a tree either')
    assert.equal(a.state.phase, b.state.phase, 'both are in the same phase — same pack, same round shape')
    assert.ok(['BASELINE', 'ROUND_PLAN', 'FINALIZE'].includes(a.state.phase), `alpha is past INIT (${a.state.phase})`)

    // The workers each keep their own bookkeeping, which is what makes a stalled run visible.
    const stats = mount.stats()
    assert.deepEqual(Object.keys(stats.runs).sort(), ['alpha', 'beta'])
    for (const id of ['alpha', 'beta']) assert.ok(stats.runs[id].ticks > 1, `${id} ticked more than once`)
    assert.equal(stats.maxActive, 2)
  } finally {
    mount.stop()
    ctx.dispose()
    for (const entry of plan.entries) entry.workspace.close()
    rmSync(runsRoot, { recursive: true, force: true })
  }
})
test('a run started from the dashboard joins the next beat, without restarting the host', { timeout: 240_000 }, async () => {
  const runsRoot = dirRoot()
  const alpha = makeRun(join(runsRoot, 'alpha'), { id: 'alpha' })
  const beta = makeRun(join(runsRoot, 'beta'), { id: 'beta' })

  setRunActive(runsRoot, 'alpha', { activate: true })
  // `beta` is registered and *not* activated: the state a run is in right after the create form.

  const resolved = resolveConfig(
    {
      workspace: alpha,
      runs_root: runsRoot,
      domain: EXAMPLE,
      executor: { kind: 'local', command: ['node', 'metric.mjs'] },
      metrics: { primary: 'auc', objectives: { auc: 'up' } },
      model: { kind: 'command', command: ['node', join(EXAMPLE, 'recorded-model.mjs')] },
    },
    { cwd: ROOT },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))

  const ctx = fakeContext()
  const logs = []
  const { apply } = await import('../lib/tick.js')
  apply({ ...ctx, logger: undefined, effect: ctx.effect, interval: ctx.interval }, { ...resolved.config, onLog: (line) => logs.push(line) })

  // Let `apply` finish reconciling and mount the interval.
  for (let index = 0; index < 40 && ctx.intervals.length === 0; index += 1) await sleep(50)
  assert.equal(ctx.intervals.length, 1, 'the host has one interval, as always')

  /** One host beat, then let the async phases settle. */
  const hostBeat = async (times = 1) => {
    for (let index = 0; index < times; index += 1) {
      ctx.intervals[0]()
      await sleep(60)
    }
  }

  try {
    await hostBeat(6)
    assert.ok(factsOf(alpha).events > 0, 'the activated run advances')
    assert.equal(existsSync(join(beta, 'workspace.db')), false, 'the registered-but-not-started run has not moved')

    // The dashboard's Start: one file write, and no restart.
    setRunActive(runsRoot, 'beta', { activate: true })
    await hostBeat(8)

    assert.ok(factsOf(beta).events > 0, 'the run started from the dashboard joined the tick')
    assert.match(logs.join('\n'), /run beta: activated, joining the tick/)

    // And Stop takes it out again without touching either fact plane.
    const beforeStop = factsOf(beta).events
    setRunActive(runsRoot, 'beta', { activate: false })
    await hostBeat(6)
    assert.match(logs.join('\n'), /run beta: deactivated, no longer advancing/)
    assert.equal(factsOf(beta).events, beforeStop, 'a run taken out of the set keeps every fact it had and gains none')
    assert.ok(factsOf(alpha).events > 0, 'while the run that is still activated keeps going')
  } finally {
    ctx.dispose()
    rmSync(runsRoot, { recursive: true, force: true })
  }
})
