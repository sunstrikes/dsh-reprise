/**
 * Guards the decision "every round freezes a content-addressed parent snapshot, so 'this round
 * started from whom' can be recovered afterwards" (issue 22; parity gap 2B).
 *
 * Content-addressed is a claim about the *address*, and it is only worth anything if both halves
 * hold: the same inputs must produce the same address (so a re-plan after a crash is recognisably the
 * same decision), and any change in the inputs must produce a different one (so nobody can swap a
 * parent out behind the address). A counter or a timestamp satisfies neither.
 *
 * The record must also carry what a reader needs to reconstruct the decision without the code that
 * took it: the frontier with each member's vector, the baseline marked as the baseline, the parent
 * order, which axis led the rotation, and the contract the comparison was made under.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { parentSnapshot } from '../lib/frontier.js'

const CONTRACT = {
  ok: true,
  status: 'ok',
  ref: 'auc-loss',
  primary: 'auc',
  objectives: [
    { name: 'auc', direction: 'up', kind: 'primary' },
    { name: 'loss', direction: 'down', kind: 'objective' },
  ],
}

const SET = {
  contract: CONTRACT,
  empty: false,
  members: [
    { candidate_id: 'baseline', round: null, vector: { auc: 0.7012 }, baseline: true },
    { candidate_id: 'r1-h1', round: 1, vector: { auc: 0.73, loss: 0.4 } },
    { candidate_id: 'r1-h2', round: 1, vector: { auc: 0.715, loss: 0.31 } },
  ],
}

const INPUT = {
  round: 2,
  events_prefix: { last_local_seq: 41 },
  set: SET,
  parents: ['r1-h1', 'r1-h2'],
  offset: 0,
}

/** Stable stringify, written here rather than imported: the test must not use the code it checks. */
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}

const addressOf = (content) => createHash('sha256').update(canonical(content)).digest('hex')

test('the same inputs give the same address, twice — a re-plan is recognisably the same decision', () => {
  const first = parentSnapshot(INPUT)
  const again = parentSnapshot({ ...INPUT, set: { ...SET, members: [...SET.members] } })

  assert.equal(first.address, again.address)
  assert.deepEqual(first.content, again.content, 'the record itself is a function of the facts, not of when it was taken')
})

test('every input that shaped the decision changes the address', () => {
  const base = parentSnapshot(INPUT).address
  const variants = {
    'the parent order': { ...INPUT, parents: ['r1-h2', 'r1-h1'] },
    'the round': { ...INPUT, round: 3 },
    'the event prefix': { ...INPUT, events_prefix: { last_local_seq: 42 } },
    'the rotation offset': { ...INPUT, offset: 1 },
    'a frontier number': {
      ...INPUT,
      set: { ...SET, members: [SET.members[0], { ...SET.members[1], vector: { auc: 0.74, loss: 0.4 } }, SET.members[2]] },
    },
    'the contract the comparison was made under': {
      ...INPUT,
      set: { ...SET, contract: { ...CONTRACT, ref: 'auc-loss@2' } },
    },
    'a member leaving the set': { ...INPUT, set: { ...SET, members: [SET.members[0], SET.members[1]] } },
  }
  for (const [what, input] of Object.entries(variants)) {
    assert.notEqual(parentSnapshot(input).address, base, `${what} must change the address, or the address is not a digest of the decision`)
  }
})

test('the address is the digest of the content, so a recovered record can be verified without us', () => {
  const { address, content } = parentSnapshot(INPUT)

  assert.equal(address, addressOf(content), 'a reader who finds the record on disk must be able to re-derive its address')
  assert.match(address, /^[0-9a-f]{64}$/, 'one address format, so it can be a filename or a field')
})

test('the record carries enough to answer "who did this round start from", baseline included', () => {
  const { content } = parentSnapshot(INPUT)

  assert.equal(content.round, 2)
  assert.deepEqual(content.parents, ['r1-h1', 'r1-h2'], 'the order is the decision: candidate i starts from parent i')
  assert.deepEqual(content.frontier.map((member) => member.candidate_id), ['baseline', 'r1-h1', 'r1-h2'])
  assert.equal(content.frontier[0].baseline, true, 'the baseline is marked, so nobody mistakes it for a candidate')
  assert.deepEqual(content.frontier[2].vector, { auc: 0.715, loss: 0.31 }, 'the numbers the decision was made on travel with it')
  assert.deepEqual(content.rotation, { axes: ['auc', 'loss'], offset: 0 }, 'which axis led the rotation is part of the decision')
  assert.deepEqual(content.contract, {
    ref: 'auc-loss',
    primary: 'auc',
    status: 'ok',
    objectives: [
      { name: 'auc', direction: 'up' },
      { name: 'loss', direction: 'down' },
    ],
  })
})

test('a round with nothing comparable snapshots the baseline as its only parent', () => {
  const { content } = parentSnapshot({
    round: 1,
    events_prefix: { last_local_seq: 0 },
    set: { contract: { ok: false, status: 'missing', objectives: [], primary: undefined }, members: [], empty: true },
    parents: ['baseline'],
  })

  assert.deepEqual(content.parents, ['baseline'])
  assert.equal(content.empty, true)
  assert.deepEqual(content.frontier, [])
  assert.equal(content.contract.status, 'missing', 'an unusable contract is recorded as such, not as an empty one that looks fine')
})