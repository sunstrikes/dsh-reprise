/**
 * Guards the decision "the parts of the packet that need a trade-off are handed to a dsh-mnemon
 * strategy, and this package does not re-implement the trade-off" (spec: 注入包与记忆; issue 10).
 *
 * The seam is one function. Upstream of it is a corpus of recipes and candidate experiences that
 * cannot all fit; downstream is a strategy that says which of them are resident and how much room
 * each gets. Everything about *which* strategy runs, how it weighs sources, and what its budgets are
 * is mnemon's; everything about rendering what it decided is this package's.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SOFT_SOURCES, mnemonStrategyPort } from '../lib/strategy.js'

/** A strategy definition with exactly the shape mnemon's `defineMemoryStrategy` produces. */
function strategy({ typeId = 'fake-strategy', decide } = {}) {
  return {
    manifest: {
      apiVersion: 'dsh-mnemon/v1',
      kind: 'strategy',
      typeId,
      packageName: 'dsh-mnemon-strategy-fake',
      deterministic: true,
      supportedSourceRoles: ['*'],
      maxSources: 32,
      maxRoutes: 32,
      maxActions: 32,
    },
    compose: decide ?? (() => ({ strategyTypeId: typeId, explanation: 'nothing admitted', sources: [] })),
  }
}

const request = { workspace: '/tmp/ws-strategy', sections: { recipes: [], candidate_experiences: [] }, budget: { maxCharacters: 6_000 } }

test('the strategy sees a mnemon-shaped view request and the two ranked sources', () => {
  let seen
  const port = mnemonStrategyPort(
    strategy({
      decide: (viewRequest, sources) => {
        seen = { viewRequest, sources }
        return { strategyTypeId: 'fake-strategy', explanation: 'ok', sources: [] }
      },
    }),
  )

  port.compose(request)

  assert.deepEqual(
    seen.viewRequest.scope,
    { storage: 'workspace', workspaceId: '/tmp/ws-strategy' },
    'the scope is the workspace: two runs must not share memory, so the strategy is told which one this is',
  )
  assert.equal(seen.viewRequest.scenario, 'reprise.injection-packet')
  assert.equal(
    seen.viewRequest.budget.maxProjectionCharacters,
    6_000,
    'the candidate budget is the one the packet asked for, so the deployment can cap it in one place',
  )
  assert.equal(typeof seen.viewRequest.budget.maxRoutes, 'number', 'the rest of the budget is a complete mnemon budget, not a partial one')
  assert.deepEqual(
    seen.sources.map((source) => [source.sourceInstanceKey, source.role, source.capabilities]),
    SOFT_SOURCES.map((source) => [source.sourceInstanceKey, source.role, ['project', 'search']]),
    'the strategy is offered exactly the two ranked sections, and nothing writable',
  )
  assert.deepEqual(
    seen.sources.map((source) => source.actions),
    [[], []],
    'a ranked section has no write action: the model never writes memory through the packet',
  )
})

test('whatever the strategy granted is what the sections get — eager, routed, and characters', () => {
  const port = mnemonStrategyPort(
    strategy({
      decide: () => ({
        strategyTypeId: 'fake-strategy',
        explanation: 'recipes are resident, experiences are on demand',
        sources: [
          { sourceInstanceKey: SOFT_SOURCES[0].sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 1_234 } },
          { sourceInstanceKey: SOFT_SOURCES[1].sourceInstanceKey, projection: { mode: 'routed', maxCharacters: 4_321 } },
        ],
      }),
    }),
  )

  const decision = port.compose(request)

  assert.equal(decision.strategy, 'fake-strategy')
  assert.equal(decision.explanation, 'recipes are resident, experiences are on demand')
  assert.deepEqual(decision.sections.recipes, { mode: 'eager', maxCharacters: 1_234 })
  assert.deepEqual(decision.sections.candidate_experiences, { mode: 'routed', maxCharacters: 4_321 })
})

test('a source the strategy did not select is routed with no budget, not silently eager', () => {
  const port = mnemonStrategyPort(strategy())

  const decision = port.compose(request)

  assert.deepEqual(decision.sections.recipes, { mode: 'routed', maxCharacters: 0 })
  assert.deepEqual(decision.sections.candidate_experiences, { mode: 'routed', maxCharacters: 0 })
})

test('the two ranked sources are addressable the way the host addresses a source', () => {
  assert.deepEqual(
    SOFT_SOURCES.map((source) => [source.section, source.role]),
    [
      ['recipes', 'recipe'],
      ['candidate_experiences', 'candidate-experience'],
    ],
  )
  for (const source of SOFT_SOURCES) {
    // mnemon's own Source-key pattern: `source:` plus a stable id. A key outside it is rejected by
    // the host, and `general`'s residentSourceKeys could never name it.
    assert.match(source.sourceInstanceKey, /^source:[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u)
  }
})

test('a strategy that is not a strategy is refused at the seam, not called and hoped over', () => {
  assert.throws(() => mnemonStrategyPort({}), /compose/u, 'a definition without compose cannot decide anything, and pretending otherwise would make every section look empty on purpose')
  assert.throws(() => mnemonStrategyPort(undefined), /compose/u)
})