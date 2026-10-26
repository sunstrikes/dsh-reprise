/**
 * The page a refused run still owes its operator.
 *
 * Contract guarded (spec "展示层", the 复现 404 report): the dashboard is mounted whenever a workspace
 * directory can be named — **including when the run configuration was refused** — and it carries the
 * sentence saying why the loop is not ticking. The defect this pins: `apply` returned early on a
 * refusal, so `dashboard` was never plugged, every `/api/reprise/*` route answered 404 while the
 * client bundle still drew the page, and the reader got a blank screen at the one moment a reason
 * mattered. The desktop profile's row had no `domain`, which is exactly the configuration below.
 *
 * Two things are asserted separately on purpose:
 *
 *   - through a real cordis root, that a refused configuration still mounts its route on the host's
 *     `connection` service and hands the UI the workspace *and* the notice;
 *   - on `displayForHost` alone, what the display half can say when not even a directory is knowable —
 *     nothing is mounted, and the boot log says why, rather than a page that renders "nothing".
 *
 * The UI package is stubbed (`importUi`), as in `dashboard.test.js`: the claim here is about the
 * arguments this package promises, not about what another package renders.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { displayForHost } from '../lib/boot.js'
import { resolveConfig } from '../lib/config.js'
import * as plugin from '../lib/index.js'
import { CONFIG_ONLY_PACK_DIR } from './support/domain.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** cordis ships with the Harness profile, not with this repository — a bare clone skips, not fails. */
async function host() {
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    return { Context }
  } catch {
    return undefined
  }
}

/** The host's registry shape: `register(route)` refuses duplicates and answers a disposer. */
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

function collector() {
  const lines = []
  return { lines, onLog: (message) => lines.push(String(message)), text: () => lines.join('\n') }
}

test('a configuration refused for a missing domain still mounts the page, with the reason on it', async (t) => {
  const hostRuntime = await host()
  if (hostRuntime === undefined) return t.skip('cordis is not in this checkout (it ships with the DeepSeek Harness profile)')

  const connection = fakeConnection()
  const root = new hostRuntime.Context()
  root.provide('connection', connection)
  const log = collector()
  const asked = []
  const workspace = mkdtempSync(join(tmpdir(), 'reprise-refused-'))

  await root.plugin(plugin, {
    workspace,
    // No `domain`: the refusal the desktop profile produced. A page needs a directory to read, and
    // this configuration names one — nothing else it says was ever validated, which is the point.
    executor: { kind: 'local', command: ['node', '-e', '0'] },
    onLog: log.onLog,
    importUi: async () => ({
      ROUTES: [{ path: '/api/reprise/overview' }],
      registerRoutes: (options) => {
        asked.push(options)
        return connection.fetch.register({ path: '/api/reprise/overview', methods: ['GET'], fetch: () => ({}) })
      },
    }),
  })
  await wait(150)

  assert.ok(connection.routes.has('/api/reprise/overview'), 'the browser must get the page, refused run or not')
  assert.equal(asked.length, 1, 'mounted once, by the display half')
  assert.equal(asked[0].workspace, workspace, 'the page reads the directory the refused configuration named')
  assert.match(
    asked[0].notice,
    /^this run is not ticking: domain must be the directory of one domain pack/,
    'and it is told why the loop is silent, in the words the boot log used',
  )
  assert.equal(asked[0].platform, undefined, 'no executor was validated, so no cluster listing is invented')
  assert.match(log.text(), /not ticking: domain must be the directory of one domain pack/, 'the boot log still says why')
  assert.match(log.text(), /dashboard routes mounted/, 'and the dashboard reports that it mounted anyway')
  assert.doesNotMatch(log.text(), /tick-applied/, 'nothing is scheduled against a refused run')

  await root.fiber.dispose()
  assert.equal(connection.routes.size, 0, 'the route goes away with the fiber that mounted it')
})

// ------------------------------------------------------------ what the display half can say

/** A valid run, resolved for real so this branch is not a hand-built stub of `resolveConfig`. */
const validRun = () =>
  resolveConfig(
    { workspace: '.run', domain: CONFIG_ONLY_PACK_DIR, executor: { kind: 'local', command: ['node', '-e', '0'] } },
    { cwd: '/srv/host', env: {} },
  )

test('a valid run answers its own workspace and no notice', () => {
  const resolved = validRun()
  assert.equal(resolved.ok, true, resolved.problems?.join('; '))

  const display = displayForHost({}, resolved, () => {})
  assert.deepEqual(display, { workspaceDir: '/srv/host/.run', notice: undefined }, 'a working run needs no apology')
})

test('a refused run answers the directory it still declared, and the reason it is not ticking', () => {
  const raw = { workspace: '.run' }
  const resolved = resolveConfig(raw, { cwd: '/srv/host', env: {} })
  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /domain/)

  const display = displayForHost(raw, resolved, () => {}, { cwd: '/srv/host', env: {} })
  assert.equal(display.workspaceDir, '/srv/host/.run', 'the refusal is about the run, not about where it reads')
  assert.equal(display.notice, `this run is not ticking: ${resolved.problem}`, 'one sentence, and not a paraphrase of it')
})

test('with no workspace declared either, nothing is mounted and the log says why', () => {
  const raw = {}
  const resolved = resolveConfig(raw, { cwd: '/srv/host', env: {} })
  assert.equal(resolved.ok, false)

  const log = collector()
  // `env: {}` rather than the machine's: a test must not inherit a DSH_REPRISE_WORKSPACE.
  const display = displayForHost(raw, resolved, log.onLog, { cwd: '/srv/host', env: {} })
  assert.equal(display, undefined, 'a dashboard with no workspace would only be a second way of saying "nothing"')
  assert.match(log.text(), /dashboard not mounted/)
  assert.match(log.text(), /workspace must be the path of the directory this run owns/, 'the log names the fix')
})