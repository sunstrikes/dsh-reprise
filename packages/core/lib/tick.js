/**
 * The ticking half: `inject: ['timer']`, one interval, one workspace per active run, one dispose.
 *
 * `inject` is not decoration. In cordis 4.0.4 a plugin may only *access* a service it declared:
 * `ctx.get('timer')` works undeclared, but `ctx.timer` — and therefore `ctx.interval()` — throws
 * `cannot get property "timer" without inject`. Declaring it also means this half applies only once
 * the timer exists, which is exactly the fact worth observing when a deployment's loop is silent.
 * Nothing else is declared, and nothing else is reached for: the loop needs no session, no model and
 * no storage domain (user story 13). The dashboard is its own child plugin (`dashboard.js`) precisely
 * so that `connection` — which a headless host does not have — cannot become a dependency of ticking.
 *
 * **Which runs this half drives (ADR 0002).** With no `runs_root` configured the answer is the one run
 * `workspace` names, and this module behaves exactly as it did before the registry existed. With a
 * registry, the answer is the *active* set (`active-runs.js`) — the run the configuration ticks plus
 * every run an operator activated — and each of those gets its own workspace object, its own frozen
 * configuration (from its own `reprise.toml`), its own fact plane and its own in-flight guard. A run
 * that is active but whose configuration cannot be resolved is **reported and skipped**: one log line
 * naming the run and the reason, and every other run keeps ticking.
 *
 * The order inside `apply` is the order the spec asks for: **open the workspaces, reconcile each
 * against the outside world, then schedule the first tick.** Reconciling first is what makes a restart
 * continue instead of restarting — a job that was in flight is adopted, not resubmitted — and it is
 * done per run, because two runs share nothing but the machine.
 *
 * @module
 */

import { activeRunIds } from './active-runs.js'
import { resolveConfig } from './config.js'
import { createWorkspace } from './workspace.js'
import { describeRun, logFor } from './boot.js'
import { mountTick } from './host.js'
import { readRunConfig } from './runs.js'

export const name = 'reprise-tick'
export const inject = ['timer']

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * One workspace for one run, or `undefined` with the reason it could not be opened.
 *
 * The single-run case hands over the configuration the host resolved at boot; a registry run resolves
 * *its own* `reprise.toml` with the run directory as the cwd, so a relative path inside a run's file
 * means what the person who wrote it meant (ADR 0002's one differing path rule).
 */
function openWorkspaceFor({ id, dir, config, log }) {
  if (config !== undefined) return { id, workspace: createWorkspace({ workspaceDir: dir, config, log }) }

  const read = readRunConfig(dir)
  if (read.status !== 'ok') {
    const reason = read.status === 'missing' ? `no ${read.path} — this run has no configuration of its own` : (read.problems ?? []).join('; ')
    return { id, problem: reason }
  }

  const resolved = resolveConfig(read.value, { cwd: dir })
  if (resolved.ok !== true) return { id, problem: resolved.problem }

  return { id, workspace: createWorkspace({ workspaceDir: dir, config: resolved.config, log }), config: resolved.config }
}

/**
 * The workspaces this host may advance, and the ones it refuses to, each with its reason.
 *
 * Exported because "which runs would this host tick?" is a question the boot log, a test and (later) a
 * diagnostics view all ask, and three copies of the answer would drift.
 *
 * @param {object} config the resolved plugin configuration
 * @param {{log?: (message: string, detail?: unknown) => void}} [options]
 * @returns {{entries: {id: string|undefined, workspace: object}[], skipped: {id: string, problem: string}[], activation: object}}
 */
export function planWorkers(config = {}, { log = () => {} } = {}) {
  const single = { id: config.registry?.defaultRun, dir: config.workspaceDir, config }

  if (!config.runs_root) {
    const opened = openWorkspaceFor({ ...single, log })
    return {
      entries: opened.workspace === undefined ? [] : [{ id: opened.id, workspace: opened.workspace }],
      skipped: opened.problem === undefined ? [] : [{ id: opened.id ?? '(workspace)', problem: opened.problem }],
      activation: { status: 'absent', ids: config.registry?.defaultRun === undefined ? [] : [config.registry.defaultRun] },
    }
  }

  const registry = config.registry
  const activation = activeRunIds({ registry, runsRoot: config.runs_root, defaultRun: registry.defaultRun })
  for (const problem of activation.problems) log(`${problem} — falling back to the run this host ticks`)

  const entries = []
  const skipped = []
  for (const id of activation.ids) {
    const dir = registry.resolve(id)
    if (dir === undefined) {
      skipped.push({ id, problem: 'the registry no longer lists this directory' })
      continue
    }
    const opened = openWorkspaceFor({ id, dir, log })
    if (opened.workspace === undefined) {
      skipped.push({ id, problem: opened.problem })
      log(`not ticking run ${id}: ${opened.problem}`)
      continue
    }
    if (opened.config !== undefined) log(`run ${id}: ${describeRun({ ...opened.config, workspaceDir: dir })}`)
    entries.push({ id, workspace: opened.workspace })
  }

  return { entries, skipped, activation }
}

export function apply(ctx, config = {}) {
  const log = logFor(ctx, config)

  const plan = planWorkers(config, { log })

  let mounted
  const workspaces = plan.entries
  if (workspaces.length === 0) {
    // Nothing could be opened. The host is already booted; the right outcome is a log line, not an
    // exception into the loader, and the dashboard still mounts on the directory the configuration
    // names (a page that explains the silence is worth more than no page).
    log('workspace unavailable: nothing to tick', { skipped: plan.skipped })
    return
  }

  // The live view of the same list. An operator starting a run from the dashboard writes the host's
  // activation record; this closure re-reads it before each beat, opens the workspace the first time a
  // run appears and stops scheduling it when it leaves — a toggle that only took effect after a host
  // restart would be a switch that lies about what it did.
  const open = new Map(workspaces.map((entry) => [entry.id, entry]))
  const reported = new Set(plan.skipped.map((entry) => entry.id))
  let lastActive = workspaces.map((entry) => entry.id)

  const provider = () => {
    const active = activeRunIds({ registry: config.registry, runsRoot: config.runs_root, defaultRun: config.registry.defaultRun })
    for (const id of active.ids) {
      if (open.has(id) || reported.has(id)) continue
      const dir = config.registry.resolve(id)
      const opened = dir === undefined ? { id, problem: 'the registry no longer lists this directory' } : openWorkspaceFor({ id, dir, log })
      if (opened.workspace === undefined) {
        // Reported once, not once per beat: a broken configuration is not news every 300 ms.
        reported.add(id)
        log(`not ticking run ${id}: ${opened.problem}`)
        continue
      }
      open.set(id, { id, workspace: opened.workspace })
      log(`run ${id}: activated, joining the tick`)
    }

    // A run that left the set stops being scheduled but keeps its handle: a tick may still be in flight
    // for it, and closing a store under a running tick is how a decision to stop becomes a crash.
    for (const id of lastActive) if (!active.ids.includes(id) && open.has(id)) log(`run ${id}: deactivated, no longer advancing`)
    lastActive = active.ids
    return active.ids.filter((id) => open.has(id)).map((id) => open.get(id))
  }

  let disposed = false
  ctx.effect(
    () => () => {
      disposed = true
      mounted?.stop()
      for (const entry of open.values()) {
        try {
          entry.workspace.close?.()
        } catch (error) {
          log(`closing run ${entry.id ?? '(workspace)'} failed: ${messageOf(error)}`)
        }
      }
      log('disposed', { ...(mounted?.stats?.() ?? {}) })
    },
    'reprise.dispose()',
  )

  // The same "what is this run" object the boot half printed, now that the loop is actually ticking:
  // one description, two moments, so a reader comparing them is comparing one derivation.
  log('tick-applied', {
    ...describeRun(config),
    interval_ms: config.interval_ms,
    runs: workspaces.map((entry) => entry.id ?? '(workspace)'),
    max_active_runs: config.max_active_runs,
  })

  // Reconciliation is async (the platform is a network boundary), the interval is not. Starting the
  // interval before reconciliation finishes would let one tick run against facts nobody has checked
  // yet, so the mount happens after — and not at all if the fiber was disposed meanwhile.
  void (async () => {
    for (const entry of workspaces) {
      try {
        const repairs = await entry.workspace.reconcileNow()
        if (repairs.length > 0) log(`run ${entry.id ?? '(workspace)'}: reconciled on boot, ${repairs.length} repair(s)`, repairs)
      } catch (error) {
        // Degrade: a platform that cannot answer during boot must not stop the loop from ticking; the
        // grace window exists precisely so "we could not find out" is not a verdict.
        log(`run ${entry.id ?? '(workspace)'}: reconcile failed, continuing: ${messageOf(error)}`)
      }
    }
    if (disposed) return

    mounted = mountTick(ctx, {
      // A registry host hands over a *provider*: which runs advance is re-read every beat, so the
      // dashboard's start/stop applies without a restart. A single-run host hands over its one
      // workspace, because there is nothing to re-read.
      ...(config.runs_root ? { provider } : { workspaces }),
      intervalMs: config.interval_ms,
      // How many runs may advance per beat. Every active run still advances; this only decides how many
      // in the same beat, so a host with five runs and `max_active_runs: 2` interleaves rather than
      // starves (ADR 0002).
      maxActive: config.max_active_runs,
      log,
    })
  })()
}