/**
 * The host-facing half of the plugin: one interval, one tick in flight, one dispose.
 *
 * The loop must advance with no session and no turn (user story 13) and it must not advance twice at
 * once: a tick awaits a training job's poll, so two overlapping ticks would double-submit and
 * double-bill. Both facts are properties of this file, and this file imports no cordis — the
 * context arrives as the two methods it is allowed to use (`interval`, `effect`), which is what makes
 * the lifecycle testable without starting a host.
 *
 * A tick that throws is *reported and survived*. The alternative — let the rejection escape into the
 * host's event loop — turns one bad phase into an unhandled rejection, and turning one bad phase into
 * a dead night shift is the failure this system exists to prevent.
 *
 * @module
 */

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Register the tick on the host's timer.
 *
 * @param {{interval: (callback: () => void, ms: number) => (() => void) | undefined,
 *          effect: (callback: () => (() => void) | undefined, label: string) => unknown}} ctx
 *   a cordis context, or anything with the same two methods
 * @param {{workspace: {tickOnce: () => Promise<unknown>, close?: () => void},
 *          intervalMs?: number, log?: (message: string, detail?: unknown) => void,
 *          onDispose?: () => void}} options
 * @returns {{tick: () => Promise<object>, stats: () => object, stop: () => void}}
 */
export function mountTick(ctx, { workspace, intervalMs = 5_000, log = () => {}, onDispose = () => {} }) {
  if (typeof workspace?.tickOnce !== 'function') {
    throw new TypeError('mountTick needs a workspace with tickOnce() — the host has nothing else to schedule')
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError(`mountTick needs a positive interval in milliseconds, got ${JSON.stringify(intervalMs)}`)
  }

  const stats = { ticks: 0, skipped: 0, failures: 0, lastDurationMs: 0 }
  let inFlight = false
  let stopped = false
  let disposed = false

  const tick = async () => {
    if (stopped) return { skipped: 'disposed' }
    if (inFlight) {
      stats.skipped += 1
      return { skipped: 'in_flight' }
    }

    inFlight = true
    const startedAt = Date.now()
    try {
      const result = await workspace.tickOnce()
      stats.ticks += 1
      return { tick: stats.ticks, result }
    } catch (error) {
      stats.failures += 1
      log(`tick failed: ${messageOf(error)}`, { error })
      return { error }
    } finally {
      inFlight = false
      stats.lastDurationMs = Date.now() - startedAt
    }
  }

  const clearInterval = ctx.interval(() => {
    // Deliberately not awaited: the timer must not queue behind a tick that is waiting for a job,
    // and the guard inside `tick` already refuses to overlap. A rejection is impossible because every
    // path above returns instead of throwing.
    void tick()
  }, intervalMs)

  ctx.effect(
    () => () => {
      if (disposed) return
      disposed = true
      stopped = true
      if (typeof clearInterval === 'function') clearInterval()
      try {
        onDispose()
      } catch (error) {
        log(`dispose failed: ${messageOf(error)}`, { error })
      }
    },
    'reprise.tick.dispose()',
  )

  return {
    tick,
    stats: () => ({ ...stats, inFlight }),
    /** Stop ticking without touching the workspace — used by tests and by an operator-initiated stop. */
    stop: () => {
      stopped = true
    },
  }
}