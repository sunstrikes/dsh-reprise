/**
 * The dashboard seam: `@dsh-reprise/ui` mounted on the host's own connection surface, and unmounted with
 * the fiber that mounted it.
 *
 * Contract guarded (spec "展示层", user stories 41/42): the dashboard is a *separate child plugin*
 * declaring `inject: ['connection']`, so a host without an HTTP surface loses the dashboard and not the
 * loop; the kernel hands over the connection service and a workspace directory and learns nothing else;
 * and every route the UI mounts goes away when the plugin is disposed — a route outliving its owner is
 * a background task nobody can stop.
 *
 * The last test is the integration one: it mounts the **real** `packages/ui` package against a fake
 * connection shaped like the host's registry, which is the only way to know this seam's two halves
 * still agree about the argument names.
 *
 * `notice` is asserted as an **argument** here, never as rendered output: it is what this package
 * promises the UI when a run was refused (`refused-run-dashboard.test.js` mounts the same seam through
 * a whole cordis root), and where the page puts the sentence is `packages/ui`'s test to make.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { mountDashboard } from '../lib/dashboard.js'
import { Store } from '../lib/store.js'

/** The host's registry shape: `register(route)` validates, refuses duplicates, returns a disposer. */
function fakeConnection() {
  const routes = new Map()
  return {
    routes,
    fetch: {
      register(route) {
        if (typeof route?.path !== 'string') throw new Error('connection: a route needs a path')
        if (routes.has(route.path)) throw new Error(`connection: ${route.path} is already registered`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

const neverUi = async () => {
  throw new Error("Cannot find package '@dsh-reprise/ui'")
}

test('a UI package mounts its routes on the connection service and hands back nothing this side owns', async () => {
  const connection = fakeConnection()
  const registered = []
  const result = await mountDashboard({
    connection,
    workspace: '/tmp/workspace',
    importUi: async () => ({
      ROUTES: [{ path: '/api/reprise/overview' }],
      registerRoutes: (options) => registered.push(options),
    }),
  })

  assert.equal(result.mounted, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].connection, connection, 'the UI mounts on the host surface; this package never owns a route')
  assert.equal(registered[0].workspace, '/tmp/workspace', 'and it reads one workspace, not a session')
  assert.equal(registered[0].notice, undefined, 'a run that is ticking has no apology to pass along')
  assert.equal(result.routes, 1)
})

test('the reason the loop is not ticking reaches the UI as a note, word for word', async () => {
  // This seam is what mounts the page for a *refused* configuration (`boot.js`'s `displayForHost`), so
  // the sentence has to arrive unedited: the kernel does not know where a note is rendered, and the
  // page is the only caller that can decide. What the UI does with it is `packages/ui`'s test.
  const registered = []
  const result = await mountDashboard({
    connection: fakeConnection(),
    workspace: '/tmp/workspace',
    notice: 'this run is not ticking: domain must be the directory of one domain pack',
    importUi: async () => ({
      registerRoutes: (options) => registered.push(options),
    }),
  })

  assert.equal(result.mounted, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].notice, 'this run is not ticking: domain must be the directory of one domain pack')
  assert.equal(registered[0].workspace, '/tmp/workspace', 'the notice rides along with the directory, not instead of it')
})

test('no UI package is a reason, never an exception', async () => {
  const result = await mountDashboard({ connection: fakeConnection(), workspace: '/tmp/workspace', importUi: neverUi })
  assert.equal(result.mounted, false)
  assert.match(result.reason, /@dsh-reprise\/ui/)
})

test('no connection surface is also a reason: a headless host still runs the loop', async () => {
  const result = await mountDashboard({ connection: undefined, workspace: '/tmp/workspace' })
  assert.equal(result.mounted, false)
  assert.match(result.reason, /connection/)
})

test('a UI package that throws on mount is reported with its own message', async () => {
  const result = await mountDashboard({
    connection: fakeConnection(),
    workspace: '/tmp/workspace',
    importUi: async () => ({
      registerRoutes: () => {
        throw new Error('/api/reprise/overview is already registered')
      },
    }),
  })
  assert.equal(result.mounted, false)
  assert.match(result.reason, /already registered/)
})

test('the real @dsh-reprise/ui mounts, and its disposer unregisters every route', async (t) => {
  const connection = fakeConnection()
  const result = await mountDashboard({ connection, workspace: '/tmp/reprise-dashboard-unused' })

  if (result.mounted !== true) {
    // The UI package is not in this checkout (its ticket may not be merged yet). Say so rather than
    // pretend the seam is verified — but only in that case, and loudly enough to notice.
    t.diagnostic(`@dsh-reprise/ui not mounted: ${result.reason}`)
    assert.match(result.reason, /@dsh-reprise\/ui/)
    return
  }

  assert.ok(connection.routes.size >= 4, `expected at least the four read routes, got ${connection.routes.size}`)
  for (const path of ['/api/reprise/overview', '/api/reprise/rounds', '/api/reprise/candidate', '/api/reprise/conclusion']) {
    assert.ok(connection.routes.has(path), `${path} must be mounted: the four views are the dashboard`)
  }

  const mounted = connection.routes.size
  result.dispose()
  assert.equal(connection.routes.size, 0, 'unloading the plugin must leave no route behind')
  assert.ok(mounted > 0)
})
test('the overview page the browser fetches carries the GPU-hours warning', async (t) => {
  let ui
  try {
    ui = await import('../../ui/lib/index.js')
  } catch (error) {
    t.diagnostic(`@dsh-reprise/ui is not in this checkout: ${error?.message ?? error}`)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'reprise-dashboard-warning-'))
  const store = Store.open(dir)
  try {
    // Exactly what a run records at INIT, which is what the dashboard reads instead of a command-line
    // flag: the page must answer about the run that happened, not about today's configuration file.
    store.setState(undefined, 'workspace', {
      started_at_ms: 1_761_091_200_000,
      metrics: { primary: 'auc', objectives: { auc: 'up' } },
      stop: { max_rounds: 1 },
      budget: { gpu_hours_limit: 0 },
      executor: { kind: 'ray' },
    })

    const page = ui.overviewView(store, {})
    const warning = page.data.warnings.find((entry) => entry.code === 'no_gpu_hours_limit')
    assert.ok(warning, `the overview payload must carry it: ${JSON.stringify(Object.keys(page.data))}`)
    assert.equal(warning.label, 'GPU 小时未设上限', 'the shipped client renders this label verbatim')
  } finally {
    store.close()
  }
})