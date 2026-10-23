/**
 * Guards the decision "the injection packet is assembled from facts, and its hard-quota parts are
 * supplied verbatim — no ranking, no truncation" (spec: 注入包与记忆; issue 10).
 *
 * The packet is the exact context a model turn receives. These tests are about the three things a
 * reader of a run is entitled to assume: every guardrail the operator declared is in it, every
 * number in it traces back to a fact, and nothing in it was chosen by a score this module invented.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPacket } from '../lib/packet.js'
import { done, frontierView, injectionConfig, row, workspace, writeRawExperience } from './support/fixtures.js'

test('the guardrails are handed over verbatim, in the order the operator declared them', () => {
  const packet = buildPacket({
    view: frontierView({ candidates: [] }),
    config: injectionConfig({
      forbidden: ['add a second attention block', 'change the tokenizer'],
      patterns: ['raising the learning rate to fix instability'],
    }),
    workspaceDir: '/tmp/ws-guardrails',
  })

  assert.deepEqual(
    packet.sections.guardrails.items.map((item) => item.text),
    [
      'forbidden_direction: add a second attention block',
      'forbidden_direction: change the tokenizer',
      'anti_pattern: raising the learning rate to fix instability',
    ],
    'every declared guardrail is present, in declaration order — no ranking, no dedupe, no trim',
  )
  assert.equal(packet.sections.guardrails.quota, 'hard')
  assert.deepEqual(
    packet.sections.guardrails.items.map((item) => item.provenance.ref),
    [
      'injection.guardrails.forbidden_directions[0]',
      'injection.guardrails.forbidden_directions[1]',
      'injection.guardrails.anti_patterns[0]',
    ],
    'each line names the config path it came from, so "why is this here" has an answer',
  )
})

test('a long guardrail list is never truncated, whatever the ranked-side budget says', () => {
  const many = Array.from({ length: 40 }, (_, index) => `direction-${index}`)
  const packet = buildPacket({
    view: frontierView({ candidates: [] }),
    config: {
      injection: {
        guardrails: { forbidden_directions: many, anti_patterns: [] },
        ranked: { max_characters: 120 },
      },
    },
    workspaceDir: '/tmp/ws-long-guardrails',
  })

  assert.equal(
    packet.sections.guardrails.items.filter((item) => item.provenance.kind === 'forbidden_direction').length,
    40,
    'the ranked budget may not reach the hard-quota sections',
  )
})

test('the singletons are the global best and the search space, both supplied whole', () => {
  const packet = buildPacket({
    view: frontierView({
      candidates: [done('c1', 0.7123), done('c2', 0.7301, { onFrontier: true })],
    }),
    config: injectionConfig({
      searchSpace: { priors: ['warmup=1'], tunable: [{ name: 'depth', values: [6, 8] }] },
    }),
    workspaceDir: '/tmp/ws-singletons',
  })

  assert.deepEqual(
    packet.sections.singletons.items.map((item) => item.text),
    [
      'global_best: candidate=c2 metric=auc value=0.7301 round=1',
      'search_space.priors: ["warmup=1"]',
      'search_space.tunable: [{"name":"depth","values":[6,8]}]',
    ],
    'the best candidate and every declared search-space group, rendered as they were declared',
  )
  assert.deepEqual(packet.sections.singletons.items[0].provenance, {
    kind: 'global_best',
    source: 'frontier',
    ref: 'best',
    candidate_id: 'c2',
    metric: 'auc',
    value: 0.7301,
    round: 1,
  })
  assert.equal(
    packet.sections.singletons.items[1].provenance.ref,
    'injection.search_space.priors',
    'the search space is traced to the group it came from, not to a merged blob',
  )
})

test('the current frontier is every candidate with its vector and position, not a top-N', () => {
  const packet = buildPacket({
    view: frontierView({
      objectives: [
        ['auc', 'up'],
        ['loss', 'down'],
      ],
      candidates: [
        done('c1', 0.7123, { vector: { auc: 0.7123, loss: 0.31 }, onFrontier: false, dominatedBy: 'c2' }),
        done('c2', 0.7301, { round: 2, vector: { auc: 0.7301, loss: 0.29 } }),
        row({
          candidate_id: 'c3',
          status: 'active',
          metrics: { auc: 0.5 },
          vector: { auc: 0.5 },
          complete: false,
          missing: ['loss'],
        }),
      ],
    }),
    config: injectionConfig(),
    workspaceDir: '/tmp/ws-frontier',
  })

  assert.deepEqual(
    packet.sections.frontier.items.map((item) => item.text),
    [
      'objectives: auc=up, loss=down',
      'candidate=c1 round=1 status=done vector=auc:0.7123,loss:0.31 position=dominated_by:c2',
      'candidate=c2 round=2 status=done vector=auc:0.7301,loss:0.29 position=frontier',
      'candidate=c3 round=1 status=active vector=auc:0.5 position=unranked missing=loss',
    ],
    'four candidates in, four lines out — the packet cannot quietly show the model only the winner',
  )
  assert.equal(packet.sections.frontier.quota, 'hard')
})

test('the packet digest is a function of its facts: same facts, same digest; new number, new digest', () => {
  const build = (candidates) =>
    buildPacket({
      view: frontierView({ candidates }),
      config: injectionConfig(),
      workspaceDir: '/tmp/ws-digest',
    })

  const first = build([done('c1', 0.7123)])
  const again = build([done('c1', 0.7123)])
  const changed = build([done('c1', 0.7124)])

  assert.equal(first.digest, again.digest, 'a packet is reproducible, so two readers can prove they saw one context')
  assert.notEqual(first.digest, changed.digest, 'a metric that moved is a different packet, not the same one with a new number')
})
// ------------------------------------------------------------------ the ranked half

/** A strategy port-shaped object: the port is a seam, so a test may be its only implementation. */
const port = (decide) => ({ strategy: 'test-strategy', compose: (request) => decide(request) })

const recipesWorkspace = () =>
  workspace([
    { experience_id: 'a-recipe', section: 'recipes', text: 'warm up for one epoch' },
    { experience_id: 'b-recipe', section: 'recipes', text: 'freeze the embedding layer' },
    { experience_id: 'c-experience', section: 'candidate_experiences', text: 'depth 8 beat depth 6' },
  ])

test('the ranked half is the port decision, item for item — this module does not re-rank it', () => {
  const workspaceDir = recipesWorkspace()
  const packet = buildPacket({
    view: frontierView({ candidates: [done('c1', 0.71)] }),
    config: injectionConfig(),
    workspaceDir,
    strategy: port(() => ({
      strategy: 'test-strategy',
      explanation: 'the port picked b first',
      sections: {
        recipes: { mode: 'eager', maxCharacters: 1_000, itemIds: ['b-recipe', 'a-recipe'] },
        candidate_experiences: { mode: 'eager', maxCharacters: 1_000, itemIds: ['c-experience'] },
      },
    })),
  })

  assert.deepEqual(
    packet.ranked.recipes.items.map((item) => item.text),
    ['recipe: freeze the embedding layer', 'recipe: warm up for one epoch'],
    'the order is the one the port gave; "b before a" may be wrong, but it is not this module\'s call',
  )
  assert.equal(packet.ranked.recipes.delegated_to, 'test-strategy')
  assert.equal(packet.ranked.recipes.explanation, 'the port picked b first')
  assert.deepEqual(packet.ranked.candidate_experiences.items.map((item) => item.text), ['candidate_experience: depth 8 beat depth 6'])
})

test('without named picks a section fills the budget it was granted, and what did not fit is staged, not lost', () => {
  const workspaceDir = recipesWorkspace()
  const packet = buildPacket({
    view: frontierView({}),
    config: injectionConfig(),
    workspaceDir,
    // Room for exactly one recipe: 'recipe: warm up for one epoch' is 29 characters, the next is 34.
    strategy: port(() => ({
      strategy: 'test-strategy',
      sections: { recipes: { mode: 'eager', maxCharacters: 34 }, candidate_experiences: { mode: 'routed', maxCharacters: 0 } },
    })),
  })

  assert.deepEqual(packet.ranked.recipes.items.map((item) => item.fact_id), ['recipe:a-recipe'])
  assert.deepEqual(
    packet.ranked.recipes.staged.map((item) => [item.fact_id, item.reason]),
    [['recipe:b-recipe', 'over_budget']],
    'a recipe that did not fit is still a fact the run can reach; dropping it silently would hide it forever',
  )
})

test('a routed section is not projected into the packet text, and its items are still staged', () => {
  const workspaceDir = recipesWorkspace()
  const packet = buildPacket({
    view: frontierView({}),
    config: injectionConfig(),
    workspaceDir,
    strategy: port(() => ({
      strategy: 'test-strategy',
      sections: {
        recipes: { mode: 'routed', maxCharacters: 4_000 },
        candidate_experiences: { mode: 'routed', maxCharacters: 4_000 },
      },
    })),
  })

  assert.deepEqual(packet.ranked.recipes.items, [], 'routed means "on demand", so nothing is spent on it up front')
  assert.deepEqual(
    packet.ranked.recipes.staged.map((item) => item.reason),
    ['routed', 'routed'],
    'the corpus is still addressable through the source route',
  )
})

test('a guardrail promotion has one home: it is supplied, and it never reaches the strategy that ranks', () => {
  const workspaceDir = workspace([
    { experience_id: 'g-guardrail', section: 'guardrails', text: 'never widen the head' },
    { experience_id: 'a-recipe', section: 'recipes', text: 'warm up for one epoch' },
  ])
  let seen
  const packet = buildPacket({
    view: frontierView({}),
    config: injectionConfig(),
    workspaceDir,
    strategy: port((request) => {
      seen = request
      return { strategy: 'test-strategy', sections: { recipes: { mode: 'eager', maxCharacters: 1_000 }, candidate_experiences: { mode: 'eager', maxCharacters: 1_000 } } }
    }),
  })

  assert.deepEqual(
    seen.sections.recipes.map((item) => item.experience_id),
    ['a-recipe'],
    'the guardrail is already in the packet verbatim; offering it to the ranking strategy would count it twice',
  )
  const occurrences = JSON.stringify(packet).split('never widen the head').length - 1
  assert.equal(occurrences, 1, 'one promotion, one place — in the guardrail section')
  assert.deepEqual(packet.suppressed, [], 'and nothing had to be suppressed to achieve it: the split is by construction')
})

test('a missing or failing strategy still yields a complete packet, and says what is missing', () => {
  const workspaceDir = recipesWorkspace()
  const hard = (packet) => [
    ...packet.sections.guardrails.items,
    ...packet.sections.singletons.items,
    ...packet.sections.frontier.items,
  ]

  const withoutStrategy = buildPacket({ view: frontierView({ candidates: [done('c1', 0.71)] }), config: injectionConfig(), workspaceDir })
  const withFailingStrategy = buildPacket({
    view: frontierView({ candidates: [done('c1', 0.71)] }),
    config: injectionConfig(),
    workspaceDir,
    strategy: port(() => {
      throw new Error('mnemon provider unavailable: no memory space can be created')
    }),
  })

  assert.equal(hard(withoutStrategy).length, hard(withFailingStrategy).length, 'the hard quota does not depend on the ranked half')
  assert.ok(hard(withFailingStrategy).length >= 4)
  assert.deepEqual(
    withoutStrategy.degraded.map((entry) => entry.code),
    ['no_ranked_strategy'],
  )
  assert.deepEqual(
    withFailingStrategy.degraded.map((entry) => entry.code),
    ['ranked_strategy_failed'],
    'the reason a turn saw fewer recipes is a fact about the packet, not a stack trace in a log',
  )
  assert.match(withFailingStrategy.degraded[0].message, /no memory space can be created/u)
  assert.deepEqual(withFailingStrategy.ranked.recipes.items, [])
  assert.equal(
    withFailingStrategy.ranked.recipes.staged.length,
    2,
    'the corpus is still staged, so the packet lost nothing it could have shown on demand',
  )
})

test('a promotion the reader rejected is reported inside the packet, where a dump can show it', () => {
  const workspaceDir = workspace([{ experience_id: 'ok', section: 'recipes', text: 'a real recipe' }])
  writeRawExperience(workspaceDir, 'broken', '{ oops')

  const packet = buildPacket({ view: frontierView({}), config: injectionConfig(), workspaceDir })

  const rejection = packet.problems.find((problem) => problem.code === 'experience_rejected')
  assert.ok(rejection, 'a promotion that could not be read is a problem of this packet, not of a log file')
  assert.match(rejection.file, /experiences\/broken\.json$/u)
})

test('no fact appears twice in one packet', () => {
  const workspaceDir = workspace([
    { experience_id: 'g', section: 'guardrails', text: 'never widen the head' },
    { experience_id: 's', section: 'singletons', text: 'hold the baseline at 0.70' },
    { experience_id: 'r', section: 'recipes', text: 'warm up for one epoch' },
    { experience_id: 'e', section: 'candidate_experiences', text: 'depth 8 beat depth 6' },
  ])
  const packet = buildPacket({
    view: frontierView({ candidates: [done('c1', 0.71)] }),
    config: injectionConfig({ searchSpace: { tunable: ['depth'] } }),
    workspaceDir,
    strategy: port(() => ({
      strategy: 'test-strategy',
      sections: { recipes: { mode: 'eager', maxCharacters: 1_000 }, candidate_experiences: { mode: 'eager', maxCharacters: 1_000 } },
    })),
  })

  const ids = [
    ...packet.sections.guardrails.items,
    ...packet.sections.singletons.items,
    ...packet.sections.frontier.items,
    ...packet.ranked.recipes.items,
    ...packet.ranked.candidate_experiences.items,
  ].map((item) => item.fact_id)

  assert.equal(new Set(ids).size, ids.length, 'a fact that appears twice is counted twice by every reader of the packet')
  assert.deepEqual(packet.suppressed, [], 'and the guarantee comes from the split, not from a filter running afterwards')
})
