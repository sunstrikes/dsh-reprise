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
 * @param {{
 *   connection: any,
 *   workspace: string,
 *   platform?: any,
 *   log?: Function,
 *   importUi?: () => Promise<any>,
 * }} options `platform` is the one external thing a route may ask (the overview's cluster listing);
 *   without it the page still mounts and reports the cluster as unread.
 * @returns {Promise<{mounted: boolean, dispose?: () => void, routes?: number, reason?: string}>}
 */
export async function mountDashboard({ connection, workspace, platform, importUi = importUiPackage }) {
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
    dispose = ui.registerRoutes({ connection, workspace, platform })
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
  // during the import still ends up with nothing mounted.
  void (async () => {
    const result = await mountDashboard({
      connection: ctx.connection,
      workspace: config.workspaceDir,
      platform: platformFor(config),
    })
    if (disposed) {
      result.dispose?.()
      return
    }
    unmount = result.dispose
    log(result.mounted ? `dashboard routes mounted (${result.routes ?? '?'} read route(s))` : `dashboard routes not mounted: ${result.reason}`)
  })()
}