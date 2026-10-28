/**
 * The half of the plugin that declares no dependency: did the package load, and is its configuration
 * usable?
 *
 * The split is the one lesson from ticket 01 that has to survive into the real plugin. A cordis plugin
 * whose declared dependency is absent is **deferred, not failed** — so a package that never applies
 * and a package whose `timer` never appeared produce the same empty log. Two entry points fix that:
 * this one runs as soon as the host boots and says "I am here, and here is what I think of my
 * configuration"; the ticking half (`tick.js`) declares `inject: ['timer']` and therefore only speaks
 * once the timer exists.
 *
 * It also owns the words the run owes its operator before anything expensive happens: the warnings
 * from `warnings.js` are logged here, at boot, not discovered on the bill.
 *
 * @module
 */

import { declaredWorkspace, resolveConfig } from './config.js'
import { createRunRegistry } from './runs.js'
import { runnerLayout } from './worktrees.js'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Where this package reports.
 *
 * Preference order, and the reason for it: an explicit `onLog` (tests, the CLI, an embedder that
 * wants the lines in its own sink), then the host's logger, then nothing at all. Writing its own
 * log file — which the ticket-01 probe did, ~1.5 MB/day — is deliberately not an option: an
 * unattended plugin that keeps a private trace is how a second, unchecked account of the run starts.
 *
 * @param {any} ctx
 * @param {{onLog?: (message: string, detail?: unknown) => void}} [config]
 * @returns {(message: string, detail?: unknown) => void}
 */
export function logFor(ctx, config = {}) {
  if (typeof config?.onLog === 'function') {
    return (message, detail) => {
      try {
        config.onLog(message, detail)
      } catch {
        // A log sink that throws must not be able to stop the loop it observes.
      }
    }
  }

  let logger
  try {
    logger = typeof ctx?.logger === 'function' ? ctx.logger('reprise') : undefined
  } catch {
    logger = undefined
  }

  return (message, detail) => {
    try {
      if (typeof logger?.info === 'function') {
        if (detail === undefined) logger.info(message)
        else logger.info(message, detail)
        return
      }
      if (typeof ctx?.logger === 'function') ctx.logger.info(message)
    } catch {
      // Same reasoning as above: logging is not a reason to fail.
    }
  }
}

/**
 * What this host is running, as one object every surface can print.
 *
 * The motivating question is blunt: an operator looking at a boot log should be able to answer *what
 * is this host running?* — which workspace it owns, which repository it branches candidates from,
 * where their trees are created, and whether it will keep them — without reading the profile patch
 * that produced it. Before this existed, the answer lived in three places (the patch, `workspace.js`'s
 * constructor, `ports.js`'s runner) and the log printed one of them.
 *
 * @param {object} [config] a resolved configuration (`config.js`)
 * @returns {{workspace: string|null, workspace_from: string|null, config_file: string|null,
 *            repo: string|null, worktrees: string|null, base_ref: string|null, keep: boolean|null,
 *            executor: string, candidate: string, rounds: 'on'|'off'}}
 */
export function describeRun(config = {}) {
  const layout = runnerLayout({ workspaceDir: config.workspaceDir, runner: config.runner })
  return {
    workspace: config.workspaceDir ?? null,
    workspace_from: config.workspaceSource ?? null,
    config_file: typeof config.config_file === 'string' ? config.config_file : null,
    repo: layout?.repoDir ?? null,
    worktrees: layout?.worktreesDir ?? null,
    base_ref: layout?.baseRef ?? null,
    keep: layout === undefined ? null : layout.keep,
    executor: config.executor?.kind ?? 'local',
    candidate: config.candidate?.kind ?? 'none',
    rounds: config.rounds === undefined || config.rounds === false ? 'off' : 'on',
  }
}

/** The one log line `describeRun` renders to: a boot log is a place, not a paragraph. */
export function describeRunLine(config) {
  const run = describeRun(config)
  const parts = [`workspace ${run.workspace ?? '(none)'}${run.workspace_from === null ? '' : ` (from ${run.workspace_from})`}`]
  parts.push(
    run.repo === null
      ? 'no runner: nothing to branch candidates from'
      : `repo ${run.repo} (branches from ${run.base_ref == null ? 'HEAD' : run.base_ref})`,
  )
  if (run.worktrees !== null) {
    parts.push(`worktrees ${run.worktrees} (${run.keep === true ? 'kept: runner.keep' : 'prunable: runner.keep: false'})`)
  }
  parts.push(`executor ${run.executor}`, `candidate ${run.candidate}`, `rounds ${run.rounds}`)
  if (run.config_file !== null) parts.push(`config_file ${run.config_file}`)
  // Only when a registry is configured: every host that predates it prints exactly the line it always
  // printed, which is what lets the boot log stay a diffable artefact (ADR 0002).
  if (config.runs_root) parts.push(`runs_root ${config.runs_root} (${config.registry?.list().length ?? 0} run(s))`)
  return `run: ${parts.join(' \u00b7 ')}`
}

/**
 * Resolve the configuration, report the verdict, and hand back what `resolveConfig` said.
 *
 * The verdict is returned **whole** — `{ok: true, config, warnings}` or `{ok: false, problem,
 * problems}` — rather than collapsed to a config or `undefined`. The reason a run may not start is
 * not only a log line any more: a refused run still mounts its read-only page (`displayForHost`
 * below), and that page is where the operator reads what is wrong. Answering `undefined` here would
 * leave the page with the one thing it cannot render — no reason at all.
 *
 * Nothing in this function throws: a misconfigured workspace is one plugin's problem, so every
 * refusal is a value the caller decides about.
 *
 * @param {object} raw the bundle-patch / loader configuration
 * @param {(message: string, detail?: unknown) => void} log
 * @returns {{ok: true, config: object, problems: string[], warnings: object[]}
 *         | {ok: false, problem: string, problems: string[], warnings: object[]}}
 */
export function resolveForHost(raw, log) {
  log('applied', { note: 'the package loaded at host boot; the ticking half waits for the timer' })

  let resolved
  try {
    resolved = resolveConfig(raw)
  } catch (error) {
    // A resolver that throws is a bug, not a configuration — but the display half still needs a
    // sentence to show, and the sentence the log just got is the honest one.
    log(`refusing to start: ${messageOf(error)}`)
    return { ok: false, problem: messageOf(error), problems: [messageOf(error)], warnings: [] }
  }

  if (!resolved.ok) {
    log(`not ticking: ${resolved.problem}`)
    for (const problem of resolved.problems.slice(1)) log(`also not ticking: ${problem}`)
    return resolved
  }

  // "What is this host running?" — answered from the resolved configuration, so the log cannot claim
  // a workspace or a repository the run is not actually pointing at.
  log(describeRunLine(resolved.config), describeRun(resolved.config))

  for (const warning of resolved.warnings) {
    log(`[${warning.severity}] ${warning.code}: ${warning.message}`, { code: warning.code, label: warning.label })
  }
  return resolved
}

/**
 * What the **read-only half** can show, whether or not the run half is allowed to tick.
 *
 * The coupling this removes: before it, "the run configuration was refused" and "there is no
 * dashboard" were the same fact, because `apply` returned early on the refusal and never plugged the
 * display plugin — every route then answered 404 while the client bundle still drew the page, which
 * is a blank screen with no explanation, at the one moment an explanation is most useful. A page
 * that reads a workspace needs a directory, not a working run.
 *
 * So: a valid run answers its own workspace and no notice. A refused run answers the directory
 * `declaredWorkspace` can still name, plus `notice` — one sentence the overview envelope renders as
 * a note, because a page that shows numbers without saying the loop is stopped is worse than no page.
 * When not even a directory can be named, the answer is `undefined` and one log line says why: a
 * dashboard mounted with no workspace would only be a second way of saying "nothing".
 *
 * @param {object} raw the same configuration `resolveForHost` was given
 * @param {{ok: boolean, config?: object, problem?: string}} resolved `resolveForHost`'s answer
 * @param {(message: string, detail?: unknown) => void} [log]
 * @param {{cwd?: string, env?: Record<string, string | undefined>,
 *         readFile?: (path: string) => string}} [options] the same resolution seams `config.js` takes,
 *   so a test can pin both a configuration and the environment that produced it.
 * @returns {{workspaceDir: string, registry: object, notice: string | undefined} | undefined}
 */
export function displayForHost(raw, resolved, log = () => {}, { cwd, env, readFile } = {}) {
  if (resolved?.ok === true) {
    // The resolved configuration already carries its registry (ADR 0002) — one derivation, so the page
    // cannot list runs the loop resolved under a different set of keys. The fallback is for a caller
    // that hands over a hand-built `resolved` (a test, an embedder) and is never the host path.
    return {
      workspaceDir: resolved.config.workspaceDir,
      registry: resolved.config.registry ?? createRunRegistry({ workspace: resolved.config.workspaceDir }),
      notice: undefined,
    }
  }

  // The refused path reads the workspace declaration on its own: the run configuration might be
  // unusable for a reason that has nothing to do with paths (a missing domain pack), and the page
  // still has a directory to read in that case.
  const workspace = declaredWorkspace(raw, { cwd, env, readFile })
  if (workspace.problem !== undefined) {
    // A host configured with a *registry* and no single `workspace` is the one shape where a refused
    // run still has something worth showing: the runs are on disk, the loop just has no run to tick.
    // Reading the registry here (rather than refusing the page) is what lets an operator adopt
    // `runs_root` before the ticking half learns to drive several runs (ADR 0002).
    const registry = createRunRegistry({ runsRoot: raw?.runs_root, runs: raw?.runs, cwd })
    const first = registry.list()[0]
    if (first === undefined) {
      log(`dashboard not mounted: the run was refused and no workspace directory could be named either (${workspace.problem})`)
      return undefined
    }
    log(`dashboard mounted on the registry's first run (${first.id}): no workspace is configured, so nothing ticks yet`)
    return {
      workspaceDir: first.dir,
      registry,
      notice: `this run is not ticking: ${workspace.problem} — ${registry.list().length} run(s) are registered and none of them is being ticked`,
    }
  }

  const problem = resolved?.problem ?? 'the run configuration could not be resolved'
  return {
    workspaceDir: workspace.dir,
    registry: createRunRegistry({ workspace: workspace.dir, runsRoot: raw?.runs_root, runs: raw?.runs, cwd }),
    notice: `this run is not ticking: ${problem}`,
  }
}
