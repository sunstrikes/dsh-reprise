#!/usr/bin/env node
/**
 * `dump` — the readability we owe people for moving the fact plane into SQLite.
 *
 * The acceptance bar, stated once and enforced by a test: **someone who has never read this code
 * must be able to answer "why did this candidate stop?", "where does it sit?" and "why did the run
 * end?" from this output alone.** So the shape is fixed — timeline, then the verdict that stopped
 * it, then the frontier position, then the workspace-level stop conclusion, then provenance.
 *
 * Read-only by construction: opens the database with `readOnly: true`, so a dump can never be the
 * reason facts changed — including `--rebuild`, which exists to prove the materialised view still
 * follows from the facts. A check that could rewrite what it checks would be worthless.
 *
 * The rendering is deliberately thin: everything it prints comes from `projection.js`, which the
 * dashboard reads too. Two renderers over one projection cannot drift; two independent derivations
 * would.
 *
 * @module
 */

import { readFileSync } from 'node:fs'

import { Store } from '../store.js'
import {
  candidateDetail,
  overview,
  summariseEvent,
} from '../projection.js'
import { ranking, rebuildRanking } from '../ranking.js'

const pad = (value, width) => String(value).padEnd(width)

const iso = (ms) => new Date(ms).toISOString()

/** Kept under its original name: `summarise` was this module's export before the projection moved. */

/**
 * The contract the run was using, for a reader who has only the workspace directory.
 *
 * `--config` wins because an operator verifying old facts with a newer contract is exactly the case
 * that matters; the recorded copy is the fallback so the common case needs no flags.
 */
function configFrom(store, configPath) {
  if (configPath !== undefined) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    // A file may hold the whole plugin config or just the metric contract; both are useful to a
    // reader verifying an old workspace, and guessing wrong would silently drop the contract.
    return parsed.metrics !== undefined ? parsed : { metrics: parsed }
  }
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  if (workspace.metrics === undefined && workspace.stop === undefined) return undefined
  return {
    ...(workspace.metrics === undefined ? {} : { metrics: workspace.metrics }),
    ...(workspace.stop === undefined ? {} : { stop: workspace.stop }),
  }
}

function frontierLines(store, candidateId, { config } = {}) {
  const detail = candidateDetail(store, candidateId, { config })
  if (detail === undefined) return []
  const position = detail.frontier
  const lines = ['', 'frontier position']

  const workspace = overview(store, { config })
  if (workspace.metricContract.ok !== true) {
    lines.push(`  not computed (${workspace.metricContract.status ?? 'no contract'}) — ${workspace.metricContract.error}`)
    return lines
  }

  const objectives = workspace.frontier.objectives
  lines.push(`  ${pad('objectives', 11)}${objectives.map((objective) => `${objective.name} (${objective.direction})`).join(', ')}`)

  const entries = Object.entries(position.vector).map(([name, value]) => `${name}=${value}`)
  lines.push(`  ${pad('vector', 11)}${entries.length === 0 ? '(no objective metric recorded)' : entries.join(' ')}`)

  if (detail.parent !== null && detail.parent !== undefined) {
    lines.push(`  ${pad('parent', 11)}${detail.parent} — the candidate this one was branched from`)
  }

  if (position.position === 'frontier') {
    const isBest = position.best?.candidate_id === candidateId
    lines.push(`  ${pad('position', 11)}${isBest ? 'on the frontier, and the best result in the run' : 'on the frontier'}`)
  } else if (position.position === 'dominated') {
    lines.push(`  ${pad('position', 11)}dominated by ${position.dominatedBy}`)
  } else if (entries.length === 0) {
    lines.push(
      `  ${pad('position', 11)}unranked — no ${objectives.map((objective) => objective.name).join('/')} recorded`,
    )
  } else {
    lines.push(`  ${pad('position', 11)}unranked — missing ${position.missing.join(', ')}`)
  }

  const best = position.best
  lines.push(
    `  ${pad('best', 11)}${best === undefined ? '(none — no candidate has a comparable result yet)' : `${best.candidate_id} ${best.metric}=${best.value} (round ${best.round})`}`,
  )
  return lines
}

function workspaceStopLines(store, { config } = {}) {
  const view = overview(store, { config })
  const stop = view.stop
  const lines = ['', 'workspace stop']

  if (stop.stopped) {
    lines.push(`  ${pad('state', 11)}${view.workspace.phase ?? 'FINALIZE'}`)
    lines.push(`  ${pad('rule', 11)}${stop.rule}`)
    lines.push(`  ${pad('limit', 11)}${stop.limit}   observed ${stop.observed}`)
    lines.push(`  ${pad('reason', 11)}${stop.message}`)
    if (stop.best !== undefined && stop.best !== null) {
      lines.push(`  ${pad('best', 11)}${stop.best.candidate_id} ${stop.best.metric}=${stop.best.value} (round ${stop.best.round})`)
    }
    lines.push(`  ${pad('recorded', 11)}${iso(stop.atMs)} (event ${stop.eventSeq} workspace_stopped)`)
  } else {
    lines.push(
      `  ${pad('state', 11)}running (${view.rounds.completed} round(s) complete; empty streak ${view.rounds.emptyStreak}, no-improvement streak ${view.rounds.noImprovementStreak})`,
    )
  }

  const rules = (stop.rules ?? []).map((rule) => {
    if (rule.enabled !== true) return `${rule.rule}=${rule.limit} disabled`
    // Which rule fired, and which were merely enabled, is part of the answer: two enabled rules with
    // one recorded reason invites the question "why not the other one?".
    const note = rule.reason !== null && rule.reason !== undefined ? ` (${rule.reason})` : ''
    if (stop.stopped && rule.rule === stop.rule) return `${rule.rule}=${rule.limit} fired`
    return `${rule.rule}=${rule.limit} enabled${note}`
  })
  if (rules.length > 0) lines.push(`  ${pad('rules', 11)}${rules.join('; ')}`)
  return lines
}

/**
 * @param {Store} store
 * @param {string} candidateId
 * @param {{ config?: any }} [options]
 * @returns {string}
 */
export function renderDump(store, candidateId, { config } = {}) {
  const detail = candidateDetail(store, candidateId, { config })

  const lines = []
  lines.push(`workspace  ${store.path}`)
  lines.push(`candidate  ${candidateId}`)

  // A pause is a workspace fact, so it is answered for every candidate — including one that has no
  // facts of its own yet, because "the run is stopped and here is why" is the question a person
  // asks first. The two kinds of pause are never rendered alike: one clears itself, one does not.
  const workspace = store.getState(undefined, 'workspace')
  if (workspace?.paused) {
    lines.push('')
    lines.push('workspace paused')
    lines.push(`  reason     ${workspace.paused.reason ?? '(no reason recorded)'}`)
    lines.push(
      `  source     ${workspace.paused.automatic === true ? 'automatic — clears itself once the cause is gone' : 'manual — only a resume intent clears this'}`,
    )
    if (workspace.paused.at_ms !== undefined) lines.push(`  since      ${iso(workspace.paused.at_ms)}`)
    if (workspace.paused.intent_id !== undefined) lines.push(`  from       intent ${workspace.paused.intent_id}`)
  }

  if (detail === undefined) {
    lines.push('')
    lines.push(`No facts recorded for "${candidateId}". Nothing was ever written for this candidate.`)
    return lines.join('\n')
  }

  lines.push(`phase      ${detail.phase ?? '(no phase written)'}`)
  if (detail.round !== null && detail.round !== undefined) lines.push(`round      ${detail.round}`)
  if (detail.paused !== null && detail.paused !== undefined) lines.push(`paused     ${JSON.stringify(detail.paused)}`)

  const lag = detail.lag.pending
  lines.push(
    `events     ${detail.lag.maxSeq}${lag > 0 ? `   applied_seq ${detail.lag.appliedSeq}  ** ${lag} event(s) recorded but not folded into state **` : ''}`,
  )

  if (detail.timeline.length > 0) {
    lines.push('')
    lines.push('timeline')
    const width = String(detail.lag.maxSeq).length
    for (const event of detail.timeline) {
      lines.push(`  ${pad(event.seq, width)}  ${iso(event.atMs)}  ${pad(event.eventType, 22)}  ${event.summary}`)
    }
  }

  // Why it stopped is two facts, not one: the verdict that judged it (four-state, with its message)
  // and the terminal event that recorded the decision. Projection keeps both, because taking only
  // the last matching event loses the four-state conclusion whenever a terminal event follows the
  // verdict — which is the normal case, and precisely what makes a dump useless for "why".
  const rejection = detail.rejection
  if (rejection !== undefined) {
    lines.push('')
    lines.push('why it stopped')
    if (rejection.phase !== undefined) lines.push(`  ${pad('at phase', 11)}${rejection.phase}`)
    if (rejection.status !== undefined) lines.push(`  ${pad('status', 11)}${rejection.status}`)
    if (rejection.message !== '' && rejection.message !== undefined) lines.push(`  ${pad('message', 11)}${rejection.message}`)
    if (rejection.reason !== undefined && rejection.reason !== rejection.message) {
      lines.push(`  ${pad('terminal', 11)}reason ${rejection.reason}`)
    }
    lines.push(`  ${pad('recorded', 11)}${iso(rejection.atMs)} (event ${rejection.seq} ${rejection.eventType})`)
    if (rejection.terminal !== undefined) {
      lines.push(
        `  ${pad('terminal', 11)}${iso(rejection.terminal.atMs)} (event ${rejection.terminal.seq} ${rejection.terminal.eventType})`,
      )
    }
    if (rejection.artifact !== undefined) lines.push(`  ${pad('from', 11)}${rejection.artifact}`)
  }

  lines.push(...frontierLines(store, candidateId, { config }))
  lines.push(...workspaceStopLines(store, { config }))

  const kinds = Object.keys(detail.bindings).sort()
  if (kinds.length > 0) {
    lines.push('')
    lines.push('identity bindings')
    for (const kind of kinds) lines.push(`  ${pad(kind, 16)}${JSON.stringify(detail.bindings[kind])}`)
  }

  if (detail.job !== null) {
    const job = detail.job
    lines.push('')
    lines.push('job')
    lines.push(
      `  ${job.job_id}  state=${job.state}  attempts=${job.attempts}${job.error_class ? `  error_class=${job.error_class}` : ''}`,
    )
  }

  if (detail.artifacts.length > 0) {
    lines.push('')
    lines.push('referenced artifacts')
    for (const path of detail.artifacts) lines.push(`  ${path}`)
  }

  return lines.join('\n')
}

/** A one-line, comparable description of a derived view. Two of these either match or they do not. */
function signatureOf(view) {
  const best = view.best === undefined ? 'best=-' : `best=${view.best.candidate_id} ${view.best.metric}=${view.best.value}`
  return `${best} frontier=[${view.frontier.join(',')}]`
}

/**
 * The verification section: what the incremental path claims, and what folding the whole stream says.
 *
 * This is the rollback story as much as the check: after changing projection logic, run it over an
 * old workspace and see whether old facts still read the same way.
 */
export function renderVerification(store, { config } = {}) {
  const incremental = ranking(store, config, { persist: false })
  const rebuilt = rebuildRanking(store, config)
  const match = JSON.stringify(incremental) === JSON.stringify(rebuilt)

  const lines = ['', 'verification (full rebuild)']
  lines.push(`  ${pad('incremental', 12)}${signatureOf(incremental)}`)
  lines.push(`  ${pad('rebuilt', 12)}${signatureOf(rebuilt)}`)

  if (match) {
    lines.push(`  ${pad('result', 12)}match — the materialised view still follows from the facts`)
    return { text: lines.join('\n'), match: true }
  }

  // Name the rows that disagree; "the views differ" would leave an operator to diff two JSON blobs.
  const differing = []
  for (const row of incremental.candidates) {
    const other = rebuilt.candidates.find((candidate) => candidate.candidate_id === row.candidate_id)
    if (JSON.stringify(row) !== JSON.stringify(other)) differing.push(row.candidate_id)
  }
  lines.push(`  ${pad('result', 12)}MISMATCH — the materialised view no longer follows from the facts`)
  for (const candidateId of differing) {
    const claimed = incremental.candidates.find((row) => row.candidate_id === candidateId)
    const actual = rebuilt.candidates.find((row) => row.candidate_id === candidateId)
    lines.push(
      `  ${pad('differs', 12)}${candidateId}: stored ${JSON.stringify(claimed?.vector ?? null)} vs facts ${JSON.stringify(actual?.vector ?? null)}`,
    )
  }
  lines.push(
    `  ${pad('advice', 12)}the materialised rows under "derived_frontier" are derived, not facts; a projection change must bump DERIVED_VERSION`,
  )
  return { text: lines.join('\n'), match: false }
}

/** @param {string[]} argv */
export function runDump(argv) {
  const get = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const candidateId = get('--candidate')
  const workspace = get('--workspace') ?? process.cwd()
  const rebuild = argv.includes('--rebuild')
  const configPath = get('--config')

  if (candidateId === undefined && !rebuild) {
    return {
      code: 2,
      output:
        'usage: dump --candidate <id> [--workspace <dir>] [--config <file>] [--rebuild]\n' +
        '       dump --workspace <dir> --rebuild [--config <file>]',
    }
  }

  const store = Store.openReadOnly(workspace)
  try {
    let config
    try {
      config = configFrom(store, configPath)
    } catch (error) {
      return { code: 2, output: `cannot read --config ${configPath}: ${error?.message ?? String(error)}` }
    }

    const sections = []
    if (candidateId !== undefined) sections.push(renderDump(store, candidateId, { config }))
    let mismatch = false
    if (rebuild) {
      const verification = renderVerification(store, { config })
      mismatch = verification.match !== true
      sections.push(verification.text)
    }
    return { code: mismatch ? 1 : 0, output: sections.join('\n') }
  } finally {
    store.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, output } = runDump(process.argv.slice(2))
  process.stdout.write(`${output}\n`)
  process.exit(code)
}