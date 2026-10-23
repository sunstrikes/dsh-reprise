#!/usr/bin/env node
/**
 * `run` — one command that starts an exploration in a workspace and prints what happened.
 *
 * This is the same wiring the host plugin uses (`workspace.js` → `tick`), driven by a loop instead of
 * by `ctx.interval`, so that a laptop without a host still exercises the real kernel. Anything this
 * program establishes is therefore evidence about the plugin, not about a second, parallel code path.
 *
 * What it prints is what an operator needs and nothing else: one line per phase step, a count, the
 * best result with its baseline, why the run stopped, and the `dump` command that explains any single
 * candidate. Exit codes: 0 reached a conclusion with a comparable metric, 1 ran but produced none,
 * 2 usage/configuration, 3 timed out waiting.
 *
 * Usage: node packages/core/lib/cli/run.js [--workspace <dir>] --config <file> [--max-seconds N] [--quiet]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveConfig } from '../config.js'
import { createWorkspace } from '../workspace.js'
import { baselinePort } from '../ports.js'
import { conclusion, overview } from '../projection.js'
import { describeWarnings } from '../warnings.js'

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const USAGE = [
  'usage: node packages/core/lib/cli/run.js [--workspace <dir>] --config <file> [--max-seconds N] [--quiet]',
  '',
  '  --workspace     directory the run owns (overrides "workspace" in the config file)',
  '  --config        JSON configuration: metric contract, budget, rounds, executor, candidates, model',
  '  --max-seconds   stop waiting after this long (default 900)',
  '  --quiet         print only the phase steps that changed, not every skipped tick',
].join('\n')

function parseArgs(argv) {
  const get = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  return {
    configPath: get('--config'),
    workspace: get('--workspace'),
    maxSeconds: Number(get('--max-seconds') ?? 900),
    quiet: argv.includes('--quiet'),
  }
}

const isTerminalState = (state) => ['succeeded', 'failed', 'lost'].includes(state)

/**
 * @param {string[]} argv
 * @param {{out?: (line: string) => void, cwd?: string, wait?: (ms: number) => Promise<unknown>,
 *          now?: () => number}} [options] injected so the five-step path can be driven in a test
 * @returns {Promise<{code: number, best?: object, ticks: number}>}
 */
export async function runLoop(argv, { out = (line) => process.stdout.write(`${line}\n`), cwd = process.cwd(), wait = sleep, now = Date.now } = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return { code: 0, ticks: 0 }
  }
  if (args.configPath === undefined) {
    out(USAGE)
    return { code: 2, ticks: 0 }
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(resolve(cwd, args.configPath), 'utf8'))
  } catch (error) {
    out(`cannot read --config ${args.configPath}: ${error?.message ?? error}`)
    return { code: 2, ticks: 0 }
  }
  if (args.workspace !== undefined) raw.workspace = args.workspace

  const resolved = resolveConfig(raw, { cwd })
  if (!resolved.ok) {
    out('the configuration cannot be used:')
    for (const problem of resolved.problems) out(`  - ${problem}`)
    return { code: 2, ticks: 0 }
  }
  const config = resolved.config

  out(`workspace   ${config.workspaceDir}`)
  out(`executor    ${config.executor.kind}${config.candidate === undefined ? '' : ` / candidate ${config.candidate.kind ?? 'command'}`}`)
  out(`metric      ${config.metrics?.primary ?? '(none)'} ${JSON.stringify(config.metrics?.objectives ?? {})}`)
  for (const line of describeWarnings(resolved.warnings)) out(line)
  out('')

  const log = args.quiet ? () => {} : (message) => out(`  · ${message}`)

  let workspace
  try {
    workspace = createWorkspace({ workspaceDir: config.workspaceDir, config, log })
  } catch (error) {
    out(`the workspace could not be opened: ${error?.message ?? error}`)
    return { code: 2, ticks: 0 }
  }

  const startedAt = now()
  try {
    try {
      const repairs = await workspace.reconcileNow()
      if (repairs.length > 0) out(`reconciled on boot: ${repairs.length} repair(s)`)
    } catch (error) {
      out(`reconcile failed, continuing: ${error?.message ?? error}`)
    }

    const lastSeen = new Map()
    const printActions = (actions, tick) => {
      for (const action of actions) {
        const key = action.candidateId ?? 'workspace'
        const text = `${key.padEnd(8)} ${String(action.phase ?? '-').padEnd(8)} ${action.action}`
        // A phase that is merely waiting prints once. A tick that changes something prints again.
        if (lastSeen.get(key) === text) continue
        lastSeen.set(key, text)
        out(`[${String(tick).padStart(2, ' ')}] ${text}`)
      }
    }

    let ticks = 0
    let paused
    let timedOut = false
    for (;;) {
      const result = await workspace.tickOnce()
      ticks += 1
      printActions(result.actions ?? [], ticks)

      if (result.paused) {
        paused = result.paused
        break
      }
      if (result.stopped?.stopped === true) break
      if (workspace.isFinished()) break
      if (now() - startedAt > args.maxSeconds * 1000) {
        timedOut = true
        break
      }
      await wait(config.interval_ms)
    }

    // The projection is the same one the dashboard and `dump` read: one conclusion, three renderers.
    const page = overview(workspace.store, { config })
    const done = conclusion(workspace.store, { config })
    const baseline = baselinePort({ workspaceDir: config.workspaceDir, store: workspace.store }).read()

    out('')
    out(`ticks       ${ticks} in ${((now() - startedAt) / 1000).toFixed(1)}s`)
    out(
      `candidates  ${page.candidates.total} total, ${page.candidates.done} done, ` +
        `${page.candidates.rejected} rejected${page.candidates.inFlight.length === 0 ? '' : `, ${page.candidates.inFlight.length} in flight`}`,
    )
    out(`spend       ${page.spend.usedGpuHours}h used of ${page.spend.limitGpuHours > 0 ? `${page.spend.limitGpuHours}h` : 'unlimited'}`)
    if (baseline !== undefined) out(`baseline    ${baseline.metric}=${baseline.value}`)

    if (done.best === undefined) {
      out('best        none — no candidate produced a comparable metric')
      for (const entry of page.candidates.incomplete) out(`  incomplete  ${entry.candidate_id}: missing ${entry.missing.join(', ')}`)
      if (paused) out(`paused      ${paused.reason}${paused.message === undefined ? '' : ` — ${paused.message}`}`)
      out('')
      out(`nothing was concluded. node packages/core/lib/cli/dump.js --candidate <id> --workspace ${config.workspaceDir} says why.`)
      return { code: paused ? 1 : timedOut ? 3 : 1, ticks }
    }

    out(`best        ${done.best.candidate_id}  ${done.best.metric}=${done.best.value}  (round ${done.best.round})`)
    if (baseline !== undefined && done.best.value !== baseline.value) {
      const better = (config.rounds?.metric?.direction ?? 'higher') === 'lower' ? done.best.value < baseline.value : done.best.value > baseline.value
      out(`verdict     ${better ? 'improved on' : 'regressed against'} the baseline`)
    }
    if (typeof done.against?.parent === 'string' && done.against.parent !== '') out(`against     ${done.against.parent}`)
    if (done.against?.best !== undefined) out(`last best   ${done.against.best.candidate_id} ${done.against.best.metric}=${done.against.best.value}`)
    out(
      `stop        ${
        done.stopped?.stopped === true
          ? `${done.stopped.rule}${done.stopped.message === undefined ? '' : ` — ${done.stopped.message}`}`
          : paused
            ? `paused: ${paused.reason}`
            : timedOut
              ? `not stopped (--max-seconds ${args.maxSeconds})`
              : 'not stopped'
      }`,
    )
    for (const warning of page.warnings) out(`warning     ${warning.label ?? warning.code}: ${warning.message}`)
    out('')
    // The config is recorded into the workspace at INIT, so the dump needs no flags to explain it.
    out(`next: node packages/core/lib/cli/dump.js --candidate ${done.best.candidate_id} --workspace ${config.workspaceDir}`)
    return { code: timedOut ? 3 : 0, best: done.best, ticks }
  } finally {
    workspace.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runLoop(process.argv.slice(2))
  process.exitCode = result.code
}