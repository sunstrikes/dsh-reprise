/**
 * The host tick recipe: one interval, one tick in flight, one dispose.
 *
 * Contract guarded (spec "唤醒是宿主 timer", user stories 13/19/41): the loop advances from a timer
 * and nothing else — no session, no turn, no model. Three facts have to hold or unattended operation
 * is a story rather than a property:
 *
 *   1. every interval fires one tick, and a tick that is still running is *skipped*, not stacked
 *      (a tick awaits subprocesses; two of them interleaving would double-submit a job);
 *   2. a tick that throws is logged and the next interval still ticks — a poisoned store or one bad
 *      phase must not silently end the night shift;
 *   3. disposal stops the interval before the workspace is closed, exactly once.
 *
 * Tested against a fake context shaped like cordis's (`interval` returns a disposer, `effect`
 * receives a cleanup factory). That is the seam: this module never imports cordis, so the host's
 * lifecycle is observable without starting a host.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mountTick } from '../lib/host.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** The parts of a cordis `Context` this module is allowed to touch. */
function fakeContext() {
  const intervals = []
  const effects = []
  return {
    intervals,
    effects,
    interval(callback, ms) {
      const entry = { callback, ms, cleared: false }
      intervals.push(entry)
      return () => {
        entry.cleared = true
      }
    },
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    /** What a fiber dispose does: run every cleanup, newest first. */
    dispose() {
      for (const cleanup of [...effects].reverse()) cleanup()
    },
  }
}

function fakeWorkspace(tickOnce) {
  const calls = { tick: 0, close: 0 }
  return {
    calls,
    async tickOnce() {
      calls.tick += 1
      return tickOnce?.(calls.tick)
    },
    close() {
      calls.close += 1
    },
  }
}

test('every interval fires one tick, with no session and no turn anywhere', async () => {
  const ctx = fakeContext()
  const workspace = fakeWorkspace()
  const logs = []
  mountTick(ctx, { workspace, intervalMs: 10, log: (message) => logs.push(message) })

  assert.equal(ctx.intervals.length, 1, 'exactly one interval, so the loop cannot be woken twice')
  for (let index = 0; index < 3; index += 1) {
    ctx.intervals[0].callback()
    await settle()
  }

  assert.equal(workspace.calls.tick, 3, 'the host timer is the only driver the loop needs')
  assert.deepEqual(logs, [], 'a healthy tick says nothing — a log line per tick is the probe this replaced')
})

test('a tick that is still running is skipped, never stacked', async () => {
  const ctx = fakeContext()
  const pending = []
  const workspace = fakeWorkspace(() => new Promise((resolve) => pending.push(resolve)))
  const stats = mountTick(ctx, { workspace, intervalMs: 10, log: () => {} }).stats

  ctx.intervals[0].callback()
  await settle()
  ctx.intervals[0].callback()
  ctx.intervals[0].callback()
  await settle()
  assert.equal(workspace.calls.tick, 1, 'one tick in flight: two overlapping ticks would submit the same job twice')
  assert.equal(stats().skipped, 2)

  pending.shift()()
  await settle()
  ctx.intervals[0].callback()
  await settle()
  assert.equal(workspace.calls.tick, 2, 'skipping is not a wedge: the next interval after the slow tick ticks')
})

test('a tick that throws is reported and does not stop the loop', async () => {
  const ctx = fakeContext()
  const workspace = fakeWorkspace((count) => {
    if (count === 1) throw new Error('database is locked')
    return { actions: [] }
  })
  const logs = []
  const mount = mountTick(ctx, { workspace, intervalMs: 10, log: (message) => logs.push(message) })

  ctx.intervals[0].callback()
  await settle()
  ctx.intervals[0].callback()
  await settle()

  assert.equal(workspace.calls.tick, 2, 'the second interval still ticked after the first one threw')
  assert.equal(logs.length, 1)
  assert.match(logs[0], /database is locked/)
  assert.equal(mount.stats().failures, 1)
})

test('dispose clears the interval before closing the workspace, exactly once', async () => {
  const ctx = fakeContext()
  const order = []
  const workspace = fakeWorkspace()
  workspace.close = () => order.push('closed')
  mountTick(ctx, {
    workspace,
    intervalMs: 10,
    log: () => {},
    onDispose: () => {
      order.push('disposed')
      workspace.close()
    },
  })

  ctx.dispose()
  ctx.dispose()

  assert.ok(ctx.intervals[0].cleared, 'the interval must not outlive the fiber that owns it')
  assert.deepEqual(order, ['disposed', 'closed'], 'stop ticking first, then release the fact plane')
  ctx.intervals[0].callback()
  await settle()
  assert.equal(workspace.calls.tick, 0, 'a disposed loop never ticks again')
})