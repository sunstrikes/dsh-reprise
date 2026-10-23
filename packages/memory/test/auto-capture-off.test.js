/**
 * Guards the decision "mnemon's auto-capture is off, and that is provable from this package alone"
 * (spec: 注入包与记忆 — 「auto-capture 必须关闭」; issue 10).
 *
 * The rule being defended is not "we do not enable it in the profile we happen to run". It is: the
 * code that holds the write right is the kernel, memory is a projection of it, and this package
 * offers the model no way to write anything. mnemon's capture policy can only reach a Source through
 * a write Action it declares, so the proof is structural — and a regression here is a one-line
 * removal from a manifest, which is exactly the kind of change that would otherwise pass review.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildPacket } from '../lib/packet.js'
import { apply, registration } from '../lib/register.js'
import { SOURCE_MANIFEST } from '../lib/source.js'
import { frontierView, injectionConfig, workspace } from './support/fixtures.js'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/** Shapes that would give a model a write path. Comments mention the words; only these shapes matter. */
const WRITE_SHAPES = [
  [/strategyExtensions\s*:/u, 'a strategy extension contribution (the capture slot is one)'],
  [/slot\s*:\s*['"]capture['"]/u, 'a capture slot declaration'],
  [/mutate\s*[:(]/u, 'a mutate()/action handler'],
  [/capabilities\s*:\s*\[[^\]]*['"](write|maintain|archive|import)['"]/u, 'a write-capable Source capability'],
  [/actions\s*:\s*\[[^\]]*\{\s*id\s*:/u, 'a declared action'],
]

test('no shipped module contains a code path that lets a model write memory', () => {
  for (const file of readdirSync(LIB).filter((entry) => entry.endsWith('.js'))) {
    const source = readFileSync(join(LIB, file), 'utf8')
    for (const [pattern, meaning] of WRITE_SHAPES) {
      assert.doesNotMatch(source, pattern, `${file} contains ${meaning}`)
    }
  }
})

test('the manifest and the runtime offer no write: not a capability, not an action, not a method', () => {
  assert.deepEqual(SOURCE_MANIFEST.actions, [])
  assert.deepEqual(SOURCE_MANIFEST.capabilities, ['status', 'project', 'search'])
  assert.equal(SOURCE_MANIFEST.capabilities.includes('write'), false)

  const packet = buildPacket({ view: frontierView({}), config: injectionConfig(), workspaceDir: workspace([]) })
  const runtime = registration({ build: () => packet }).sources[0].create({
    sourceInstanceKey: 'source:injection-packet',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })

  assert.equal(runtime.mutate, undefined)
  assert.equal(runtime.manage, undefined)
  assert.deepEqual(Object.keys(runtime).sort(), ['facts', 'project', 'query'])
})

test('the plugin contributes sources only, so mnemon\'s capture policy has no target here', () => {
  const installed = []
  const ctx = {
    mnemonMemory: { installContributions: (contribution) => (installed.push(contribution), () => {}) },
    effect: (callback) => callback(),
  }

  apply(ctx, { build: () => buildPacket({ view: frontierView({}), config: injectionConfig(), workspaceDir: workspace([]) }) })

  assert.equal(installed.length, 1)
  assert.equal('strategyExtensions' in installed[0], false, 'only the capture slot can ask a model to record a fact, and it is not contributed')
  assert.deepEqual(installed[0].sources[0].manifest.actions, [], 'and the source offers no action to record one with')
})