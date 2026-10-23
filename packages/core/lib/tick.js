/**
 * The ticking half: `inject: ['timer']`, one workspace, one interval, one dispose.
 *
 * `inject` is not decoration. In cordis 4.0.4 a plugin may only *access* a service it declared:
 * `ctx.get('timer')` works undeclared, but `ctx.timer` — and therefore `ctx.interval()` — throws
 * `cannot get property "timer" without inject`. Declaring it also means this half applies only once
 * the timer exists, which is exactly the fact worth observing when a deployment's loop is silent.
 * Nothing else is declared, and nothing else is reached for: the loop needs no session, no model and
 * no storage domain (user story 13). The dashboard is its own child plugin (`dashboard.js`) precisely
 * so that `connection` — which a headless host does not have — cannot become a dependency of ticking.
 *
 * The order inside `apply` is the order the spec asks for: **open the workspace, reconcile against
 * the outside world, then schedule the first tick.** Reconciling first is what makes a restart
 * continue instead of restarting — a job that was in flight is adopted, not resubmitted.
 *
 * @module
 */

import { createWorkspace } from './workspace.js'
import { logFor } from './boot.js'
import { mountTick } from './host.js'

export const name = 'reprise-tick'
export const inject = ['timer']

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

export function apply(ctx, config = {}) {
  const log = logFor(ctx, config)

  let workspace
  try {
    workspace = createWorkspace({ workspaceDir: config.workspaceDir, config, log })
  } catch (error) {
    // A workspace that cannot be opened is the one failure this half is allowed to have. The host is
    // already booted; the right outcome is a log line, not an exception into the loader.
    log(`workspace unavailable: ${messageOf(error)}`, { workspace: config.workspaceDir })
    return
  }

  let disposed = false
  let mount
  ctx.effect(
    () => () => {
      disposed = true
      mount?.stop()
      workspace.close()
      log('disposed', { ...(mount?.stats?.() ?? {}) })
    },
    'reprise.dispose()',
  )

  log('tick-applied', {
    workspace: config.workspaceDir,
    interval_ms: config.interval_ms,
    executor: config.executor?.kind ?? 'local',
    candidate: config.candidate?.kind ?? 'none',
    rounds: config.rounds === undefined || config.rounds === false ? 'off' : 'on',
  })

  // Reconciliation is async (the platform is a network boundary), the interval is not. Starting the
  // interval before reconciliation finishes would let one tick run against facts nobody has checked
  // yet, so the mount happens after — and not at all if the fiber was disposed meanwhile.
  void (async () => {
    try {
      const repairs = await workspace.reconcileNow()
      if (repairs.length > 0) log(`reconciled on boot: ${repairs.length} repair(s)`, repairs)
    } catch (error) {
      // Degrade: a platform that cannot answer during boot must not stop the loop from ticking; the
      // grace window exists precisely so "we could not find out" is not a verdict.
      log(`reconcile failed, continuing: ${messageOf(error)}`)
    }
    if (disposed) return

    mount = mountTick(ctx, { workspace, intervalMs: config.interval_ms, log })
  })()
}