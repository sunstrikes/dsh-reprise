/**
 * Human intents are files.
 *
 * The point is not convenience, it is that **the file is the fact**. A CLI, a dashboard button and
 * a chat approval widget are three writers of one directory; none of them is the truth, so none of
 * them can disagree with the others. The kernel reads the directory at the top of every tick and
 * consumes each intent exactly once.
 *
 * Four rules make that safe, and all of them are fail-closed:
 *
 *   **Consumed once.** `pending/<id>.json` is the request; `intents/applied/<id>.json` and
 *   `intents/refused/<id>.json` are the receipts. A receipt is the ledger: re-placing a consumed
 *   id is refused, never re-applied. Effects that cannot be made idempotent (a grant adds hours)
 *   also record their id in `workspace.intents_applied` inside the *same* state write as the
 *   effect, so a crash between effect and receipt cannot grant twice.
 *
 *   **Refused with a reason.** Malformed or over-reaching intents change nothing and say why:
 *   `invalid_additional_gpu_hours: -1` beats a file that quietly does nothing.
 *
 *   **Nobody waits forever.** An intent that gates a step (a proposal held for approval) must
 *   carry a deadline; a hold *without* a deadline is itself refused, because that is the one
 *   shape that could park an unattended run on a human who never comes. At the deadline the
 *   predetermined answer applies and the event says `fallback`, not `human`.
 *
 *   **One fact, whichever writer.** The UI and the CLI both call `placeIntent`, so both produce
 *   the same file, byte for byte, and a second writer cannot overwrite the first (`wx`).
 *
 * What this module deliberately does not own: pausing, resuming and the budget arithmetic. Those
 * are `budget.js`'s semantics and are called, not re-implemented — `pause()` already knows that an
 * automatic pause may clear itself and a manual one may not, and duplicating that here is how two
 * accounts of the same pause start to drift.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isPlainObject } from '@dsh-reprise/contract'

import { budgetOf, pause, resume } from './budget.js'

/** Workspace-wide intents have no candidate, so their events land on this reserved actor. */
export const WORKSPACE_ACTOR = 'workspace'

export const INTENT_KINDS = Object.freeze([
  'proposal',
  'grant',
  'anchor',
  'pause',
  'resume',
  'approval',
  'experience',
])

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA = /^[0-9a-f]{7,40}$/
const MAX_TEXT = 4_000

/** Every field an intent may carry, per kind. Anything else is refused instead of ignored. */
const FIELDS = Object.freeze({
  proposal: ['kind', 'intent_id', 'placed_at_ms', 'candidate_id', 'hypothesis', 'round', 'requires_approval', 'deadline_ms', 'on_timeout'],
  grant: ['kind', 'intent_id', 'placed_at_ms', 'additional_gpu_hours', 'additional_runtime_hours'],
  anchor: ['kind', 'intent_id', 'placed_at_ms', 'candidate_id', 'commit'],
  pause: ['kind', 'intent_id', 'placed_at_ms', 'reason'],
  resume: ['kind', 'intent_id', 'placed_at_ms', 'reason'],
  approval: ['kind', 'intent_id', 'placed_at_ms', 'target', 'decision'],
  experience: ['kind', 'intent_id', 'placed_at_ms', 'experience_id', 'text', 'section'],
})

/** Refused by the *writer* (bad shape, never written). Consumption refusals are recorded on disk. */
export class IntentRefused extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'IntentRefused'
    this.reason = reason
  }
}

const isId = (value) => typeof value === 'string' && ID.test(value)
const isText = (value, max = MAX_TEXT) => typeof value === 'string' && value.trim() !== '' && value.length <= max
/** `true` is an `int` in JS and would grant one hour; booleans are never numbers here. */
const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
const isPositiveInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isAbsent = (value) => value === undefined || value === null

export function intentPaths(workspaceDir) {
  return {
    pending: join(workspaceDir, 'pending'),
    applied: join(workspaceDir, 'intents', 'applied'),
    refused: join(workspaceDir, 'intents', 'refused'),
    experiences: join(workspaceDir, 'experiences'),
  }
}

function ensureLayout(workspaceDir) {
  const paths = intentPaths(workspaceDir)
  for (const dir of [paths.pending, paths.applied, paths.refused]) mkdirSync(dir, { recursive: true })
  return paths
}

// ------------------------------------------------------------- validation

/**
 * Shape validation, used by both writers and the kernel. World-dependent refusals (a candidate
 * that does not exist, a budget that is already unlimited) live in `precondition`.
 *
 * @param {any} intent
 * @param {{ expectedId?: string }} [options] `expectedId` is the filename stem: an intent may not
 *   claim an identity other than the name it was planted under.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateIntent(intent, { expectedId } = {}) {
  const refuse = (reason) => ({ ok: false, reason })
  if (!isPlainObject(intent)) return refuse('not_an_object')

  const kind = intent.kind
  if (typeof kind !== 'string' || !INTENT_KINDS.includes(kind)) return refuse(`unknown_kind: ${JSON.stringify(kind ?? null)}`)
  if (!isId(intent.intent_id)) return refuse(`invalid_intent_id: ${JSON.stringify(intent.intent_id ?? null)}`)
  if (expectedId !== undefined && intent.intent_id !== expectedId) {
    return refuse(`intent_id_mismatch: file is ${JSON.stringify(expectedId)}, file says ${JSON.stringify(intent.intent_id)}`)
  }
  if (!isAbsent(intent.placed_at_ms) && !Number.isSafeInteger(intent.placed_at_ms)) {
    return refuse(`invalid_placed_at_ms: ${JSON.stringify(intent.placed_at_ms)}`)
  }
  for (const field of Object.keys(intent)) {
    if (!FIELDS[kind].includes(field)) return refuse(`unknown_field: ${kind}.${field}`)
  }

  switch (kind) {
    case 'proposal':
      return validateProposal(intent)
    case 'grant':
      return validateGrant(intent)
    case 'anchor':
      if (!isId(intent.candidate_id)) return refuse(`invalid_candidate_id: ${JSON.stringify(intent.candidate_id ?? null)}`)
      if (typeof intent.commit !== 'string' || !SHA.test(intent.commit)) return refuse(`invalid_commit: ${JSON.stringify(intent.commit ?? null)}`)
      return { ok: true }
    case 'pause':
    case 'resume':
      if (!isAbsent(intent.reason) && !isText(intent.reason, 200)) return refuse(`invalid_reason: ${JSON.stringify(intent.reason)}`)
      return { ok: true }
    case 'approval':
      if (!isId(intent.target)) return refuse(`invalid_target: ${JSON.stringify(intent.target ?? null)}`)
      if (!['approve', 'refuse'].includes(intent.decision)) return refuse(`invalid_decision: ${JSON.stringify(intent.decision ?? null)}`)
      return { ok: true }
    case 'experience':
      if (!isId(intent.experience_id)) return refuse(`invalid_experience_id: ${JSON.stringify(intent.experience_id ?? null)}`)
      if (!isText(intent.text)) return refuse(`invalid_text: length ${typeof intent.text === 'string' ? intent.text.length : 'none'}`)
      if (!isAbsent(intent.section) && !['guardrails', 'singletons', 'recipes', 'candidate_experiences'].includes(intent.section)) {
        return refuse(`invalid_section: ${JSON.stringify(intent.section)}`)
      }
      return { ok: true }
    default:
      return refuse(`unknown_kind: ${kind}`)
  }
}

function validateGrant(intent) {
  const refuse = (reason) => ({ ok: false, reason })
  const hours = intent.additional_gpu_hours
  const runtime = intent.additional_runtime_hours
  if (isAbsent(hours) && isAbsent(runtime)) return refuse('nothing_to_grant')
  if (!isAbsent(hours) && !isPositiveNumber(hours)) {
    return refuse(`invalid_additional_gpu_hours: ${JSON.stringify(hours)}`)
  }
  if (!isAbsent(runtime) && !isPositiveNumber(runtime)) {
    return refuse(`invalid_additional_runtime_hours: ${JSON.stringify(runtime)}`)
  }
  return { ok: true }
}

function validateProposal(intent) {
  const refuse = (reason) => ({ ok: false, reason })
  if (!isId(intent.candidate_id)) return refuse(`invalid_candidate_id: ${JSON.stringify(intent.candidate_id ?? null)}`)
  if (typeof intent.hypothesis !== 'string' || intent.hypothesis.trim() === '') return refuse('missing_hypothesis')
  if (!isAbsent(intent.round) && !isPositiveInteger(intent.round)) return refuse(`invalid_round: ${JSON.stringify(intent.round)}`)
  if (!isAbsent(intent.requires_approval) && typeof intent.requires_approval !== 'boolean') {
    return refuse(`invalid_requires_approval: ${JSON.stringify(intent.requires_approval)}`)
  }
  if (!isAbsent(intent.deadline_ms) && !Number.isSafeInteger(intent.deadline_ms)) {
    return refuse(`invalid_deadline_ms: ${JSON.stringify(intent.deadline_ms)}`)
  }
  if (!isAbsent(intent.on_timeout) && !['apply', 'refuse'].includes(intent.on_timeout)) {
    return refuse(`invalid_on_timeout: ${JSON.stringify(intent.on_timeout)}`)
  }
  if (intent.requires_approval === true) {
    // The one shape that could park an unattended run on a human who never comes.
    if (isAbsent(intent.deadline_ms)) return refuse('hold_without_deadline')
  } else if (!isAbsent(intent.deadline_ms) || !isAbsent(intent.on_timeout)) {
    return refuse('deadline_without_hold')
  }
  return { ok: true }
}

// ---------------------------------------------------------------- writers

/**
 * Place one intent for the kernel to consume. This is the only write path a UI or a CLI needs, so
 * both produce the same file. It never overwrites: the first writer of an id wins, because an
 * intent already on disk is a fact someone is about to be judged on.
 *
 * @param {string} workspaceDir
 * @param {object} intent
 * @param {{ now?: number }} [options]
 */
export function placeIntent(workspaceDir, intent, { now = Date.now() } = {}) {
  const complain = validateIntent(intent)
  if (!complain.ok) throw new IntentRefused(complain.reason)

  const paths = ensureLayout(workspaceDir)
  const placed = { ...intent, placed_at_ms: intent.placed_at_ms ?? now }
  const path = join(paths.pending, `${placed.intent_id}.json`)
  try {
    writeFileSync(path, `${JSON.stringify(placed, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') return { status: 'exists', path, intent: placed }
    throw error
  }
  return { status: 'placed', path, intent: placed }
}

// ---------------------------------------------------------------- listing

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function describePending(workspaceDir, name, now) {
  const path = join(workspaceDir, 'pending', name)
  const intentId = name.slice(0, -'.json'.length)
  try {
    const intent = readJson(path)
    const held = isPlainObject(intent) && intent.kind === 'proposal' && intent.requires_approval === true
    return {
      intent_id: intentId,
      kind: typeof intent?.kind === 'string' ? intent.kind : 'unknown',
      held,
      deadline_ms: held ? intent.deadline_ms : undefined,
      on_timeout: held ? (intent.on_timeout ?? 'refuse') : undefined,
      expired: held && Number.isSafeInteger(intent.deadline_ms) ? now >= intent.deadline_ms : false,
      path,
      intent,
    }
  } catch (error) {
    return { intent_id: intentId, kind: 'unknown', malformed: error.message, path, intent: undefined }
  }
}

/** What is waiting, what was applied, what was refused — the operator's whole view of intents. */
export function listIntents(workspaceDir, { now = Date.now() } = {}) {
  const paths = intentPaths(workspaceDir)
  const names = (dir) => {
    try {
      return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    } catch {
      return []
    }
  }
  const read = (dir, name) => {
    try {
      return readJson(join(dir, name))
    } catch {
      return undefined
    }
  }
  return {
    pending: names(paths.pending).map((name) => describePending(workspaceDir, name, now)),
    applied: names(paths.applied).map((name) => {
      const record = read(paths.applied, name) ?? {}
      return {
        intent_id: record.intent_id ?? name.slice(0, -'.json'.length),
        kind: record.kind ?? 'unknown',
        at_ms: record.at_ms,
        decision_source: record.decision_source,
        fallback: record.fallback === true,
        event_seq: record.event_seq,
        path: join(paths.applied, name),
        intent: record.intent,
      }
    }),
    refused: names(paths.refused).map((name) => {
      const record = read(paths.refused, name) ?? {}
      return {
        intent_id: record.intent_id ?? name.slice(0, -'.json'.length),
        kind: record.kind ?? 'unknown',
        at_ms: record.at_ms,
        reason: record.reason ?? 'record unreadable',
        event_seq: record.event_seq,
        path: join(paths.refused, name),
        intent: record.intent,
      }
    }),
  }
}

// ---------------------------------------------------------------- receipts

const ledgerOf = (workspace) => (Array.isArray(workspace?.intents_applied) ? workspace.intents_applied : [])

function writeReceipt(path, record) {
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    // A receipt is written once. A second writer means a crash landed between receipt and unlink,
    // and the first receipt is the truth.
    if (error?.code !== 'EEXIST') throw error
  }
}

function receiptOf(paths, intentId) {
  for (const [outcome, dir] of [['applied', paths.applied], ['refused', paths.refused]]) {
    const path = join(dir, `${intentId}.json`)
    if (!existsSync(path)) continue
    try {
      return { outcome, path, record: readJson(path) }
    } catch {
      return { outcome, path, record: undefined }
    }
  }
  return undefined
}

// --------------------------------------------------------------- consuming

function emit(store, clock, eventType, payload) {
  return store.appendEvent({
    candidate_id: WORKSPACE_ACTOR,
    wall_clock_ms: clock.now(),
    event_type: eventType,
    payload,
  }).local_seq
}

/** Events are the dedupe ledger for *events*; the state ledger below is the dedupe for *effects*. */
function alreadyEmitted(store, eventType, intentId, reason) {
  return store
    .eventsFor(WORKSPACE_ACTOR)
    .some(
      (event) =>
        event.event_type === eventType &&
        event.payload?.intent_id === intentId &&
        (reason === undefined || event.payload?.reason === reason),
    )
}

/**
 * Consume every intent waiting in `pending/`. Called at the top of a tick, before the pause is
 * honoured, so a grant that removes the cause of an automatic pause clears it in that same tick.
 *
 * @param {{
 *   store: any, clock: { now: () => number }, config?: any, now: number,
 *   createCandidate?: (intent: object) => any,
 *   log?: (message: string, detail?: unknown) => void,
 * }} ports
 */
export function consumePending(ports) {
  const { store, clock, now, log } = ports
  const workspaceDir = dirname(store.path)
  const paths = ensureLayout(workspaceDir)
  const outcome = { applied: [], refused: [], held: [], duplicates: [] }
  const consumed = new Set()

  const entries = []
  for (const name of readdirSync(paths.pending).filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(paths.pending, name)
    const intentId = name.slice(0, -'.json'.length)
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      entries.push({ path, intentId, reason: `unreadable: ${error.message}` })
      continue
    }
    try {
      entries.push({ path, intentId, intent: JSON.parse(raw) })
    } catch (error) {
      entries.push({ path, intentId, reason: `invalid_json: ${error.message}`, raw })
    }
  }

  // Approvals first: an approval answers a held proposal, and that ordering must not depend on
  // which filename happens to sort first.
  const rank = (entry) => (entry.intent?.kind === 'approval' ? 0 : 1)
  entries.sort((left, right) => rank(left) - rank(right))

  const context = {
    ...ports,
    workspace: () => store.getState(undefined, 'workspace', {}) ?? {},
    paths,
    emit: (eventType, payload) => emit(store, clock, eventType, payload),
    remove: (path) => {
      try {
        unlinkSync(path)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    },
  }

  for (const entry of entries) {
    if (consumed.has(entry.intentId)) continue
    consumed.add(entry.intentId)

    const complaint = entry.reason !== undefined ? entry.reason : validateIntent(entry.intent, { expectedId: entry.intentId }).reason
    if (complaint !== undefined) {
      outcome.refused.push(refuse(context, entry, complaint))
      continue
    }

    const receipt = receiptOf(paths, entry.intentId)
    if (receipt !== undefined) {
      // The id was consumed before. Refuse the *placement*, never re-apply the intent, and keep
      // the original receipt untouched — it is the evidence of what actually happened.
      outcome.duplicates.push({ intentId: entry.intentId, outcome: receipt.outcome })
      if (!alreadyEmitted(store, 'intent_refused', entry.intentId, 'already_consumed')) {
        context.emit('intent_refused', {
          intent_id: entry.intentId,
          kind: entry.intent.kind,
          reason: 'already_consumed',
          existing_outcome: receipt.outcome,
          content_matches: JSON.stringify(receipt.record?.intent) === JSON.stringify(entry.intent),
        })
      }
      context.remove(entry.path)
      continue
    }

    if (recovered(entry.intent, context)) {
      // The effect is already visible but the receipt is not: a crash landed between them. Finish
      // the bookkeeping without touching the effect a second time.
      outcome.applied.push(record(context, entry, { decision_source: 'human', fallback: false, detail: { recovered: true } }))
      continue
    }

    const blocked = precondition(entry.intent, context)
    if (blocked !== undefined) {
      outcome.refused.push(refuse(context, entry, blocked))
      continue
    }

    const result = apply(entry.intent, context)
    if (result?.held === true) {
      outcome.held.push({ intentId: entry.intentId, kind: entry.intent.kind, deadline_ms: entry.intent.deadline_ms })
      continue
    }
    // An approval answers a held proposal, so it consumes that proposal's file too — but only once
    // the approval itself applies, so a refused approval leaves the proposal to its deadline.
    for (const alsoConsumed of result?.consumes ?? []) consumed.add(alsoConsumed)
    if (result?.refused !== undefined) {
      outcome.refused.push(
        refuse(context, entry, result.refused, {
          fallback: result.fallback === true,
          ...(result.detail ?? {}),
        }),
      )
      continue
    }
    outcome.applied.push(record(context, entry, result))
  }

  if (outcome.applied.length + outcome.refused.length > 0) {
    log?.(
      `intents: ${outcome.applied.length} applied, ${outcome.refused.length} refused, ${outcome.held.length} held`,
      outcome,
    )
  }
  return outcome
}

function refuse(context, entry, reason, extra = {}) {
  const { paths, store } = context
  const intentId = entry.intentId
  const receipt = {
    outcome: 'refused',
    intent_id: intentId,
    kind: entry.intent?.kind ?? 'unknown',
    reason,
    fallback: extra.fallback === true,
    decision_source: extra.decision_source ?? (extra.fallback === true ? 'timeout' : 'human'),
    ...extra,
    at_ms: context.now,
    intent: entry.intent,
    ...(entry.raw === undefined ? {} : { raw: entry.raw.slice(0, 2_000) }),
  }
  writeReceipt(join(paths.refused, `${intentId}.json`), receipt)
  if (!alreadyEmitted(store, 'intent_refused', intentId, reason)) {
    receipt.event_seq = context.emit('intent_refused', {
      intent_id: intentId,
      kind: receipt.kind,
      reason,
      fallback: receipt.fallback,
      decision_source: receipt.decision_source,
      ...extra,
    })
  }
  context.remove(entry.path)
  return { intentId, kind: receipt.kind, reason, fallback: receipt.fallback }
}

function record(context, entry, result) {
  const { paths } = context
  const intentId = entry.intentId
  const receipt = {
    outcome: 'applied',
    intent_id: intentId,
    kind: entry.intent.kind,
    decision_source: result.decision_source,
    fallback: result.fallback === true,
    ...result.detail,
    at_ms: context.now,
    intent: entry.intent,
  }
  writeReceipt(join(paths.applied, `${intentId}.json`), receipt)
  if (!alreadyEmitted(context.store, 'intent_applied', intentId)) {
    receipt.event_seq = context.emit('intent_applied', {
      intent_id: intentId,
      kind: receipt.kind,
      decision_source: receipt.decision_source,
      fallback: receipt.fallback,
      ...result.detail,
    })
  }
  context.remove(entry.path)
  return { intentId, kind: receipt.kind, decision_source: receipt.decision_source, fallback: receipt.fallback }
}

/**
 * Is this intent's effect already visible? Only reachable after a crash between effect and receipt,
 * because a completed consumption leaves a receipt and is caught earlier.
 */
function recovered(intent, context) {
  const ledger = ledgerOf(context.workspace())
  if (ledger.includes(intent.intent_id)) return true
  if (intent.kind === 'pause') return context.workspace().paused?.intent_id === intent.intent_id
  if (intent.kind === 'approval') {
    const receipt = receiptOf(context.paths, intent.target)
    return receipt?.record?.approval_intent_id === intent.intent_id
  }
  return false
}

/** World-dependent refusals: a well-shaped intent that this workspace cannot honour. */
function precondition(intent, context) {
  const { store, config, now } = context
  switch (intent.kind) {
    case 'grant': {
      const budget = budgetOf(context.workspace(), config)
      if (!isAbsent(intent.additional_gpu_hours) && !(budget.gpu_hours_limit > 0)) {
        return 'budget_unlimited: a GPU-hour grant changes nothing while the limit is 0 (unlimited)'
      }
      if (!isAbsent(intent.additional_runtime_hours) && !(budget.max_runtime_hours > 0)) {
        return 'runtime_unlimited: a wall-clock grant changes nothing while the limit is 0 (unlimited)'
      }
      return undefined
    }
    case 'anchor': {
      const state = store.getState(intent.candidate_id, 'phase')
      if (state === undefined) return `unknown_candidate: ${intent.candidate_id}`
      if (state.phase !== 'DONE') return `candidate_not_done: ${intent.candidate_id} is ${state.phase}`
      return undefined
    }
    case 'pause': {
      const paused = context.workspace().paused
      if (paused?.intent_id === intent.intent_id) return undefined
      if (paused) return `already_paused: ${paused.reason ?? 'paused'} (${paused.automatic === true ? 'automatic' : 'manual'})`
      return undefined
    }
    case 'resume': {
      return context.workspace().paused ? undefined : 'not_paused: nothing to resume'
    }
    case 'proposal': {
      return store.getState(intent.candidate_id, 'phase') === undefined
        ? undefined
        : `candidate_exists: ${intent.candidate_id}`
    }
    case 'approval': {
      // An approval answers a *held* proposal and nothing else. Approving something that needed no
      // approval is not a no-op an operator should be told succeeded: it is a misunderstanding of
      // what is pending, so it is refused instead of quietly applied.
      const target = heldProposalOf(intent.target, context)
      if (target === undefined) return `unknown_target: ${intent.target}`
      if (target.unreadable !== undefined) return `target_unreadable: ${intent.target} (${target.unreadable})`
      if (target.intent?.kind !== 'proposal' || target.intent.requires_approval !== true) {
        return `target_not_held: ${intent.target} is not waiting for approval`
      }
      if (Number.isSafeInteger(target.intent.deadline_ms) && now >= target.intent.deadline_ms) {
        // Past the deadline the predetermined answer already owns the decision; a late approval
        // must not overwrite it, or "fallback" would be a lie whenever someone answers late.
        return `target_expired: ${intent.target} passed its deadline at ${target.intent.deadline_ms}`
      }
      return undefined
    }
    case 'experience': {
      const promoted = Array.isArray(context.workspace().experiences) ? context.workspace().experiences : []
      if (promoted.some((entry) => entry?.experience_id === intent.experience_id)) {
        return `already_promoted: ${intent.experience_id}`
      }
      return undefined
    }
    default:
      return undefined
  }
}

function heldProposalOf(intentId, context) {
  const path = join(context.paths.pending, `${intentId}.json`)
  if (!existsSync(path)) return undefined
  try {
    return { path, intent: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { path, unreadable: error.message }
  }
}

function apply(intent, context) {
  const { store, clock, now } = context
  switch (intent.kind) {
    case 'grant':
      return applyGrant(intent, context)
    case 'pause': {
      const paused = pause(store, clock, {
        reason: intent.reason ?? 'operator_requested',
        automatic: false,
        intent_id: intent.intent_id,
      })
      applyLedger(context, intent.intent_id)
      return { decision_source: 'human', fallback: false, detail: { paused } }
    }
    case 'resume': {
      const resumed = resume(store, clock, { force: true })
      if (resumed.status !== 'resumed') return { refused: `not_paused: nothing to resume` }
      applyLedger(context, intent.intent_id)
      return { decision_source: 'human', fallback: false, detail: { was: resumed.was } }
    }
    case 'anchor': {
      applyWorkspace(intent, context, () => ({
        code_base_anchor: { candidate_id: intent.candidate_id, commit: intent.commit, intent_id: intent.intent_id },
      }))
      return {
        decision_source: 'human',
        fallback: false,
        detail: { candidate_id: intent.candidate_id, commit: intent.commit },
      }
    }
    case 'proposal': {
      if (intent.requires_approval !== true) {
        return { decision_source: 'human', fallback: false, detail: createCandidateFor(intent, context) }
      }
      // A hold is bounded by construction: shape validation refused any hold without a deadline.
      if (now < intent.deadline_ms) return { held: true }
      if ((intent.on_timeout ?? 'refuse') === 'refuse') {
        return {
          refused: `approval_timeout: no approval before ${new Date(intent.deadline_ms).toISOString()}`,
          fallback: true,
          detail: { deadline_ms: intent.deadline_ms },
        }
      }
      // The declared default, applied because nobody answered. Still a fallback, never an approval.
      return {
        decision_source: 'timeout',
        fallback: true,
        detail: { deadline_ms: intent.deadline_ms, ...createCandidateFor(intent, context) },
      }
    }
    case 'approval': {
      const target = heldProposalOf(intent.target, context)
      if (target === undefined) return { refused: `unknown_target: ${intent.target}` }
      const targetEntry = { path: target.path, intentId: intent.target, intent: target.intent }
      const detail = { target: intent.target, decision: intent.decision, approval_intent_id: intent.intent_id }
      if (intent.decision === 'approve') {
        record(context, targetEntry, {
          decision_source: 'human',
          fallback: false,
          detail: { approval_intent_id: intent.intent_id, ...createCandidateFor(target.intent, context) },
        })
      } else {
        refuse(context, targetEntry, 'refused_by_human', { approval_intent_id: intent.intent_id })
      }
      return { decision_source: 'human', fallback: false, detail, consumes: [intent.target] }
    }
    case 'experience':
      return applyExperience(intent, context)
    default:
      return { refused: `unknown_kind: ${intent.kind}` }
  }
}

/** The one place a proposal becomes a candidate; the phase machine stays in `loop.js`. */
function createCandidateFor(intent, context) {
  if (typeof context.createCandidate !== 'function') {
    throw new TypeError('consumePending needs a createCandidate port to apply a proposal')
  }
  const round = intent.round ?? 1
  const created = context.createCandidate({
    candidate_id: intent.candidate_id,
    hypothesis: intent.hypothesis,
    round,
  })
  return {
    candidate_id: intent.candidate_id,
    hypothesis: intent.hypothesis,
    round,
    created: created?.status ?? 'unknown',
  }
}

/**
 * A promoted experience is a durable artifact, not a line in a database: the injection packet reads
 * it as a file, and a file survives a wiped cache. The workspace state is only the index.
 */
function applyExperience(intent, context) {
  const section = intent.section ?? 'recipes'
  const artifact = {
    experience_id: intent.experience_id,
    section,
    text: intent.text,
    intent_id: intent.intent_id,
    promoted_at_ms: context.now,
  }
  try {
    mkdirSync(context.paths.experiences, { recursive: true })
    writeFileSync(join(context.paths.experiences, `${intent.experience_id}.json`), `${JSON.stringify(artifact, null, 2)}\n`)
  } catch (error) {
    // The artifact is the fact; if it cannot be written, nothing was promoted. Refuse instead of
    // recording a promotion the injection packet would never see.
    return { refused: `experience_write_failed: ${error.message}` }
  }

  applyWorkspace(intent, context, (workspace) => {
    const promoted = Array.isArray(workspace.experiences) ? workspace.experiences : []
    return { experiences: [...promoted.filter((entry) => entry.experience_id !== intent.experience_id), artifact] }
  })
  return { decision_source: 'human', fallback: false, detail: { experience_id: intent.experience_id, section } }
}

/**
 * A grant is the one effect that is pure arithmetic on the workspace budget, so the effect and its
 * ledger entry are a single state write: a crash between them cannot double the money.
 */
function applyGrant(intent, context) {
  const { store, config } = context
  const workspace = context.workspace()
  const effective = budgetOf(workspace, config)
  const workspaceBudget = { ...(workspace.budget ?? {}) }
  const detail = {}

  if (!isAbsent(intent.additional_gpu_hours)) {
    workspaceBudget.gpu_hours_limit = effective.gpu_hours_limit + intent.additional_gpu_hours
    detail.gpu_hours_limit = workspaceBudget.gpu_hours_limit
  }
  if (!isAbsent(intent.additional_runtime_hours)) {
    workspaceBudget.max_runtime_hours = effective.max_runtime_hours + intent.additional_runtime_hours
    detail.max_runtime_hours = workspaceBudget.max_runtime_hours
  }

  store.setState(undefined, 'workspace', {
    ...workspace,
    budget: workspaceBudget,
    intents_applied: [...ledgerOf(workspace), intent.intent_id],
  })
  return { decision_source: 'human', fallback: false, detail }
}

/** A single workspace write: the intent's effect and its ledger id land together. */
function applyWorkspace(intent, context, patch) {
  const workspace = context.workspace()
  context.store.setState(undefined, 'workspace', {
    ...workspace,
    ...patch(workspace),
    intents_applied: [...ledgerOf(workspace), intent.intent_id],
  })
}

function applyLedger(context, intentId) {
  const workspace = context.workspace()
  const ledger = ledgerOf(workspace)
  if (ledger.includes(intentId)) return
  context.store.setState(undefined, 'workspace', { ...workspace, intents_applied: [...ledger, intentId] })
}