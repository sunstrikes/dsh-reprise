/**
 * Guards the decision "the dashboard answers increments with an `after` cursor, and repeating a
 * request changes nothing" (spec 展示层 "数据走 `?after=<local_seq>` 增量游标"; ticket 11 AC 2).
 *
 * The seam is the same plain handler, with `query.after`. What this file owns:
 *
 *   - a full read (`after` absent) returns every fact and a cursor that names the last one;
 *   - a read with `after` returns only the facts recorded after it — no repeats, no gaps — and the
 *     `data` half is identical to a full read, so a cursor can never make a page wrong;
 *   - the cursor is a *workspace* cursor, not the largest `local_seq` in the workspace: a candidate
 *     created later starts its own `local_seq` at 1, and it must still show up (this is the test
 *     that would pass on a bare-integer cursor and hide the bug, so it is written to fail);
 *   - repeating a request is idempotent — same bytes — and two windows polling the same workspace
 *     with different cursors do not disturb each other, because the server keeps no cursor state;
 *   - a malformed cursor is a 400, not a silent full refresh.
 */

import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'

import { overviewHandler } from '../lib/routes.js'
import { openWorkspace, runCandidate, seedConfig } from '../../core/test/support/fake-ports.js'

const config = (extra = {}) => ({ metrics: { primary: 'auc', objectives: { auc: 'up' } }, ...extra })

async function portsFor(extra = {}) {
  const ports = openWorkspace({ config: config({ stop: { max_rounds: 0 }, ...extra }) })
  seedConfig(ports.store, ports.config)
  return ports
}

const dirOf = (ports) => dirname(ports.store.path)

test('a full read returns every fact and a cursor that names the last one; repeating it is byte-identical', async () => {
  const ports = await portsFor()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirOf(ports)

  const first = overviewHandler(dir, {})
  const second = overviewHandler(dir, {})

  const facts = ports.store.eventSubjects().reduce((total, subject) => total + ports.store.eventsFor(subject).length, 0)
  assert.equal(first.after, null, 'no cursor was asked for, and the answer says so')
  assert.equal(first.incremental.events.length, facts, 'every fact is delivered on the first read')
  assert.equal(first.more, true)
  assert.deepEqual(second, first, 'the same request over the same facts is the same answer — no clock, no counter')

  const lastEvent = ports.store.eventsFor('r1-c1').at(-1)
  assert.equal(
    first.cursor,
    `${lastEvent.wall_clock_ms}:r1-c1:${lastEvent.local_seq}`,
    'the cursor names the last fact by the store\'s own order: wall clock, then identity',
  )
  ports.store.close()
})

test('a candidate created after the cursor still arrives: the cursor is workspace-wide, not the largest local_seq', async () => {
  const ports = await portsFor()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirOf(ports)

  // What a browser holds after its first read, before round 2 exists.
  const { cursor: watermark } = overviewHandler(dir, {})

  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.75 } })

  const delta = overviewHandler(dir, { after: watermark })
  const roundTwoFacts = ports.store.eventsFor('r2-c1').length

  assert.ok(roundTwoFacts >= 3, 'the fixture really did write a candidate worth watching')
  assert.equal(delta.incremental.events.length, roundTwoFacts, 'every new fact once, and nothing from round 1 again')
  assert.deepEqual(
    [...new Set(delta.incremental.events.map((event) => event.candidate_id))],
    ['r2-c1'],
    'r2-c1 starts its own local_seq at 1; a cursor compared as a bare integer would silently drop it',
  )
  assert.deepEqual(
    delta.incremental.events.map((event) => event.local_seq),
    ports.store.eventsFor('r2-c1').map((event) => event.local_seq),
    'and in the order the facts were written, so a timeline can be appended as it arrives',
  )
  assert.notEqual(delta.cursor, watermark, 'the cursor moved with the facts')
  ports.store.close()
})

test('the increment carries the view as well, identical to a full read: a cursor never makes the page wrong', async () => {
  const ports = await portsFor({ budget: { gpu_hours_limit: 4 } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirOf(ports)
  const { cursor } = overviewHandler(dir, {})

  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })

  const incremental = overviewHandler(dir, { after: cursor })
  const full = overviewHandler(dir, {})

  assert.deepEqual(incremental.data, full.data, 'the derived page is always computed from all facts')
  assert.equal(incremental.data.best.candidate_id, 'r2-c1', 'and it already includes the facts the increment delivered')
  ports.store.close()
})

test('a cursor already at the head returns an empty increment and says nothing is new', async () => {
  const ports = await portsFor()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirOf(ports)

  const head = overviewHandler(dir, {})
  const idle = overviewHandler(dir, { after: head.cursor })

  assert.deepEqual(idle.incremental.events, [], 'a poll with nothing new costs nothing')
  assert.equal(idle.more, false)
  assert.equal(idle.cursor, head.cursor)
  assert.deepEqual(idle.data, head.data, 'and the page is still complete')
  ports.store.close()
})

test('two windows polling the same workspace with different cursors do not disturb each other', async () => {
  const ports = await portsFor()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirOf(ports)
  const early = overviewHandler(dir, {}).cursor

  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.75 } })

  // Interleaved on purpose: a cursor stored server-side would leak one window's position to the other.
  const windowA = overviewHandler(dir, { after: early })
  const windowB = overviewHandler(dir, {})
  const windowAAgain = overviewHandler(dir, { after: early })

  assert.deepEqual(windowAAgain, windowA, 'the second window\'s full read did not move the first window\'s cursor')
  assert.equal(windowB.incremental.events.length > windowA.incremental.events.length, true, 'the full read still saw everything')
  assert.deepEqual(windowA.data, windowB.data, 'both windows see the same run')
  ports.store.close()
})

test('a malformed cursor is refused instead of silently answered with a full refresh', async () => {
  const ports = await portsFor()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = dirOf(ports)

  for (const after of ['nonsense', '5', '5:r1-c1', ':r1-c1:5', '5::5', 'x:r1-c1:5']) {
    assert.throws(() => overviewHandler(dir, { after }), /cursor/i, `after=${JSON.stringify(after)} must be refused`)
  }
  ports.store.close()
})