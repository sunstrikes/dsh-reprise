/**
 * The plugin configuration, validated once at boot instead of discovered mid-run.
 *
 * A run is **(run configuration) × (domain pack)**. What this run decides — the workspace it owns,
 * its budget, how many rounds, which implementer and which model port — is here. What the *domain*
 * knows — the metric contract, the priors, the adjustable surface, the five prompts and the executor
 * entry — is in the pack, and `domain` names it. The kernel reads neither as policy: it reads them as
 * numbers and names, which is why a user changes a metric direction without touching code.
 *
 * Two rules shape the validation:
 *
 *   - **Refuse at boot what cannot work at tick 400.** A workspace path that does not exist, an
 *     executor with no command, a round workflow with no model port: each of those is a log line now
 *     and a stalled night later, so they are fatal here and cost the host nothing (the plugin simply
 *     does not mount). This is the "degrade, never break the boot" rule applied early.
 *   - **Warn about what is legal but dangerous.** An uncapped spend on a real executor is not a
 *     configuration error — it is the shipped default — but it must be said out loud; those come from
 *     `warnings.js` so the boot log and the dashboard read the same list.
 *
 * @module
 */

import { resolve as resolvePath } from 'node:path'

import { isPlainObject } from '@dsh-reprise/contract'
import { MODEL_KINDS } from '@dsh-reprise/exec/model'

import { DomainPackError, executorProblems, loadDomainPack } from './domain.js'
import { gpuExclusivityProblems } from './jobs.js'
import { bindingOf, resolveMetricContract } from './metric-contract.js'
import { loadConfigFile } from './run-config.js'
import { createRunRegistry } from './runs.js'
import { effectiveSettings } from './settings.js'
import { configWarnings, modelPortDeclared } from './warnings.js'

/** Five seconds: the cadence ticket 01 measured in the real host (78 beats / 415 s, drift ≤ 3 ms). */
export const DEFAULT_INTERVAL_MS = 5_000

/**
 * Two runs may tick at once by default. Not a performance number: it is the smallest value that makes
 * "several exploration tasks" real while keeping one `interval_ms` tick from submitting to two
 * executors back to back without anybody noticing the bill.
 */
export const DEFAULT_MAX_ACTIVE_RUNS = 2

const CANDIDATE_KINDS = Object.freeze(['command', 'claude', 'dsh'])

const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isCommand = (value) => Array.isArray(value) && value.length > 0 && value.every(isText)

/**
 * The workspace directory a configuration declares — answered without judging the rest of it.
 *
 * Two callers ask this question for different reasons and must not get different answers.
 * `resolveConfig` asks it to decide whether a run may start (no directory, no run), and the display
 * half (`boot.js`'s `displayForHost`) asks it about a run that was **refused**, because the
 * read-only page needs a directory to read rather than a working run — and a refusal is exactly when
 * somebody opens that page. Two accounts of "which directory does this run mean?" would let the boot
 * log and the page disagree about it, so both come here.
 *
 * The precedence is one order: inline `workspace` → the value the run configuration file supplied →
 * `DSH_REPRISE_WORKSPACE`. The first two share one field after `loadConfigFile`'s shallow merge, which
 * is what `workspaceFromFile` exists to tell apart. `dir` is absolute in every case: an inline or
 * environment value was typed in the host's cwd and means what it says there, while a value inside a
 * configuration file was already resolved against *that file's* directory (`run-config.js`'s one
 * differing path rule) — resolving it again against `cwd` cannot move an absolute path.
 *
 * @param {unknown} raw the object the host's bundle patch, the `run` CLI, or a test hands over
 * @param {{cwd?: string, env?: Record<string, string | undefined>, readFile?: (path: string) => string,
 *         loaded?: object}} [options] `loaded` is `loadConfigFile`'s result when the caller has already
 *   read the file (the boot path has, and one run is not read twice); omit it and this reads the file
 *   itself, which is what a refused boot does — it has the raw configuration, not the reading.
 * @returns {{dir: string, source: 'config' | 'config_file' | 'env'} | {problem: string}}
 */
export function declaredWorkspace(raw = {}, { cwd = process.cwd(), env = process.env, readFile, loaded } = {}) {
  const read = loaded ?? loadConfigFile({ raw, cwd, env, readFile })
  if (!read.ok) return { problem: read.problems[0] }

  const merged = read.raw ?? {}
  if (isText(merged.workspace)) {
    return { dir: resolvePath(cwd, merged.workspace), source: read.workspaceFromFile ? 'config_file' : 'config' }
  }
  // The environment is last because a value typed into the configuration is the more specific
  // statement, and first among the two when the configuration names none.
  if (isText(env?.DSH_REPRISE_WORKSPACE)) return { dir: resolvePath(cwd, env.DSH_REPRISE_WORKSPACE), source: 'env' }

  return {
    problem:
      'workspace must be the path of the directory this run owns, e.g. workspace: .reprise/run-1 — ' +
      'or set DSH_REPRISE_WORKSPACE (a relative path in either place resolves against the host cwd)',
  }
}

/**
 * Validate and normalise one plugin/CLI configuration.
 *
 * @param {unknown} raw the object the host's bundle patch, the `run` CLI, or a test hands over
 * @param {{cwd?: string, env?: Record<string, string | undefined>, loadDomain?: (dir: string) => object,
 *         readFile?: (path: string) => string}} [options] `workspace` and `domain` are resolved against
 *   `cwd`, not against wherever the host process happens to be. `loadDomain` is the seam a test uses
 *   to hand over a pack without a directory of files on disk; `readFile` is the seam for the run
 *   configuration file `config_file` / `DSH_REPRISE_CONFIG` names; `env` is passed, never read
 *   implicitly, so configuration precedence is testable.
 * @returns {{ok: true, config: object, problems: string[], warnings: object[]}
 *         | {ok: false, problem: string, problems: string[], warnings: object[]}}
 */
export function resolveConfig(
  raw = {},
  { cwd = process.cwd(), env = process.env, loadDomain = loadDomainPack, readFile } = {},
) {
  const problems = []
  const fail = () => ({ ok: false, problem: problems[0], problems, warnings: [] })

  if (!isPlainObject(raw)) {
    problems.push('the plugin configuration must be an object')
    return fail()
  }

  // One file per run, when the operator names one: it is the base, and the inline keys below win key
  // by key. Refusing here (rather than at the first tick) is the same rule the rest of this module
  // follows — a missing file is a run pointed at defaults nobody chose, and that is a run that starts
  // in the wrong directory.
  const loaded = loadConfigFile({ raw, cwd, env, readFile })
  if (!loaded.ok) {
    problems.push(...loaded.problems)
    return fail()
  }
  const merged = loaded.raw

  // The workspace is the one key whose answer survives a refused run (the dashboard reads it), so the
  // order in which three sources win lives in `declaredWorkspace` above rather than here — and this
  // call passes the reading it just did, so a run's file is opened once and not twice.
  const workspace = declaredWorkspace(raw, { cwd, env, readFile, loaded })
  if (workspace.problem !== undefined) problems.push(workspace.problem)
  raw = merged

  // The pack is loaded here, at boot, because every way it can be wrong is a way the run cannot
  // work: no metric contract means nothing to compare, no prompts means a model answering nothing,
  // no executor entry means no job. `loadDomain` is the test seam; production reads the directory.
  let pack
  if (!isText(raw.domain)) {
    problems.push(
      'domain must be the directory of one domain pack (a directory with a domain.json): the metric contract, ' +
        'priors, adjustable surface, five prompts and executor entry are read from there, not from the kernel',
    )
  } else {
    try {
      pack = loadDomain(resolvePath(cwd, raw.domain))
    } catch (error) {
      if (!(error instanceof DomainPackError)) throw error
      problems.push(...error.problems)
    }
  }

  // The domain ships the entry that measures it; a run may override it (a laptop job versus the
  // same training script on a cluster), and either way the shape is checked by one validator.
  const executor = raw.executor ?? pack?.executor
  if (executor === undefined) {
    problems.push('executor must be an object with a kind — neither the run nor its domain pack declared one')
  } else {
    problems.push(...executorProblems(executor))
    // The cluster does not reserve the cards, so "which of the two ways do we own them" is a
    // configuration decision that has to be made on purpose. Both at once is a contradiction and is
    // refused here; neither is legal-but-dangerous and is warned about by name in `warnings.js`.
    if (isPlainObject(executor)) problems.push(...gpuExclusivityProblems(executor))
  }

  // The metric contract: the run's own restatement, or the pack's. One resolver reads it — the same
  // one the ranking, the stop rules and the gate call — so a contract that is absent or contradicts
  // itself is refused here, at boot, rather than being reinterpreted differently by three readers later.
  const metricContract = raw.metrics ?? pack?.metricContract
  let metricResolution
  if (metricContract === undefined) {
    problems.push(
      'metrics: no metric contract — the run declares none and its domain pack supplies none, so nothing says which metric decides "better"',
    )
  } else {
    metricResolution = resolveMetricContract(metricContract)
    for (const problem of metricResolution.problems) problems.push(`metrics: ${problem.message}`)
  }

  const candidate = raw.candidate
  if (candidate !== undefined) {
    if (!isPlainObject(candidate)) problems.push('candidate must be an object with a kind')
    else {
      const kind = candidate.kind ?? 'command'
      if (!CANDIDATE_KINDS.includes(kind)) {
        problems.push(`candidate.kind must be one of ${CANDIDATE_KINDS.join(', ')} (got ${JSON.stringify(kind)})`)
      }
      if (kind === 'command' && !isCommand(candidate.command)) {
        problems.push('candidate.command must be a non-empty argv array — it is the implementer run inside the worktree')
      }
    }
    const runner = raw.runner
    // LAND briefs an implementer inside the worktree the runner created. A candidate with no runner
    // is a run that dies at the first landing with a TypeError, which is why it is refused here.
    if (!isPlainObject(runner) || !isText(runner.repo) || !isText(runner.dir)) {
      problems.push('runner.repo and runner.dir are required when a candidate implementer is configured')
    }
  }

  // Retention is a *declared* policy rather than something a reader has to infer from the code:
  // `keep: true` (the default) means nothing in the kernel may remove a candidate worktree, and
  // `keep: false` does not remove anything by itself either — it only allows the explicit
  // `worktrees prune`, which is the one action that may. Either way the value has to be a boolean, or
  // "may I clean this up?" is answered by a string nobody validated.
  if (isPlainObject(raw.runner) && raw.runner.keep !== undefined && typeof raw.runner.keep !== 'boolean') {
    problems.push(
      `runner.keep must be true (keep every candidate worktree — the default) or false (allow an explicit ` +
        `worktrees prune); got ${JSON.stringify(raw.runner.keep)}`,
    )
  }

  // The judgement phases reach a model through one command adapter. `kind` names a shipped CLI
  // (`dsh --profile headless`, `claude -p`); `command` names a wrapper of your own. One of them must
  // be there, because "no model port" is a run that stalls at the first round rather than a run that
  // degrades.
  const model = raw.model
  if (model !== undefined) {
    if (!isPlainObject(model)) problems.push('model must be an object with a kind or a command')
    else if (model.kind === undefined && !isCommand(model.command)) {
      problems.push('model must name a kind (dsh, claude or command) or a non-empty model.command argv')
    } else if (model.kind !== undefined && !MODEL_KINDS.includes(model.kind)) {
      problems.push(`model.kind must be one of ${MODEL_KINDS.join(', ')} (got ${JSON.stringify(model.kind)})`)
    } else if ((model.kind ?? 'command') === 'command' && !isCommand(model.command)) {
      problems.push('model.command must be a non-empty argv array when model.kind is command')
    }
  }
  const hasModel = isPlainObject(model) && (modelPortDeclared(model) === true)

  if (raw.rounds !== undefined && raw.rounds !== false && !hasModel) {
    // ROUND_PLAN and ROUND_REFLECT are model entries; without a port the run stalls at the first
    // round and only the log says why. Refusing at boot is the same information, earlier.
    problems.push(
      'rounds is configured but no model.command is: ROUND_PLAN and ROUND_REFLECT are model entries. ' +
        'Add a model port, or remove rounds to run candidates created by human proposals only.',
    )
  }

  const intervalMs = raw.interval_ms ?? DEFAULT_INTERVAL_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    problems.push(`interval_ms must be a positive integer number of milliseconds (got ${JSON.stringify(intervalMs)})`)
  }

  // The registry (ADR 0002): a directory of runs, plus extra absolute paths. It is *additive* — the
  // host still ticks the one run `workspace` names, and a deployment that never sets `runs_root`
  // gets a registry of exactly that one run, so nothing it saw before changes.
  // The two keys an operator can also set from the page (`settings.js`). The plugin configuration is
  // the fallback and the page's value wins — the reverse would make the settings form a decoration.
  // `runs_root_from` / `max_active_runs_from` travel into the resolved config so the boot log and the
  // settings route can both answer "who set this?" without a second derivation.
  const settings = effectiveSettings({ config: raw, env })
  const runsRoot = isText(raw.runs_root) ? resolvePath(cwd, raw.runs_root) : undefined
  let extraRuns = []
  if (raw.runs !== undefined) {
    if (!Array.isArray(raw.runs) || !raw.runs.every(isText)) {
      problems.push(`runs must be an array of absolute run directories (got ${JSON.stringify(raw.runs)})`)
    } else {
      extraRuns = raw.runs.map((dir) => resolvePath(cwd, dir))
    }
  }
  const maxActive = raw.max_active_runs ?? DEFAULT_MAX_ACTIVE_RUNS
  if (!Number.isSafeInteger(maxActive) || maxActive <= 0) {
    problems.push(
      `max_active_runs must be a positive integer (how many runs may tick at once; got ${JSON.stringify(raw.max_active_runs)})`,
    )
  }

  if (problems.length > 0) return fail()

  const config = {
    ...raw,
    // Recorded so the boot log and the dashboard can answer "where did this value come from?" without
    // guessing: an operator who has just set an environment variable needs to know it was read.
    // `workspace` and `workspaceDir` carry the same absolute directory: the first is the name older
    // readers use, and two spellings of one path must not be able to drift apart in one object.
    workspace: workspace.dir,
    workspaceSource: workspace.source,
    // The whole contract, not the two fields the readers used to need: the tolerance, the guardrail
    // and the window reading are part of "which metric decides", and a run that dropped them would
    // leave the ranking and the gate reading a contract nobody wrote.
    metrics: { ...metricContract },
    executor: { kind: 'local', ...executor },
    interval_ms: intervalMs,
    workspaceDir: workspace.dir,
    domainPack: pack,
    // The registry the dashboard reads (ADR 0002): which runs this host may show, and which one a
    // request means when it names none. It is a value, not a service — built from the same keys by
    // every reader — so the page cannot list a run the loop has never heard of, and a test can hand
    // over a `runs_root` of temporary directories without a host.
    runs_root: runsRoot ?? null,
    // What is actually in force: the page's value where it has one, the configuration's otherwise.
    effective_runs_root: isText(settings.runsRoot) ? settings.runsRoot : null,
    effective_runs_root_from: settings.runsRootFrom,
    effective_max_active_runs: settings.maxActiveRuns,
    effective_max_active_runs_from: settings.maxActiveRunsFrom,
    settings_path: settings.path ?? null,
    settings_status: settings.status,
    settings_problems: settings.problems,
    runs: extraRuns,
    max_active_runs: maxActive,
    registry: createRunRegistry({
      workspace: workspace.dir,
      runsRoot: isText(settings.runsRoot) ? settings.runsRoot : runsRoot,
      runs: extraRuns,
      cwd,
    }),
  }

  // One normalised `runner`: `keep` is filled in here rather than left to each reader's memory of
  // what the default is, because "did this run keep its worktrees?" is answered by the same object in
  // the boot log, the worktree report and the prune command.
  if (isPlainObject(raw.runner)) config.runner = { keep: true, ...raw.runner }

  // The round workflow's binding is *derived* from the same resolution rather than declared beside it:
  // `rounds.metric` is the shape rounds.js freezes at INIT, and a second account of which metric leads
  // would let the gate and the round planner optimise different numbers. An explicit `rounds.metric`
  // still wins here — and `warnings.js` reports it when it disagrees with the contract.
  if (isPlainObject(config.rounds) && config.rounds.metric === undefined) {
    const binding = bindingOf(metricResolution)
    if (binding !== undefined) config.rounds = { ...config.rounds, metric: binding }
  }

  return { ok: true, config, problems: [], warnings: configWarnings(config) }
}