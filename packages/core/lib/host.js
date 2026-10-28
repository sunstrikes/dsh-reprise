/**
 * The host-facing half of the plugin: one interval, at most `maxActive` ticks in flight, one dispose.
 *
 * The loop must advance with no session and no turn (user story 13) and it must not advance the same
 * run twice at once: a tick awaits a training job's poll, so two overlapping ticks of one run would
 * double-submit and double-bill. Both facts are properties of this file, and this file imports no
 * cordis — the context arrives as the two methods it is allowed to use (`interval`, `effect`), which is
 * what makes the lifecycle testable without starting a host.
 *
 * **One interval, several runs (ADR 0002).** A host may drive more than one run, so this module takes a
 * *list*: each beat advances up to `maxActive` runs that are not already ticking, in round-robin order,
 * so a run waiting on a long job poll cannot starve the others out of their beat. The in-flight guard
 * is per run, not global — the thing that must never overlap is one run's own tick. With one run in the
 * list (every deployment that configures no `runs_root`) the behaviour is exactly what it was: bound,
 * one tick per interval, one dispose.
 *
 * A tick that throws is *reported and survived*, and reported with the run it belongs to: the
 * alternative — let the rejection escape into the host's event loop — turns one bad phase into an
 * unhandled rejection, and one run's bad phase into a dead night shift for every other run too.
 *
 * @module
 */

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Register the tick on the host's timer.
 *
 * `provider` is how a *live* set is scheduled: it is called at the start of every beat and its answer
 * is what the beat advances, so a run started from the dashboard joins without restarting the host (the
 * provider re-reads the activation file; this module stays ignorant of what that file is).
 *
 * @param {{interval: (callback: () => void, ms: number) => (() => void) | undefined,
 *          effect: (callback: () => (() => void) | undefined, label: string) => unknown}} ctx
 *   a cordis context, or anything with the same two methods
 * @param {{
 *   workspace?: {tickOnce: () => Promise<unknown>, close?: () => void},
 *   workspaces?: {id?: string, workspace: {tickOnce: () => Promise<unknown>, close?: () => void}}[],
 *   provider?: () => {id?: string, workspace: {tickOnce: () => Promise<unknown>, close?: () => void}}[],
 *   intervalMs?: number, maxActive?: number, log?: (message: string, detail?: unknown) => void,
 *   onDispose?: () => void,
 * }} options `workspace` is the single-run form every pre-registry caller uses; `workspaces` is the
 *   registry form, and the two are alternatives rather than a merge (a caller that has a list has
 *   already answered "which runs"). `maxActive` caps how many of the list advance per beat.
 * @returns {{tick: () => Promise<object>, stats: () => object, stop: () => void}}
 */
export function mountTick(
  ctx,
  { workspace, workspaces, provider, intervalMs = 5_000, maxActive, log = () => {}, onDispose = () => {} },
) {
  const fixed = Array.isArray(workspaces)
    ? workspaces
    : workspace === undefined
      ? undefined
      : [{ id: undefined, workspace }]
  if (fixed === undefined && typeof provider !== 'function') {
    throw new TypeError('mountTick needs a workspace with tickOnce(), or a non-empty workspaces list, or a provider')
  }
  if (fixed !== undefined && fixed.length === 0) {
    throw new TypeError('mountTick needs a workspace with tickOnce(), or a non-empty workspaces list')
  }

  /** The set this beat may advance. A fixed list is its own provider; a live one is asked every beat. */
  const current = () => {
    const list = fixed ?? provider()
    if (!Array.isArray(list)) throw new TypeError('the provider must answer an array of {id, workspace} entries')
    for (const entry of list) {
      if (typeof entry?.workspace?.tickOnce !== 'function') {
        throw new TypeError(`mountTick needs every entry to carry a workspace with tickOnce() (got ${JSON.stringify(entry?.id ?? null)})`)
      }
    }
    return list
  }

  let list = current()
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError(`mountTick needs a positive interval in milliseconds, got ${JSON.stringify(intervalMs)}`)
  }
  const capFor = (size) => (maxActive === undefined || maxActive === null ? size : maxActive)
  const cap = capFor(list.length)
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new TypeError(`mountTick needs a positive maxActive, got ${JSON.stringify(maxActive)}`)
  }

  const per = new Map()
  const countersFor = (entry) => {
    if (!per.has(entry)) per.set(entry, { inFlight: false, ticks: 0, failures: 0, skipped: 0 })
    return per.get(entry)
  }
  for (const entry of list) countersFor(entry)
  const stats = { ticks: 0, skipped: 0, failures: 0, lastDurationMs: 0 }
  let stopped = false
  let disposed = false
  // The cursor is what makes this round-robin rather than "the first N forever": a run whose job is
  // being polled stays in flight and the next beat starts with the run after it.
  let cursor = 0

  const advance = async (entry) => {
    const counters = countersFor(entry)
    counters.inFlight = true
    const startedAt = Date.now()
    try {
      const result = await entry.workspace.tickOnce()
      counters.ticks += 1
      stats.ticks += 1
      return { tick: counters.ticks, run: entry.id, result }
    } catch (error) {
      counters.failures += 1
      stats.failures += 1
      log(`tick failed${entry.id === undefined ? '' : ` for run ${entry.id}`}: ${messageOf(error)}`, { run: entry.id, error })
      return { error, run: entry.id }
    } finally {
      counters.inFlight = false
      stats.lastDurationMs = Date.now() - startedAt
    }
  }

  /** Advance the next run that is not already ticking. Manual ticks and the timer share this. */
  const tick = async () => {
    if (stopped) return { skipped: 'disposed' }
    if (fixed === undefined) {
      // Re-read before choosing: a run activated from the dashboard joins on the next beat, and one
      // deactivated leaves, without restarting the host.
      try {
        list = current()
      } catch (error) {
        log(`cannot read the set of runs to advance: ${messageOf(error)}`)
        return { error }
      }
    }
    for (let attempt = 0; attempt < list.length; attempt += 1) {
      const index = (cursor + attempt) % list.length
      const entry = list[index]
      const counters = countersFor(entry)
      // Counted as a skip, not as a silent pass: "this run wanted its beat and its own previous tick
      // was still running" is the number that tells an operator whether `interval_ms` is too short for
      // the jobs this run waits on.
      if (counters.inFlight) {
        counters.skipped += 1
        stats.skipped += 1
        continue
      }
      cursor = (index + 1) % list.length
      return advance(entry)
    }
    return { skipped: 'all_in_flight' }
  }

  /** One beat: up to `maxActive` runs**, each not awaited (the timer must not queue behind a job poll). */
  const beat = () => {
    if (fixed === undefined) {
      try {
        list = current()
      } catch (error) {
        log(`cannot read the set of runs to advance: ${messageOf(error)}`)
        return
      }
    }
    const startable = Math.min(capFor(list.length), list.length)
    for (let index = 0; index < startable; index += 1) void tick()
  }

  const clearInterval = ctx.interval(beat, intervalMs)

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
    stats: () => {
      const inFlight = list.filter((entry) => per.get(entry)?.inFlight === true).length
      const runs = {}
      for (const [entry, counters] of per) {
        runs[entry.id ?? '(workspace)'] = {
          ticks: counters.ticks,
          failures: counters.failures,
          skipped: counters.skipped,
          inFlight: counters.inFlight,
        }
      }
      return { ...stats, inFlight, runs, maxActive: capFor(list.length) }
    },
    /** Stop ticking without touching the workspaces — used by tests and by an operator-initiated stop. */
    stop: () => {
      stopped = true
    },
  }
}