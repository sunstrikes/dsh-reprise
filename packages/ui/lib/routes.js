/**
 * The dashboard's routes — registered on the host's existing HTTP surface, never on a port of ours.
 *
 * `registerRoutes({ connection, workspace })` mounts six exact Fetch routes through
 * `connection.fetch.register` and returns the disposer that unmounts them. There is no server here,
 * no launcher, no liveness probe: the host already owns the listener, and a dashboard that opened a
 * second one would be the detached FastAPI process this rewrite exists to delete.
 *
 * Three properties are load-bearing and each has a test:
 *
 *   - **Read-only.** Every route is `GET`. Each request opens its own `readOnly` SQLite handle and
 *     closes it, so a view physically cannot write a fact, two windows cannot interfere through a
 *     shared handle, and the page works with every session closed (it needs the workspace directory
 *     and nothing else — no session, no agent, no live `tick`).
 *   - **Plain handlers.** `overviewHandler(workspace, query)` and friends are ordinary functions
 *     returning JSON. The route object is a two-line adapter over them, so the data contract can be
 *     tested without a host or a socket.
 *   - **Disposal restores the previous state.** Routes belong to the calling fiber; unloading the
 *     plugin must leave the host's registry exactly as it was, including other features' routes.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DB_FILENAME, Store } from '../../core/lib/store.js'
import { ViewError, candidateView, conclusionView, overviewView, roundsView } from './views.js'

export { ViewError }

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/**
 * Run one read against the workspace fact plane.
 *
 * A missing database is not an error: a workspace with no facts yet is exactly what the dashboard
 * shows before the first tick, and answering 500 there would make an empty run look broken.
 *
 * @param {string} workspace
 * @param {(store: Store) => object} read
 * @returns {object | undefined} `undefined` when the workspace has no facts yet
 */
export function withStore(workspace, read) {
  if (typeof workspace !== 'string' || workspace === '') throw new ViewError(500, 'no workspace configured')
  if (!existsSync(join(workspace, DB_FILENAME))) return undefined
  const store = Store.openReadOnly(workspace)
  try {
    return read(store)
  } finally {
    store.close()
  }
}

/**
 * The answer for a workspace that has no facts at all. Same envelope as a real view, so the client
 * has one shape to render: nothing new arrived, and here is why there is no page.
 */
const nothingYet = (view, workspace, query) => ({
  view,
  workspace,
  cursor: null,
  after: query.after ?? null,
  more: false,
  incremental: { events: [] },
  data: null,
  reason: 'no facts recorded in this workspace yet',
})

function answer(workspace, name, render, query) {
  const rendered = withStore(workspace, (store) => render(store, query))
  return rendered ?? nothingYet(name, workspace, query)
}

/** The overview route's plain handler: `(workspace, query) → JSON`. */
export function overviewHandler(workspace, query = {}) {
  return answer(workspace, 'overview', overviewView, query)
}

/** The rounds route's plain handler. */
export function roundsHandler(workspace, query = {}) {
  return answer(workspace, 'rounds', roundsView, query)
}

/** The candidate-detail route's plain handler; needs `query.candidate`. */
export function candidateHandler(workspace, query = {}) {
  return answer(workspace, 'candidate', candidateView, query)
}

/** The conclusion route's plain handler. */
export function conclusionHandler(workspace, query = {}) {
  return answer(workspace, 'conclusion', conclusionView, query)
}

/**
 * The declared routes, in registration order.
 *
 * The four view routes come first so a failed registration cannot leave the page mounted without
 * the data it fetches; the page and its module are static files read from `client/` per request
 * (no build step, nothing to watch, and a stale bundle cannot outlive an edit).
 */
export const ROUTES = [
  { name: 'overview', path: '/api/reprise/overview', handler: overviewHandler },
  { name: 'rounds', path: '/api/reprise/rounds', handler: roundsHandler },
  { name: 'candidate', path: '/api/reprise/candidate', handler: candidateHandler },
  { name: 'conclusion', path: '/api/reprise/conclusion', handler: conclusionHandler },
]

/** Static files the page needs. Served from this package so there is no build artefact to ship. */
export const ASSETS = [
  { path: '/api/reprise/page', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { path: '/api/reprise/dashboard.js', file: 'dashboard.js', contentType: 'text/javascript; charset=utf-8' },
]

/** `?after=…&candidate=…` → a plain object; absent parameters stay absent rather than null. */
export function queryOf(url) {
  const params = new URL(url, 'http://dsh.test').searchParams
  const query = {}
  for (const key of ['after', 'candidate']) {
    const value = params.get(key)
    if (value !== null) query[key] = value
  }
  return query
}

function assetResponse({ file, contentType }) {
  try {
    return new Response(readFileSync(join(PACKAGE_DIR, 'client', file), 'utf8'), {
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    })
  } catch (error) {
    return new Response(`cannot read client/${file}: ${error?.message ?? String(error)}`, { status: 500 })
  }
}

/**
 * One route object, shaped exactly as the host's `connection.fetch.register` demands: an exact path
 * under `/api`, a non-empty method list, a declared body mode, and a Fetch handler.
 */
function route({ path, methods, fetch }) {
  return { path, methods, requestBody: 'buffered', fetch }
}

function routeFor({ path, handler, workspace }) {
  return route({
    path,
    methods: ['GET'],
    fetch: (request) => {
      try {
        return json(handler(workspace, queryOf(request.url)))
      } catch (error) {
        if (error instanceof ViewError) return json({ error: { message: error.message } }, error.status)
        return json({ error: { message: error?.message ?? String(error) } }, 500)
      }
    },
  })
}

/**
 * Mount the dashboard on the host's connection service.
 *
 * @param {{ connection: { fetch: { register(route: object): () => void } }, workspace: string }} options
 * @returns {() => void} the disposer that unregisters every route this call mounted
 */
export function registerRoutes({ connection, workspace }) {
  const disposers = []
  try {
    for (const entry of ROUTES) disposers.push(connection.fetch.register(routeFor({ ...entry, workspace })))
    for (const entry of ASSETS) {
      disposers.push(
        connection.fetch.register(route({ path: entry.path, methods: ['GET'], fetch: () => assetResponse(entry) })),
      )
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}