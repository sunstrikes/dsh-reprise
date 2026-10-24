/**
 * Configuration: what is refused at boot, what is merely warned about, and where paths resolve to.
 *
 * Contract guarded (spec "领域差异必须是数据", user stories 26/28): the domain lives in configuration,
 * so configuration is the first thing an operator touches and the first place a run can be made
 * impossible. Three rules are pinned here:
 *
 *   - **What cannot work is refused before the first tick**, and the message says which key to fix.
 *     The alternative — a run that starts and stalls four hours later — is the failure this project
 *     exists to remove. A run with no **domain pack** is refused here: the pack is where the metric
 *     contract, the prompts and the executor entry live, so without one there is nothing to run.
 *   - **The pack answers what the run does not restate.** A configuration that names a pack and no
 *     executor or metric is complete, because the domain knows how it is measured and what better
 *     means; a run that does restate them keeps its own words.
 *   - **What is legal but dangerous is warned about**, not refused: an uncapped spend on a real
 *     executor is the shipped default, and the plugin's job is to make it visible, not to forbid it.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { CONFIG_ONLY_PACK_DIR } from './support/domain.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LOCAL = { kind: 'local', command: ['node', 'metric.mjs'] }

/**
 * A stand-in pack for the tests that are about *other* keys: loading it is `domain.test.js`'s job,
 * and a refusal for a bad executor should not depend on a directory of files being on disk.
 */
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

/** `resolveConfig` with a pack supplied, so each test can be about one key. */
const resolve = (raw, options = {}) =>
  resolveConfig({ domain: 'a-domain-pack', ...raw }, { loadDomain: () => PACK, ...options })

test('a usable configuration is normalised: the workspace becomes absolute, defaults are filled in', () => {
  const resolved = resolve({ workspace: '.workspace/feed', executor: LOCAL }, { cwd: '/tmp/elsewhere' })
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.workspaceDir, join('/tmp/elsewhere', '.workspace/feed'))
  assert.equal(resolved.config.executor.kind, 'local')
  assert.equal(resolved.config.interval_ms, 5_000, 'the interval ticket 01 measured in the real host is the default')
})

test('no workspace means no run, and the message names the key', () => {
  const resolved = resolve({ executor: LOCAL })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /workspace/)
})

test('an executor with no command is refused: a job with nothing to run is not a configuration', () => {
  const resolved = resolve({ workspace: 'w', executor: { kind: 'local' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /executor\.command/)
})

test('an unknown executor kind is refused rather than silently treated as local', () => {
  const resolved = resolve({ workspace: 'w', executor: { kind: 'nope' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /executor\.kind/)
})

test('a ray executor without a dashboard URL is refused at boot, not at SUBMIT', () => {
  const resolved = resolve({ workspace: 'w', executor: { kind: 'ray' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /base_url/)
})

test('a candidate implementer without a runner is refused: LAND would throw a TypeError on the first candidate', () => {
  const resolved = resolve({ workspace: 'w', executor: LOCAL, candidate: { kind: 'command', command: ['node', 'x.mjs'] } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /runner\./)
})

test('a round workflow with no model port is refused at boot — ROUND_PLAN has nobody to ask', () => {
  const resolved = resolve({ workspace: 'w', executor: LOCAL, rounds: { metric: { name: 'auc', direction: 'higher' } } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /model\.command/)
})

test('a candidate-only workspace needs no model port: proposals alone are a legitimate run', () => {
  const resolved = resolve({ workspace: 'w', executor: LOCAL })
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.deepEqual(resolved.warnings, [], 'nothing to warn about on a well-configured laptop run')
})

test('an uncapped spend on a real executor is a warning the boot log carries, not a refusal', () => {
  const resolved = resolve({
    workspace: 'w',
    executor: { kind: 'ray', base_url: 'http://ray.invalid' },
    budget: { gpu_hours_limit: 0 },
  })
  assert.equal(resolved.ok, true, 'the shipped default must remain runnable — it must only be loud')
  assert.deepEqual(resolved.warnings.map((warning) => warning.code), ['no_gpu_hours_limit'])
})

test('a nonsensical interval is refused instead of becoming a busy loop', () => {
  for (const interval_ms of [0, -5, 1.5, 'fast']) {
    assert.equal(resolve({ workspace: 'w', executor: LOCAL, interval_ms }).ok, false, `interval_ms=${JSON.stringify(interval_ms)}`)
  }
})

test('a workspace path is not created by validation: refusing and creating are different jobs', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'reprise-config-')), 'not-yet')
  const resolved = resolve({ workspace: missing, executor: LOCAL })
  assert.equal(resolved.ok, true, 'a workspace may not exist yet — the plugin creates it when it opens the fact plane')
})
// ------------------------------------------------------- the domain pack

test('a run with no domain pack is refused: there is no default domain, so there is nothing to measure', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: LOCAL }, { loadDomain: () => PACK })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /domain/, 'the message names the key to add')
  assert.match(resolved.problem, /domain\.json/, 'and what a pack is, so the reader knows what to point at')
})

test('a pack that cannot be used is refused at boot, quoting the file that is wrong', () => {
  const copied = copyPack(CONFIG_ONLY_PACK_DIR)
  try {
    rmSync(join(copied, 'priors.json'))
    const resolved = resolveConfig({ workspace: 'w', domain: copied, executor: LOCAL }, { cwd: ROOT })
    assert.equal(resolved.ok, false, 'a run does not start against half a domain')
    assert.match(resolved.problem, /priors/, 'the pack field is named')
    assert.match(resolved.problem, /priors\.json/, 'and the file it should have found')
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('the pack supplies the executor entry when the run does not: the domain knows how it is measured', () => {
  const resolved = resolveConfig({ workspace: 'w', domain: CONFIG_ONLY_PACK_DIR }, { cwd: ROOT })
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.deepEqual(resolved.config.executor.command, ['node', '-e', '0'], 'the pack\'s own argv, not a kernel default')
  assert.equal(resolved.config.executor.kind, 'local')
})

test('the run may override the executor the pack ships — same training script, a cluster instead of a laptop', () => {
  const resolved = resolveConfig(
    {
      workspace: 'w',
      domain: CONFIG_ONLY_PACK_DIR,
      executor: { kind: 'ray', base_url: 'http://ray.invalid' },
      budget: { gpu_hours_limit: 4 },
    },
    { cwd: ROOT },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.executor.kind, 'ray')
})

test('the pack supplies the metric contract when the run does not restate it, and the round workflow reads the same one', () => {
  const resolved = resolveConfig(
    { workspace: 'w', domain: CONFIG_ONLY_PACK_DIR, rounds: { max_rounds: 1 }, model: { command: ['node', 'port.mjs'] } },
    { cwd: ROOT },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  const packContract = JSON.parse(readFileSync(join(CONFIG_ONLY_PACK_DIR, 'metric-contract.json'), 'utf8'))
  assert.deepEqual(
    resolved.config.metrics,
    packContract,
    'the whole contract travels verbatim, not a two-field summary: the tolerance, the guardrail and the ' +
      'window reading are part of "which metric decides", and the reader that dropped them would be reading a contract nobody wrote',
  )
  assert.deepEqual(
    resolved.config.rounds.metric,
    { name: 'score', direction: 'higher', contract_ref: 'config-only-score' },
    'one mapping from contract to binding: the round gate and the judge read the same metric',
  )
  assert.equal(resolved.config.domainPack.name, 'config-only-domain', 'the resolved config carries the pack it loaded')
})

test('a run that restates the metric keeps its own words, because changing the direction is a data edit', () => {
  const resolved = resolveConfig(
    {
      workspace: 'w',
      domain: CONFIG_ONLY_PACK_DIR,
      metrics: { primary: 'score', objectives: { score: 'down' } },
      rounds: { max_rounds: 1, metric: { name: 'score', direction: 'lower' } },
      model: { command: ['node', 'port.mjs'] },
    },
    { cwd: ROOT },
  )
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.deepEqual(resolved.config.metrics.objectives, { score: 'down' })
  assert.equal(resolved.config.rounds.metric.direction, 'lower')
})

test('the shipped example configuration resolves: its pack answers the executor, and its own words stay', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'examples', 'feed-structure', 'config.json'), 'utf8'))
  const resolved = resolveConfig(raw, { cwd: ROOT })
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.domainPack.name, 'feed-structure')
  assert.deepEqual(resolved.config.executor.command, ['node', 'metric.mjs'])
  assert.equal(resolved.config.rounds.metric.contract_ref, 'examples/feed-structure/metric-contract.json')
})

/** A throwaway copy of a pack, so a test may break one part without touching the repository. */
function copyPack(source) {
  const target = mkdtempSync(join(tmpdir(), 'reprise-config-pack-'))
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  return target
}
