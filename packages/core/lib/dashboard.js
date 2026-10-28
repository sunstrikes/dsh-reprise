/**
 * The third half of the plugin: the read-only dashboard, mounted on whatever connection surface the
 * host already has.
 *
 * It is a **separate plugin** for the same reason the ticking half is: dependencies. `@dsh-reprise/ui`
 * registers its routes on `connection.fetch`, so this half declares `inject: ['connection']` and is
 * simply deferred in a host that has no HTTP surface (a headless run, a bare cordis test). Declaring
 * it next to `timer` would have made one missing display service take the loop down with it.
 *
 * The seam is deliberately one-directional and three lines wide: this package hands over the
 * `connection` service and the workspace directory, and the UI package mounts its own routes and
 * returns a disposer. The kernel never learns a path, a port or a template — so the display layer
 * cannot make the loop depend on it, and a missing UI package costs the dashboard, not the run.
 *
 * @module
 */

import { logFor } from './boot.js'
import { createPlatform } from './ports.js'
import { createRunRegistry } from './runs.js'

export const name = 'reprise-dashboard'

/** The host service the UI package mounts on; declared, then read from our own ctx. */
export const inject = ['connection']

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Resolve the UI package: by name when the workspace installed it, by sibling path otherwise.
 *
 * Both forms are honest. A published deployment has `@dsh-reprise/ui` in its module tree; this
 * monorepo's checkout has `packages/ui` beside `packages/core`, and a dynamic `import()` by bare name
 * would fail there for a reason that has nothing to do with the dashboard (an undeclared workspace
 * dependency is not a bug in the display layer). The failure of the *second* attempt is what gets
 * reported, so the reason a stranger reads is about the UI package.
 */
export async function importUiPackage() {
  try {
    return await import('@dsh-reprise/ui')
  } catch (byName) {
    try {
      return await import('../../ui/lib/index.js')
    } catch {
      throw byName
    }
  }
}

/**
 * Mount the dashboard's routes, if there is a UI package and a surface to mount them on.
 *
 * Never throws: every reason it cannot mount is a value the caller logs. That is the difference
 * between "no dashboard" and "no run", and it is the whole point of this module existing separately.
 *
 * `notice` is passed straight through, untouched and uninterpreted. It is the reason the loop is not
 * ticking, and it exists because this seam mounts the page for a **refused** run configuration too
 * (`boot.js`'s `displayForHost`): the page needs a workspace directory, not a working run, and the
 * operator who opens it at that moment is the one who needs the reason most. Whether and where to
 * render it is the UI package's decision — the kernel knows a workspace and one sentence, no routes.
 *
 * @param {{
 *   connection: any,
 *   workspace: string,
 *   registry?: object,
 *   platform?: any,
 *   notice?: string,
 *   log?: Function,
 *   importUi?: () => Promise<any>,
 * }} options `platform` is the one external thing a route may ask (the overview's cluster listing);
 *   without it the page still mounts and reports the cluster as unread. `notice` is the refusal
 *   sentence for a run that is not ticking, or `undefined` for one that is. `registry` is the list of
 *   runs a request may name (ADR 0002); without it the UI mounts a registry of exactly this one
 *   workspace, which is what every deployment that never sets `runs_root` gets.
 * @returns {Promise<{mounted: boolean, dispose?: () => void, routes?: number, reason?: string}>}
 */
export async function mountDashboard({ connection, workspace, registry, platform, notice, importUi = importUiPackage }) {
  if (typeof connection?.fetch?.register !== 'function') {
    return { mounted: false, reason: 'the host exposes no connection.fetch.register, so there is no surface to mount on' }
  }
  if (typeof workspace !== 'string' || workspace === '') {
    return { mounted: false, reason: 'no workspace directory is configured, so the dashboard would have nothing to read' }
  }

  let ui
  try {
    ui = await importUi()
  } catch (error) {
    return {
      mounted: false,
      reason:
        `@dsh-reprise/ui is not importable in this checkout (${messageOf(error)}) — the projection, its warnings ` +
        'and the packet are all ready for it; the run itself does not depend on them',
    }
  }

  if (typeof ui?.registerRoutes !== 'function') {
    return { mounted: false, reason: '@dsh-reprise/ui exports no registerRoutes(), so there is nothing to call' }
  }

  let dispose
  try {
    dispose = ui.registerRoutes({ connection, workspace, registry, platform, notice })
  } catch (error) {
    return { mounted: false, reason: `@dsh-reprise/ui refused to mount: ${messageOf(error)}` }
  }

  return {
    mounted: true,
    dispose: typeof dispose === 'function' ? dispose : () => {},
    routes: Array.isArray(ui.ROUTES) ? ui.ROUTES.length : undefined,
  }
}

/**
 * The platform the overview route may ask, when this run has one.
 *
 * The display half is a separate plugin and declares `inject: ['connection']` only, so it cannot
 * borrow the ticking half's port; it builds its own from the same configuration, which is a value
 * rather than a service. That is what lets the page print real card numbers when the executor can
 * list its jobs, and `null` plus "cannot list" when it cannot.
 *
 * A configuration that cannot build a platform is not a dashboard failure: no platform is exactly
 * the "the cluster was not asked" answer the projection already has, so the page mounts either way.
 */
function platformFor(config) {
  if (typeof config?.workspaceDir !== 'string' || config.workspaceDir === '') return undefined
  // A configuration that reached here from `resolveConfig` always carries an executor (that file fills
  // the default in). A display-only configuration — the one `index.js` hands over for a refused run —
  // does not, and inventing a local adapter from it would make the page report a cluster listing
  // nobody asked about. "The cluster was not read" is the honest answer, and it is one the
  // projection already has.
  if (config.executor === undefined) return undefined
  try {
    return createPlatform(config, { workspaceDir: config.workspaceDir })
  } catch {
    return undefined
  }
}

export function apply(ctx, config = {}) {
  const log = logFor(ctx, config)
  let disposed = false
  let unmount

  ctx.effect(
    () => () => {
      disposed = true
      unmount?.()
      log('dashboard routes unmounted')
    },
    'reprise.dashboard.dispose()',
  )

  // Async because the import is: the fiber's dispose is registered first, so a host that shuts down
  // during the import still ends up with nothing mounted. `importUi` is a seam for the same reason
  // `onLog` and `config.js`'s `loadDomain` are: a test can mount a stand-in UI and assert the
  // arguments this seam promises, without the real package's behaviour becoming the thing tested.
  void (async () => {
    const result = await mountDashboard({
      connection: ctx.connection,
      workspace: config.workspaceDir,
      // A display-only mount (a refused run) has no resolved configuration to carry a registry, so the
      // fallback is the one run this page can read. `registerRoutes` treats a missing registry the same
      // way; passing it here keeps that answer in one place instead of two.
      registry: config.registry ?? createRunRegistry({ workspace: config.workspaceDir }),
      platform: platformFor(config),
      notice: config.notice,
      importUi: config.importUi,
    })
    if (disposed) {
      result.dispose?.()
      return
    }
    unmount = result.dispose
    log(result.mounted ? `dashboard routes mounted (${result.routes ?? '?'} read route(s))` : `dashboard routes not mounted: ${result.reason}`)
  })()
}