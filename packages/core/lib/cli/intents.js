#!/usr/bin/env node
/**
 * `intents` — the hand-drivable end of the pending-intent mechanism.
 *
 * This exists so that a script, a cron job or a person at a terminal can advance or hold a run that
 * is already going, without a UI and without a chat session. It is deliberately a *thin* writer:
 * every intent goes through `placeIntent`, which is the same call a dashboard button will make, so
 * the two write paths cannot produce two accounts of one act.
 *
 * The command never opens the database. Placing an intent is a filesystem fact, and it must work
 * even on a workspace whose run is stopped, paused, or has not ticked yet.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { IntentRefused, INTENT_KINDS, listIntents, placeIntent } from '../intents.js'

const USAGE = `usage: intents <command> [options]

commands
  place <kind> [options]   write one intent into <workspace>/pending/
  list [--json]            show what is pending, applied and refused

kinds and their options
  proposal    --candidate-id <id> --hypothesis <text> [--round <n>]
              [--requires-approval --deadline-ms <ms> | --ttl-ms <ms> [--on-timeout apply|refuse]]
  grant       [--additional-gpu-hours <h>] [--additional-runtime-hours <h>]
  anchor      --candidate-id <id> --commit <sha>
  pause       [--reason <text>]
  resume      [--reason <text>]
  approval    --target <intent-id> --decision approve|refuse
  experience  --experience-id <id> --text <text> [--section guardrails|singletons|recipes|candidate_experiences]

common options
  --id <intent-id>         identity of this intent (default: <kind>-<epoch ms>)
  --workspace <dir>        workspace directory (default: current directory)
  --now <epoch ms>         the writer's clock, for reproducible scripts and tests

exit codes  0 placed, 1 refused (the reason is on stderr), 2 usage`

const VALUE_FLAGS = new Set([
  'workspace',
  'now',
  'id',
  'candidate-id',
  'hypothesis',
  'round',
  'deadline-ms',
  'ttl-ms',
  'on-timeout',
  'additional-gpu-hours',
  'additional-runtime-hours',
  'commit',
  'reason',
  'target',
  'decision',
  'experience-id',
  'text',
  'section',
])

const BOOLEAN_FLAGS = new Set(['requires-approval', 'json', 'help'])

class Usage extends Error {}

function parse(argv) {
  const flags = Object.create(null)
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new Usage(`unknown option: --${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Usage(`option --${name} needs a value`)
    flags[name] = value
    index += 1
  }
  return { flags, positional }
}

/** Numbers are parsed here, at the edge, so the intent body carries a number and not a string. */
function number(flags, name, { integer = false } = {}) {
  const raw = flags[name]
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Usage(`--${name} must be a number, got ${JSON.stringify(raw)}`)
  if (integer && !Number.isSafeInteger(value)) throw new Usage(`--${name} must be an integer, got ${JSON.stringify(raw)}`)
  return value
}

function buildIntent(kind, flags, { now }) {
  const intent = { kind }
  if (flags.id !== undefined) intent.intent_id = flags.id

  switch (kind) {
    case 'proposal': {
      intent.candidate_id = flags['candidate-id']
      intent.hypothesis = flags.hypothesis
      const round = number(flags, 'round', { integer: true })
      if (round !== undefined) intent.round = round
      if (flags['requires-approval'] === true) {
        intent.requires_approval = true
        const deadline = number(flags, 'deadline-ms', { integer: true })
        const ttl = number(flags, 'ttl-ms', { integer: true })
        if (deadline !== undefined) intent.deadline_ms = deadline
        else if (ttl !== undefined) intent.deadline_ms = now + ttl
        if (flags['on-timeout'] !== undefined) intent.on_timeout = flags['on-timeout']
      }
      break
    }
    case 'grant': {
      const gpu = number(flags, 'additional-gpu-hours')
      const runtime = number(flags, 'additional-runtime-hours')
      if (gpu !== undefined) intent.additional_gpu_hours = gpu
      if (runtime !== undefined) intent.additional_runtime_hours = runtime
      break
    }
    case 'anchor':
      intent.candidate_id = flags['candidate-id']
      intent.commit = flags.commit
      break
    case 'pause':
    case 'resume':
      if (flags.reason !== undefined) intent.reason = flags.reason
      break
    case 'approval':
      intent.target = flags.target
      intent.decision = flags.decision
      break
    case 'experience':
      intent.experience_id = flags['experience-id']
      intent.text = flags.text
      if (flags.section !== undefined) intent.section = flags.section
      break
    default:
      throw new Usage(`unknown intent kind: ${kind} (one of ${INTENT_KINDS.join(', ')})`)
  }
  return intent
}

function freeId(workspaceDir, kind, at) {
  const pending = join(workspaceDir, 'pending')
  const base = `${kind}-${at}`
  if (!existsSync(join(pending, `${base}.json`))) return base
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!existsSync(join(pending, `${candidate}.json`))) return candidate
  }
  throw new Usage(`too many ${kind} intents placed at ${at}`)
}

function describeList(listed) {
  const lines = []
  const section = (title, rows) => {
    lines.push(`${title} (${rows.length})`)
    for (const row of rows) lines.push(`  ${row}`)
  }

  section(
    'pending',
    listed.pending.map((entry) => {
      const held = entry.held
        ? `held until ${new Date(entry.deadline_ms).toISOString()}${entry.expired ? ' (expired)' : ''} — if nobody answers: ${entry.on_timeout}`
        : 'waiting'
      const malformed = entry.malformed === undefined ? '' : `  malformed: ${entry.malformed}`
      return `${entry.intent_id.padEnd(24)}${entry.kind.padEnd(12)}${held}${malformed}`
    }),
  )
  section(
    'applied',
    listed.applied.map(
      (entry) => `${entry.intent_id.padEnd(24)}${entry.kind.padEnd(12)}${entry.decision_source ?? ''}${entry.fallback ? ' (fallback)' : ''}`,
    ),
  )
  section(
    'refused',
    listed.refused.map((entry) => `${entry.intent_id.padEnd(24)}${entry.kind.padEnd(12)}${entry.reason}`),
  )
  return lines.join('\n')
}

/**
 * @param {string[]} argv
 * @param {{ now?: () => number }} [options]
 * @returns {{ code: number, output: string, error?: string }}
 */
export function runIntents(argv, { now = () => Date.now() } = {}) {
  try {
    const { flags, positional } = parse(argv)
    if (flags.help === true || positional.length === 0) return { code: 0, output: USAGE }

    const [command, kind] = positional
    const workspaceDir = resolve(flags.workspace ?? process.cwd())
    const at = flags.now === undefined ? now() : Number(flags.now)
    if (!Number.isSafeInteger(at)) throw new Usage(`--now must be an integer epoch in milliseconds`)

    if (command === 'list') {
      const listed = listIntents(workspaceDir, { now: at })
      if (flags.json === true) return { code: 0, output: JSON.stringify(listed, null, 2) }
      return { code: 0, output: describeList(listed) }
    }

    if (command !== 'place') throw new Usage(`unknown command: ${command}`)
    if (kind === undefined) throw new Usage('place needs an intent kind')

    const intent = buildIntent(kind, flags, { now: at })
    // A generated identity must never collide with a fact already on disk: two intents placed in
    // the same millisecond are two intents, not one. An explicit `--id` is left alone, so asking
    // for an identity twice is reported as `already pending` instead of silently becoming a second.
    if (intent.intent_id === undefined) intent.intent_id = freeId(workspaceDir, kind, at)
    const placed = placeIntent(workspaceDir, intent, { now: at })
    if (placed.status === 'exists') {
      return { code: 0, output: `already pending: ${placed.intent.intent_id} at ${placed.path} (not overwritten)` }
    }
    return { code: 0, output: `placed ${kind} ${placed.intent.intent_id} in ${basename(placed.path)}` }
  } catch (error) {
    if (error instanceof Usage) return { code: 2, output: '', error: `${error.message}\n\n${USAGE}` }
    if (error instanceof IntentRefused) return { code: 1, output: '', error: `refused: ${error.reason}` }
    return { code: 1, output: '', error: String(error?.stack ?? error) }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, output, error } = runIntents(process.argv.slice(2))
  if (output !== '') process.stdout.write(`${output}\n`)
  if (error !== undefined) process.stderr.write(`${error}\n`)
  process.exit(code)
}