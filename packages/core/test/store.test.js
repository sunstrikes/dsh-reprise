/**
 * The fact plane: one SQLite file per workspace, and the rules that make it a fact plane.
 *
 * Three of them are worth naming at the top of the file:
 *
 *  1. **The `user_version` pragma is the version, and migrations are sequential and append-only.** A
 *     workspace is opened once at whatever shape it was last left in and brought forward in place;
 *     nobody has to guess which version a directory is (user story 35). A fresh file and a released
 *     v1 file both leave `Store.open` at the current shape, with every fact the old file held intact.
 *  2. **Event identity is the pair `(candidate_id, local_seq)`**, and re-appending one is
 *     `inserted | duplicate | conflict` — never a silent overwrite.
 *  3. **The database refuses what the contract forbids** (insert-only bindings), rather than relying
 *     on every caller to remember.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DB_FILENAME, MAX_EVENT_BYTES, PayloadTooLargeError, Store } from '../lib/store.js'

const AT = 1_761_091_200_000
const workspace = () => mkdtempSync(join(tmpdir(), 'reprise-ws-'))

const openStore = () => Store.open(workspace())

/**
 * A workspace as the released v1 wrote it: `MIGRATIONS[0]`, copied verbatim and then frozen.
 *
 * Copied rather than imported on purpose (user story 35: "顺序 migration 加版本号，不需要猜某个工作区
 * 是哪个版本"). The migration list is append-only, so this text is what a v1 file on somebody's disk
 * *is*; importing it would make the fixture follow the code and the test would pass even after a
 * released migration was edited. Never change this string.
 */
const V1_DDL = `
  CREATE TABLE events (
    candidate_id  TEXT    NOT NULL,
    local_seq     INTEGER NOT NULL,
    wall_clock_ms INTEGER NOT NULL,
    event_type    TEXT    NOT NULL,
    payload       TEXT    NOT NULL,
    PRIMARY KEY (candidate_id, local_seq)
  ) WITHOUT ROWID;

  CREATE INDEX events_by_time ON events (wall_clock_ms, candidate_id, local_seq);

  CREATE TABLE workspace_state (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE candidate_state (
    candidate_id TEXT NOT NULL,
    key          TEXT NOT NULL,
    value_json   TEXT NOT NULL,
    PRIMARY KEY (candidate_id, key)
  );

  CREATE TABLE candidate_bindings (
    candidate_id TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    value_json   TEXT    NOT NULL,
    frozen_at_ms INTEGER NOT NULL,
    PRIMARY KEY (candidate_id, kind)
  );

  CREATE TRIGGER candidate_bindings_no_update
  BEFORE UPDATE ON candidate_bindings
  BEGIN SELECT RAISE(ABORT, 'candidate_bindings is insert-only'); END;

  CREATE TRIGGER candidate_bindings_no_delete
  BEFORE DELETE ON candidate_bindings
  BEGIN SELECT RAISE(ABORT, 'candidate_bindings is insert-only'); END;

  CREATE TABLE jobs (
    job_id           TEXT PRIMARY KEY,
    candidate_id     TEXT    NOT NULL,
    submission_id    TEXT    NOT NULL,
    harness          TEXT    NOT NULL,
    submitted_at_ms  INTEGER NOT NULL,
    deadline_ms      INTEGER NOT NULL,
    last_polled_at_ms INTEGER,
    next_poll_at_ms  INTEGER NOT NULL DEFAULT 0,
    state            TEXT    NOT NULL,
    error_class      TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0
  );

  CREATE UNIQUE INDEX jobs_by_submission ON jobs (submission_id);
  CREATE INDEX jobs_by_candidate ON jobs (candidate_id);

  CREATE TABLE ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    gpu_hours    REAL    NOT NULL,
    tokens       INTEGER NOT NULL DEFAULT 0,
    at_ms        INTEGER NOT NULL
  );

  CREATE INDEX ledger_by_candidate ON ledger (candidate_id, kind);

  CREATE TABLE ops_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms  INTEGER NOT NULL,
    op     TEXT    NOT NULL,
    detail TEXT    NOT NULL
  );
`

test('a fresh workspace is migrated to the current version', () => {
  const store = openStore()
  // 2 = ticket 16's job-ledger identity columns (round, marker, outcome) on top of the initial
  // shape; 3 = ticket 30's `kind`, which says what a job is for.
  assert.equal(store.version, 3, 'a new file must already be at the version this kernel speaks')
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const table of ['candidate_bindings', 'candidate_state', 'events', 'jobs', 'ledger', 'ops_log', 'workspace_state']) {
    assert.ok(tables.includes(table), `${table} must exist`)
  }
  // Migration 3: the ledger says what a job is for, so a baseline job is not read as a candidate.
  const jobColumns = store.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name)
  assert.ok(jobColumns.includes('kind'), 'jobs.kind must exist, with candidate as the default for old rows')
  store.close()
})

test('re-opening an existing workspace is a no-op, not a re-migration', () => {
  const dir = workspace()
  Store.open(dir).close()
  const again = Store.open(dir)
  assert.equal(again.version, 3)
  again.close()
})

test('a v1 workspace is brought forward in place, and every fact it held survives the migration', () => {
  const dir = workspace()
  const path = join(dir, DB_FILENAME)

  // A file the released v1 left behind: its own shape, its own version, and rows a user's round
  // already depends on. Written with the raw driver because `Store` speaks only the current version.
  const v1 = new DatabaseSync(path)
  v1.exec(V1_DDL)
  v1.exec('PRAGMA user_version = 1')
  const eventPayload = JSON.stringify({ round: 1, hypothesis: 'widen the embedding table', seeds: [11, 12] })
  v1.prepare('INSERT INTO events (candidate_id, local_seq, wall_clock_ms, event_type, payload) VALUES (?, ?, ?, ?, ?)').run(
    'r1-h1',
    1,
    AT,
    'candidate_created',
    eventPayload,
  )
  v1.prepare(
    `INSERT INTO jobs (job_id, candidate_id, submission_id, harness, submitted_at_ms, deadline_ms,
                       last_polled_at_ms, next_poll_at_ms, state, error_class, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('raysubmit_0001', 'r1-h1', 'r1-h1', 'ray', AT, AT + 86_400_000, AT + 500, AT + 1_000, 'running', null, 2)
  v1.prepare('INSERT INTO ops_log (at_ms, op, detail) VALUES (?, ?, ?)').run(AT, 'round_planned', JSON.stringify({ round: 1 }))
  v1.close()

  const store = Store.open(dir)
  assert.equal(store.version, 2, 'the file was migrated forward, not recreated at the current shape')

  // The new columns exist, and an old row has no value in them: v1 never knew about rounds as a
  // column, or about the outcome of a job, and inventing a value would be a fact nobody wrote.
  const columns = store.db
    .prepare('PRAGMA table_info(jobs)')
    .all()
    .map((column) => column.name)
  for (const column of ['round', 'marker', 'outcome']) assert.ok(columns.includes(column), `jobs.${column} must exist after migrating`)
  const job = store.jobFor('r1-h1')
  assert.equal(job.round, null)
  assert.equal(job.marker, null)
  assert.equal(job.outcome, null)

  // The old rows are the old rows — same text, same identity, not a re-serialisation of them.
  const raw = store.db.prepare('SELECT payload FROM events WHERE candidate_id = ? AND local_seq = ?').get('r1-h1', 1)
  assert.equal(raw.payload, eventPayload, 'the payload column is byte-for-byte what v1 wrote')
  const event = store.eventsFor('r1-h1')[0]
  assert.equal(event.event_type, 'candidate_created')
  assert.deepEqual(event.payload, JSON.parse(eventPayload))
  assert.equal(job.job_id, 'raysubmit_0001')
  assert.equal(job.submission_id, 'r1-h1')
  assert.equal(job.state, 'running')
  assert.equal(job.attempts, 2)
  assert.equal(job.deadline_ms, AT + 86_400_000)
  assert.equal(store.ops()[0].op, 'round_planned')

  // And it is a v2 workspace from here on: writing the columns the migration added works, and
  // reopening does not migrate a second time.
  store.updateJob('raysubmit_0001', { outcome: 'succeeded' })
  assert.equal(store.jobFor('r1-h1').outcome, 'succeeded')
  store.close()
  const again = Store.open(dir)
  assert.equal(again.version, 2)
  assert.equal(again.jobFor('r1-h1').outcome, 'succeeded', 'the second open did not undo anything')
  assert.equal(again.eventsFor('r1-h1').length, 1)
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