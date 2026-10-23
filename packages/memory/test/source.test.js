/**
 * Guards the decision "the packet reaches a model turn as a dsh-mnemon Source, shaped exactly like
 * the measured contract, and degrades to a complete packet when durable evidence is unavailable"
 * (spec: 注入包与记忆 / 宿主边界; issue 10).
 *
 * Two things are being defended here. The first is the contract shape — `{manifest, create}` →
 * `{facts, project, query?}` — because a source that is *almost* right fails at the host, and the
 * host is exactly where we cannot see it. The second is the failure mode: memory spaces are broken
 * upstream today, and no amount of memory trouble may cost the loop a tick.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPacket } from '../lib/packet.js'
import { PACKET_SCENARIO, SOFT_SOURCES } from '../lib/strategy.js'
import { SOURCE_TYPE_ID, createInjectionPacketSource } from '../lib/source.js'
import { done, frontierView, injectionConfig, workspace } from './support/fixtures.js'

const port = (compose) => ({ strategy: 'test-strategy', compose })

function workspaceWithRecipes() {
  return workspace([
    { experience_id: 'a-recipe', section: 'recipes', text: 'warm up for one epoch' },
    { experience_id: 'b-recipe', section: 'recipes', text: 'freeze the embedding layer' },
  ])
}

/** A builder that returns a fixed packet, so a source test never needs a fact plane. */
const fixed = (packet) => () => packet

function packet({ recipesMode = 'eager', recipesCharacters = 1_000, workspaceDir = workspaceWithRecipes() } = {}) {
  return buildPacket({
    view: frontierView({ candidates: [done('c1', 0.7301)] }),
    config: injectionConfig({ forbidden: ['add a second attention block'] }),
    workspaceDir,
    strategy: port(() => ({
      strategy: 'test-strategy',
      sections: {
        recipes: { mode: recipesMode, maxCharacters: recipesCharacters },
        candidate_experiences: { mode: 'routed', maxCharacters: 0 },
      },
    })),
  })
}

const factsRequest = () => ({ scope: { storage: 'workspace', workspaceId: '/tmp/ws' }, scenario: PACKET_SCENARIO, budget: {} })

function projectRequest(packetValue, overrides = {}) {
  return {
    scope: { storage: 'workspace', workspaceId: '/tmp/ws' },
    sourceInstanceKey: 'source:test',
    expectedRevision: packetValue.digest,
    includeProjection: true,
    mode: 'eager',
    maxCharacters: 4_000,
    ...overrides,
  }
}

test('the definition is a mnemon Source: manifest, create, and a read-only runtime', () => {
  const definition = createInjectionPacketSource({ build: fixed(packet()) })

  assert.equal(definition.manifest.apiVersion, 'dsh-mnemon/v1')
  assert.equal(definition.manifest.kind, 'source')
  assert.equal(definition.manifest.typeId, SOURCE_TYPE_ID)
  assert.equal(definition.manifest.packageName, '@dsh-reprise/memory')
  assert.equal(definition.manifest.role, 'injection-packet', 'not one of mnemon\'s three roles: a packet must not displace a runtime or durable source')
  assert.deepEqual(definition.manifest.capabilities, ['status', 'project', 'search'])
  assert.equal(definition.manifest.consistency, 'exact-snapshot', 'a packet is read as one snapshot, or two fragments could describe different facts')
  assert.deepEqual(
    definition.manifest.routes.map((route) => [route.id, route.capability, typeof route.inputSchema, route.maxCalls > 0]),
    [['ranked', 'search', 'object', true]],
    'the staged corpus is reachable through one declared route, and that route is all it offers',
  )
  assert.equal(typeof definition.create, 'function')

  const runtime = definition.create({ sourceInstanceKey: 'source:test', provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' } })
  assert.equal(typeof runtime.facts, 'function')
  assert.equal(typeof runtime.project, 'function')
  assert.equal(typeof runtime.query, 'function')
  assert.equal(runtime.mutate, undefined, 'a model-writable memory source is exactly what auto-capture needs; this one must not be it')
  assert.equal(runtime.manage, undefined)
})

test('facts() describes the packet without writing anything and without needing the host', () => {
  const packetValue = packet()
  const runtime = createInjectionPacketSource({ build: fixed(packetValue) }).create({
    sourceInstanceKey: 'source:test',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })

  const facts = runtime.facts(factsRequest())

  assert.equal(facts.sourceInstanceKey, 'source:test')
  assert.equal(facts.sourceTypeId, SOURCE_TYPE_ID)
  assert.equal(facts.availability, 'ready')
  assert.equal(facts.revision, packetValue.digest, 'the revision is the packet digest, so a pinned read can be checked against it')
  assert.deepEqual(facts.capabilities, ['status', 'project', 'search'])
  assert.deepEqual(facts.routeIds, ['ranked'])
  assert.deepEqual(facts.actionIds, [])
  assert.equal(facts.hints.hard_items, 6, 'guardrail + two absences + global best + search space + objectives + candidate row: the whole hard half is counted')
  assert.deepEqual(facts.hints.ranked.recipes, { mode: 'eager', shown: 2, staged: 0, delegated_to: 'test-strategy' })
  assert.equal(facts.hints.degraded.length, 0)
})

test('project() hands over complete hard sections and budget-bound ranked ones', () => {
  const packetValue = packet()
  const runtime = createInjectionPacketSource({ build: fixed(packetValue) }).create({
    sourceInstanceKey: 'source:test',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })

  const contribution = runtime.project(projectRequest(packetValue, { maxCharacters: 40 }))

  const byId = new Map(contribution.fragments.map((fragment) => [fragment.id, fragment]))
  assert.deepEqual(
    [...byId.keys()],
    ['source:test/guardrails', 'source:test/singletons', 'source:test/frontier', 'source:test/ranked'],
    'one fragment per section, in packet order',
  )
  assert.match(
    byId.get('source:test/guardrails').text,
    /- forbidden_direction: add a second attention block/u,
    'a guardrail is never cut to fit a budget; a truncated prohibition reads as a weaker one',
  )
  assert.doesNotMatch(
    byId.get('source:test/guardrails').text,
    /←/u,
    'provenance is metadata, not model text — the model gets the rule, the dump gets the source',
  )
  assert.equal(byId.get('source:test/guardrails').provenance.quota, 'hard')
  assert.equal(byId.get('source:test/guardrails').revision, packetValue.digest)

  const ranked = byId.get('source:test/ranked')
  assert.ok(ranked.text.length <= 40, `the ranked fragment respects the host budget (${ranked.text.length} > 40)`)
  assert.equal(ranked.provenance.delegated_to, 'test-strategy')
})

test('project() reports a budget that the hard half alone already exceeds, instead of cutting it', () => {
  const packetValue = packet()
  const runtime = createInjectionPacketSource({ build: fixed(packetValue) }).create({
    sourceInstanceKey: 'source:test',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })

  const contribution = runtime.project(projectRequest(packetValue, { maxCharacters: 10 }))

  assert.equal(contribution.fragments.length, 4)
  assert.equal(
    contribution.fragments.find((fragment) => fragment.id === 'source:test/frontier').text.includes('candidate=c1'),
    true,
    'the frontier is part of the hard quota: an under-budget projection is a host problem to surface, not a reason to hide the frontier',
  )
  assert.equal(contribution.presentation.visibleItems, 6)
})

test('a routed section is not in the projected text, and query() serves it on demand', () => {
  const packetValue = packet({ recipesMode: 'routed' })
  const runtime = createInjectionPacketSource({ build: fixed(packetValue) }).create({
    sourceInstanceKey: 'source:test',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })

  const contribution = runtime.project(projectRequest(packetValue))
  const evidence = runtime.query({
    view: { id: 'view:1', scope: { storage: 'workspace', workspaceId: '/tmp/ws' } },
    route: {
      id: 'source:test/ranked',
      sourceInstanceKey: 'source:test',
      sourceRouteId: 'ranked',
      description: 'read the staged ranked corpus',
      capability: 'search',
      inputSchema: {},
      readGrantId: 'grant:1',
      maxCalls: 1,
      maxResults: 1,
    },
    grant: { id: 'grant:1', sourceInstanceKey: 'source:test', schema: 'reprise.injection-packet/v1', value: {}, revision: packetValue.digest, consistency: 'exact-snapshot' },
    input: {},
  })

  assert.doesNotMatch(contribution.fragments.map((fragment) => fragment.text).join('\n'), /warm up for one epoch/u)
  assert.equal(evidence.sourceInstanceKey, 'source:test')
  assert.equal(evidence.viewId, 'view:1')
  assert.deepEqual(
    evidence.items.map((item) => item.id),
    ['recipe:a-recipe'],
    'one result, because the route said maxResults: 1 — the ceiling is the host\'s',
  )
  assert.equal(evidence.truncated, true, 'and it says so, rather than looking like the whole corpus')
  assert.equal(evidence.items[0].text, 'recipe: warm up for one epoch')
  assert.equal(evidence.items[0].provenance.source, 'experience-file')
})

test('a packet that cannot be built yields an unavailable source instead of an exception', () => {
  const runtime = createInjectionPacketSource({
    build: () => {
      throw new Error('the fact plane is unreadable')
    },
  }).create({ sourceInstanceKey: 'source:test', provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' } })

  const facts = runtime.facts(factsRequest())

  assert.equal(facts.availability, 'unavailable', 'a turn must be able to continue without the packet; it is not required by anything')
  assert.match(facts.hints.unavailable, /unreadable/u)
  assert.deepEqual(runtime.project(projectRequest({ digest: 'x' })).fragments, [])
  assert.match(
    runtime.query({
      view: { id: 'view:1', scope: { storage: 'workspace' } },
      route: { id: 'r', sourceInstanceKey: 'source:test', sourceRouteId: 'ranked', description: '', capability: 'search', inputSchema: {}, readGrantId: 'g', maxCalls: 1 },
      grant: { id: 'g', sourceInstanceKey: 'source:test', schema: 'reprise.injection-packet/v1', value: {}, revision: 'x', consistency: 'exact-snapshot' },
      input: {},
    }).unavailable,
    /the fact plane is unreadable/u,
    'the read reports the failure it actually hit, rather than a generic "unavailable"',
  )
})

test('without memory spaces the packet is still complete, and the source says it is degraded', () => {
  const packetValue = buildPacket({
    view: frontierView({ candidates: [done('c1', 0.7301)] }),
    config: injectionConfig(),
    workspaceDir: workspaceWithRecipes(),
    strategy: port(() => {
      throw new Error('no memory space can be created: the subagent provider is missing')
    }),
  })
  const runtime = createInjectionPacketSource({ build: fixed(packetValue) }).create({
    sourceInstanceKey: 'source:test',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })

  const facts = runtime.facts(factsRequest())
  const contribution = runtime.project(projectRequest(packetValue))

  assert.equal(facts.availability, 'degraded', 'the hard half is complete; the ranked half is missing, and the host can tell')
  assert.deepEqual(facts.hints.degraded, ['ranked_strategy_failed'])
  assert.match(contribution.fragments.map((fragment) => fragment.text).join('\n'), /- global_best: candidate=c1/u)
  assert.match(
    contribution.fragments.find((fragment) => fragment.id === 'source:test/ranked').text,
    /\(none\)/u,
    'the ranked section is honestly empty, not absent',
  )
})

test('an aborted read stops instead of finishing work nobody will read', () => {
  const packetValue = packet()
  const runtime = createInjectionPacketSource({ build: fixed(packetValue) }).create({
    sourceInstanceKey: 'source:test',
    provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
  })
  const controller = new AbortController()
  controller.abort()

  assert.throws(
    () =>
      runtime.query({
        view: { id: 'view:1', scope: { storage: 'workspace' } },
        route: { id: 'r', sourceInstanceKey: 'source:test', sourceRouteId: 'ranked', description: '', capability: 'search', inputSchema: {}, readGrantId: 'g', maxCalls: 1 },
        grant: { id: 'g', sourceInstanceKey: 'source:test', schema: 'reprise.injection-packet/v1', value: {}, revision: packetValue.digest, consistency: 'exact-snapshot' },
        input: {},
        signal: controller.signal,
      }),
    /abort/iu,
  )
})

test('the two ranked sections keep their own instance identity, so a strategy can grant them differently', () => {
  assert.deepEqual(
    SOFT_SOURCES.map((source) => [source.section, source.role]),
    [
      ['recipes', 'recipe'],
      ['candidate_experiences', 'candidate-experience'],
    ],
  )
})