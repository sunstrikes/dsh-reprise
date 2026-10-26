#!/usr/bin/env node
/**
 * `worktrees` — where the candidate trees are, and the only way one is ever removed.
 *
 * The inventory answers a question the run could not answer before: *the run finished — where did
 * candidate r2-h1's tree go?* It is a **view** (`worktrees.js`), so `list` is read-only by
 * construction: facts plus one `stat` per candidate, no git, no writes.
 *
 * `prune` is the one exception, and it is a command rather than a tick step on purpose. A tree is the
 * evidence behind a landing — the diff the candidate was judged on is the files in that directory —
 * so removing one is a decision a person makes, naming the candidates, exactly as `jobs reap` names
 * the orphans it stops. Three refusals come first (a candidate that is not finished, an unknown id, a
 * run whose `runner.keep` is `true`); only then is `git worktree remove` run, and the
 * `worktree_pruned` fact records what was removed and when.
 *
 * Two commands:
 *
 *   list   one row per candidate: round, phase, files landed, whether the tree is on disk, its path
 *   prune  remove the trees named with --candidate; everything else is refused with its reason
 *
 * It reads configuration through the same `resolveConfig` the run uses — `--config` is a run
 * configuration file, so a workspace written relative to that file resolves against the file — and
 * the workspace it speaks about is the run's workspace. There is no second config.
 *
 * Usage: node packages/core/lib/cli/worktrees.js list --config <file> [--workspace <dir>] [--json]
 *        node packages/core/lib/cli/worktrees.js prune --config <file> --candidate <id> [--candidate <id>...]
 *
 * Exit codes: 0 done, 1 refused (the reasons are on stdout), 2 usage or configuration.
 */

import { resolveConfig } from '../config.js'
import { createWorktreeRunner } from '../ports.js'
import { Store } from '../store.js'
import { pruneRefusal, worktreeReport } from '../worktrees.js'

const USAGE = [
  'usage: worktrees list --config <file> [--workspace <dir>] [--json]',
  '       worktrees prune --config <file> --candidate <id> [--candidate <id>...]',
  '',
  '  list         one row per candidate: round, phase, files, whether the tree is on disk, its path',
  '  prune        remove the trees named with --candidate; a running candidate is never removed',
  '  --config     a run configuration file (its relative "workspace" resolves against the file)',
  '  --workspace  directory the run owns (overrides "workspace" in the config file)',
  '  --json       print the view as JSON instead of a table',
].join('\n')

function parseArgs(argv) {
  const flags = { json: false }
  const candidateIds = []
  let command
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--json') {
      flags.json = true
      continue
    }
    if (arg.startsWith('--')) {
      const next = argv[index + 1]
      if (next === undefined) return { error: `${arg} needs a value` }
      // `--candidate` may be repeated: pruning is an act about a list of ids, and keeping only the
      // last one would remove fewer trees than the operator asked for.
      if (arg === '--candidate') candidateIds.push(next)
      else flags[arg.slice(2)] = next
      index += 1
      continue
    }
    if (command === undefined) command = arg
    else candidateIds.push(arg)
  }
  return { command, ...flags, candidateIds }
}

/** One line per row, wide enough to read at a terminal and to paste into a message. */
function table(rows, columns) {
  const width = columns.map((column) => Math.max(column.label.length, ...rows.map((row) => String(column.value(row) ?? '').length)))
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(width[index])).join('  ').trimEnd()
  return [line(columns.map((column) => column.label)), ...rows.map((row) => line(columns.map((column) => column.value(row))))]
}

/** How a row's tree reads on screen: the absence of a tree is a word, never an empty cell. */
const treeState = (row) => (!row.landed ? 'not created' : row.exists ? 'present' : 'MISSING')

/**
 * The command, with its ports injected: `config` is a resolved configuration, `runner` the worktree
 * runner built from it. A test hands over both; the process entry point fills them in.
 *
 * @returns {{code: number}}
 */
export function worktreesCommand(argv, { out = (line) => process.stdout.write(`${line}\n`), config, runner, now = Date.now() } = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return { code: 0 }
  }
  if (args.error !== undefined || args.command === undefined) {
    out(args.error ?? USAGE)
    return { code: 2 }
  }
  if (args.command !== 'list' && args.command !== 'prune') {
    out(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`)
    return { code: 2 }
  }

  const store = Store.open(config.workspaceDir)
  try {
    const report = worktreeReport({ store, workspaceDir: config.workspaceDir, runner })

    if (args.command === 'list') {
      if (args.json) {
        out(JSON.stringify(report, null, 2))
        return { code: 0 }
      }
      out(`workspace   ${report.workspace}`)
      out(`repo        ${report.repo ?? '(no runner configured)'}${report.base_ref === null ? '' : `   branches from ${report.base_ref}`}`)
      out(`worktrees   ${report.worktrees ?? '(no runner configured)'}${report.kept === null ? '' : `   ${report.kept ? 'kept (runner.keep: true)' : 'prunable (runner.keep: false)'}`}`)
      out('')
      if (report.rows.length === 0) {
        out('no candidates are recorded in this workspace yet')
        return { code: 0 }
      }
      for (const line of table(report.rows, [
        { label: 'candidate', value: (row) => row.candidate_id },
        { label: 'round', value: (row) => row.round ?? '-' },
        { label: 'phase', value: (row) => row.phase ?? '-' },
        { label: 'files', value: (row) => row.files },
        { label: 'tree', value: (row) => treeState(row) },
        { label: 'path', value: (row) => row.path ?? '-' },
      ])) out(`  ${line}`)
      out('')
      out(`${report.rows.length} candidate(s), ${report.present} tree(s) on disk`)
      return { code: 0 }
    }

    // prune
    if (args.candidateIds.length === 0) {
      out('prune needs at least one --candidate <id>: it never removes a tree it was not named')
      return { code: 2 }
    }
    const keep = report.kept === null ? undefined : report.kept
    const refusals = []
    for (const candidateId of args.candidateIds) {
      const row = report.rows.find((candidate) => candidate.candidate_id === candidateId)
      const refusal = pruneRefusal({ row, keep })
      if (refusal !== undefined) {
        out(`refused     ${candidateId}: ${refusal}`)
        refusals.push(candidateId)
        continue
      }
      if (runner === undefined || typeof runner.remove !== 'function') {
        out(`refused     ${candidateId}: this run configured no runner, so it never created a tree this command could remove`)
        refusals.push(candidateId)
        continue
      }
      let removal
      try {
        removal = runner.remove(candidateId)
      } catch (error) {
        out(`refused     ${candidateId}: ${error?.message ?? String(error)}`)
        refusals.push(candidateId)
        continue
      }
      store.appendEvent({
        candidate_id: candidateId,
        wall_clock_ms: now(),
        event_type: 'worktree_pruned',
        payload: { path: removal.path, reason: 'explicit prune', existed: removal.removed },
      })
      out(`pruned      ${candidateId}  ${removal.path}${removal.removed ? '' : '  (the directory was already gone; the registration was pruned)'}`)
    }
    return { code: refusals.length > 0 ? 1 : 0 }
  } finally {
    store.close()
  }
}

/**
 * The process entry point: read the run configuration file, build the runner, then hand the command
 * its ports.
 */
export function runWorktrees(argv, { out = (line) => process.stdout.write(`${line}\n`), cwd = process.cwd(), now = Date.now } = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return { code: 0 }
  }
  if (args.config === undefined) {
    out(USAGE)
    return { code: 2 }
  }

  // `--config` names a *run configuration file*: `config_file` is what carries the file-relative
  // `workspace` rule, so the same file an operator hands the host also answers these commands.
  const raw = { config_file: args.config, ...(args.workspace === undefined ? {} : { workspace: args.workspace }) }
  const resolved = resolveConfig(raw, { cwd })
  if (!resolved.ok) {
    out('the configuration cannot be used:')
    for (const problem of resolved.problems) out(`  - ${problem}`)
    return { code: 2 }
  }
  const config = resolved.config
  const runner =
    config.runner === undefined ? undefined : createWorktreeRunner(config.runner, { workspaceDir: config.workspaceDir })
  return worktreesCommand(argv, { out, config, runner, now })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runWorktrees(process.argv.slice(2))
  process.exitCode = result.code
}