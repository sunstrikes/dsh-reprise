/**
 * What the run must admit about itself, computed rather than remembered.
 *
 * Two kinds of warning live here, and both exist because a default that is *safe* is not the same as
 * a default that is *silent*:
 *
 *   - **`no_gpu_hours_limit`** — the open-source default budget is unlimited GPU hours, which is
 *     right for the laptop path and dangerous the moment a real training executor is wired in. So
 *     the check is conditional on the *executor*, not on the budget: `local` bills nothing and gets
 *     no warning; anything that rents GPUs and has no cap gets one, every time the page is read.
 *   - **contract disagreements** — "better" is declared twice (the frontier ranks objectives, the
 *     judge compares against a baseline) and "which metric the round optimises" is a third name.
 *     Two declarations that disagree make two rounds incomparable, so a mismatch is reported instead
 *     of being resolved by whichever module happened to run last.
 *
 * Where this renders, concretely:
 *
 *   - `overview()` in `projection.js` puts the list on the page as `warnings`, and the dashboard's
 *     overview route (`packages/ui/lib/views.js` → `overviewView`) passes that page through to the
 *     browser unchanged. `packages/core/test/dashboard.test.js` asserts the payload carries it.
 *   - the read *configuration* the dashboard hands the projection is the one recorded into the
 *     workspace at INIT (`executor`, `budget`, `metrics`, `stop` — see `loop.js`), never today's
 *     config file, so the page answers about the run that happened.
 *   - `run` prints the same list before its first tick, and the plugin logs it at boot.
 *
 * Both shipped clients draw the list they fetch: the standalone page
 * (`packages/ui/client/dashboard.js`) renders one line per warning above the notes, and the Web UI
 * panel (`packages/core/client/index.js`) renders the same entries in its own warnings section. What
 * neither of them decides is *what* is a warning — that stayed here, in the projection, because a
 * component that computed it would be the second, unchecked account of the run.
 *
 * @module
 */

import { DEFAULT_BUDGET } from './budget.js'
import { gpuExclusivityOf } from './jobs.js'

/** Executors that can rent GPU hours. Anything else is a laptop-class run. */
export const REMOTE_EXECUTORS = Object.freeze(['ray'])

export const EXECUTOR_KINDS = Object.freeze(['local', 'ray'])

const executorKind = (config) => config?.executor?.kind ?? 'local'

const budgetOfConfig = (config) => ({ ...DEFAULT_BUDGET, ...(config?.budget ?? {}) })

/**
 * The warning the ticket asks for, as a value rather than as prose in a component.
 *
 * `label` is the sentence the shipped client renders; it is Chinese because the ticket names that
 * exact string, and a translated warning is a different warning.
 *
 * @param {{executor?: {kind?: string}, budget?: object}} config
 * @returns {object | undefined}
 */
export function noGpuHoursLimit(config) {
  const kind = executorKind(config)
  if (!REMOTE_EXECUTORS.includes(kind)) return undefined

  const budget = budgetOfConfig(config)
  if (budget.gpu_hours_limit > 0) return undefined

  return {
    code: 'no_gpu_hours_limit',
    severity: 'warning',
    about: 'spend',
    where: 'dashboard.overview',
    label: '当前无 GPU 小时上限',
    message:
      `the "${kind}" executor bills real GPU hours and this run has no GPU-hours limit ` +
      '(budget.gpu_hours_limit is 0, which means unlimited). Set budget.gpu_hours_limit to cap the spend, ' +
      'or keep it uncapped deliberately — either way the page says which one it is.',
  }
}

/**
 * The cluster does not reserve the cards (measured, ticket 14: two 8-card jobs ran at once on the
 * same node), so a run on a GPU-billing executor that has not said which of the two ways it owns
 * them will quietly share them with itself. Legal, dangerous, and named.
 *
 * A laptop run has no cards to share, so it earns nothing here — the check is conditional on the
 * executor for the same reason `no_gpu_hours_limit` is.
 */
export function gpuExclusivityUndeclared(config) {
  const kind = executorKind(config)
  if (!REMOTE_EXECUTORS.includes(kind)) return undefined
  if (gpuExclusivityOf(config) !== undefined) return undefined

  return {
    code: 'gpu_exclusivity_undeclared',
    severity: 'warning',
    about: 'dispatch',
    where: 'dashboard.overview',
    label: '未声明 GPU 排他',
    message:
      `the "${kind}" executor's cluster does not reserve GPUs, and this run declares neither ` +
      'executor.gpu_exclusivity: single_job (one training job at a time) nor executor.cuda_visible_devices ' +
      '(each submission writes its own device list): two of our jobs will share the same cards.',
  }
}

/** 'up' / 'down' (frontier) as the judge's 'higher' / 'lower'. */
const DIRECTIONS = Object.freeze({ up: 'higher', down: 'lower' })

function metricWarnings(config) {
  const objectiveNames = config?.metrics?.objectives
  const roundsMetric = config?.rounds?.metric
  if (roundsMetric === undefined || typeof roundsMetric !== 'object') return []

  const warnings = []
  const name = roundsMetric.name
  const declared = typeof objectiveNames === 'object' && objectiveNames !== null ? objectiveNames[name] : undefined

  if (typeof objectiveNames === 'object' && objectiveNames !== null && declared === undefined) {
    warnings.push({
      code: 'round_metric_not_an_objective',
      severity: 'warning',
      about: 'metric_contract',
      where: 'dashboard.overview',
      label: '轮次指标不在前沿目标里',
      message:
        `the round optimises ${JSON.stringify(name)} but the frontier's objectives are ` +
        `${JSON.stringify(Object.keys(objectiveNames))}: the candidate the gate calls "improved" is not the ` +
        'candidate the frontier can rank. Declare it in metrics.objectives, or point rounds.metric at one that is.',
    })
    return warnings
  }

  if (declared !== undefined && DIRECTIONS[declared] !== undefined && DIRECTIONS[declared] !== roundsMetric.direction) {
    warnings.push({
      code: 'metric_direction_mismatch',
      severity: 'warning',
      about: 'metric_contract',
      where: 'dashboard.overview',
      label: '指标方向前后不一致',
      message:
        `${JSON.stringify(name)} is declared ${JSON.stringify(declared)} (metrics.objectives) for the frontier ` +
        `but ${JSON.stringify(roundsMetric.direction)} (rounds.metric.direction) for the gate: two accounts of ` +
        '"better" in one run make the frozen baseline a number about something else.',
    })
  }
  return warnings
}

/** A model port is declared when the run names a CLI (`kind`) or an argv to reach one (`command`). */
export const modelPortDeclared = (model) =>
  (typeof model?.kind === 'string' && model.kind !== '') ||
  (Array.isArray(model?.command) && model.command.length > 0)

function modelWarning(config) {
  const rounds = config?.rounds
  if (rounds === undefined || rounds === null || rounds === false || rounds.enabled === false) return []
  const hasPort = modelPortDeclared(config?.model)
  if (hasPort) return []
  return [
    {
      code: 'no_model_port',
      severity: 'warning',
      about: 'judgement',
      where: 'plugin.log',
      label: '没有模型入口',
      message:
        'config.rounds is set but no model port is configured (model.kind or model.command): ROUND_PLAN and ROUND_REFLECT are ' +
        'model entries, so those phases will be refused and the run will stall at the first round.',
    },
  ]
}

/**
 * Every warning the current configuration earns. Order is stable: spend first, then the contract,
 * then the judgement ports — the order a stranger would want to fix them in.
 *
 * @param {object} config the plugin/CLI configuration
 * @returns {object[]}
 */
export function configWarnings(config) {
  const warnings = []
  const gpu = noGpuHoursLimit(config)
  if (gpu !== undefined) warnings.push(gpu)
  const exclusivity = gpuExclusivityUndeclared(config)
  if (exclusivity !== undefined) warnings.push(exclusivity)
  warnings.push(...metricWarnings(config))
  warnings.push(...modelWarning(config))
  return warnings
}

/** One line per warning, for the plugin log and for `run`'s startup banner. */
export function describeWarnings(warnings) {
  return warnings.map((warning) => `[${warning.severity}] ${warning.code}: ${warning.message}`)
}