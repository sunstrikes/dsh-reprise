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

import { DomainPackError, executorProblems, loadDomainPack } from './domain.js'
import { bindingOf, resolveMetricContract } from './metric-contract.js'
import { configWarnings } from './warnings.js'

/** Five seconds: the cadence ticket 01 measured in the real host (78 beats / 415 s, drift ≤ 3 ms). */
export const DEFAULT_INTERVAL_MS = 5_000

const CANDIDATE_KINDS = Object.freeze(['command', 'claude', 'dsh'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isCommand = (value) => Array.isArray(value) && value.length > 0 && value.every(isText)

/**
 * Validate and normalise one plugin/CLI configuration.
 *
 * @param {unknown} raw the object the host's bundle patch, the `run` CLI, or a test hands over
 * @param {{cwd?: string, loadDomain?: (dir: string) => object}} [options] `workspace` and `domain`
 *   are resolved against `cwd`, not against wherever the host process happens to be. `loadDomain` is
 *   the seam a test uses to hand over a pack without a directory of files on disk.
 * @returns {{ok: true, config: object, problems: string[], warnings: object[]}
 *         | {ok: false, problem: string, problems: string[], warnings: object[]}}
 */
export function resolveConfig(raw = {}, { cwd = process.cwd(), loadDomain = loadDomainPack } = {}) {
  const problems = []
  const fail = () => ({ ok: false, problem: problems[0], problems, warnings: [] })

  if (!isObject(raw)) {
    problems.push('the plugin configuration must be an object')
    return fail()
  }

  if (!isText(raw.workspace)) {
    problems.push('workspace must be the path of the directory this run owns, e.g. workspace: .reprise/run-1')
  }

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
    if (!isObject(candidate)) problems.push('candidate must be an object with a kind')
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
    if (!isObject(runner) || !isText(runner.repo) || !isText(runner.dir)) {
      problems.push('runner.repo and runner.dir are required when a candidate implementer is configured')
    }
  }

  const model = raw.model
  if (model !== undefined && (!isObject(model) || !isCommand(model.command))) {
    problems.push('model.command must be a non-empty argv array — it is how the judgement phases reach a model')
  }

  if (raw.rounds !== undefined && raw.rounds !== false && (model === undefined || !isCommand(model.command))) {
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

  if (problems.length > 0) return fail()

  const config = {
    ...raw,
    // The whole contract, not the two fields the readers used to need: the tolerance, the guardrail
    // and the window reading are part of "which metric decides", and a run that dropped them would
    // leave the ranking and the gate reading a contract nobody wrote.
    metrics: { ...metricContract },
    executor: { kind: 'local', ...executor },
    interval_ms: intervalMs,
    workspaceDir: resolvePath(cwd, raw.workspace),
    domainPack: pack,
  }

  // The round workflow's binding is *derived* from the same resolution rather than declared beside it:
  // `rounds.metric` is the shape rounds.js freezes at INIT, and a second account of which metric leads
  // would let the gate and the round planner optimise different numbers. An explicit `rounds.metric`
  // still wins here — and `warnings.js` reports it when it disagrees with the contract.
  if (isObject(config.rounds) && config.rounds.metric === undefined) {
    const binding = bindingOf(metricResolution)
    if (binding !== undefined) config.rounds = { ...config.rounds, metric: binding }
  }

  return { ok: true, config, problems: [], warnings: configWarnings(config) }
}