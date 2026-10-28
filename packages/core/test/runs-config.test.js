/**
 * The registry keys (ADR 0002): `runs_root`, `runs`, `max_active_runs`.
 *
 * What is pinned here is that the registry is **additive** — a deployment that never sets these keys
 * resolves to exactly the configuration and the boot line it resolved to before — and that the three
 * keys are refused by name when they cannot work. The registry's own behaviour (union, dedup, the id
 * rule) is `runs.test.js`'s.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_MAX_ACTIVE_RUNS, resolveConfig } from '../lib/config.js'
import { describeRunLine } from '../lib/boot.js'

const PACK = Object.freeze({
  dir: '/packs/config-only-domain',
  name: 'config-only-domain',
  metricContract: { name: 'config-only-score', primary: 'score', direction: 'higher', objectives: { score: 'up' } },
  priors: { search_space: {}, priors: [], hypothesis_classes: [] },
  surface: { files: ['src/thing.json'], keys: ['width'], symbols: [] },
  promptsDir: '/packs/config-only-domain/prompts',
  prompts: new Map(),
  executor: { kind: 'local', command: ['node', 'score.mjs'] },
})

const resolve = (raw, options = {}) =>
  resolveConfig({ domain: 'a-domain-pack', ...raw }, { loadDomain: () => PACK, ...options })

const runsRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'reprise-runs-root-'))
  mkdirSync(join(root, 'run-a'))
  mkdirSync(join(root, 'run-b'))
  return root
}

test('a configuration with no registry keys is unchanged: one run, the boot line identical', () => {
  const plain = resolve({ workspace: '.workspace/feed', executor: { kind: 'local', command: ['node', 'm.mjs'] } }, { cwd: '/tmp/x' })
  assert.equal(plain.ok, true, plain.problems?.join('; '))
  assert.deepEqual(
    plain.config.registry.list().map((entry) => entry.id),
    ['feed'],
    'the ticked workspace is the whole registry',
  )
  assert.equal(plain.config.runs_root, null)
  assert.deepEqual(plain.config.runs, [])
  assert.equal(plain.config.max_active_runs, DEFAULT_MAX_ACTIVE_RUNS)
  assert.doesNotMatch(describeRunLine(plain.config), /runs_root/, 'the boot line of an unregistered host does not change')
})

test('runs_root joins the registry, and the boot line says how many runs it holds', () => {
  const root = runsRoot()
  const resolved = resolve(
    { workspace: '.workspace/feed', executor: { kind: 'local', command: ['node', 'm.mjs'] }, runs_root: root },
    { cwd: '/tmp/x' },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.runs_root, root)
  assert.deepEqual(
    resolved.config.registry.list().map((entry) => entry.id),
    ['feed', 'run-a', 'run-b'],
    'the ticked run first, then the root in its own order',
  )
  assert.match(
    describeRunLine(resolved.config),
    /\(3 run\(s\), from config\)/,
    'and who chose it: the configuration, because no settings file overrides it here',
  )
})

test('extra runs are joined, and a relative one resolves against the host cwd like every other path', () => {
  const resolved = resolve(
    {
      workspace: '.workspace/feed',
      executor: { kind: 'local', command: ['node', 'm.mjs'] },
      runs: ['../elsewhere/run-c', '/abs/run-d'],
    },
    { cwd: '/tmp/x' },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.deepEqual(resolved.config.runs, ['/tmp/elsewhere/run-c', '/abs/run-d'])
  assert.deepEqual(resolved.config.registry.list().map((entry) => entry.source), ['workspace', 'runs', 'runs'])
})

test('the three keys are refused by name when they cannot work', () => {
  const badMax = resolve({ workspace: '.w', max_active_runs: 0 }, { cwd: '/tmp/x' })
  assert.equal(badMax.ok, false)
  assert.match(badMax.problem, /max_active_runs/)

  const notInteger = resolve({ workspace: '.w', max_active_runs: 'two' }, { cwd: '/tmp/x' })
  assert.equal(notInteger.ok, false)
  assert.match(notInteger.problem, /max_active_runs/)

  const badRuns = resolve({ workspace: '.w', runs: 'one-dir' }, { cwd: '/tmp/x' })
  assert.equal(badRuns.ok, false)
  assert.match(badRuns.problem, /runs must be an array/)

  const mixed = resolve({ workspace: '.w', runs: ['/abs/ok', 7] }, { cwd: '/tmp/x' })
  assert.equal(mixed.ok, false)
  assert.match(mixed.problem, /runs must be an array/)
})

test('a registry with no runs still refuses to tick, and says which key is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'reprise-empty-root-'))
  const resolved = resolve({ runs_root: root, executor: { kind: 'local', command: ['node', 'm.mjs'] } }, { cwd: '/tmp/x' })
  assert.equal(resolved.ok, false, 'the ticking half needs one run; the display half reads the registry')
  assert.match(resolved.problem, /workspace must be the path of the directory this run owns/)
})