/**
 * The dashboard's routes — registered on the host's existing HTTP surface, never on a port of ours.
 *
 * `registerRoutes({ connection, workspace, registry, platform, clock, notice })` mounts the exact Fetch
 * routes through `connection.fetch.register` and returns the disposer that unmounts them. There is no
 * server here, no launcher, no liveness probe: the host already owns the listener, and a dashboard that
 * opened a second one would be the detached FastAPI process this rewrite exists to delete.
 *
 * Three properties are load-bearing and each has a test:
 *
 *   - **Read-only views, two named writes.** The seven view routes are `GET`; the only other verbs a
 *     run's state accepts are `POST /api/reprise/runs` (scaffold a directory under `runs_root`) and
 *     `POST /api/reprise/intent` (place the file under `<run>/pending/` the kernel already consumes) —
 *     ADR 0002. Every read opens its own `readOnly` SQLite handle and closes it, so a view physically
 *     cannot write a fact, two windows cannot interfere through a shared handle, and the page works
 *     with every session closed (it needs the run directory and nothing else — no session, no agent,
 *     no live `tick`).
 *   - **Plain handlers.** `overviewHandler(workspace, query)` and friends are ordinary functions
 *     returning JSON. The route object is a two-line adapter over them, so the data contract can be
 *     tested without a host or a socket.
 *   - **Disposal restores the previous state.** Routes belong to the calling fiber; unloading the
 *     plugin must leave the host's registry exactly as it was, including other features' routes.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readListing } from '../../core/lib/jobs.js'
import { createRunRegistry } from '../../core/lib/runs.js'
import { ViewError, callView, callsView, candidateView, conclusionView, overviewView, roundsView, treeView } from './views.js'
import { createRunHandler, intentHandler, resolveRun, runsHandler, withStore } from './runs.js'

export { ViewError }

/**
 * `withStore` moved to `runs.js` when the registry arrived: a registry route may read *any* run in the
 * listing, so the one read-only opener belongs beside those routes. It is re-exported here because
 * this is where its callers import it from (`status-tool.js`, `test/read-only.test.js`), and moving a
 * helper must not move an import for somebody else.
 */
export { withStore }

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/** The one sentence an empty page says, written once so a test and a payload cannot drift apart. */
const NOTHING_YET = 'no facts recorded in this workspace yet'

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
  reason: NOTHING_YET,
})

function answer(workspace, name, render, query) {
  const rendered = withStore(workspace, (store) => render(store, query))
  return rendered ?? nothingYet(name, workspace, query)
}

/**
 * The clock a request reads the run with. Injectable so a test — and a replay — can ask "how close is
 * this run to its wall-clock limit" and get the same answer twice; the projection never reads a clock
 * of its own.
 */
const SYSTEM_CLOCK = Object.freeze({ now: () => Date.now() })

/**
 * Fold the host's `notice` into the overview envelope — the one channel both surfaces draw words from.
 *
 * The notice is why the run is not ticking (a refused configuration, say), and it is not a fact, so it
 * cannot come out of the projection: the projection reads the workspace and nothing else, and two
 * reads of the same facts must stay equal. It rides `notes`, which the strip on both surfaces draws in
 * every state — including the empty one, where `client/dashboard.js`'s `renderStrips` paints the notes
 * before it returns (`packages/core/client/index.js` does the same). So a notice reaches a reader on a
 * workspace that never ticked, which is the case it exists for. It goes first because a reader should
 * meet the reason before the numbers it explains.
 *
 * `reason` is deliberately left alone. It answers a different question — "why is this page empty" —
 * and both surfaces draw it as the empty text of several regions; folding the notice into it would
 * print the same sentence four times on one screen.
 *
 * Absent, empty or non-string leaves the envelope untouched, so a mount without a notice still sends
 * byte-for-byte what it sent before this option existed.
 *
 * @param {object} body an overview envelope
 * @param {string | undefined} notice
 * @returns {object}
 */
function withNotice(body, notice) {
  if (typeof notice !== 'string' || notice === '') return body
  return { ...body, notes: [notice, ...(body.notes ?? [])] }
}

/**
 * The overview route's plain handler: `(workspace, query, { platform, clock, notice }) → Promise<JSON>`.
 *
 * The one route that may ask the world a question. `cards.inUse` and `queue.upstream` are facts only
 * the cluster owns, so when a platform port is supplied the handler reads its listing through
 * `jobs.js`'s `readListing` — the same reader `reprise jobs` uses — and hands the answer to the
 * projection. Three answers stay three answers: a listing that was read (real numbers), a platform
 * that cannot list ("cannot read", in its own words), and no platform at all (the page says the
 * listing was not read and reports `null`, never 0).
 *
 * `clock` is the instant the reading is taken — `{ now: () => number }` — and it is stamped here, at
 * the request boundary, rather than inside the projection: the stop gauges report a distance to a
 * wall-clock limit, and a distance measured against a clock the projection reached for itself could
 * not be reproduced by `dump` or by a test.
 *
 * The one route that also takes `notice`, the words the host could not put in a fact: why the run is
 * not ticking. It belongs here and not on the other routes because it is about the run, and the
 * overview is the page that reports the run — see `withNotice` for how it reaches both of the page's
 * surfaces.
 *
 * Asynchronous because a listing is a network call. Every other route stays synchronous; the route
 * adapter awaits uniformly, so a handler's shape is one thing rather than two.
 */
export async function overviewHandler(workspace, query = {}, { platform, clock = SYSTEM_CLOCK, notice } = {}) {
  const listing = platform === undefined ? undefined : await readListing(platform)
  const now = clock.now()
  const body = answer(workspace, 'overview', (store) => overviewView(store, query, { listing, now }), query)
  return withNotice(body, notice)
}

/** The rounds route's plain handler. */
export function roundsHandler(workspace, query = {}) {
  return answer(workspace, 'rounds', roundsView, query)
}

/** The candidate-detail route's plain handler; needs `query.candidate`. */
export function candidateHandler(workspace, query = {}) {
  return answer(workspace, 'candidate', candidateView, query)
}

/** The search-tree route's plain handler: the whole search as nodes, edges and reasons. */
export function treeHandler(workspace, query = {}) {
  return answer(workspace, 'tree', treeView, query)
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
 * The declared view routes, in registration order.
 *
 * The view routes come first so a failed registration cannot leave the page mounted without
 * the data it fetches; the page and its module are static files read from `client/` per request
 * (no build step, nothing to watch, and a stale bundle cannot outlive an edit).
 *
 * `method` is spelled out rather than implied, because it is no longer the same for every route this
 * package mounts: these seven read (`GET`), and the registry's own two are declared in `RUN_ROUTES`
 * below.
 */
export const ROUTES = [
  { name: 'overview', path: '/api/reprise/overview', method: 'GET', handler: overviewHandler },
  { name: 'rounds', path: '/api/reprise/rounds', method: 'GET', handler: roundsHandler },
  { name: 'candidate', path: '/api/reprise/candidate', method: 'GET', handler: candidateHandler },
  // The search as a tree: the one page whose unit is the search, not a round or a candidate.
  { name: 'tree', path: '/api/reprise/tree', method: 'GET', handler: treeHandler },
  { name: 'conclusion', path: '/api/reprise/conclusion', method: 'GET', handler: conclusionHandler },
  // The audit is what makes a model's answer checkable: which judgement, what prompt, what came back.
  { name: 'calls', path: '/api/reprise/calls', method: 'GET', handler: callsHandler },
  { name: 'call', path: '/api/reprise/call', method: 'GET', handler: callHandler },
]

/**
 * The two paths a run's own state accepts a write on, and the whole of this package's write surface
 * (ADR 0002). Everything else a browser can reach here reads.
 *
 * `runs` carries the list and the create on one path because they are one resource — the directory of
 * runs — and a client that can list them is one form away from adding one. `intent` is written by
 * `placeIntent`, the same function the CLI calls, so a button and `dsh-reprise intents place pause`
 * produce the same bytes under `<run>/pending/`, and neither of them is the truth: the notebook on disk
 * is, and the kernel consumes it once.
 *
 * `read` is present where a `GET` is served and absent where it is not; a `GET` to `intent` is not
 * routed at all (the method is not declared here), which is how "no view of the intent file is
 * offered" is a fact about the route table rather than a promise.
 */
export const RUN_ROUTES = [
  { name: 'runs', path: '/api/reprise/runs', methods: ['GET', 'POST'], read: runsHandler, write: createRunHandler },
  { name: 'intent', path: '/api/reprise/intent', methods: ['POST'], write: intentHandler },
]

/**
 * Static files the page needs. Served from this package so there is no build artefact to ship.
 *
 * `format.js` sits beside `dashboard.js` on purpose: the page imports it as `./format.js`, which the
 * browser resolves against the module's own URL, so the two files are one unit that cannot be served
 * out of step. The Web UI panel imports the same URL later (spec §9.1) — one formatter, two clients.
 *
 * `dashboard.css` is here for the same reason. It holds the `--reprise-*` token block and the
 * component styles as one file with no page-specific glue, so ticket #6's panel injects it verbatim
 * and the two surfaces cannot drift into two palettes.
 *
 * `states.js` is the third: the words a candidate state goes by, and the mark names the stylesheet
 * paints. The page imports it as `./states.js`; the panel will import the identical URL, so one
 * candidate is described with one vocabulary on both surfaces (ticket #5).
 */
export const ASSETS = [
  { path: '/api/reprise/page', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { path: '/api/reprise/dashboard.js', file: 'dashboard.js', contentType: 'text/javascript; charset=utf-8' },
  { path: '/api/reprise/format.js', file: 'format.js', contentType: 'text/javascript; charset=utf-8' },
  { path: '/api/reprise/states.js', file: 'states.js', contentType: 'text/javascript; charset=utf-8' },
  { path: '/api/reprise/dashboard.css', file: 'dashboard.css', contentType: 'text/css; charset=utf-8' },
]

/**
 * `?after=…&candidate=…&run=…` → a plain object; absent parameters stay absent rather than null.
 *
 * `run` is the registry's id for the run a request means (ADR 0002). It travels through the same
 * parser as the view's own parameters because it is parsed at the same boundary and validated once, by
 * `resolveRun` — a view never sees an id it would have to interpret.
 */
export function queryOf(url) {
  const params = new URL(url, 'http://dsh.test').searchParams
  const query = {}
  for (const key of ['after', 'candidate', 'site', 'ref', 'run']) {
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

/**
 * The one place a thrown thing becomes a status.
 *
 * A `ViewError` carries its own status and is the whole vocabulary of refusals this package raises: a
 * 400 for a request that cannot be honoured, a 404 for an id nobody registered. Anything else is a bug
 * and stays a 500, so a `TypeError` can never be disguised as a client error.
 */
function failure(error) {
  if (error instanceof ViewError) return json({ error: { message: error.message } }, error.status)
  return json({ error: { message: error?.message ?? String(error) } }, 500)
}

/**
 * A write's body, parsed — and every way it can fail answered as a `400` rather than as a `500`.
 *
 * A body the bridge could not deliver, a body that is not JSON, and no body at all are three ways for
 * a caller to be wrong about a request, and none of them is a fault of this server. The empty case is
 * spelled out because `fetch` hands an empty body to `request.text()` as `''`, which `JSON.parse`
 * reports as a syntax error at position 0 — a sentence that would send the reader looking for a
 * missing brace that was never sent.
 */
async function readBody(request) {
  let text
  try {
    text = await request.text()
  } catch (error) {
    throw new ViewError(400, `the request body could not be read: ${error?.message ?? String(error)}`)
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ViewError(400, 'the request body must be a JSON object; this request sent no body')
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ViewError(400, `the request body is not JSON: ${error?.message ?? String(error)}`)
  }
}

/**
 * One view route: resolve which run the request means, then hand the handler that run's directory.
 *
 * `?run=` absent means the registry's default run, and the handler then receives exactly what it
 * received before the registry existed — the configured workspace, by the same string — so every
 * payload that predates ADR 0002 is byte-identical. `platform` and `notice` are the host's answers
 * about *the default run* (the one it ticks), so a request for any other run gets neither: its page
 * says the cluster was not read, rather than printing the default run's cards.
 */
function routeFor({ path, method = 'GET', handler, workspace, registry, platform, clock, notice }) {
  return route({
    path,
    methods: [method],
    // `await` on a non-promise is a no-op, so one adapter serves the seven synchronous views and the
    // one route that reads the cluster listing. Every option is handed to every handler: only the
    // overview reads them, and a handler that ignored its third argument before cannot start using it
    // by accident — the tests pin the other six payloads as byte-identical with both options mounted.
    fetch: async (request) => {
      try {
        const query = queryOf(request.url)
        const target = resolveRun(registry, query, { workspace })
        const host = target.isDefault ? { platform, clock, notice } : { platform: undefined, clock, notice: undefined }
        return json(await handler(target.dir, query, host))
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/**
 * One route of the registry's own: the list and the create share a path because they are one resource,
 * and the intent is the single write a run's own state accepts (ADR 0002).
 *
 * The two writes read their body here rather than in the handler, so a handler can be written against
 * "the parsed body" and tested without a `Request` — and so the one place a body can be unreadable is
 * a 400 in a function with a test.
 */
function registryRoute({ entry, registry, clock }) {
  return route({
    path: entry.path,
    methods: entry.methods,
    fetch: async (request) => {
      try {
        if (request.method === 'GET' && typeof entry.read === 'function') {
          return json(entry.read(registry, { clock }))
        }
        const body = await readBody(request)
        return json(entry.write(registry, body))
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/**
 * Mount the dashboard on the host's connection service.
 *
 * @param {{
 *   connection: { fetch: { register(route: object): () => void } },
 *   workspace?: string,
 *   registry?: object,
 *   platform?: object,
 *   clock?: { now: () => number },
 *   notice?: string,
 * }} options `workspace` is the one run this host ticks; it is required only when no `registry` is
 *   given, because then it *is* the registry. `registry` is the runs a request may name (ADR 0002:
 *   `createRunRegistry`). Without it this mount builds a registry of exactly this one workspace, so
 *   every caller that predates the registry — `mountDashboard`, every test — keeps passing the same
 *   arguments and gets the same page. `platform` is optional: it is the only thing any route may ask,
 *   and only the overview route does (the cluster listing). It is built from the default run's
 *   configuration, so it is handed only to a request that means the default run; any other run's page
 *   reports "the cluster was not read" instead. `clock` is optional too, and defaults to the system
 *   clock: it is what the stop gauges measure a wall-clock limit against. `notice` is the host's sentence about the *run* rather than about the facts: why the
 *   loop is not ticking (a refused configuration). It is not a fact, so it cannot be in the projection,
 *   but a dashboard mounted over a run that never started would otherwise show an empty page and no
 *   reason — the reader goes hunting for the wrong fault. It lands first in the overview envelope's
 *   `notes`, the channel the standalone page already renders; an empty page draws only `reason`, so it
 *   lands there too (see `withNotice`). No other route carries it, and no other *run* receives it: the
 *   sentence is about the run the host ticks.
 * @returns {() => void} the disposer that unregisters every route this call mounted
 */
export function registerRoutes({ connection, workspace, registry, platform, clock, notice }) {
  const runs = registry ?? createRunRegistry({ workspace })
  const disposers = []
  try {
    for (const entry of ROUTES) {
      disposers.push(connection.fetch.register(routeFor({ ...entry, workspace, registry: runs, platform, clock, notice })))
    }
    // The registry's routes come after the views for the same reason the views come first at all: a
    // page that cannot read a run is useless even if it can create one.
    for (const entry of RUN_ROUTES) {
      disposers.push(connection.fetch.register(registryRoute({ entry, registry: runs, clock })))
    }
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