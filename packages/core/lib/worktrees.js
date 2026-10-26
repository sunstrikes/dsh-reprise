/**
 * Where a run's candidate worktrees are, and what became of them.
 *
 * A landed candidate's change lives as uncommitted edits in `<workspace>/worktrees/<candidateId>`, and
 * an accepted candidate's tree may be committed as the code base anchor — so those directories are
 * evidence, not scratch space. The kernel therefore never removes one: `runner.keep` is the declared
 * policy (default `true`), and the *only* removal path is the explicit `worktrees prune` command,
 * which has to be allowed by `keep: false` first. That is the same rule the cluster-job reaper
 * follows (`cli/jobs.js`): a heartbeat that tidies up on its own deletes somebody's evidence the first
 * time its idea of "finished" is wrong.
 *
 * This module is the **view** over that arrangement, and two of its properties are load-bearing:
 *
 *   - **Pure over facts plus a `stat`.** One row per candidate, from the fact plane (the `land_done`
 *     that recorded the path, the phase state, the `_workspace` anchor history) and a filesystem
 *     check for "is it still there". No git calls and no writes, so reading a finished run cannot
 *     disturb it — and a reader who only has the workspace directory can answer the question
 *     "the run ended, where did candidate r2-h1's tree go?".
 *   - **One derivation of a path.** `runnerLayout` is the only place `runner.repo` and `runner.dir`
 *     become absolute directories, and `worktreePathFor` is the only place a candidate id becomes a
 *     path. The runner (`ports.js`) uses both, which is what makes "the path the tree was created at",
 *     "the path a job runs in" and "the path the report prints" the same string.
 *
 * Removal itself is not here: the runner owns git (`ports.js` `remove`), and `pruneRefusal` below is
 * the decision the CLI asks before it may call it.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isPlainObject, isTerminal } from '@dsh-reprise/contract'
import { safeSlug } from '@dsh-reprise/exec'

import { readAnchor } from './anchor.js'
import { WORKSPACE_SUBJECT } from './store.js'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * The two directories a run's trees live between, as absolute paths, or `undefined` when the run has
 * no runner.
 *
 * It reads either shape on purpose: the **configuration** (`repo`, `dir`, `base_ref`, `keep`) at boot,
 * and the **runner** `ports.js` builds (`repoDir`, `worktreesDir`, `baseRef`, `keep`) whenever a
 * caller already has one — a report over a live run must not re-derive what the runner already
 * resolved, because the two answers would be one edit apart. `repo` / `dir` resolve against the
 * workspace exactly as they always have (an absolute value passes through `resolve` unchanged), and
 * `keep` defaults to `true`: the shipped default is retention.
 *
 * @param {{workspaceDir?: string, runner?: object}} options
 * @returns {{workspaceDir: string|undefined, repoDir: string, worktreesDir: string, baseRef: string, keep: boolean} | undefined}
 */
export function runnerLayout({ workspaceDir, runner } = {}) {
  if (!isPlainObject(runner)) return undefined
  const repoDir = isText(runner.repoDir)
    ? runner.repoDir
    : isText(runner.repo) && isText(workspaceDir)
      ? resolve(workspaceDir, runner.repo)
      : undefined
  const worktreesDir = isText(runner.worktreesDir)
    ? runner.worktreesDir
    : isText(runner.dir) && isText(workspaceDir)
      ? resolve(workspaceDir, runner.dir)
      : undefined
  if (repoDir === undefined || worktreesDir === undefined) return undefined
  const baseRef = isText(runner.baseRef) ? runner.baseRef : isText(runner.base_ref) ? runner.base_ref : 'HEAD'
  return { workspaceDir, repoDir, worktreesDir, baseRef, keep: runner.keep !== false }
}

/** The path one candidate's tree is created at. Deterministic, because a dump has to explain it. */
export function worktreePathFor({ worktreesDir, candidateId }) {
  if (!isText(candidateId)) throw new TypeError('a worktree path needs the candidate id it belongs to')
  if (!isText(worktreesDir)) return undefined
  return join(worktreesDir, safeSlug(candidateId))
}

/**
 * The runner configuration the run recorded into its own workspace at INIT, if it did.
 *
 * This is what lets `dump` name a tree from a workspace directory and nothing else: a reader of a
 * finished run does not have the YAML the run was started with, and asking for it again on the
 * command line is how two readers end up describing the same run differently.
 */
export function recordedRunner(store) {
  const recorded = store?.getState?.(undefined, 'workspace', {})?.runner
  return isPlainObject(recorded) ? recorded : undefined
}

/** `runnerLayout` for a workspace that only has its facts — the dump path. */
export function recordedLayout({ store, workspaceDir }) {
  return runnerLayout({ workspaceDir, runner: recordedRunner(store) })
}

/** The commits the run recorded for candidates: the anchor it rolled to, and the ones it proposed. */
function sealedCommits(store) {
  const sealed = new Map()
  for (const event of store.eventsFor(WORKSPACE_SUBJECT)) {
    if (event.event_type !== 'anchor_rolled' && event.event_type !== 'anchor_roll_proposed') continue
    const { candidate_id: candidateId, commit } = event.payload ?? {}
    if (isText(candidateId) && isText(commit)) sealed.set(candidateId, commit)
  }
  const current = readAnchor(store)
  if (current !== undefined) sealed.set(current.candidate_id, current.commit)
  return sealed
}

/** When this candidate's tree was removed by an explicit prune, if it ever was. */
function prunedAtMs(store, candidateId) {
  const events = store.eventsFor(candidateId)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event_type === 'worktree_pruned') return events[index].wall_clock_ms
  }
  return null
}

/**
 * One candidate's row.
 *
 * @param {{store: object, layout?: object, pathFor?: (candidateId: string) => string,
 *          anchor?: object, sealed?: Map<string, string>}} context
 * @param {string} candidateId
 */
function rowFor({ store, layout, pathFor, anchor, sealed }, candidateId) {
  const state = store.getState(candidateId, 'phase') ?? {}
  const events = store.eventsFor(candidateId)
  let payload
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event_type === 'land_done') {
      payload = events[index].payload ?? {}
      break
    }
  }

  const recorded = payload === undefined || !isText(payload.worktree_dir) ? undefined : payload.worktree_dir
  const derived =
    typeof pathFor === 'function' ? pathFor(candidateId) : worktreePathFor({ worktreesDir: layout?.worktreesDir, candidateId })
  const path = recorded ?? derived ?? null
  const files =
    payload === undefined
      ? 0
      : Array.isArray(payload.files)
        ? payload.files.length
        : Number.isSafeInteger(payload.files_changed)
          ? payload.files_changed
          : 0

  return {
    candidate_id: candidateId,
    round: Number.isSafeInteger(payload?.round) ? payload.round : Number.isSafeInteger(state.round) ? state.round : null,
    path,
    source: recorded !== undefined ? 'land_done' : derived !== undefined ? 'runner' : 'none',
    landed: payload !== undefined,
    exists: path === null ? false : existsSync(path),
    phase: isText(state.phase) ? state.phase : null,
    files,
    anchor: anchor?.candidate_id === candidateId,
    sealed_commit: sealed.get(candidateId) ?? null,
    pruned_at_ms: prunedAtMs(store, candidateId),
  }
}

const contextOf = ({ store, workspaceDir, runner }) => ({
  store,
  layout: runnerLayout({ workspaceDir, runner }) ?? recordedLayout({ store, workspaceDir }),
  pathFor: runner?.pathFor,
  anchor: readAnchor(store),
  sealed: sealedCommits(store),
})

/**
 * The whole inventory: one row per candidate, plus the three answers a reader asks for first — where
 * the trees go, which repository they branch from, and whether the run keeps them.
 *
 * @param {{store: object, workspaceDir?: string, runner?: object}} options
 * @returns {{workspace: string|null, repo: string|null, worktrees: string|null, base_ref: string|null,
 *            kept: boolean|null, rows: object[], present: number}}
 */
export function worktreeReport({ store, workspaceDir, runner } = {}) {
  if (store === undefined || store === null) {
    throw new TypeError('worktreeReport needs the fact store — a worktree path is a fact before it is a directory')
  }
  const context = contextOf({ store, workspaceDir, runner })
  const rows = (store.candidateIds?.() ?? []).map((candidateId) => rowFor(context, candidateId))
  return {
    workspace: workspaceDir ?? context.layout?.workspaceDir ?? null,
    repo: context.layout?.repoDir ?? null,
    worktrees: context.layout?.worktreesDir ?? null,
    base_ref: context.layout?.baseRef ?? null,
    kept: context.layout === undefined ? null : context.layout.keep,
    rows,
    present: rows.filter((row) => row.exists).length,
  }
}

/** One candidate's row, derived exactly as the report derives it. `undefined` when the run never heard of it. */
export function worktreeOf({ store, workspaceDir, runner, candidateId } = {}) {
  if (store === undefined || store === null) throw new TypeError('worktreeOf needs the fact store')
  if (!isText(candidateId) || !(store.candidateIds?.() ?? []).includes(candidateId)) return undefined
  return rowFor(contextOf({ store, workspaceDir, runner }), candidateId)
}

/**
 * May this candidate's tree be removed? `undefined` means yes; a string is the reason it may not.
 *
 * All three refusals live here rather than in the CLI so they are one decision, tested directly:
 * a run that keeps its worktrees (`keep: true`, the default), an id this workspace never recorded,
 * and a candidate that has not finished — removing a running candidate's tree is how a job in flight
 * loses the files it is reading.
 *
 * @param {{row?: object, keep?: boolean}} options
 * @returns {string | undefined}
 */
export function pruneRefusal({ row, keep } = {}) {
  if (keep === true) {
    return (
      'the run keeps its worktrees (runner.keep: true) — set runner.keep: false in the run configuration ' +
        'if this workspace may be pruned'
    )
  }
  if (row === undefined || row === null) return 'no candidate with that id is recorded in this workspace'
  if (row.phase === null || row.phase === undefined) {
    return 'no phase is recorded for this candidate, so it is not known to be finished'
  }
  if (!isTerminal(row.phase)) return `the candidate is still ${row.phase} — only a finished candidate's tree may be pruned`
  return undefined
}