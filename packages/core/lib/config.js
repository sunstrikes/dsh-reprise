/**
 * The plugin configuration, validated once at boot instead of discovered mid-run.
 *
 * Everything domain-specific is here as data (user stories 27/28): the metric contract and its
 * direction, the round budget, the spend cap, the executor, the candidate implementer and the model
 * port. The kernel reads none of it as policy — it reads it as numbers and names — which is why a
 * user changes a metric direction without touching code.
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

import { configWarnings, EXECUTOR_KINDS } from './warnings.js'

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
 * @param {{cwd?: string}} [options] `workspace` is resolved against this, not against wherever the
 *   host process happens to be
 * @returns {{ok: true, config: object, problems: string[], warnings: object[]}
 *         | {ok: false, problem: string, problems: string[], warnings: object[]}}
 */
export function resolveConfig(raw = {}, { cwd = process.cwd() } = {}) {
  const problems = []
  const fail = () => ({ ok: false, problem: problems[0], problems, warnings: [] })

  if (!isObject(raw)) {
    problems.push('the plugin configuration must be an object')
    return fail()
  }

  if (!isText(raw.workspace)) {
    problems.push('workspace must be the path of the directory this run owns, e.g. workspace: .reprise/run-1')
  }

  const executor = raw.executor ?? { kind: 'local' }
  if (!isObject(executor)) problems.push('executor must be an object with a kind')
  else {
    if (!EXECUTOR_KINDS.includes(executor.kind ?? 'local')) {
      problems.push(`executor.kind must be one of ${EXECUTOR_KINDS.join(', ')} (got ${JSON.stringify(executor.kind)})`)
    }
    if ((executor.kind ?? 'local') === 'local' && !isCommand(executor.command)) {
      problems.push(
        'executor.command must be a non-empty argv array — the local executor runs one process per job, ' +
          'e.g. command: ["node", "train.mjs"]',
      )
    }
    if (executor.kind === 'ray' && !isText(executor.base_url)) {
      problems.push('executor.base_url must be the Ray dashboard URL when executor.kind is ray')
    }
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
    executor: { kind: 'local', ...executor },
    interval_ms: intervalMs,
    workspaceDir: resolvePath(cwd, raw.workspace),
  }
  return { ok: true, config, problems: [], warnings: configWarnings(config) }
}