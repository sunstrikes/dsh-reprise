/**
 * Guards the decision "the dashboard cannot change what it is watching".
 *
 * The doctrine changed with ADR 0002 (a run registry): the page may now **create a run** and **place
 * an intent**, and it still may not touch a fact of a run it shows. So the property asserted here is
 * narrower and sharper than "every route is a GET":
 *
 *   - **The handle refuses.** Every view reads through `Store.openReadOnly`, so an accidental write in
 *     a view throws instead of landing. This is asserted directly on the handle the routes use rather
 *     than by reading the source.
 *   - **Nothing moved.** Every fact the workspace holds — the event streams, the workspace record,
 *     each candidate's state, its immutable bindings, the job ledger and the spend ledger — is
 *     identical before and after a full tour of every route, including cursor reads. The event stream
 *     is the one that matters: a dashboard that appended one "viewed" event per visit would be a run
 *     that rewrites its own history.
 *   - **The write surface is a closed set of two paths**, and neither of them is a view: creating a
 *     run writes a new directory under `runs_root`, and an intent writes a file under
 *     `<run>/pending/`. What those two do is asserted in `runs-routes.test.js`; what is asserted here
 *     is that no *other* path can be reached with a verb that writes.
 *
 * The routes are exercised through the registered route objects (`connection.dispatch`), so this
 * covers the adapter as well: a mutation verb against a view path is unrouted, and a bad query is a
 * 400 with a JSON error body rather than a page.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { Store } from '../../core/lib/store.js'
import { ROUTES, registerRoutes, withStore } from '../lib/routes.js'
import { fakeJudge, openWorkspace, runCandidate, seedConfig } from '../../core/test/support/fake-ports.js'
import { fakeConnection } from './support/fake-connection.js'

/**
 * The paths allowed to accept a verb other than GET. Anything else is a defect.
 *
 * Two of them write outside any run's fact plane: `runs` creates a directory under `runs_root` and
 * `runs/delete` moves one aside (never destroying it). `intent` writes the file the kernel consumes, or
 * the host's own activation set. `settings` writes the plugin's own memory about itself — where new runs
 * go, and how many may advance. None of the four can write a fact.
 */
const WRITE_PATHS = Object.freeze([
  '/api/reprise/intent',
  '/api/reprise/runs',
  '/api/reprise/runs/delete',
  '/api/reprise/settings',
])

/** Every fact the workspace holds, through the store's own readers. */
function facts(store) {
  const subjects = store.eventSubjects()
  const candidates = store.candidateIds()
  return {
    events: subjects.map((subject) => [subject, store.eventsFor(subject)]),
    workspace: store.getState(undefined, 'workspace') ?? null,
    candidates: candidates.map((id) => ({
      id,
      phase: store.getState(id, 'phase') ?? null,
      appliedSeq: store.getState(id, 'applied_seq') ?? null,
      bindings: store.bindings(id),
      job: store.jobFor(id) ?? null,
    })),
    totals: store.totals(),
    ops: store.ops(1_000),
  }
}

/** A workspace with a done candidate, a rejected one, and a concluded stop decision. */
async function workspaceWithEverything() {
  const ports = openWorkspace({ config: { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_rounds: 1 } } })
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, {
    candidateId: 'r1-c2',
    round: 1,
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({ candidate_id: candidateId, passed: 'yes-please', checks: [], decided_at_ms: now }),
    }),
  })
  await import('../../core/lib/loop.js').then(({ tick }) => tick(ports))
  const dir = dirname(ports.store.path)
  ports.store.close()
  return dir
}

test('the handle every view reads through refuses to write', async () => {
  const dir = await workspaceWithEverything()

  const refusal = (() => {
    try {
      withStore(dir, (store) => store.setState(undefined, 'workspace', { phase: 'FINALIZE' }))
      return undefined
    } catch (error) {
      return error
    }
  })()

  assert.ok(refusal !== undefined, 'a view that tried to write would have thrown')
  assert.match(String(refusal.message), /readonly/)
  assert.equal(refusal.code, 'ERR_SQLITE_ERROR')
})

test('a full tour of every route leaves every fact byte-identical', async () => {
  const dir = await workspaceWithEverything()

  const reader = Store.openReadOnly(dir)
  const before = facts(reader)
  reader.close()

  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: dir })
  try {
    const overview = await connection.dispatch('GET', '/api/reprise/overview')
    const cursor = overview.json.cursor
    const tour = [
      ['GET', '/api/reprise/overview'],
      ['GET', `/api/reprise/overview?after=${encodeURIComponent(cursor)}`],
      ['GET', '/api/reprise/rounds'],
      ['GET', '/api/reprise/candidate?candidate=r1-c1'],
      ['GET', '/api/reprise/candidate?candidate=r1-c2'],
      ['GET', '/api/reprise/candidate?candidate=nobody'],
      ['GET', '/api/reprise/conclusion'],
      // The audit (ticket 29): the list, the same list narrowed to one call site, and one record
      // opened. A view that read a model call must not be able to write one either.
      ['GET', '/api/reprise/calls'],
      ['GET', '/api/reprise/calls?site=verify'],
      ['GET', '/api/reprise/call?ref=model_call:verify:r1-c1:a1'],
      ['GET', '/api/reprise/page'],
      ['GET', '/api/reprise/dashboard.js'],
      ['POST', '/api/reprise/overview'],
      ['POST', '/api/reprise/conclusion?candidate=r1-c1'],
      ['PUT', '/api/reprise/rounds'],
    ]
    for (const [method, url] of tour) {
      const { status } = await connection.dispatch(method, url)
      assert.ok(status === 200 || status === 404, `${method} ${url} answered ${status}`)
    }
  } finally {
    dispose()
  }

  const after = Store.openReadOnly(dir)
  assert.deepEqual(facts(after), before, 'not one event, state row, binding, job or ledger entry was written')
  after.close()
})

test('the four views answer through the registered routes with no session and no agent anywhere', async () => {
  const dir = await workspaceWithEverything()
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: dir })
  try {
    const routes = [
      '/api/reprise/overview',
      '/api/reprise/rounds',
      '/api/reprise/candidate?candidate=r1-c1',
      '/api/reprise/conclusion',
      '/api/reprise/calls',
    ]
    for (const url of routes) {
      const { status, json, contentType } = await connection.dispatch('GET', url)
      assert.equal(status, 200, `${url} is readable with the loop process gone`)
      assert.match(contentType, /application\/json/)
      assert.equal(json.view, url.split('/').at(-1).split('?')[0], 'the envelope names the view it answered')
      assert.ok(json.data !== null, `${url} returned a page`)
    }

    // The audit's detail view answers with a page too; for a reference this workspace never filed,
    // the page says "no such record" rather than handing back an empty call.
    const opened = await connection.dispatch('GET', '/api/reprise/call?ref=model_call:verify:r1-c1:a1')
    assert.equal(opened.status, 200)
    assert.equal(opened.json.view, 'call')
    assert.equal(opened.json.missing, true)
  } finally {
    dispose()
  }
})

test('a bad query is a 400 with a JSON error, never a page and never a 500', async () => {
  const dir = await workspaceWithEverything()
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: dir })
  try {
    const missingCandidate = await connection.dispatch('GET', '/api/reprise/candidate')
    assert.equal(missingCandidate.status, 400)
    assert.match(missingCandidate.json.error.message, /candidate/)

    const badCursor = await connection.dispatch('GET', '/api/reprise/overview?after=yesterday')
    assert.equal(badCursor.status, 400, 'a malformed cursor is refused rather than answered with a full refresh')
    assert.match(badCursor.json.error.message, /cursor/i)
  } finally {
    dispose()
  }
})

test('the write surface is a closed set: the two non-GET paths, and no view among them', async () => {
  const dir = await workspaceWithEverything()
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: dir })
  try {
    const writers = [...connection.routes.values()].filter((route) => route.methods.some((method) => method !== 'GET'))
    assert.deepEqual(
      writers.map((route) => route.path).sort(),
      [...WRITE_PATHS].sort(),
      'creating a run and placing an intent are the only writes, and both are named here on purpose',
    )
    // One path for both registry verbs — reading the list and creating a run are the same resource —
    // and one path that only ever accepts a POST, because an intent is placed, never read back.
    const METHODS = {
      '/api/reprise/runs': ['GET', 'POST'],
      '/api/reprise/runs/delete': ['POST'],
      '/api/reprise/intent': ['POST'],
      '/api/reprise/settings': ['GET', 'POST'],
    }
    for (const route of writers) {
      assert.deepEqual(route.methods, METHODS[route.path], `${route.path} declares exactly the verbs it needs`)
    }

    // Every view path is still GET-only, so a mutation verb against it is unrouted — the property the
    // old closed-set test existed for, kept for the paths that still have it.
    const viewPaths = ROUTES.filter((entry) => entry.method === undefined || entry.method === 'GET').map((entry) => entry.path)
    for (const path of viewPaths) {
      const mounted = connection.routes.get(path)
      assert.ok(mounted !== undefined, `${path} is mounted`)
      assert.deepEqual(mounted.methods, ['GET'], `${path} reads only`)
    }

    const streaming = [...connection.routes.values()].filter((route) => route.requestBody !== 'buffered')
    assert.deepEqual(streaming, [], 'no route asks the bridge to stream a request body into a read')
  } finally {
    dispose()
  }
})

test('two workspaces are two dashboards: a route answers for the workspace it was registered for', async () => {
  const first = await workspaceWithEverything()
  const second = join(mkdtempSync(join(tmpdir(), 'reprise-ui-other-')))

  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: first })
  try {
    const answer = await connection.dispatch('GET', '/api/reprise/overview')
    assert.equal(answer.json.workspace, first, 'the page names the workspace it is a viewer of')
    assert.equal(answer.json.data.candidates.total, 2)
  } finally {
    dispose()
  }

  const empty = fakeConnection()
  const disposeEmpty = registerRoutes({ connection: empty, workspace: second })
  try {
    const answer = await empty.dispatch('GET', '/api/reprise/overview')
    assert.equal(answer.json.workspace, second, 'and a second dashboard is a viewer of a second workspace')
    assert.equal(answer.json.data, null, 'which has no facts, and says so')
    assert.match(answer.json.reason, /no facts recorded/)
  } finally {
    disposeEmpty()
  }
})