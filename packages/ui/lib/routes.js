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

import { readListing } from '../../core/lib/jobs.js'
import { DB_FILENAME, Store } from '../../core/lib/store.js'
import { ViewError, callView, callsView, candidateView, conclusionView, overviewView, roundsView } from './views.js'

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

/**
 * The overview route's plain handler: `(workspace, query, { platform }) → Promise<JSON>`.
 *
 * The one route that may ask the world a question. `cards.inUse` and `queue.upstream` are facts only
 * the cluster owns, so when a platform port is supplied the handler reads its listing through
 * `jobs.js`'s `readListing` — the same reader `reprise jobs` uses — and hands the answer to the
 * projection. Three answers stay three answers: a listing that was read (real numbers), a platform
 * that cannot list ("cannot read", in its own words), and no platform at all (the page says the
 * listing was not read and reports `null`, never 0).
 *
 * Asynchronous because a listing is a network call. Every other route stays synchronous; the route
 * adapter awaits uniformly, so a handler's shape is one thing rather than two.
 */
export async function overviewHandler(workspace, query = {}, { platform } = {}) {
  const listing = platform === undefined ? undefined : await readListing(platform)
  return answer(workspace, 'overview', (store) => overviewView(store, query, { listing }), query)
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

/** The audit route's plain handler: every model call the run filed, `?site=` to narrow it. */
export function callsHandler(workspace, query = {}) {
  return answer(workspace, 'calls', callsView, query)
}

/** One model call, opened: needs `query.ref`. */
export function callHandler(workspace, query = {}) {
  return answer(workspace, 'call', callView, query)
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
  // The audit is what makes a model's answer checkable: which judgement, what prompt, what came back.
  { name: 'calls', path: '/api/reprise/calls', handler: callsHandler },
  { name: 'call', path: '/api/reprise/call', handler: callHandler },
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
  for (const key of ['after', 'candidate', 'site', 'ref']) {
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

function routeFor({ path, handler, workspace, platform }) {
  return route({
    path,
    methods: ['GET'],
    // `await` on a non-promise is a no-op, so one adapter serves the five synchronous views and the
    // one route that reads the cluster listing.
    fetch: async (request) => {
      try {
        return json(await handler(workspace, queryOf(request.url), { platform }))
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
 * @param {{
 *   connection: { fetch: { register(route: object): () => void } },
 *   workspace: string,
 *   platform?: object,
 * }} options `platform` is optional: it is the only thing any route may ask, and only the overview
 *   route does (the cluster listing). Without it the page is exactly as complete as it was — it just
 *   reports "the cluster listing was not read" instead of a number.
 * @returns {() => void} the disposer that unregisters every route this call mounted
 */
export function registerRoutes({ connection, workspace, platform }) {
  const disposers = []
  try {
    for (const entry of ROUTES) disposers.push(connection.fetch.register(routeFor({ ...entry, workspace, platform })))
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