/**
 * Guards the decision "the search is a tree, and the page can draw it without inventing a fact".
 *
 * Three properties, and each one is a way the picture could lie:
 *
 *   1. **The edges are the planner's.** A candidate hangs off the parent its round assigned it
 *      (`parent_id`), and the baseline is the root. A tree assembled from anything else — "who was
 *      best that round", "who ran first" — would be a plausible shape with no fact behind it.
 *   2. **A missing child has a reason, and the reason belongs to the round that did not pick it.**
 *      `passed-over` is read from that round's frozen roster, not from today's frontier: a candidate
 *      dominated now may have led the frontier when the round was planned, and "we rotated to the
 *      other axis" is the truthful answer while "it was no good" is not.
 *   3. **The four states keep their names.** An artifact that arrived and broke its schema is drawn
 *      as `invalid`, a change the gate refused as `rejected`, and a branch that is merely still
 *      running as in flight — CODING_STANDARDS §2, on a second surface.
 *
 * What this file does not test: whether a browser paints it. The projection is the seam the panel
 * and the page share, and the page's own scans live in `packages/ui/test`.
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { fileArtifacts } from '../lib/artifacts.js'
import { createCandidate, rejectCandidate } from '../lib/loop.js'
import { searchTree } from '../lib/projection.js'
import { Store } from '../lib/store.js'
import { openWorkspace, runCandidate, seedConfig } from './support/fake-ports.js'

const CONFIG = { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_rounds: 0 } }

/** Write the parent the planner writes: `parent_id` in the candidate's phase state. */
function assignParent(store, candidateId, parentId) {
  const phase = store.getState(candidateId, 'phase') ?? {}
  store.setState(candidateId, 'phase', { ...phase, parent_id: parentId })
}

/**
 * The roster a round freezes before it creates anything: who it started from, and the set it chose
 * from. Written through the same artifact store the kernel uses, so the projection reads a real file
 * and not a stub it was handed.
 */
function freezeRoster(store, round, { parents, frontier, offset = 0 }) {
  return fileArtifacts(join(dirname(store.path), 'artifacts')).write(`round-${round}/parents`, {
    address: `test-address-${round}`,
    content: {
      round,
      parents,
      empty: parents.length === 0,
      frontier: frontier.map((candidateId) => ({ candidate_id: candidateId, vector: {}, baseline: candidateId === 'baseline' })),
      rotation: { axes: ['auc'], offset },
      contract: { primary: 'auc', objectives: [{ name: 'auc', direction: 'up' }] },
    },
  })
}

/** Two finished candidates of round 1, both rooted at the baseline. */
async function twoRoots() {
  const ports = openWorkspace({ config: CONFIG })
  seedConfig(ports.store, CONFIG)
  await runCandidate(ports, { candidateId: 'r1-a', round: 1, metrics: { auc: 0.72 } })
  await runCandidate(ports, { candidateId: 'r1-b', round: 1, metrics: { auc: 0.7 } })
  assignParent(ports.store, 'r1-a', 'baseline')
  assignParent(ports.store, 'r1-b', 'baseline')
  return ports
}

const byId = (tree) => new Map(tree.nodes.map((node) => [node.candidate_id, node]))

test('every candidate hangs off the parent its round assigned, and the baseline is the root', async () => {
  const ports = await twoRoots()
  await runCandidate(ports, { candidateId: 'r2-a', round: 2, metrics: { auc: 0.73 } })
  assignParent(ports.store, 'r2-a', 'r1-a')

  const tree = searchTree(ports.store, { config: CONFIG })
  const nodes = byId(tree)

  assert.deepEqual(tree.baseline.children, ['r1-a', 'r1-b'], 'the baseline roots both candidates of round 1')
  assert.deepEqual(tree.edges, [
    { from: 'baseline', to: 'r1-a' },
    { from: 'baseline', to: 'r1-b' },
    { from: 'r1-a', to: 'r2-a' },
  ])
  assert.equal(nodes.get('r1-a').continuation.kind, 'continued', 'a node with a child says so')
  assert.deepEqual(nodes.get('r2-a').children, [])
  assert.equal(nodes.get('r2-a').parent, 'r1-a')
  assert.equal(nodes.get('r1-b').value, 0.7, 'the node carries the number the ranking gave it')
  ports.store.close()
})

test('a finished branch a later round did not pick says so, from that round\'s frozen roster', async () => {
  const ports = await twoRoots()
  freezeRoster(ports.store, 2, { parents: ['r1-a'], frontier: ['r1-a', 'r1-b'], offset: 1 })
  await runCandidate(ports, { candidateId: 'r2-a', round: 2, metrics: { auc: 0.73 } })
  assignParent(ports.store, 'r2-a', 'r1-a')

  const nodes = byId(searchTree(ports.store, { config: CONFIG }))

  assert.deepEqual(
    nodes.get('r1-b').continuation,
    { kind: 'passed-over', round: 2, slots: 1, offset: 1, axis: 'auc' },
    'eligible on that round\'s frontier and not named: the rotation passed it over, and the round says which rotation',
  )
  assert.equal(nodes.get('r1-a').continuation.kind, 'continued')
  ports.store.close()
})

test('a parent the round named but created no candidate from is its own answer, not "passed over"', async () => {
  const ports = await twoRoots()
  freezeRoster(ports.store, 2, { parents: ['r1-a', 'r1-b'], frontier: ['r1-a', 'r1-b'] })
  await runCandidate(ports, { candidateId: 'r2-a', round: 2, metrics: { auc: 0.73 } })
  assignParent(ports.store, 'r2-a', 'r1-a')

  const nodes = byId(searchTree(ports.store, { config: CONFIG }))

  assert.deepEqual(nodes.get('r1-b').continuation, { kind: 'roster-unused', round: 2, slots: 2, offset: 0, axis: 'auc' })
  ports.store.close()
})

test('a branch no later round recorded a roster for is not explained away', async () => {
  const ports = await twoRoots()
  await runCandidate(ports, { candidateId: 'r2-a', round: 2, metrics: { auc: 0.73 } })
  assignParent(ports.store, 'r2-a', 'r1-a')

  const tree = searchTree(ports.store, { config: CONFIG })
  const nodes = byId(tree)

  assert.deepEqual(
    nodes.get('r1-b').continuation,
    { kind: 'no-roster', round: 2 },
    'the round exists and its roster is missing: the reason is absent from the facts, and the tree says so',
  )
  assert.ok(
    tree.notes.some((note) => note.includes('round 2 recorded no parent roster')),
    'and the page gets a sentence it can print, not a silent gap',
  )
  ports.store.close()
})

test('a rejected branch is never continued from, and says which phase refused it', async () => {
  const ports = openWorkspace({ config: CONFIG })
  createCandidate(ports, { candidateId: 'r1-x', round: 1, hypothesis: 'widen the embedding table' })
  rejectCandidate(ports, 'r1-x', 'VERIFY', { message: 'the review refused the diff' })

  const node = byId(searchTree(ports.store, { config: CONFIG })).get('r1-x')

  assert.equal(node.continuation.kind, 'rejected')
  assert.equal(node.rejection.phase, 'VERIFY')
  assert.equal(node.rejection.message, 'the review refused the diff')
  assert.equal(node.shape, 'rejected', 'a refusal with nothing malformed is "rejected", not "invalid"')
  ports.store.close()
})

test('a malformed artifact keeps its own shape on the tree', async () => {
  const ports = openWorkspace({ config: CONFIG })
  createCandidate(ports, { candidateId: 'r1-y', round: 1, hypothesis: 'a hypothesis whose artifact broke its schema' })
  rejectCandidate(ports, 'r1-y', 'VERIFY', { message: 'the review artifact is not the declared shape', status: 'invalid' })

  const node = byId(searchTree(ports.store, { config: CONFIG })).get('r1-y')

  assert.equal(node.shape, 'invalid', 'present and broken is a different square from refused, which is the whole four-state split')
  ports.store.close()
})

test('a workspace that recorded no parent draws no edge, and says why', async () => {
  const ports = openWorkspace({ config: CONFIG })
  seedConfig(ports.store, CONFIG)
  await runCandidate(ports, { candidateId: 'r1-a', round: 1, metrics: { auc: 0.72 } })

  const tree = searchTree(ports.store, { config: CONFIG })

  assert.deepEqual(tree.edges, [], 'no parent is not a guessed parent')
  assert.deepEqual(tree.baseline.children, [])
  assert.ok(tree.notes.some((note) => note.includes('no candidate in this workspace records a parent')))
  ports.store.close()
})

test('the tree is a pure function of the facts, and reads a handle that could not write', async () => {
  const ports = await twoRoots()
  freezeRoster(ports.store, 2, { parents: ['r1-a'], frontier: ['r1-a', 'r1-b'] })
  await runCandidate(ports, { candidateId: 'r2-a', round: 2, metrics: { auc: 0.73 } })
  assignParent(ports.store, 'r2-a', 'r1-a')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const store = Store.openReadOnly(dir)
  try {
    assert.deepEqual(searchTree(store, { config: CONFIG }), searchTree(store, { config: CONFIG }))
  } finally {
    store.close()
  }
})

test('a parent id with no facts behind it is a note, not an edge nobody can draw', async () => {
  const ports = await twoRoots()
  await runCandidate(ports, { candidateId: 'r2-a', round: 2, metrics: { auc: 0.73 } })
  assignParent(ports.store, 'r2-a', 'r9-ghost')

  const tree = searchTree(ports.store, { config: CONFIG })

  assert.deepEqual(
    tree.edges.filter((edge) => edge.from === 'r9-ghost'),
    [],
    'the edge would have one end in the air, so it is not published as one',
  )
  assert.deepEqual(tree.orphans, ['r9-ghost'])
  assert.ok(
    tree.notes.some((note) => note.includes('r9-ghost is named as a parent but has no facts')),
    'and the reader is told which id is missing instead of meeting a root with no explanation',
  )
  assert.deepEqual(
    tree.counts,
    [
      { kind: 'no-roster', count: 2 },
      { kind: 'no-later-round', count: 1 },
    ],
    'the tally is the projection\'s, and it still adds up to the candidate count',
  )
})

test('a baseline frozen in another metric is a dash and a sentence, never relabelled', async () => {
  const ports = await twoRoots()
  writeFileSync(join(dirname(ports.store.path), 'baseline.json'), JSON.stringify({ metric: 'loss', value: 0.62 }))

  const tree = searchTree(ports.store, { config: CONFIG })

  assert.equal(tree.baseline.value, null, 'a loss is not an auc, and the page prints the metric beside the number')
  assert.equal(tree.baseline.metric, null)
  assert.ok(
    tree.notes.some((note) => note.includes('the frozen baseline cannot be drawn on this metric')),
    'the mismatch is said in words, as the conclusion page already says it',
  )
  ports.store.close()
})
