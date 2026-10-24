import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_EVENT_BYTES, PayloadTooLargeError, Store } from '../lib/store.js'

const AT = 1_761_091_200_000
const workspace = () => mkdtempSync(join(tmpdir(), 'reprise-ws-'))

const openStore = () => Store.open(workspace())

test('a fresh workspace is migrated to the current version', () => {
  const store = openStore()
  assert.equal(store.version, 2, 'a new file must already be at the version this kernel speaks')
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const table of ['candidate_bindings', 'candidate_state', 'events', 'jobs', 'ledger', 'ops_log', 'workspace_state']) {
    assert.ok(tables.includes(table), `${table} must exist`)
  }
  // Migration 2: the ledger says what a job is for, so a baseline job is not read as a candidate.
  const jobColumns = store.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name)
  assert.ok(jobColumns.includes('kind'), 'jobs.kind must exist, with candidate as the default for old rows')
  store.close()
})

test('re-opening an existing workspace is a no-op, not a re-migration', () => {
  const dir = workspace()
  Store.open(dir).close()
  const again = Store.open(dir)
  assert.equal(again.version, 2)
  again.close()
})

test('event identity is the pair, and idempotence has three states', () => {
  const store = openStore()
  const first = store.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'candidate_created', payload: { round: 1 } })
  assert.equal(first.status, 'inserted')
  assert.equal(first.local_seq, 1, 'the first event of a candidate is seq 1')

  const replay = store.appendEvent({ candidate_id: 'c1', local_seq: 1, wall_clock_ms: AT + 1, event_type: 'candidate_created', payload: { round: 1 } })
  assert.equal(replay.status, 'duplicate', 'same identity and same payload is a replay, not an error')

  const contradictory = store.appendEvent({ candidate_id: 'c1', local_seq: 1, wall_clock_ms: AT, event_type: 'candidate_created', payload: { round: 2 } })
  assert.equal(contradictory.status, 'conflict', 'same identity with a different payload must never be absorbed')
  assert.equal(store.maxSeq('c1'), 1, 'a conflict writes nothing')

  // The same local_seq under a different candidate is a different fact entirely.
  store.appendEvent({ candidate_id: 'c2', local_seq: 1, wall_clock_ms: AT, event_type: 'candidate_created', payload: { round: 1 } })
  assert.equal(store.maxSeq('c2'), 1)
  store.close()
})

test('timestamps must be epoch milliseconds', () => {
  const store = openStore()
  for (const [label, value] of [
    ['seconds', 1_761_091_200],
    ['nanoseconds', 1_761_091_200_000_000_000],
    ['a float', 1_761_091_200_000.5],
  ]) {
    assert.throws(
      () => store.appendEvent({ candidate_id: 'c1', wall_clock_ms: value, event_type: 'x', payload: {} }),
      /epoch milliseconds/,
      `${label} must be refused at the boundary`,
    )
  }
  store.close()
})

test('an oversized payload is refused and says what to do instead', () => {
  const store = openStore()
  const big = { blob: 'x'.repeat(MAX_EVENT_BYTES) }
  assert.throws(
    () => store.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'x', payload: big }),
    (error) => error instanceof PayloadTooLargeError && /artifact/.test(error.message),
  )
  assert.equal(store.maxSeq('c1'), 0)
  store.close()
})

test('bindings are insert-only, enforced by the database rather than by habit', () => {
  const store = openStore()
  assert.equal(store.freezeBinding('c1', 'parent_binding', { parent_id: 'baseline-0' }, AT).status, 'frozen')
  assert.equal(store.freezeBinding('c1', 'parent_binding', { parent_id: 'baseline-0' }, AT + 1).status, 'duplicate')
  assert.equal(store.freezeBinding('c1', 'parent_binding', { parent_id: 'baseline-9' }, AT).status, 'conflict')
  assert.deepEqual(store.binding('c1', 'parent_binding'), { parent_id: 'baseline-0' })

  assert.throws(() => store.db.exec("UPDATE candidate_bindings SET value_json = '{}'"), /insert-only/)
  assert.throws(() => store.db.exec('DELETE FROM candidate_bindings'), /insert-only/)
  assert.deepEqual(store.binding('c1', 'parent_binding'), { parent_id: 'baseline-0' }, 'still untouched')
  store.close()
})

test('a crash between the two transactions is detectable after reopening', () => {
  const dir = workspace()

  // Facts first…
  const writer = Store.open(dir)
  for (const type of ['candidate_created', 'land_done', 'gate_result']) {
    writer.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: type, payload: {} })
  }
  // …then state catches up, but only for the first event: the process dies here.
  writer.setState('c1', 'phase', { phase: 'LAND' })
  writer.setAppliedSeq('c1', 1)
  writer.close()

  const reopened = Store.open(dir)
  assert.equal(reopened.maxSeq('c1'), 3)
  assert.equal(reopened.appliedSeq('c1'), 1, 'the lag is readable, not silently repaired')
  const pending = reopened.eventsAfter('c1', reopened.appliedSeq('c1'))
  assert.deepEqual(
    pending.map((event) => event.event_type),
    ['land_done', 'gate_result'],
    'replay knows exactly what to fold',
  )
  reopened.close()
})

test('replaying events is idempotent', () => {
  const store = openStore()
  store.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'candidate_created', payload: { round: 1 } })
  const pending = store.eventsAfter('c1', 0)
  const replayed = pending.map((event) => store.appendEvent(event))
  assert.deepEqual(replayed.map((entry) => entry.status), ['duplicate'])
  store.close()
})

test('spend distinguishes settled from in flight, and nothing goes negative', () => {
  const store = openStore()
  store.reserve('c1', 2, AT)
  assert.deepEqual(store.totals(), { settledGpuHours: 0, inFlightGpuHours: 2, tokens: 0 }, 'a reservation is at risk immediately')

  store.settle('c1', 1.5, AT + 1000, 4200)
  const after = store.totals()
  assert.equal(after.settledGpuHours, 1.5)
  assert.equal(after.inFlightGpuHours, 0.5)
  assert.equal(after.tokens, 4200)

  store.settle('c1', 0.5, AT + 2000)
  assert.equal(store.totals().inFlightGpuHours, 0)
  assert.equal(store.inFlightGpuHours('c1'), 0)

  // An over-settlement is a data error, but it must not produce a negative amount at risk.
  store.settle('c1', 5, AT + 3000)
  assert.equal(store.totals().inFlightGpuHours, 0)
  store.close()
})

test('the job ledger keys on submission id, so a resubmission cannot duplicate a job', () => {
  const store = openStore()
  const base = {
    job_id: 'j1',
    candidate_id: 'c1',
    submission_id: 'sub-1',
    harness: 'claude',
    submitted_at_ms: AT,
    deadline_ms: AT + 3_600_000,
    state: 'running',
  }
  store.putJob(base)
  assert.throws(() => store.putJob({ ...base, job_id: 'j2' }), /UNIQUE|constraint/i)
  assert.equal(store.jobBySubmission('sub-1').job_id, 'j1')

  store.updateJob('j1', { state: 'lost', attempts: 2, last_polled_at_ms: AT + 5000 })
  assert.equal(store.jobFor('c1').state, 'lost')
  assert.equal(store.jobFor('c1').attempts, 2)
  store.updateJob('j1', { not_a_real_column: 'DROP TABLE jobs' })
  const untouched = store.jobFor('c1')
  assert.equal(untouched.state, 'lost', 'unknown columns are dropped, never interpolated into SQL')
  assert.equal(untouched.attempts, 2)
  store.close()
})

test('bookkeeping that is not an event has its own table', () => {
  const store = openStore()
  store.logOp('round_plan_harvest', { round: 2, kept: 3 }, AT)
  const ops = store.ops()
  assert.equal(ops.length, 1)
  assert.equal(ops[0].op, 'round_plan_harvest')
  assert.deepEqual(JSON.parse(ops[0].detail), { round: 2, kept: 3 })
  assert.equal(store.maxSeq('c1'), 0, 'ops rows never masquerade as events')
  store.close()
})

test('a read-only handle cannot write', () => {
  const dir = workspace()
  const writer = Store.open(dir)
  writer.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'candidate_created', payload: {} })
  writer.close()

  const reader = Store.openReadOnly(dir)
  assert.equal(reader.eventsFor('c1').length, 1, 'reading works while the fact plane is closed')
  assert.throws(() => reader.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'x', payload: {} }))
  reader.close()
})

test('a second reader can open while a writer holds the workspace', () => {
  const dir = workspace()
  const writer = Store.open(dir)
  writer.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'candidate_created', payload: {} })

  const reader = Store.openReadOnly(dir)
  assert.equal(reader.maxSeq('c1'), 1, 'WAL lets a read-only handle read a live workspace')
  reader.close()
  writer.close()
})