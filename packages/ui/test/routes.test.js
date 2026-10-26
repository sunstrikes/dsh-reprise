/**
 * Guards the decision "the dashboard rides the host's existing HTTP surface, and its routes leave
 * with the plugin" (spec 展示层; ticket 11 AC 1 and 5).
 *
 * The seam is `registerRoutes({ connection, workspace })`: the host's exact Fetch-route registry in,
 * a disposer out. What this file owns, and what nothing else can observe:
 *
 *   - the dashboard mounts the paths it promises, on the host's own registry (no second port, no
 *     launcher, no separate process — there is nothing here that could start one);
 *   - every route is `GET`-only, so v1 has no write endpoint by construction rather than by
 *     discipline, and a `POST` to a mounted path is a 404 before any handler runs;
 *   - `registerRoutes` returns a disposer that restores the *previous* registry state — other
 *     features' routes survive, ours are gone, and registering again works (a disposer that only
 *     marked itself "done" would leave the path taken);
 *   - a half-finished registration leaves nothing behind.
 *
 * What it cannot prove from a worktree: that the real host's `connection` service has this shape, or
 * that the browser cookie/Peer fence admits the page. `pnpm smoke` against a real `dsh web` would.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { registerRoutes } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

/** The paths the ticket promises. Written out, not imported: a test that reads the constant it asserts proves nothing. */
const DATA_PATHS = [
  '/api/reprise/overview',
  '/api/reprise/rounds',
  '/api/reprise/candidate',
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