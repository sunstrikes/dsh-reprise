/**
 * One workspace, opened the same way by the host plugin and by the `run` CLI.
 *
 * The seam exists so there is exactly one answer to "what does starting a run mean": open the fact
 * plane, reconcile against the outside world, then advance one step per tick. The host wires that to
 * `ctx.interval`; the CLI wires it to a loop it prints. A second copy of this sequence in the CLI
 * would drift from the plugin on the first change, and the five-step path would then be proving
 * something the host does not do.
 *
 * Reconciliation is *before* the first tick, not part of it (spec: 先对账再推进). A candidate that
 * was in flight when the process died must be asked about upstream before a phase machine decides it
 * is missing; folding first and asking later would reject every job that survived the restart.
 *
 * @module
 */

import { Store } from './store.js'
import { tick, reconcile } from './loop.js'
import { portsFromConfig } from './ports.js'
import { isTerminal } from '@dsh-reprise/contract'
import { readRoundsState } from './rounds.js'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * @param {{
 *   workspaceDir: string,
 *   config: object,
 *   log?: (message: string, detail?: unknown) => void,
 *   ports?: object,
 * }} options `ports` is the test seam: the same workspace object drives fake ports in a test and
 *   real executors under the host, and nothing else changes.
 */
export function createWorkspace({ workspaceDir, config, log = () => {}, ports }) {
  if (typeof workspaceDir !== 'string' || workspaceDir === '') {
    throw new TypeError('createWorkspace needs a workspace directory')
  }

  const store = Store.open(workspaceDir)
  let closed = false

  const resolved = {
    ...(ports ?? portsFromConfig({ config, workspaceDir, store, log })),
    ...(ports ?? {}),
    store,
    config,
    log,
  }
  if (resolved.clock === undefined) resolved.clock = { now: () => Date.now() }

  return {
    workspaceDir,
    store,
    config,

    /** One step for the workspace and at most one step per candidate — the main seam. */
    tickOnce: () => tick(resolved),

    /** Ask the platform about everything in flight, adopt what it knows, replay what we missed. */
    reconcileNow: () => reconcile(resolved),

    /**
     * Is there anything left to advance?
     *
     * Deliberately two different questions, depending on the kind of workspace. With a round workflow
     * the *workflow* owns "finished" — or the stop rule does — because a round whose candidates are
     * all terminal still has to be reflected on, closed, and concluded; treating "every candidate is
     * terminal" as done would skip exactly the phase that writes down what was learned. A
     * candidate-only workspace has no such phase, so terminal candidates really are the end.
     */
    isFinished() {
      const workspaceState = store.getState(undefined, 'workspace') ?? {}
      if (workspaceState.stopped !== undefined) return true

      const rounds = readRoundsState(store)
      if (rounds !== undefined) return rounds.finalized_at_ms !== undefined

      const candidates = store.candidateIds()
      if (candidates.length === 0) return false
      return candidates.every((candidateId) => {
        const state = store.getState(candidateId, 'phase')
        return state === undefined || isTerminal(state.phase)
      })
    },

    close() {
      if (closed) return
      closed = true
      try {
        store.close()
      } catch (error) {
        log(`workspace close failed: ${messageOf(error)}`, { error })
      }
    },
  }
}