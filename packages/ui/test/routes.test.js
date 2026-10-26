/**
 * Guards the decision "the dashboard rides the host's existing HTTP surface, and its routes leave
 * with the plugin" (spec 展示层; ticket 11 AC 1 and 5).
 *
 * The seam is `registerRoutes({ connection, workspace, platform, notice })`: the host's exact
 * Fetch-route registry in, a disposer out. What this file owns, and what nothing else can observe:
 *
 *   - the dashboard mounts the paths it promises, on the host's own registry (no second port, no
 *     launcher, no separate process — there is nothing here that could start one);
 *   - every route is `GET`-only, so v1 has no write endpoint by construction rather than by
 *     discipline, and a `POST` to a mounted path is a 404 before any handler runs;
 *   - `registerRoutes` returns a disposer that restores the *previous* registry state — other
 *     features' routes survive, ours are gone, and registering again works (a disposer that only
 *     marked itself "done" would leave the path taken);
 *   - a half-finished registration leaves nothing behind;
 *   - the host's optional `notice` — why the run is not ticking — reaches the overview page and no
 *     other route, and reaches it in the one state a refused run is actually in: a workspace with no
 *     database yet, whose empty page is drawn from `reason` rather than from `notes`.
 *
 * What it cannot prove from a worktree: that the real host's `connection` service has this shape, or
 * that the browser cookie/Peer fence admits the page. `pnpm smoke` against a real `dsh web` would.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Store } from '../../core/lib/store.js'
import { overviewHandler, registerRoutes } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

/** The paths the ticket promises. Written out, not imported: a test that reads the constant it asserts proves nothing. */
const DATA_PATHS = [
  '/api/reprise/overview',
  '/api/reprise/rounds',
  '/api/reprise/candidate',
  // The search as a tree: the one page whose unit is the search, not a round or a candidate.
  '/api/reprise/tree',
  '/api/reprise/conclusion',
  // The model-call audit (ticket 29): the list, and one record opened.
  '/api/reprise/calls',
  '/api/reprise/call',
]
// The page, its module, and the formatting module both clients import (ticket #2). The stylesheet
// joins them in ticket #3: the Web UI panel injects the same file, so it is served, not inlined.
const ASSET_PATHS = [
  '/api/reprise/page',
  '/api/reprise/dashboard.js',
  '/api/reprise/format.js',
  '/api/reprise/states.js',
  '/api/reprise/dashboard.css',
]

const workspaceDir = () => mkdtempSync(join(tmpdir(), 'reprise-ui-routes-'))

/**
 * The host's words when the loop is not ticking — a refused configuration, in the shape the desktop
 * profile hit. Written as a literal because the notice is opaque to this package: it is a string the
 * host supplies, and nothing here may assume its wording.
 */
const NOTICE = 'this run is not ticking: the configuration was refused (no domain configured)'

/** The note the projection already emits for a workspace that never recorded a budget. */
const BUDGET_NOTE = /never recorded a budget/

/**
 * A workspace with a database and no facts in it.
 *
 * The state a refused run is actually in when the host still mounted the dashboard: a directory with
 * nothing recorded, so the overview has a real `notes` array (the budget note) for the notice to sit
 * in front of. Built here rather than through the loop so this file keeps proving route behaviour
 * without needing a run.
 */
function workspaceWithDatabase() {
  const dir = workspaceDir()
  Store.open(dir).close()
  return dir
}

test('the dashboard mounts its routes on the host connection and unregisters them on dispose', () => {
  const connection = fakeConnection()
  const elsewhere = connection.fetch.register({
    path: '/api/other/thing',
    methods: ['GET'],
    fetch: () => new Response('ok'),
  })
  const before = connection.paths()

  const dispose = registerRoutes({ connection, workspace: workspaceDir() })

  assert.deepEqual(
    connection.paths(),
    [...DATA_PATHS, ...ASSET_PATHS, '/api/other/thing'].sort(),
    'the views, the audit and the page with its module, mounted on the host registry instead of a new server',
  )
  assert.deepEqual(connection.paths().filter((path) => !path.startsWith('/api/reprise/')), ['/api/other/thing'])

  dispose()

  assert.deepEqual(connection.paths(), before, 'disposing restores the previous registry, not an empty one')
  assert.equal(connection.routes.has('/api/other/thing'), true, 'another feature\'s route is not collateral damage')

  const again = registerRoutes({ connection, workspace: workspaceDir() })
  assert.deepEqual(connection.paths(), [...DATA_PATHS, ...ASSET_PATHS, '/api/other/thing'].sort(), 'unloading really released the paths')
  again()
  elsewhere()
  assert.deepEqual(connection.paths(), [])
})

test('every mounted route is GET-only: v1 has no write endpoint to reach for', () => {
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: workspaceDir() })

  for (const path of [...DATA_PATHS, ...ASSET_PATHS]) {
    const route = connection.routes.get(path)
    assert.deepEqual(route.methods, ['GET'], `${path} declares exactly one method, and it is not a mutation`)
    assert.equal(route.requestBody, 'buffered', `${path} declares its body mode, so the bridge never streams into a read`)
  }

  dispose()
})

test('a POST to a mounted path is not routed: the method is not declared, so it 404s', async () => {
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: workspaceDir() })

  const posted = await connection.dispatch('POST', '/api/reprise/overview')
  const put = await connection.dispatch('PUT', '/api/reprise/conclusion')
  const deleted = await connection.dispatch('DELETE', '/api/reprise/candidate?candidate=r1-c1')

  assert.equal(posted.status, 404, 'a mutation verb falls through to the host 404, never into a handler')
  assert.equal(put.status, 404)
  assert.equal(deleted.status, 404)
  assert.equal((await connection.dispatch('GET', '/api/reprise/overview')).status, 200, 'while the read still answers')

  dispose()
})

test('a registration that fails part-way leaves no route behind', () => {
  const connection = fakeConnection()
  // Something else already owns one of the paths we would register — the host refuses it.
  const squatter = connection.fetch.register({
    path: '/api/reprise/conclusion',
    methods: ['GET'],
    fetch: () => new Response('not ours'),
  })

  assert.throws(() => registerRoutes({ connection, workspace: workspaceDir() }), /already registered/)
  assert.deepEqual(connection.paths(), ['/api/reprise/conclusion'], 'the routes that did register were disposed again')

  squatter()
  assert.deepEqual(connection.paths(), [], 'and the other feature keeps control of its own path')
})

// ------------------------------------------------------------------- the notice

test("the host's notice is the first note on the overview, and no other route repeats it", async () => {
  const dir = workspaceWithDatabase()
  const noticed = fakeConnection()
  const plain = fakeConnection()
  const noticedDispose = registerRoutes({ connection: noticed, workspace: dir, notice: NOTICE })
  const plainDispose = registerRoutes({ connection: plain, workspace: dir })

  const overview = await noticed.dispatch('GET', '/api/reprise/overview')

  assert.equal(overview.status, 200, 'a notice explains the run; it does not turn the page into an error')
  assert.equal(overview.json.notes[0], NOTICE, 'the reason comes before the numbers it explains')
  assert.match(overview.json.notes[1], BUDGET_NOTE, 'and the notes the projection found still follow it')

  // The notice is about the run, which is what the overview is about. Every other route answers
  // byte-for-byte what it answered on a mount that was never told anything.
  for (const path of DATA_PATHS.filter((entry) => entry !== '/api/reprise/overview')) {
    const withNotice = await noticed.dispatch('GET', path)
    const without = await plain.dispatch('GET', path)
    assert.equal(withNotice.text, without.text, `${path} is untouched by a notice it has no business carrying`)
    assert.equal(withNotice.text.includes(NOTICE), false, `${path} does not repeat the host's words`)
  }

  noticedDispose()
  plainDispose()
})

test('a workspace with no database yet still carries the notice, on the strip an empty page draws', async () => {
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: workspaceDir(), notice: NOTICE })

  const answer = await connection.dispatch('GET', '/api/reprise/overview')

  assert.equal(answer.status, 200, 'nothing has happened yet is a page, not a 500')
  assert.equal(answer.json.data, null, 'and it is still empty: a notice explains the emptiness, it does not fill it')
  assert.equal(answer.json.notes[0], NOTICE, 'the notice lands even on an envelope that had no notes key at all')
  // `reason` keeps answering its own question. Folding the notice into it would print the same
  // sentence once per empty region, because both surfaces draw `reason` wherever there is no data.
  assert.equal(answer.json.reason.includes(NOTICE), false, 'the empty text is not the notice repeated')
  assert.match(answer.json.reason, /no facts recorded/, 'and it keeps saying why there is no page')

  dispose()
})

test('a mount without a notice sends the payload it always sent, and an empty string is not a notice', async () => {
  const dir = workspaceWithDatabase()
  const connection = fakeConnection()
  // The overview stamps the instant of the reading, so both sides of a byte comparison have to read
  // the same clock — otherwise this test would pass or fail on which millisecond it ran in.
  const clock = { now: () => 1_700_000_000_000 }
  const dispose = registerRoutes({ connection, workspace: dir, clock })

  const answer = await connection.dispatch('GET', '/api/reprise/overview')

  assert.equal(answer.text.includes(NOTICE), false)
  assert.equal(answer.json.notes.length, 1, 'only the projection note: the notice option added nothing')
  assert.match(answer.json.notes[0], BUDGET_NOTE)

  // The plain handler's own contract, so the seam the host calls is pinned as well as the route over
  // it: options absent and options present-but-blank are the same bytes, not merely the same fields.
  const direct = await overviewHandler(dir, {}, { clock })
  assert.equal(answer.text, JSON.stringify(direct), 'the route sends the handler\'s bytes, with no notice folded in')
  assert.equal(
    JSON.stringify(await overviewHandler(dir, {}, { notice: '', clock })),
    JSON.stringify(direct),
    'an empty notice is not a blank line',
  )

  dispose()
})
