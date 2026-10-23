/**
 * Spend and pacing. Two different questions live here and they are easy to confuse:
 *
 *   **spend** — GPU hours actually bought, and hours in flight that are already at risk.
 *   **pacing** — wall-clock time the workspace has been alive.
 *
 * Both answer one question at tick time: *may we dispatch anything new?* Answering it from the
 * ledger with reserve-on-dispatch means the remaining budget is a definite value at any instant,
 * with no callback to wait for — which is what lets the stop decision stay inside the tick.
 *
 * `cost_*` is deliberately absent: in the predecessor that name meant "model inference cost as an
 * optimisation objective", not money. Merging the two is how a budget gate ends up optimising the
 * metric it was supposed to be paying for.
 *
 * @module
 */

export const DEFAULT_BUDGET = Object.freeze({
  /** 0 means unlimited: the open-source default is a cheap local run, not a cluster. */
  gpu_hours_limit: 0,
  /** Stop dispatching new candidates at this fraction; let in-flight ones finish. */
  soft_ratio: 0.8,
  /** What a candidate is assumed to cost when it is dispatched (reserved, then settled). */
  candidate_gpu_hours: 0.5,
  /** 0 means unlimited. Wall-clock pacing, folded into the same gate as spend. */
  max_runtime_hours: 0,
  /** Tokens are recorded, never judged. */
  judge_tokens: false,
})

const HOUR_MS = 3_600_000

/** @param {any} workspace */
export function budgetOf(workspace, config) {
  return { ...DEFAULT_BUDGET, ...(config?.budget ?? {}), ...(workspace?.budget ?? {}) }
}

/**
 * What has been spent. `used` counts reservations too: money already promised is not available,
 * and a crash must not refund it.
 */
export function spendOf(store) {
  const totals = store.totals()
  return {
    settledGpuHours: totals.settledGpuHours,
    inFlightGpuHours: totals.inFlightGpuHours,
    usedGpuHours: totals.settledGpuHours + totals.inFlightGpuHours,
    tokens: totals.tokens,
  }
}

export const elapsedHours = (workspace, now) =>
  workspace?.started_at_ms === undefined ? 0 : Math.max(0, now - workspace.started_at_ms) / HOUR_MS

/**
 * @returns {{
 *   verdict: 'ok' | 'soft' | 'hard' | 'runtime',
 *   usedGpuHours: number, gpuLimitHours: number, ratio: number,
 *   elapsedHours: number, runtimeLimitHours: number, tokens: number,
 * }}
 */
export function evaluate(store, workspace, config, now) {
  const budget = budgetOf(workspace, config)
  const spend = spendOf(store)
  const elapsed = elapsedHours(workspace, now)

  const ratio = budget.gpu_hours_limit > 0 ? spend.usedGpuHours / budget.gpu_hours_limit : 0
  const base = {
    ...spend,
    gpuLimitHours: budget.gpu_hours_limit,
    ratio,
    elapsedHours: elapsed,
    runtimeLimitHours: budget.max_runtime_hours,
  }

  // Wall-clock exhaustion ends the same way as money exhaustion: pause, not finalize.
  if (budget.max_runtime_hours > 0 && elapsed >= budget.max_runtime_hours) {
    return { ...base, verdict: 'runtime' }
  }
  if (budget.gpu_hours_limit > 0 && spend.usedGpuHours >= budget.gpu_hours_limit) {
    return { ...base, verdict: 'hard' }
  }
  if (budget.gpu_hours_limit > 0 && ratio >= budget.soft_ratio) {
    return { ...base, verdict: 'soft' }
  }
  return { ...base, verdict: 'ok' }
}

/**
 * May a new job be dispatched? Only the soft and hard verdicts say no — and the soft one says no
 * exclusively to *new* work, because killing a candidate mid-flight cannot un-spend its money.
 */
export function canDispatch(store, workspace, config, now) {
  const decision = evaluate(store, workspace, config, now)
  if (decision.verdict === 'ok') return { ok: true, decision }
  return { ok: false, reason: decision.verdict, decision }
}

/**
 * Pause the workspace. `automatic` is not decoration: an automatic pause is allowed to clear
 * itself, a manual one is only clearable by a human. Conflating them makes an operator's pause
 * disappear on its own, which is the one pause they will remember.
 */
export function pause(store, clock, { reason, automatic, ...detail }) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const paused = { reason, automatic: automatic === true, at_ms: clock.now(), ...detail }
  store.setState(undefined, 'workspace', { ...workspace, paused })
  return paused
}

export function resume(store, clock, { force = false } = {}) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const paused = workspace.paused
  if (!paused) return { status: 'not_paused' }
  if (paused.automatic !== true && !force) return { status: 'needs_human', paused }
  store.setState(undefined, 'workspace', { ...workspace, paused: null, resumed_at_ms: clock.now() })
  return { status: 'resumed', was: paused }
}

/**
 * Clear an automatic pause whose cause has gone away. Called at the top of every tick, before the
 * pause is honoured — otherwise raising the limit would need a restart.
 */
export function autoResumeIfClear(store, clock, config, now) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  if (workspace.paused?.automatic !== true) return { status: 'not_applicable' }
  const decision = evaluate(store, workspace, config, now)
  if (decision.verdict !== 'ok' && decision.verdict !== 'soft') return { status: 'still_blocked', decision }
  const resumed = resume(store, clock, { force: true })
  return { ...resumed, decision }
}