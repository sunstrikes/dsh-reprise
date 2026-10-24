/**
 * The fact plane: one SQLite file inside the workspace directory.
 *
 * What lives here and why:
 *   events            append-only, identity is the BINARY pair (candidate_id, local_seq)
 *   candidate_state   mutable KV per candidate; fields can be added without a migration
 *   workspace_state   mutable KV for the workspace
 *   candidate_bindings  insert-only; the database refuses UPDATE and DELETE
 *   jobs              the external-job ledger
 *   ledger            spend: reserve on dispatch, settle on completion
 *   ops_log           bookkeeping rows that are not events (the old events.jsonl mixed these in)
 *
 * What deliberately does NOT live here: phase artifacts, priors manifests, human intents. Those
 * stay files — they get carried by git and read by tools outside this process.
 *
 * Every timestamp column is milliseconds. Nanoseconds overflow `Number.MAX_SAFE_INTEGER` and
 * `node:sqlite` throws reading them back; Python's arbitrary-precision integers hid that.
 *
 * @module
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A single event payload may not exceed this; move bulk into an artifact and reference it. */
export const MAX_EVENT_BYTES = 65_536

export const DB_FILENAME = 'workspace.db'

/**
 * The subject workspace-level events are written under.
 *
 * Events are identified by `(candidate_id, local_seq)` and there is no such thing as "no candidate",
 * so a conclusion about the whole workspace needs a subject. A reserved one keeps the identity pair
 * intact instead of inventing a second event table. The leading underscore is the marker: a
 * planner-generated candidate id must not look like this, and derived views skip it.
 */
export const WORKSPACE_SUBJECT = '_workspace'

/**
 * Order matters and is append-only: a released version's migration is never edited.
 * The pragma `user_version` records how far a file has been brought.
 */
const MIGRATIONS = [
  // 1 — the initial shape
  `
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
  `,

  // 2 — the job ledger becomes a ledger of identities and outcomes (ticket 16).
  //
  // `round` and `marker` say *which* job of ours this is, from the cluster's own listing: the round
  // it was submitted in and the string that travels in the job's `metadata`. `outcome` is the
  // terminal conclusion, and it exists as its own column so that a job somebody stopped and a job
  // that broke are two different rows in this table — `state: 'failed'` plus
  // `error_class: 'canceled'` is the platform's vocabulary, not ours to re-derive at every reader.
  `
  ALTER TABLE jobs ADD COLUMN round INTEGER;
  ALTER TABLE jobs ADD COLUMN marker TEXT;
  ALTER TABLE jobs ADD COLUMN outcome TEXT;

  CREATE INDEX jobs_by_marker ON jobs (marker);
  CREATE INDEX jobs_by_outcome ON jobs (outcome, state);
  `,
]

export class PayloadTooLargeError extends Error {
  constructor(bytes) {
    super(`event payload is ${bytes} bytes; the limit is ${MAX_EVENT_BYTES} — move the bulk into an artifact and reference it`)
    this.name = 'PayloadTooLargeError'
    this.bytes = bytes
  }
}

/** Thrown when the database refuses an operation the contract forbids. */
export class ImmutableBindingError extends Error {}

export class Store {
  /** @param {DatabaseSync} db */
  constructor(db, path) {
    this.db = db
    this.path = path
  }

  /** @param {string} workspaceDir */
  static open(workspaceDir) {
    mkdirSync(workspaceDir, { recursive: true })
    const path = join(workspaceDir, DB_FILENAME)
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA synchronous = NORMAL')
    return new Store(migrate(db), path)
  }

  /** Read-only handle for `dump` and for anything that must not be able to corrupt facts. */
  static openReadOnly(workspaceDir) {
    const path = join(workspaceDir, DB_FILENAME)
    const db = new DatabaseSync(path, { readOnly: true })
    return new Store(db, path)
  }

  close() {
    this.db.close()
  }

  get version() {
    return Number(this.db.prepare('PRAGMA user_version').get().user_version)
  }

  // ---------------------------------------------------------------- events

  maxSeq(candidateId) {
    const row = this.db
      .prepare('SELECT MAX(local_seq) AS seq FROM events WHERE candidate_id = ?')
      .get(candidateId)
    return row?.seq ?? 0
  }

  nextSeq(candidateId) {
    return this.maxSeq(candidateId) + 1
  }

  /**
   * Append one event. Returns a status instead of throwing on conflict: appending the same event
   * again is normal (replay, retry, crash recovery) while appending a *different* payload under an
   * existing identity is an incident. The kernel decides what to do with `conflict`; the store
   * only refuses to overwrite.
   *
   * @param {{ candidate_id: string, local_seq?: number, wall_clock_ms: number, event_type: string, payload?: object }} event
   * @returns {{ status: 'inserted' | 'duplicate' | 'conflict', local_seq: number, existing?: string }}
   */
  appendEvent(event) {
    const { candidate_id: candidateId, wall_clock_ms: at, event_type: eventType } = event
    if (typeof candidateId !== 'string' || candidateId === '') throw new TypeError('candidate_id is required')
    if (typeof eventType !== 'string' || eventType === '') throw new TypeError('event_type is required')
    if (!Number.isSafeInteger(at) || at < 1e12) throw new TypeError('wall_clock_ms must be epoch milliseconds')

    const payload = JSON.stringify(event.payload ?? {})
    const bytes = Buffer.byteLength(payload)
    if (bytes > MAX_EVENT_BYTES) throw new PayloadTooLargeError(bytes)

    // One transaction per event: facts commit on their own, before any state is advanced.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const localSeq = event.local_seq ?? this.nextSeq(candidateId)
      const existing = this.db
        .prepare('SELECT payload FROM events WHERE candidate_id = ? AND local_seq = ?')
        .get(candidateId, localSeq)

      if (existing !== undefined) {
        this.db.exec('COMMIT')
        const same = existing.payload === payload
        return { status: same ? 'duplicate' : 'conflict', local_seq: localSeq, existing: existing.payload }
      }

      this.db
        .prepare(
          'INSERT INTO events (candidate_id, local_seq, wall_clock_ms, event_type, payload) VALUES (?, ?, ?, ?, ?)',
        )
        .run(candidateId, localSeq, at, eventType, payload)
      this.db.exec('COMMIT')
      return { status: 'inserted', local_seq: localSeq }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Events after a sequence number, ascending — the replay path. */
  eventsAfter(candidateId, afterSeq = 0) {
    return this.db
      .prepare(
        'SELECT candidate_id, local_seq, wall_clock_ms, event_type, payload FROM events WHERE candidate_id = ? AND local_seq > ? ORDER BY local_seq ASC',
      )
      .all(candidateId, afterSeq)
      .map(decodeEvent)
  }

  eventsFor(candidateId) {
    return this.eventsAfter(candidateId, 0)
  }

  /** All candidates that have any state, in stable order. */
  candidateIds() {
    return this.db
      .prepare('SELECT DISTINCT candidate_id AS id FROM candidate_state ORDER BY id')
      .all()
      .map((row) => row.id)
  }

  /**
   * Every subject the *event stream* mentions, in stable order.
   *
   * Deliberately not `candidateIds()`: a derived view that enumerated state would miss a candidate
   * whose events landed while the process died before its state row — exactly the lag this system
   * can detect but must never silently forget. It is also the only honest basis for a full rebuild,
   * which exists to check the incremental path rather than to repeat its assumptions.
   */
  eventSubjects() {
    return this.db
      .prepare('SELECT DISTINCT candidate_id AS id FROM events ORDER BY id')
      .all()
      .map((row) => row.id)
  }

  // ------------------------------------------------------------ state (KV)

  /**
   * @param {string | undefined} candidateId undefined for workspace-wide state
   * @param {string} key
   * @param {unknown} [fallback]
   */
  getState(candidateId, key, fallback) {
    const row =
      candidateId === undefined
        ? this.db.prepare('SELECT value_json FROM workspace_state WHERE key = ?').get(key)
        : this.db
            .prepare('SELECT value_json FROM candidate_state WHERE candidate_id = ? AND key = ?')
            .get(candidateId, key)
    return row === undefined ? fallback : JSON.parse(row.value_json)
  }

  /** @param {string | undefined} candidateId undefined for workspace-wide state */
  setState(candidateId, key, value) {
    const json = JSON.stringify(value)
    if (candidateId === undefined) {
      this.db
        .prepare('INSERT INTO workspace_state (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
        .run(key, json)
    } else {
      this.db
        .prepare(
          'INSERT INTO candidate_state (candidate_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(candidate_id, key) DO UPDATE SET value_json = excluded.value_json',
        )
        .run(candidateId, key, json)
    }
  }

  /**
   * The last event sequence folded into this candidate's state. `maxSeq() > appliedSeq()` means a
   * crash landed between the two transactions — detectable by design.
   */
  appliedSeq(candidateId) {
    return this.getState(candidateId, 'applied_seq', 0)
  }

  setAppliedSeq(candidateId, seq) {
    this.setState(candidateId, 'applied_seq', seq)
  }

  // ------------------------------------------------------------- bindings

  /**
   * Freeze a binding once. The table refuses UPDATE and DELETE at the database level, so
   * "parent / gate / fold never changed" does not depend on anyone's discipline.
   *
   * @param {string} candidateId
   * @param {string} kind
   * @param {object} value
   * @param {number} frozenAtMs
   * @returns {{ status: 'frozen' | 'duplicate' | 'conflict' }}
   */
  freezeBinding(candidateId, kind, value, frozenAtMs) {
    const json = JSON.stringify(value)
    const existing = this.db
      .prepare('SELECT value_json FROM candidate_bindings WHERE candidate_id = ? AND kind = ?')
      .get(candidateId, kind)

    if (existing !== undefined) {
      return { status: existing.value_json === json ? 'duplicate' : 'conflict' }
    }

    this.db
      .prepare('INSERT INTO candidate_bindings (candidate_id, kind, value_json, frozen_at_ms) VALUES (?, ?, ?, ?)')
      .run(candidateId, kind, json, frozenAtMs)
    return { status: 'frozen' }
  }

  binding(candidateId, kind) {
    const row = this.db
      .prepare('SELECT value_json FROM candidate_bindings WHERE candidate_id = ? AND kind = ?')
      .get(candidateId, kind)
    return row === undefined ? undefined : JSON.parse(row.value_json)
  }

  bindings(candidateId) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const row of this.db
      .prepare('SELECT kind, value_json FROM candidate_bindings WHERE candidate_id = ? ORDER BY kind')
      .all(candidateId)) {
      out[row.kind] = JSON.parse(row.value_json)
    }
    return out
  }

  // ------------------------------------------------------------ job ledger

  putJob(job) {
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, candidate_id, submission_id, harness, submitted_at_ms, deadline_ms,
                           last_polled_at_ms, next_poll_at_ms, state, error_class, attempts,
                           round, marker, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.job_id,
        job.candidate_id,
        job.submission_id,
        job.harness,
        job.submitted_at_ms,
        job.deadline_ms,
        job.last_polled_at_ms ?? null,
        job.next_poll_at_ms ?? 0,
        job.state,
        job.error_class ?? null,
        job.attempts ?? 0,
        job.round ?? null,
        job.marker ?? null,
        job.outcome ?? null,
      )
  }

  updateJob(jobId, patch) {
    const allowed = ['last_polled_at_ms', 'next_poll_at_ms', 'state', 'error_class', 'attempts', 'outcome']
    const fields = Object.keys(patch).filter((key) => allowed.includes(key))
    if (fields.length === 0) return
    const assignments = fields.map((field) => `${field} = ?`).join(', ')
    this.db
      .prepare(`UPDATE jobs SET ${assignments} WHERE job_id = ?`)
      .run(...fields.map((field) => patch[field]), jobId)
  }

  jobFor(candidateId) {
    return this.db
      .prepare('SELECT * FROM jobs WHERE candidate_id = ? ORDER BY submitted_at_ms DESC LIMIT 1')
      .get(candidateId)
  }

  jobBySubmission(submissionId) {
    return this.db.prepare('SELECT * FROM jobs WHERE submission_id = ?').get(submissionId)
  }

  jobsInState(state) {
    return this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY submitted_at_ms ASC').all(state)
  }

  /** Every job this workspace ever recorded, oldest first — the ledger side of the ledger view. */
  allJobs() {
    return this.db.prepare('SELECT * FROM jobs ORDER BY submitted_at_ms ASC, job_id ASC').all()
  }

  /**
   * Jobs that may still be running on the cluster.
   *
   * `unknown` counts: "we could not find out" is not evidence that a job finished, and dispatching a
   * second training job because the dashboard was down is exactly the collision the exclusivity
   * configuration exists to prevent.
   */
  inFlightJobs() {
    return this.db
      .prepare("SELECT * FROM jobs WHERE outcome IS NULL AND state IN ('running', 'unknown') ORDER BY submitted_at_ms ASC")
      .all()
  }

  // ---------------------------------------------------------------- ledger

  reserve(candidateId, gpuHours, atMs, tokens = 0) {
    this.db
      .prepare('INSERT INTO ledger (candidate_id, kind, gpu_hours, tokens, at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(candidateId, 'reserve', gpuHours, tokens, atMs)
  }

  settle(candidateId, gpuHours, atMs, tokens = 0) {
    this.db
      .prepare('INSERT INTO ledger (candidate_id, kind, gpu_hours, tokens, at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(candidateId, 'settle', gpuHours, tokens, atMs)
  }

  /** Reserved hours not yet settled — the amount still at risk. */
  inFlightGpuHours(candidateId) {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN gpu_hours END), 0)
              - COALESCE(SUM(CASE WHEN kind = 'settle'  THEN gpu_hours END), 0) AS inflight
           FROM ledger WHERE candidate_id = ?`,
      )
      .get(candidateId)
    return Math.max(0, row?.inflight ?? 0)
  }

  /** @param {string} [candidateId] omit for the whole workspace */
  totals(candidateId) {
    const scope = candidateId === undefined ? '' : 'WHERE candidate_id = ?'
    const params = candidateId === undefined ? [] : [candidateId]
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'settle'  THEN gpu_hours END), 0) AS settled,
                COALESCE(SUM(CASE WHEN kind = 'reserve' THEN gpu_hours END), 0) AS reserved,
                COALESCE(SUM(tokens), 0) AS tokens
           FROM ledger ${scope}`,
      )
      .get(...params)
    return {
      settledGpuHours: row?.settled ?? 0,
      inFlightGpuHours: Math.max(0, (row?.reserved ?? 0) - (row?.settled ?? 0)),
      tokens: row?.tokens ?? 0,
    }
  }

  // --------------------------------------------------------------- ops log

  /** Bookkeeping that is not an event. The old events.jsonl mixed these in and dropped them on read. */
  logOp(op, detail, atMs) {
    this.db
      .prepare('INSERT INTO ops_log (op, detail, at_ms) VALUES (?, ?, ?)')
      .run(op, JSON.stringify(detail), atMs)
  }

  ops(limit = 100) {
    return this.db.prepare('SELECT * FROM ops_log ORDER BY id DESC LIMIT ?').all(limit)
  }
}

function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version)
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return db
}

function decodeEvent(row) {
  return {
    candidate_id: row.candidate_id,
    local_seq: row.local_seq,
    wall_clock_ms: row.wall_clock_ms,
    event_type: row.event_type,
    payload: JSON.parse(row.payload),
  }
}