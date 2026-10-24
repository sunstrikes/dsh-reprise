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

import { MODEL_KINDS } from '@dsh-reprise/exec/model'

import { DomainPackError, executorProblems, loadDomainPack, metricFromContract } from './domain.js'
import { gpuExclusivityProblems } from './jobs.js'
import { configWarnings, modelPortDeclared } from './warnings.js'

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
    // The cluster does not reserve the cards, so "which of the two ways do we own them" is a
    // configuration decision that has to be made on purpose. Both at once is a contradiction and is
    // refused here; neither is legal-but-dangerous and is warned about by name in `warnings.js`.
    if (isObject(executor)) problems.push(...gpuExclusivityProblems(executor))
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

  // The judgement phases reach a model through one command adapter. `kind` names a shipped CLI
  // (`dsh --profile headless`, `claude -p`); `command` names a wrapper of your own. One of them must
  // be there, because "no model port" is a run that stalls at the first round rather than a run that
  // degrades.
  const model = raw.model
  if (model !== undefined) {
    if (!isObject(model)) problems.push('model must be an object with a kind or a command')
    else if (model.kind === undefined && !isCommand(model.command)) {
      problems.push('model must name a kind (dsh, claude or command) or a non-empty model.command argv')
    } else if (model.kind !== undefined && !MODEL_KINDS.includes(model.kind)) {
      problems.push(`model.kind must be one of ${MODEL_KINDS.join(', ')} (got ${JSON.stringify(model.kind)})`)
    } else if ((model.kind ?? 'command') === 'command' && !isCommand(model.command)) {
      problems.push('model.command must be a non-empty argv array when model.kind is command')
    }
  }
  const hasModel = isObject(model) && (modelPortDeclared(model) === true)

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

  if (problems.length > 0) return fail()

  const config = {
    ...raw,
    executor: { kind: 'local', ...executor },
    interval_ms: intervalMs,
    workspaceDir: resolvePath(cwd, raw.workspace),
    domainPack: pack,
  }

  // The pack declares what "better" means; a run may restate it. When a run says nothing, the pack
  // answers — so a configuration that names a pack and no metric is complete rather than metric-less,
  // and the two accounts cannot disagree by omission. (Collapsing the restatement entirely, so that
  // one file names the metric, is a contract-resolution change, not this seam.)
  const binding = metricFromContract(pack.metricContract)
  if (config.metrics === undefined) {
    config.metrics = {
      primary: pack.metricContract.primary,
      objectives: { ...pack.metricContract.objectives },
    }
  }
  if (isObject(config.rounds) && config.rounds.metric === undefined) {
    config.rounds = { ...config.rounds, metric: { ...binding } }
  }

  return { ok: true, config, problems: [], warnings: configWarnings(config) }
}