/**
 * The activation set and the multi-run tick plan (ADR 0002, T2).
 *
 * Three properties, each of which costs somebody money or a night shift when it is wrong:
 *
 *   - **An absent activation file means "only the run the configuration ticks".** A directory appearing
 *     next to a run must never start spending on its own.
 *   - **A run that is active but unusable is skipped by name, and every other run still ticks.** One
 *     broken `reprise.toml` is one row's problem, not the host's.
 *   - **One run's tick never overlaps its own, and the cap decides how many runs share a beat** — that
 *     is the whole of `max_active_runs`, and `host-tick.test.js` owns the single-run half of it.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HOST_STATE_FILENAME, activeRunIds, readHostState, setRunActive } from '../lib/active-runs.js'
import { resolveConfig } from '../lib/config.js'
import { mountTick } from '../lib/host.js'
import { createRunRegistry, runConfigDocument } from '../lib/runs.js'
import { planWorkers } from '../lib/tick.js'
import { CONFIG_ONLY_PACK_DIR } from './support/domain.js'

const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-active-'))
  return dir
}
const mkdir = (dir) => {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A run whose `reprise.toml` would boot: the pack supplies the executor and the contract, and the file
 * supplies the two blocks a form cannot know. Without them `resolveConfig` refuses, which is the state
 * a freshly scaffolded run is in on purpose.
 */
function makeRun(dir, { runnable = true } = {}) {
  mkdir(dir)
  const base = runConfigDocument({ domain: CONFIG_ONLY_PACK_DIR })
  const extra = runnable
    ? `
[metrics]
primary = "config-only-score"
objectives = { "config-only-score" = "up" }

[candidate]
kind = "command"
command = ["node", "-e", "0", "{candidate}"]

[model]
kind = "command"
command = ["node", "-e", "0"]
`
    : ''
  writeFileSync(join(dir, 'reprise.toml'), `${base}${extra}`)
  return dir
}

// ------------------------------------------------------------- the activation set

test('an absent file is "nothing has been activated", not "everything is"', () => {
  const runsRoot = root()
  const registry = createRunRegistry({ runsRoot, workspace: mkdir(join(runsRoot, 'a')) })

  const state = readHostState(runsRoot)
  assert.equal(state.status, 'absent')
  assert.equal(state.ids, undefined)

  const active = activeRunIds({ registry, runsRoot, defaultRun: 'a' })
  assert.deepEqual(active.ids, ['a'], 'the run the configuration ticks is the whole set')
  assert.equal(active.status, 'absent')
})

test('activating and deactivating write one set, atomically, and are idempotent', () => {
  const runsRoot = root()
  const registry = createRunRegistry({ runsRoot, workspace: mkdir(join(runsRoot, 'a')) })
  mkdir(join(runsRoot, 'b'))

  const first = setRunActive(runsRoot, 'b', { activate: true })
  assert.deepEqual(first.ids, ['b'])
  assert.equal(first.changed, true)
  assert.deepEqual(JSON.parse(readFileSync(join(runsRoot, HOST_STATE_FILENAME), 'utf8')), { v: 1, active: ['b'] })

  // A button is a button: a double click must not be an error.
  const again = setRunActive(runsRoot, 'b', { activate: true })
  assert.deepEqual(again.ids, ['b'])
  assert.equal(again.changed, false)

  assert.deepEqual(activeRunIds({ registry, runsRoot, defaultRun: 'a' }).ids, ['b'], 'the file, not the default, decides')
  assert.deepEqual(setRunActive(runsRoot, 'b', { activate: false }).ids, [])
  assert.deepEqual(activeRunIds({ registry, runsRoot, defaultRun: 'a' }).ids, [])
})

test('a corrupt activation file is reported and never overwritten', () => {
  const runsRoot = root()
  mkdir(join(runsRoot, 'a'))
  const path = join(runsRoot, HOST_STATE_FILENAME)
  writeFileSync(path, '{ not json')

  assert.equal(readHostState(runsRoot).status, 'invalid')
  assert.throws(() => setRunActive(runsRoot, 'a', { activate: true }), /not valid JSON/)
  assert.equal(readFileSync(path, 'utf8'), '{ not json', 'the record of what somebody decided is still there')

  const registry = createRunRegistry({ runsRoot })
  const active = activeRunIds({ registry, runsRoot, defaultRun: undefined })
  assert.equal(active.status, 'invalid')
  assert.ok(active.problems.length > 0, 'and the caller is given the reason rather than a guess')
})

test('an id that left the registry is dropped from the answer but kept in the file', () => {
  const runsRoot = root()
  const registry = createRunRegistry({ runsRoot })
  setRunActive(runsRoot, 'gone', { activate: true })

  assert.deepEqual(activeRunIds({ registry, runsRoot }).ids, [], 'nothing to tick right now')
  assert.deepEqual(readHostState(runsRoot).ids, ['gone'], 'but the decision is not forgotten')
})

// --------------------------------------------------------------- the tick plan

test('a host with a registry ticks every activated, runnable run — and reports the rest', () => {
  const runsRoot = root()
  const good = makeRun(join(runsRoot, 'good'))
  makeRun(join(runsRoot, 'unconfigured'), { runnable: false })
  mkdir(join(runsRoot, 'empty'))

  setRunActive(runsRoot, 'good', { activate: true })
  setRunActive(runsRoot, 'unconfigured', { activate: true })
  setRunActive(runsRoot, 'empty', { activate: true })

  const resolved = resolveConfig(
    {
      workspace: good,
      domain: CONFIG_ONLY_PACK_DIR,
      executor: { kind: 'local', command: ['node', '-e', '0'] },
      metrics: { primary: 'config-only-score', objectives: { 'config-only-score': 'up' } },
      model: { kind: 'command', command: ['node', '-e', '0'] },
      runs_root: runsRoot,
    },
    { cwd: '/' },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))

  const logs = []
  const plan = planWorkers(resolved.config, { log: (message) => logs.push(message) })

  assert.deepEqual(plan.entries.map((entry) => entry.id), ['good'], 'only the run that could be opened becomes a worker')
  assert.deepEqual(
    plan.skipped.map((entry) => entry.id).sort(),
    ['empty', 'unconfigured'],
    'the others are reported, not silently dropped',
  )
  assert.match(logs.join('\n'), /not ticking run empty/)
  assert.match(logs.join('\n'), /not ticking run unconfigured/)
  for (const entry of plan.entries) entry.workspace.close()
})

test('a host with no registry ticks exactly one run, as it always did', () => {
  const dir = makeRun(join(root(), 'single'))
  const resolved = resolveConfig(
    {
      workspace: dir,
      domain: CONFIG_ONLY_PACK_DIR,
      executor: { kind: 'local', command: ['node', '-e', '0'] },
      metrics: { primary: 'config-only-score', objectives: { 'config-only-score': 'up' } },
      model: { kind: 'command', command: ['node', '-e', '0'] },
    },
    { cwd: '/' },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))

  const plan = planWorkers(resolved.config)
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].workspace.workspaceDir, dir)
  assert.deepEqual(plan.skipped, [])
  plan.entries[0].workspace.close()
})

// ------------------------------------------------------------ the scheduler, several runs

function fakeContext() {
  const intervals = []
  const effects = []
  return {
    intervals,
    effects,
    interval(callback, ms) {
      const entry = { callback, ms, cleared: false }
      intervals.push(entry)
      return () => {
        entry.cleared = true
      }
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

const settle = () => new Promise((resolve) => setImmediate(resolve))

function fakeWorkspace(id, tickOnce) {
  const calls = { tick: 0 }
  return {
    id,
    calls,
    async tickOnce() {
      calls.tick += 1
      return tickOnce?.(calls.tick)
    },
  }
}

test('max_active_runs decides how many runs share a beat, and round-robin gives every run a turn', async () => {
  const ctx = fakeContext()
  const a = fakeWorkspace('a')
  const b = fakeWorkspace('b')
  const c = fakeWorkspace('c')
  const mount = mountTick(ctx, {
    workspaces: [
      { id: 'a', workspace: a },
      { id: 'b', workspace: b },
      { id: 'c', workspace: c },
    ],
    intervalMs: 10,
    maxActive: 2,
  })

  // Beat one starts two runs; the third waits its turn rather than being starved.
  ctx.intervals[0].callback()
  await settle()
  assert.equal(a.calls.tick + b.calls.tick + c.calls.tick, 2)
  assert.equal(c.calls.tick, 0, 'the cap counted, and the cursor started at the front')

  ctx.intervals[0].callback()
  await settle()
  assert.equal(a.calls.tick + b.calls.tick + c.calls.tick, 4)
  assert.equal(c.calls.tick, 1, 'the run the first beat left out is served by the second')
  assert.equal(ctx.intervals.length, 1, 'still one interval for the whole host')
  assert.deepEqual(Object.keys(mount.stats().runs).sort(), ['a', 'b', 'c'])
  ctx.dispose()
})

test('one run in flight does not stop the others, and one run throwing does not stop the next', async () => {
  const ctx = fakeContext()
  const pending = []
  const slow = fakeWorkspace('slow', () => new Promise((resolve) => pending.push(resolve)))
  const bad = fakeWorkspace('bad', () => {
    throw new Error('database is locked')
  })
  const good = fakeWorkspace('good')
  const logs = []
  const mount = mountTick(ctx, {
    workspaces: [
      { id: 'slow', workspace: slow },
      { id: 'bad', workspace: bad },
      { id: 'good', workspace: good },
    ],
    intervalMs: 10,
    maxActive: 3,
    log: (message) => logs.push(message),
  })

  ctx.intervals[0].callback()
  await settle()
  ctx.intervals[0].callback()
  await settle()

  assert.equal(slow.calls.tick, 1, 'the slow run is not re-entered')
  assert.equal(bad.calls.tick, 2, 'the failing run is retried on the next beat')
  assert.equal(good.calls.tick, 2, 'and the healthy run kept going through both')
  assert.match(logs.join('\n'), /tick failed for run bad: database is locked/)
  assert.equal(mount.stats().failures, 2)
  assert.equal(mount.stats().inFlight, 1, 'exactly one tick is still running')

  pending.pop()()
  await settle()
  assert.equal(mount.stats().inFlight, 0)
  ctx.dispose()
})