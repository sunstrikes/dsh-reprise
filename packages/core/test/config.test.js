/**
 * Configuration: what is refused at boot, what is merely warned about, and where paths resolve to.
 *
 * Contract guarded (spec "领域差异必须是数据", user stories 26/28): the domain lives in configuration,
 * so configuration is the first thing an operator touches and the first place a run can be made
 * impossible. Two rules are pinned here:
 *
 *   - **What cannot work is refused before the first tick**, and the message says which key to fix.
 *     The alternative — a run that starts and stalls four hours later — is the failure this project
 *     exists to remove.
 *   - **What is legal but dangerous is warned about**, not refused: an uncapped spend on a real
 *     executor is the shipped default, and the plugin's job is to make it visible, not to forbid it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'

const LOCAL = { kind: 'local', command: ['node', 'metric.mjs'] }

test('a usable configuration is normalised: the workspace becomes absolute, defaults are filled in', () => {
  const resolved = resolveConfig({ workspace: '.workspace/feed', executor: LOCAL }, { cwd: '/tmp/elsewhere' })
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.workspaceDir, join('/tmp/elsewhere', '.workspace/feed'))
  assert.equal(resolved.config.executor.kind, 'local')
  assert.equal(resolved.config.interval_ms, 5_000, 'the interval ticket 01 measured in the real host is the default')
})

test('no workspace means no run, and the message names the key', () => {
  const resolved = resolveConfig({ executor: LOCAL })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /workspace/)
})

test('an executor with no command is refused: a job with nothing to run is not a configuration', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: { kind: 'local' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /executor\.command/)
})

test('an unknown executor kind is refused rather than silently treated as local', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: { kind: 'nope' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /executor\.kind/)
})

test('a ray executor without a dashboard URL is refused at boot, not at SUBMIT', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: { kind: 'ray' } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /base_url/)
})

test('a candidate implementer without a runner is refused: LAND would throw a TypeError on the first candidate', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: LOCAL, candidate: { kind: 'command', command: ['node', 'x.mjs'] } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /runner\./)
})

test('a round workflow with no model port is refused at boot — ROUND_PLAN has nobody to ask', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: LOCAL, rounds: { metric: { name: 'auc', direction: 'higher' } } })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /model\.command/)
})

test('a candidate-only workspace needs no model port: proposals alone are a legitimate run', () => {
  const resolved = resolveConfig({ workspace: 'w', executor: LOCAL })
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.deepEqual(resolved.warnings, [], 'nothing to warn about on a well-configured laptop run')
})

test('an uncapped spend on a real executor is a warning the boot log carries, not a refusal', () => {
  const resolved = resolveConfig({
    workspace: 'w',
    executor: { kind: 'ray', base_url: 'http://ray.invalid' },
    budget: { gpu_hours_limit: 0 },
  })
  assert.equal(resolved.ok, true, 'the shipped default must remain runnable — it must only be loud')
  assert.deepEqual(resolved.warnings.map((warning) => warning.code), ['no_gpu_hours_limit'])
})

test('a nonsensical interval is refused instead of becoming a busy loop', () => {
  for (const interval_ms of [0, -5, 1.5, 'fast']) {
    assert.equal(resolveConfig({ workspace: 'w', executor: LOCAL, interval_ms }).ok, false, `interval_ms=${JSON.stringify(interval_ms)}`)
  }
})

test('a workspace path is not created by validation: refusing and creating are different jobs', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'reprise-config-')), 'not-yet')
  const resolved = resolveConfig({ workspace: missing, executor: LOCAL })
  assert.equal(resolved.ok, true, 'a workspace may not exist yet — the plugin creates it when it opens the fact plane')
})