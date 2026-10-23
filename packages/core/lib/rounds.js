/**
 * The workspace phases: INIT → BASELINE → ROUND_PLAN → FINALIZE.
 *
 * The candidate machine (loop.js) answers "what happens to this candidate next". This file answers
 * the other question: "should there be candidates at all, and what did the last batch of them
 * teach?" One tick advances the workspace by at most one step, exactly as for a candidate.
 *
 * Two of the four phases consult a model — ROUND_PLAN and ROUND_REFLECT — and both must hand back
 * an artifact the contract accepts before the phase moves. The other two call it *zero* times:
 * freezing a baseline the run already produced is arithmetic, and deciding the round budget is spent
 * is a comparison against a number in the configuration. A run that is waiting three days for
 * training jobs must not wake a model four thousand times to be told so.
 *
 * Where the state lives: one workspace KV row (`rounds`), not the `workspace` row. The `workspace`
 * row is where pausing and the start time live, and two features writing the same JSON object is how
 * a field silently disappears.
 *
 * @module
 */

import { dirname, join } from 'node:path'

import { isBlocking, isNonEmptyString, isTerminal, validateArtifact } from '@dsh-reprise/contract'

import { fileArtifacts, memoryArtifacts } from './artifacts.js'
// The cycle with loop.js (loop → rounds → loop) is safe by construction: `createCandidate` is a
// hoisted function declaration, and it is only called while a tick is already running.
import { createCandidate } from './loop.js'
import { pause } from './budget.js'
// Registers `round_reflect` / `land_hypothesis` even when the judge is a test double.
import './artifact-kinds.js'

/** The KV key this workflow owns. */
export const ROUNDS_KEY = 'rounds'

/** The workspace phases, in the order they are visited. */
export const WORKSPACE_FLOW = Object.freeze(['INIT', 'BASELINE', 'ROUND_PLAN', 'FINALIZE'])

export const ROUND_DEFAULTS = Object.freeze({
  /** The open-source default: a short run that reaches a conclusion, not a cluster marathon. */
  max_rounds: 3,
  candidates_per_round: 2,
  /** A refused artifact is retried on a backoff, then stopped for a human — never retried forever. */
  retry: Object.freeze({ base_ms: 60_000, max_ms: 3_600_000, max_attempts: 3 }),
})

/** @param {any} store */
export const readRoundsState = (store) => store.getState(undefined, ROUNDS_KEY)

/** The workspace phase, or undefined when this workspace runs no round workflow. */
export const workspacePhase = (store) => readRoundsState(store)?.phase

const writeState = (store, state) => store.setState(undefined, ROUNDS_KEY, state)

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Normalise the round settings out of config. Everything here is read once, at INIT, and then frozen
 * into the workspace state: a knob that looks hot-tunable but is silently read from config every tick
 * is how the predecessor ended up with fields whose comments promised something the code never did.
 */
export function roundSettings(config) {
  const raw = config?.rounds ?? {}
  const metric = raw.metric ?? {}
  const retry = raw.retry ?? {}
  const settings = {
    metric: Object.freeze({
      name: metric.name,
      direction: metric.direction ?? 'higher',
      contract_ref: metric.contract_ref ?? metric.name,
    }),
    max_rounds: raw.max_rounds ?? ROUND_DEFAULTS.max_rounds,
    candidates_per_round: raw.candidates_per_round ?? ROUND_DEFAULTS.candidates_per_round,
    retry: Object.freeze({ ...ROUND_DEFAULTS.retry, ...retry }),
    baseline: raw.baseline,
  }
  return { settings, problem: settingsProblem(settings) }
}

function settingsProblem(settings) {
  if (!isNonEmptyString(settings.metric.name)) return 'rounds.metric.name must name the metric this run optimises'
  if (settings.metric.direction !== 'higher' && settings.metric.direction !== 'lower') {
    return 'rounds.metric.direction must be "higher" or "lower"'
  }
  if (!Number.isSafeInteger(settings.max_rounds) || settings.max_rounds <= 0) return 'rounds.max_rounds must be a positive integer'
  if (!Number.isSafeInteger(settings.candidates_per_round) || settings.candidates_per_round <= 0) {
    return 'rounds.candidates_per_round must be a positive integer'
  }
  return undefined
}

const artifactsFor = (ports) => {
  if (ports.artifacts !== undefined) return ports.artifacts
  const path = ports.store?.path
  // The workspace directory is the one holding the fact plane: one directory, everything the
  // workspace owns, so a run can be copied or wiped as a unit.
  if (typeof path === 'string' && path !== '') return fileArtifacts(join(dirname(path), 'artifacts'))
  return memoryArtifacts()
}

const candidateIdFor = (round, hypothesisId) => `r${round}-${hypothesisId}`

/** The candidates this round created — a hand-made candidate from elsewhere is not this round's. */
const candidateIdsOfRound = (store, round) =>
  store.candidateIds().filter((candidateId) => store.getState(candidateId, 'phase')?.round === round)

/**
 * What the model is allowed to reason from: frozen evidence, in one object.
 *
 * Deliberately no recommendation, no previous plan and no model output of its own beyond the last
 * reflection — a model re-reading its own past prose converges on it.
 */
function roundFacts(store, state, settings) {
  return {
    round: state.round ?? 0,
    max_rounds: settings.max_rounds,
    candidates_per_round: settings.candidates_per_round,
    metric_contract: { ...settings.metric },
    baseline: state.baseline === undefined ? null : { metric: state.baseline.metric, value: state.baseline.value },
    candidates: candidateOutcomes(store),
    previous_reflection: state.last_reflection ?? null,
  }
}

function candidateOutcomes(store) {
  return store.candidateIds().map((candidateId) => {
    const phase = store.getState(candidateId, 'phase') ?? {}
    const events = store.eventsFor(candidateId)
    const analysed = [...events].reverse().find((event) => event.event_type === 'cand_analyze')
    const rejected = [...events].reverse().find((event) => event.event_type === 'candidate_rejected')
    return {
      candidate_id: candidateId,
      round: phase.round ?? null,
      hypothesis: phase.hypothesis ?? null,
      phase: phase.phase ?? null,
      verdict: analysed?.payload?.verdict ?? null,
      root_cause: analysed?.payload?.root_cause ?? null,
      rejected_at_phase: rejected?.payload?.phase ?? null,
      reject_reason: rejected?.payload?.reject_reason ?? null,
    }
  })
}

// ------------------------------------------------------------------ step

/**
 * Advance the workspace by at most one step.
 *
 * Returns `{action, phase, ...}`. `action: 'skipped'` means this workspace has no round workflow —
 * the caller pushes nothing into the tick's action list, so a candidate-only workspace behaves
 * exactly as it did before this module existed.
 *
 * @param {{
 *   store: any, clock: { now: () => number }, judge?: any, config?: any,
 *   artifacts?: any, baseline?: { read: () => unknown }, log?: (message: string, detail?: unknown) => void,
 * }} ports
 */
export async function stepWorkspace(ports) {
  const { store, clock, config, judge, log } = ports
  const raw = config?.rounds
  if (raw === undefined || raw === null || raw === false || raw.enabled === false) {
    return { action: 'skipped', phase: undefined }
  }
  if (judge === undefined) {
    throw new TypeError(
      'the round workflow needs a judge port: ROUND_PLAN and ROUND_REFLECT are model entries, and nothing else may answer for them',
    )
  }

  const now = clock.now()
  const { settings, problem } = roundSettings(config)

  let state = readRoundsState(store)
  if (state === undefined) {
    state = { phase: 'INIT', round: 0, attempts: 0, next_action_at: 0, started_at_ms: now }
    writeState(store, state)
  }

  // A configuration the run cannot honour is not retried: repeating it would spend GPU hours against
  // a metric nobody named. It pauses, and only a human can answer what "better" means here.
  if (problem !== undefined) {
    store.logOp('round_config_invalid', { problem }, now)
    pause(store, clock, { reason: 'round_config_invalid', automatic: false, message: problem })
    log?.(`workspace: round configuration is unusable — ${problem}`)
    return { action: 'config_invalid', phase: state.phase, round: state.round, message: problem }
  }

  // A finished workspace is inert: no retries, no model calls, nothing to heal on restart.
  if (state.phase === 'FINALIZE' && state.finalized_at_ms !== undefined) {
    return { action: 'finalized', phase: 'FINALIZE', round: state.round }
  }
  if ((state.next_action_at ?? 0) > now) {
    return { action: 'waiting', phase: state.phase, round: state.round, next_action_at: state.next_action_at }
  }

  // The metric contract is frozen at INIT and read from the state afterwards: a config edit that
  // redefined "better" mid-run would make two rounds incomparable and quietly turn the frozen
  // baseline into a number about something else. The round budget and the retry backoff are read
  // from config every tick on purpose — raising the budget continues a run, and this is the
  // documented difference the predecessor got wrong by claiming hot-tuning it did not have.
  const effective = state.metric === undefined ? settings : Object.freeze({ ...settings, metric: state.metric })
  const context = { ...ports, settings: effective, now, artifacts: artifactsFor(ports) }

  switch (state.phase) {
    case 'INIT':
      return advanceFromInit(context, state)
    case 'BASELINE':
      return freezeBaseline(context, state)
    case 'ROUND_PLAN':
      return roundPlanStep(context, state)
    case 'FINALIZE':
      return finalizeStep(context, state)
    default:
      return { action: `unknown workspace phase ${JSON.stringify(state.phase)}`, phase: state.phase, round: state.round }
  }
}

// ----------------------------------------------------------------- phases

/** INIT: adopt the configuration and freeze it. No model, no evidence, no judgement. */
function advanceFromInit({ store, now, settings }, state) {
  writeState(store, {
    ...state,
    phase: 'BASELINE',
    metric: { ...settings.metric },
    attempts: 0,
    next_action_at: 0,
  })
  store.logOp(
    'rounds_initialised',
    { metric: settings.metric, max_rounds: settings.max_rounds, candidates_per_round: settings.candidates_per_round },
    now,
  )
  return { action: 'init -> baseline', phase: 'BASELINE', round: state.round }
}

/**
 * BASELINE: freeze the evidence every candidate will be compared against.
 *
 * It arrives through a port (the baseline run finished somewhere else) or from configuration; either
 * way it is copied into the workspace state once, and ROUND_PLAN only ever reads it from there. If it
 * has not arrived, the workspace waits — it does not guess a baseline, and it does not ask a model
 * what the baseline probably was.
 */
async function freezeBaseline({ store, now, settings, baseline: port }, state) {
  const evidence = await baselineEvidence(settings, port)
  if (evidence === undefined) return { action: 'waiting_for_baseline', phase: 'BASELINE', round: state.round }

  const frozen = { metric: evidence.metric, value: evidence.value, frozen_at_ms: now }
  writeState(store, { ...state, phase: 'ROUND_PLAN', round: 0, baseline: frozen, attempts: 0, next_action_at: 0 })
  store.logOp('baseline_frozen', frozen, now)
  return { action: 'baseline frozen -> round_plan', phase: 'ROUND_PLAN', round: 0 }
}

async function baselineEvidence(settings, port) {
  let raw = settings.baseline
  if (typeof port?.read === 'function') {
    const read = await port.read()
    if (read !== undefined && read !== null) raw = read
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? { metric: settings.metric.name, value: raw } : undefined
  if (raw === null || raw === undefined) return undefined
  const value = raw.value
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return { metric: isNonEmptyString(raw.metric) ? raw.metric : settings.metric.name, value }
}

/**
 * ROUND_PLAN: the round in progress, or the next round to plan.
 *
 * One step per tick, in a fixed order: plan → run → reflect → close → plan again. Every transition
 * that consumes a model answer passes through `validateArtifact` first, and a refusal leaves the
 * phase exactly where it was.
 */
async function roundPlanStep(context, state) {
  const { store, now, settings } = context
  if (state.plan === undefined) return planNextRound(context, state)

  const round = state.plan.round
  const pending = candidateIdsOfRound(store, round).filter((candidateId) => {
    const phase = store.getState(candidateId, 'phase')?.phase
    return phase === undefined || !isTerminal(phase)
  })
  if (pending.length > 0) {
    return {
      action: `waiting for round ${round} (${pending.length} candidate${pending.length === 1 ? '' : 's'} still running)`,
      phase: 'ROUND_PLAN',
      round,
    }
  }

  if (state.reflection === undefined || state.reflection.round !== round) return reflectRound(context, state)

  if (round >= settings.max_rounds) {
    // The round budget is a number in the configuration. Nothing the model said enters this test.
    writeState(store, { ...state, phase: 'FINALIZE', attempts: 0, next_action_at: 0 })
    store.logOp('rounds_finished', { rounds: round, reason: 'round_budget' }, now)
    return { action: 'finalize', phase: 'FINALIZE', round }
  }

  writeState(store, { ...state, plan: undefined, reflection: undefined, attempts: 0, next_action_at: 0 })
  store.logOp('round_closed', { round }, now)
  return { action: `round ${round} closed`, phase: 'ROUND_PLAN', round }
}

async function planNextRound(context, state) {
  const { store, clock, now, settings, judge } = context
  const round = (state.round ?? 0) + 1
  if (round > settings.max_rounds) {
    writeState(store, { ...state, phase: 'FINALIZE', attempts: 0, next_action_at: 0 })
    store.logOp('rounds_finished', { rounds: state.round ?? 0, reason: 'round_budget' }, now)
    return { action: 'finalize', phase: 'FINALIZE', round: state.round ?? 0 }
  }

  let artifact
  try {
    artifact = await judge.plan({ round, facts: roundFacts(store, state, settings) })
  } catch (error) {
    return refuse(context, state, { step: 'round_plan', status: 'invalid', message: `the round plan could not be produced: ${messageOf(error)}` })
  }

  const verdict = validateArtifact('candidate_plan', artifact)
  if (isBlocking(verdict)) return refuse(context, state, { step: 'round_plan', status: verdict.status, message: verdict.message })

  // A plan is an offer to spend money. The round told the model how many candidates it affords;
  // a plan that ignores that is refused rather than quietly truncated, because a dropped hypothesis
  // is an idea nobody can see was dropped.
  if (artifact.hypotheses.length > settings.candidates_per_round) {
    return refuse(context, state, {
      step: 'round_plan',
      status: 'invalid',
      message: `the plan names ${artifact.hypotheses.length} hypotheses but this round affords ${settings.candidates_per_round} (candidates_per_round)`,
    })
  }

  // The LAND entry freezes each hypothesis and briefs the implementer before any worktree is touched.
  const landings = []
  for (const hypothesis of artifact.hypotheses) {
    const candidateId = candidateIdFor(round, hypothesis.id)
    let landing
    try {
      landing = await judge.land({ candidateId, round, hypothesis, now })
    } catch (error) {
      return refuse(context, state, {
        step: 'land',
        status: 'invalid',
        message: `the hypothesis could not be frozen for ${candidateId}: ${messageOf(error)}`,
      })
    }
    const landVerdict = validateArtifact('land_hypothesis', landing.artifact)
    if (isBlocking(landVerdict)) {
      return refuse(context, state, { step: 'land', status: landVerdict.status, message: `${candidateId}: ${landVerdict.message}` })
    }
    landings.push({ candidateId, ...landing })
  }

  // Facts first: the plan is on disk before a candidate exists, so a crash cannot leave candidates
  // whose round has no recorded plan. Re-planning after such a crash re-creates the same candidate
  // ids, and `createCandidate` treats that as `exists`.
  const stored = context.artifacts.write(`round-${round}/candidate_plan`, artifact)
  for (const landing of landings) {
    const frozen = context.artifacts.write(`round-${round}/land-${landing.candidateId}`, landing.artifact)
    const created = createCandidate({ store, clock }, { candidateId: landing.candidateId, round, hypothesis: landing.artifact.statement })
    // `createCandidate` records the hypothesis in the event but not in the phase state, and every
    // phase worker reads it from there (LAND briefs the implementer with it, VERIFY checks that the
    // candidate had one at all). Written from here so this ticket's edit to loop.js stays the phase
    // wiring only; a one-line fix in loop.js would make this redundant.
    const phase = store.getState(landing.candidateId, 'phase') ?? {}
    store.setState(landing.candidateId, 'phase', { ...phase, hypothesis: landing.artifact.statement })
    store.setState(landing.candidateId, 'land', {
      artifact: landing.artifact,
      prompt: landing.prompt,
      path: frozen.path,
      sha256: frozen.sha256,
      created: created.status,
    })
  }

  writeState(store, {
    ...state,
    round,
    plan: { round, path: stored.path, sha256: stored.sha256, at_ms: now },
    reflection: undefined,
    attempts: 0,
    next_action_at: 0,
  })
  store.logOp(
    'round_plan_accepted',
    { round, hypotheses: artifact.hypotheses.length, candidates: landings.map((landing) => landing.candidateId), artifact: stored.path },
    now,
  )
  return { action: `planned round ${round}`, phase: 'ROUND_PLAN', round }
}

async function reflectRound(context, state) {
  const { store, now, settings, judge } = context
  const round = state.plan.round

  let artifact
  try {
    artifact = await judge.reflect({ round, facts: roundFacts(store, state, settings), now })
  } catch (error) {
    return refuse(context, state, { step: 'round_reflect', status: 'invalid', message: `the reflection could not be produced: ${messageOf(error)}` })
  }

  const verdict = validateArtifact('round_reflect', artifact)
  if (isBlocking(verdict)) return refuse(context, state, { step: 'round_reflect', status: verdict.status, message: verdict.message })

  const stored = context.artifacts.write(`round-${round}/round_reflect`, artifact)
  writeState(store, {
    ...state,
    reflection: { round, path: stored.path, sha256: stored.sha256, at_ms: now },
    last_reflection: {
      round,
      summary: artifact.summary,
      lessons: artifact.lessons,
      next_round_focus: artifact.next_round_focus,
    },
    attempts: 0,
    next_action_at: 0,
  })
  store.logOp('round_reflect_accepted', { round, lessons: artifact.lessons.length, artifact: stored.path }, now)
  return { action: `reflected round ${round}`, phase: 'ROUND_PLAN', round }
}

/** FINALIZE: record that the run is over. The stop *decision* belongs to the stop policy, not here. */
function finalizeStep({ store, now }, state) {
  writeState(store, { ...state, finalized_at_ms: now })
  store.logOp('workspace_finalized', { rounds: state.round }, now)
  return { action: 'finalized', phase: 'FINALIZE', round: state.round }
}

/**
 * A refused artifact: record it, back off, and after the retry budget is spent, stop for a human.
 *
 * Backoff rather than a pause on the first refusal, because a model returning a malformed artifact
 * once is a hiccup; a model returning one repeatedly is a broken prompt, and a broken prompt needs a
 * person — not a loop that quietly retries until the budget is gone.
 */
function refuse(context, state, { step, status, message }) {
  const { store, now, settings, log } = context
  const attempts = (state.attempts ?? 0) + 1
  const delay = Math.min(settings.retry.base_ms * 2 ** (attempts - 1), settings.retry.max_ms)

  store.logOp('round_artifact_refused', { phase: state.phase, step, status, message, attempts }, now)
  writeState(store, {
    ...state,
    attempts,
    next_action_at: now + delay,
    last_refusal: { phase: state.phase, step, status, message, at_ms: now },
  })
  log?.(`workspace: ${step} refused (${status}) — ${message}`)

  if (attempts >= settings.retry.max_attempts) {
    pause(store, context.clock, {
      reason: 'round_artifact_refused',
      automatic: false,
      phase: state.phase,
      step,
      status,
      message,
      attempts,
    })
  }
  return { action: `refused:${status}`, phase: state.phase, round: state.round, message, attempts, next_action_at: now + delay }
}