#!/usr/bin/env node
/**
 * `jobs` — the operator's view of the cluster job ledger, and the only way an orphan is ever stopped.
 *
 * Why this is a command and not a tick step: the cluster is shared with other people's work (the
 * live dashboard carried 106 jobs from other teams before this ledger existed), and the difference
 * between "ours but unrecorded" and "somebody else's" is a marker inside a string field. A heartbeat
 * that acts on that difference kills a stranger's training the first time a marker is wrong; a
 * person reading a list does not. So `list` shows what the view computes, and `reap` stops only the
 * ids it was named, only if the view calls them orphans, and only while they are still running.
 *
 * Two commands:
 *
 *   list   the ledger, our jobs as the cluster reports them, the orphans, and the rest
 *   reap   stop the orphans named with --job; everything else is refused with its reason
 *
 * It reads configuration through the same `resolveConfig` the run uses, so the workspace it speaks
 * about is the run's workspace and the executor is the run's executor — there is no second config.
 *
 * Usage: node packages/core/lib/cli/jobs.js list --config <file> [--workspace <dir>] [--json]
 *        node packages/core/lib/cli/jobs.js reap --config <file> --job <id> [--job <id>...]
 *
 * Exit codes: 0 done, 1 refused (the reasons are on stdout), 2 usage or configuration.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveConfig } from '../config.js'
import { jobReport, readListing, reapOrphans } from '../jobs.js'
import { createPlatform } from '../ports.js'
import { Store } from '../store.js'

const USAGE = [
  'usage: jobs list --config <file> [--workspace <dir>] [--json]',
  '       jobs reap --config <file> --job <id> [--job <id>...]',
  '',
  '  list         the ledger, the jobs the cluster lists as ours, the orphans, and the rest',
  '  reap         stop the orphans named with --job; nothing else is ever stopped',
  '  --workspace  directory the run owns (overrides "workspace" in the config file)',
  '  --json       print the view as JSON instead of a table',
].join('\n')

function parseArgs(argv) {
  const positional = []
  const flags = { json: false }
  // `--job` may be repeated: reaping is an act about a list of ids, and a command that silently
  // keeps only the last one would stop fewer jobs than the operator asked for.
  const jobIds = []
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
      if (arg === '--job') jobIds.push(next)
      else flags[arg.slice(2)] = next
      index += 1
      continue
    }
    if (command === undefined) command = arg
    else positional.push(arg)
  }
  return { command, ...flags, jobIds: [...jobIds, ...positional] }
}

/** One line per job, wide enough to read at a terminal and to paste into a message. */
function table(rows, columns) {
  const width = columns.map((column) => Math.max(column.label.length, ...rows.map((row) => String(column.value(row) ?? '').length)))
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(width[index])).join('  ').trimEnd()
  return [line(columns.map((column) => column.label)), ...rows.map((row) => line(columns.map((column) => column.value(row))))]
}

/** How a job is named on screen: the id you would type, and the submission id when they differ. */
const label = (job) =>
  job.job_id !== null && job.submission_id !== null && job.job_id !== job.submission_id
    ? `${job.job_id} (${job.submission_id})`
    : (job.reference ?? job.submission_id ?? job.job_id)

/**
 * The command, with its ports injected: `config` is a resolved configuration, `platform` the job
 * port, `now` the clock. A test hands over all three; the process entry point fills them in.
 *
 * @returns {Promise<{code: number}>}
 */
export async function jobsCommand(argv, { out = (line) => process.stdout.write(`${line}\n`), config, platform, now = Date.now() } = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return { code: 0 }
  }
  if (args.error !== undefined || args.command === undefined) {
    out(args.error ?? USAGE)
    return { code: 2 }
  }
  const store = Store.open(config.workspaceDir)
  try {
    const listing = await readListing(platform)
    const report = jobReport({ rows: store.allJobs(), listing })

    if (args.command === 'list') {
      if (args.json) {
        out(JSON.stringify(report, null, 2))
        return { code: report.read ? 0 : 1 }
      }
      out(`workspace   ${config.workspaceDir}`)
      out(`executor    ${config.executor?.kind ?? 'local'}`)
      if (!report.read) {
        out('cluster     NOT READ')
        out(`            ${report.reason}`)
        out('            orphan detection needs a listing: nothing below claims to know what is running upstream')
      }
      out('')
      if (report.ledger.length > 0) {
        out('ledger (facts written by this workspace)')
        for (const line of table(report.ledger, [
          { label: 'candidate', value: (row) => row.candidate_id },
          { label: 'round', value: (row) => row.round ?? '-' },
          { label: 'job', value: (row) => row.job_id },
          { label: 'state', value: (row) => row.state },
          { label: 'outcome', value: (row) => row.outcome ?? 'in flight' },
          { label: 'marker', value: (row) => row.marker ?? '-' },
        ])) out(`  ${line}`)
        out('')
      }
      if (report.read) {
        out(`ours (${report.ours.length})`)
        for (const job of report.ours) out(`  ${label(job)}  ${job.status || 'unknown'}  ${job.outcome ?? 'in flight'}`)
        out('')
        out(`orphans (${report.orphans.length}) — our marker, no ledger row`)
        for (const job of report.orphans) out(`  ${label(job)}  ${job.status || 'unknown'}  ${job.marker}`)
        if (report.orphans.length > 0) out('  stop one with: jobs reap --job <reference>')
        out('')
        out(`not ours (${report.foreign.length}) — never actionable here`)
        for (const job of report.foreign) out(`  ${label(job)}  ${job.status || 'unknown'}`)
        if (report.unlisted.length > 0) {
          out('')
          out(`recorded but no longer listed (${report.unlisted.length})`)
          for (const row of report.unlisted) out(`  ${row.job_id}  ${row.state}  ${row.outcome ?? 'in flight'}`)
        }
      }
      return { code: report.read ? 0 : 1 }
    }

    if (args.command === 'reap') {
      if (args.jobIds.length === 0) {
        out('reap needs at least one --job <reference>: it never stops anything it was not named')
        return { code: 2 }
      }
      const result = await reapOrphans({ platform, store, report, jobIds: args.jobIds, now })
      for (const job of result.stopped) out(`stopped     ${job.reference} (${job.submission_id}, marker ${job.marker})`)
      for (const refusal of result.refusals) out(`refused     ${refusal.job_id}: ${refusal.reason}`)
      return { code: result.refusals.length > 0 ? 1 : 0 }
    }

    out(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`)
    return { code: 2 }
  } finally {
    store.close()
  }
}

/** The process entry point: read the configuration file, then hand the command its ports. */
export async function runJobs(argv, { out = (line) => process.stdout.write(`${line}\n`), cwd = process.cwd(), now = Date.now() } = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return { code: 0 }
  }
  if (args.config === undefined) {
    out(USAGE)
    return { code: 2 }
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(resolve(cwd, args.config), 'utf8'))
  } catch (error) {
    out(`cannot read --config ${args.config}: ${error?.message ?? error}`)
    return { code: 2 }
  }
  if (args.workspace !== undefined) raw.workspace = args.workspace

  const resolved = resolveConfig(raw, { cwd })
  if (!resolved.ok) {
    out('the configuration cannot be used:')
    for (const problem of resolved.problems) out(`  - ${problem}`)
    return { code: 2 }
  }

  const platform = createPlatform(resolved.config, { workspaceDir: resolved.config.workspaceDir })
  return jobsCommand(argv, { out, config: resolved.config, platform, now })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runJobs(process.argv.slice(2))
  process.exitCode = result.code
}