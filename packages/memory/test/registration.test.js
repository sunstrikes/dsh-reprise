/**
 * Guards the decision "the Source is registered from the plugin's own ctx, and nothing assumes a
 * service is synchronously visible" (spec: 宿主边界; issue 10).
 *
 * The measured facts this is written against:
 *   - a service must be declared in `export const inject` before it can be *accessed*; `ctx.get()`
 *     only reports presence, and `ctx.interval()` throws without the declaration;
 *   - a plugin whose declared dependency is absent is *deferred*, not failed, so "never ran" and
 *     "dependency missing" look identical in a log;
 *   - `ctx.plugin()` returns a promise, and nothing from that fiber is readable before it settles.
 *
 * The consequences encoded below: the definition is built with no host at all, the service is read
 * from the ctx `apply` was given (never a module-level or global handle), and the registration is
 * inside `ctx.effect` so disposal takes it with the fiber.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPacket } from '../lib/packet.js'
import { apply, inject, memoryPlugin, name, registration } from '../lib/register.js'
import { frontierView, injectionConfig, workspace } from './support/fixtures.js'

/** A ctx with exactly the members cordis gives a plugin, and a service that records installations. */
function fakeContext() {
  const disposers = []
  const service = {
    installed: [],
    installContributions(contribution, options) {
      const entry = { contribution, options }
      this.installed.push(entry)
      const dispose = () => {
        this.installed = this.installed.filter((candidate) => candidate !== entry)
      }
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx: {
      mnemonMemory: service,
      effect(callback, label) {
        const disposer = callback()
        this.effects.push({ label, disposer })
        return disposer
      },
      effects: [],
    },
    service,
  }
}

const builder = () => buildPacket({ view: frontierView({}), config: injectionConfig(), workspaceDir: workspace([]) })

test('the plugin declares the memory service, so the host defers it instead of crashing on access', () => {
  assert.deepEqual(inject, ['mnemonMemory'], 'an undeclared service can be get()-probed but not accessed — and this plugin accesses it')
  assert.equal(name, '@dsh-reprise/memory')
  assert.deepEqual(memoryPlugin.roles, ['source'])
  assert.deepEqual(memoryPlugin.provides, [{ id: 'source' }, { id: 'source.injection-packet' }])
  assert.equal(memoryPlugin.apiVersion, 'dsh-mnemon/plugin/v1')
})

test('the source definition needs no host to be built — a memory outage cannot stop a tick', () => {
  const definition = registration({ build: builder }).sources[0]

  assert.equal(definition.manifest.kind, 'source')
  assert.equal(typeof definition.create, 'function')
})

test('apply registers through the service on its own ctx, so two hosts never share a registration', () => {
  const left = fakeContext()
  const right = fakeContext()

  apply(left.ctx, { build: builder, instanceId: 'reprise-left' })
  apply(right.ctx, { build: builder, instanceId: 'reprise-right' })

  assert.equal(left.service.installed.length, 1)
  assert.equal(right.service.installed.length, 1)
  assert.equal(left.service.installed[0].options.instanceId, 'reprise-left')
  assert.equal(right.service.installed[0].options.instanceId, 'reprise-right')
  assert.equal(
    left.service.installed[0].contribution.sources[0].manifest.typeId,
    'injection-packet',
    'the registration is the source we built, not a shared singleton the second host would join',
  )
})

test('the registration lives and dies with the fiber', () => {
  const { ctx, service } = fakeContext()

  apply(ctx, { build: builder, instanceId: 'reprise-memory' })

  assert.equal(ctx.effects.length, 1, 'one effect, registered on the given ctx — not on a root or a module global')
  assert.match(ctx.effects[0].label, /injection-packet/u, 'the effect is labelled, so a dispose log says what went away')
  assert.equal(service.installed.length, 1)

  ctx.effects[0].disposer()

  assert.equal(service.installed.length, 0, 'disposing the plugin removes its source; a leftover registration is a memory nobody owns')
})

test('the registration contributes a source and nothing else — no capture slot, no writable source', () => {
  const { ctx, service } = fakeContext()

  apply(ctx, { build: builder, instanceId: 'reprise-memory' })

  const contribution = service.installed[0].contribution
  assert.deepEqual(Object.keys(contribution).sort(), ['plugin', 'sources'], 'no strategyExtensions: an auto-capture slot is exactly what must not be contributed')
  assert.equal(contribution.sources.length, 1)
  assert.deepEqual(contribution.sources[0].manifest.actions, [], 'mnemon only offers a write Action for a source that declares one')
  assert.deepEqual(contribution.sources[0].manifest.capabilities, ['status', 'project', 'search'])
})

test('apply refuses a ctx that cannot take the registration, instead of installing nothing quietly', () => {
  assert.throws(() => apply({ effect: () => {} }, { build: builder }), /mnemonMemory/u)
})

test('apply builds a usable definition from a workspace when no builder is wired yet', () => {
  const { ctx, service } = fakeContext()

  apply(ctx, { workspaceDir: workspace([{ experience_id: 'r', section: 'guardrails', text: 'never widen the head' }]), instanceId: 'reprise-memory' })

  const definition = service.installed[0].contribution.sources[0]
  const runtime = definition.create({ sourceInstanceKey: 'source:injection-packet', provenance: { packageName: '@dsh-reprise/memory', entryId: 'reprise-memory' } })
  const facts = runtime.facts({ scope: { storage: 'workspace' }, scenario: 'reprise.injection-packet', budget: {} })
  const contribution = runtime.project({
    scope: { storage: 'workspace' },
    sourceInstanceKey: 'source:injection-packet',
    expectedRevision: facts.revision,
    includeProjection: true,
    mode: 'eager',
    maxCharacters: 4_000,
  })

  assert.match(
    contribution.fragments.map((fragment) => fragment.text).join('\n'),
    /- guardrail: never widen the head/u,
    'a degraded-but-complete packet is better than a source that cannot be mounted before core is wired',
  )
})