/**
 * The workspace phases: INIT → BASELINE → ROUND_PLAN → FINALIZE.
 *
 * The candidate machine (loop.js) answers "what happens to this candidate next". This file answers
 * the other question: "should there be candidates at all, and what did the last batch of them
 * teach?" One tick advances the workspace by at most one step, exactly as for a candidate.
 *
 * Two of the four phases consult a model — ROUND_PLAN and ROUND_REFLECT — and both must hand back
 * an artifact the contract accepts before the phase moves. The other two call it *zero* times:
 * BASELINE dispatches a job and freezes what it measured (`baseline.js`), and deciding the round
 * budget is spent is a comparison against a number in the configuration. A run that is waiting three
 * days for training jobs must not wake a model four thousand times to be told so.
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
import { ANCHOR_MODES, anchorStep, readAnchor } from './anchor.js'
import { stepBaseline } from './baseline.js'
import { frontierOf, parentSnapshot, parentsOf } from './frontier.js'
import { ranking } from './ranking.js'
import { MODEL_UNAVAILABLE, isModelUnavailable, modelFailureOf, recordModelUnavailable } from './model-failure.js'
// The cycle with loop.js (loop → rounds → loop) is safe by construction: `createCandidate` is a
// hoisted function declaration, and it is only called while a tick is already running.
import { createCandidate } from './loop.js'
import { pause } from './budget.js'
import { recordStop } from './stop.js'
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
  /**
   * Who may move the code base. `automatic` applies the double-domination rule between rounds;
   * `human` files a proposal and waits for an `anchor` intent, because moving the tree every
   * candidate branches from is a policy a run may not be trusted with (ticket 23).
   */
  anchor: Object.freeze({ mode: 'automatic' }),
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
    // A config may spell it `rounds.anchor: "human"` or `rounds.anchor: { mode: "human" }`; both
    // mean the same thing and both are validated, so a typo pauses the run instead of quietly
    // behaving like the default.
    anchor_mode: typeof raw.anchor === 'string' ? raw.anchor : raw.anchor?.mode ?? ROUND_DEFAULTS.anchor.mode,
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
  if (!ANCHOR_MODES.includes(settings.anchor_mode)) {
    return `rounds.anchor must be one of ${ANCHOR_MODES.join(', ')} — got ${JSON.stringify(settings.anchor_mode)}`
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
function roundFacts(store, state, settings, frontierFacts) {
  return {
    round: state.round ?? 0,
    max_rounds: settings.max_rounds,
    candidates_per_round: settings.candidates_per_round,
    metric_contract: { ...settings.metric },
    baseline: state.baseline === undefined ? null : { metric: state.baseline.metric, value: state.baseline.value },
    // The non-dominated set and the parents chosen from it are computed in code and handed over
    // whole: a model that is asked "who should this round build on" answers with prose, and every
    // number in prose is a number nobody can trace to a fact. `null` means nobody computed it, which
    // is what a reflection over a legacy workspace sees.
    frontier: frontierFacts ?? null,
    // Where the trees come from: the code base anchor (ticket 23), or null for "the runner's own
    // base ref". The planner does not choose it — it is a fact it plans *on*.
    code_base: readAnchor(store) ?? null,
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
 * BASELINE: produce and freeze the evidence every candidate will be compared against.
 *
 * Four sources, in the order they are tried, and the order *is* the decision:
 *
 *   1. **A frozen baseline already in the workspace.** Read back, never re-measured: a second boot
 *      must not replace the denominator that earlier rounds were compared against.
 *   2. **A number the configuration states.** Frozen as what it is — `source: 'configured'` — so a
 *      reader can tell a typed-in denominator from a measured one.
 *   3. **The executor** (`baseline.js`): submit a job, wait, collect its windowed samples. This is
 *      how a run normally gets a denominator, and it is the same `submit → poll → collect` path a
 *      candidate takes.
 *   4. **The evidence file an older workspace carries** (`baseline.json`, through the port). Kept
 *      for a workspace whose baseline was measured before the loop could do it, and for a run with
 *      no executor port at all.
 *
 * If none of them answers, the workspace waits. It does not guess a baseline, and it does not ask a
 * model what the baseline probably was.
 */
async function freezeBaseline(context, state) {
  const { store, now, settings, baseline: port, platform } = context

  if (state.baseline !== undefined) {
    // Already a fact. Re-entering BASELINE (a rebuilt state row, a resumed old workspace) must not
    // turn into a second measurement.
    writeState(store, { ...state, phase: 'ROUND_PLAN', attempts: 0, next_action_at: 0 })
    return { action: `baseline already frozen (${state.baseline.metric}=${state.baseline.value}) -> round_plan`, phase: 'ROUND_PLAN', round: state.round }
  }

  if (settings.baseline !== undefined) {
    const evidence = evidenceFrom(settings.baseline, settings.metric.name)
    if (evidence !== undefined) return freeze(context, state, { ...evidence, source: 'configured' })
  }

  if (platform !== undefined && typeof platform.submit === 'function') {
    const result = await stepBaseline(context, state)
    if (result.status === 'frozen') return freeze(context, state, result.baseline)
    if (result.status === 'stopped') {
      // A workspace-level conclusion, recorded where every other stop is: the event explains it, the
      // state absorbs it, and the next tick reports it as already concluded instead of re-running a
      // baseline that cannot run.
      const recorded = recordStop({ store, clock: context.clock, log: context.log }, result.decision)
      return { action: result.action, phase: 'BASELINE', round: state.round, stopped: recorded }
    }
    if (result.next_action_at !== undefined) {
      writeState(store, { ...state, attempts: (state.attempts ?? 0) + 1, next_action_at: result.next_action_at })
    }
    return { action: result.action, phase: 'BASELINE', round: state.round }
  }

  // No executor and no configured number: the evidence file is the last source there is.
  const evidence = await baselineEvidence(settings, port)
  if (evidence === undefined) return { action: 'waiting_for_baseline', phase: 'BASELINE', round: state.round }
  return freeze(context, state, evidence)
}

/** Write the frozen baseline and move to ROUND_PLAN. One place, so the record has one shape. */
function freeze({ store, now }, state, evidence) {
  const frozen = {
    metric: evidence.metric,
    value: evidence.value,
    unit: evidence.unit,
    windows: evidence.windows,
    window_series: evidence.window_series,
    job_id: evidence.job_id,
    source: evidence.source,
    frozen_at_ms: now,
  }
  writeState(store, { ...state, phase: 'ROUND_PLAN', round: 0, baseline: frozen, attempts: 0, next_action_at: 0 })
  store.logOp('baseline_frozen', frozen, now)
  return { action: 'baseline frozen -> round_plan', phase: 'ROUND_PLAN', round: 0 }
}

/** A configured or file-borne baseline: a number and the metric it is a number *of*. */
function evidenceFrom(raw, metricName) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { metric: metricName, value: raw } : undefined
  if (raw === null || raw === undefined) return undefined
  const value = raw.value
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return { metric: isNonEmptyString(raw.metric) ? raw.metric : metricName, value }
}

async function baselineEvidence(settings, port) {
  let raw = settings.baseline
  if (typeof port?.read === 'function') {
    const read = await port.read()
    if (read !== undefined && read !== null) raw = read
  }
  const evidence = evidenceFrom(raw, settings.metric.name)
  return evidence === undefined ? undefined : { ...evidence, source: 'evidence' }
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

/**
 * The contract parent selection compares under.
 *
 * The run's metric contract when it declared one; otherwise the round workflow's own metric, which is
 * what that workflow optimises. An absent contract is not "rank nothing quietly": the ranking reports
 * `missing` and the roster falls back to the baseline, which is a decision a reader can see.
 */
function parentMetricConfig(config, metric) {
  if (config?.metrics !== undefined) return { metrics: config.metrics }
  // No contract and no frozen round metric: the ranking says `missing` and the roster is the
  // baseline. Naming a default metric here would be the kernel inventing what "better" means.
  if (typeof metric?.name !== 'string' || metric.name === '') return { metrics: undefined }
  return { metrics: { primary: metric.name, objectives: { [metric.name]: metric.direction === 'lower' ? 'down' : 'up' } } }
}

/** The frontier-relevant fork point: the highest event sequence any candidate had reached. */
function eventPrefixOf(store) {
  let last = 0
  for (const subject of store.eventSubjects()) last = Math.max(last, store.maxSeq(subject))
  return { last_local_seq: last }
}

/**
 * The parents this round starts from, and the snapshot that says so.
 *
 * Computed from facts alone: the ranking over every candidate, the non-dominated set over that, the
 * per-axis top-k rotation over that. The baseline is in the set by construction, so a workspace with
 * nothing comparable yet plans its first round from the baseline — the behaviour every existing
 * workspace already had, now as a decision instead of an omission.
 */
function parentRoster({ store }, state, round, settings, view) {
  const set = frontierOf(view, { baseline: state.baseline })
  const parents = parentsOf(set, { k: settings.candidates_per_round })
  const snapshot = parentSnapshot({ round, events_prefix: eventPrefixOf(store), set, parents })
  return {
    set,
    parents,
    snapshot,
    // What the planner is told: the set with its vectors, and the roster. Whole, unranked, untrimmed.
    facts: {
      members: set.members.map((member) => ({
        candidate_id: member.candidate_id,
        round: member.round ?? null,
        vector: { ...member.vector },
        baseline: member.baseline === true,
      })),
      parents: [...parents],
      empty: set.empty,
    },
  }
}

/** A frozen roster, reshaped for a prompt: the reflection sees the parents its round actually used. */
function frozenRoster(state) {
  const frozen = state.plan?.parent_snapshot?.content
  if (frozen === undefined) return undefined
  return { members: frozen.frontier, parents: frozen.parents, empty: frozen.empty }
}

async function planNextRound(context, state) {
  const { store, clock, now, settings, judge } = context
  const round = (state.round ?? 0) + 1
  if (round > settings.max_rounds) {
    writeState(store, { ...state, phase: 'FINALIZE', attempts: 0, next_action_at: 0 })
    store.logOp('rounds_finished', { rounds: state.round ?? 0, reason: 'round_budget' }, now)
    return { action: 'finalize', phase: 'FINALIZE', round: state.round ?? 0 }
  }

  // The ranking is computed once per plan, because two decisions read it: the code base anchor
  // (below) and the parent roster. Two derivations of the same numbers are two chances to disagree.
  const view = ranking(store, parentMetricConfig(context.config, state.metric), { persist: true })

  // The code base, before the roster: which *tree* the round's candidates branch from is settled
  // here, between rounds, and it is a strictly separate question from who their parent is. The
  // denominator this comparison reads is the frozen baseline and it is never written here — a roll
  // moves the tree, not the ruler (ticket 23).
  const roll = anchorStep(context, state, view, settings)

  // Who this round starts from is decided from the facts, before any model is asked. The plan then
  // proposes hypotheses *on* those parents; it does not get to pick its own base refs.
  const roster = parentRoster(context, state, round, settings, view)

  let artifact
  try {
    artifact = await judge.plan({ round, facts: roundFacts(store, state, settings, roster.facts) })
  } catch (error) {
    // No model answered: not a refused artifact. Refusing here would spend the round's retry budget
    // and then ask a human to fix a provider, and the plan would look like a bad hypothesis.
    if (isModelUnavailable(error)) return modelOut(context, state, 'round_plan', error)
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
  // Freeze who this round starts from. Content-addressed, so a crash and a re-plan land on the same
  // address, and any change in the facts lands on a different one — see `parentSnapshot`.
  const frozenParents = context.artifacts.write(`round-${round}/parents`, {
    address: roster.snapshot.address,
    content: roster.snapshot.content,
  })

  const stored = context.artifacts.write(`round-${round}/candidate_plan`, artifact)
  for (const [index, landing] of landings.entries()) {
    const frozen = context.artifacts.write(`round-${round}/land-${landing.candidateId}`, landing.artifact)
    const created = createCandidate({ store, clock }, { candidateId: landing.candidateId, round, hypothesis: landing.artifact.statement })
    // `createCandidate` records the hypothesis in the event but not in the phase state, and every
    // phase worker reads it from there (LAND briefs the implementer with it, VERIFY checks that the
    // candidate had one at all). Written from here so this ticket's edit to loop.js stays the phase
    // wiring only; a one-line fix in loop.js would make this redundant.
    const phase = store.getState(landing.candidateId, 'phase') ?? {}
    // Candidate i starts from parent i of the roster, wrapping when the round affords more candidates
    // than the frontier holds. Written where LAND reads it (`state.parent_id`), so the parent is a
    // fact of the candidate rather than something the plan text claimed.
    const parentId = roster.parents[index % roster.parents.length]
    store.setState(landing.candidateId, 'phase', { ...phase, hypothesis: landing.artifact.statement, parent_id: parentId })
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
    plan: {
      round,
      path: stored.path,
      sha256: stored.sha256,
      at_ms: now,
      // The address is the identity of the decision; the path is where the bytes live. Both are kept
      // so "this round started from whom" is answerable from the fact plane alone.
      parent_snapshot: { address: roster.snapshot.address, path: frozenParents.path, sha256: frozenParents.sha256 },
    },
    reflection: undefined,
    attempts: 0,
    next_action_at: 0,
  })
  store.logOp(
    'round_plan_accepted',
    {
      round,
      hypotheses: artifact.hypotheses.length,
      candidates: landings.map((landing) => landing.candidateId),
      artifact: stored.path,
      parents: roster.parents,
      parent_snapshot: roster.snapshot.address,
      // Recorded beside the parents because a reader asking "where did this round's candidates
      // start from" needs both answers: the parent is whom they build on, the code base is the tree.
      code_base: readAnchor(store) ?? null,
      code_base_decision: roll.decision.reason,
    },
    now,
  )
  return { action: `planned round ${round}`, phase: 'ROUND_PLAN', round }
}

async function reflectRound(context, state) {
  const { store, now, settings, judge } = context
  const round = state.plan.round

  let artifact
  try {
    artifact = await judge.reflect({ round, facts: roundFacts(store, state, settings, frozenRoster(state)), now })
  } catch (error) {
    if (isModelUnavailable(error)) return modelOut(context, state, 'round_reflect', error)
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
 * No model answered at a workspace phase: record one operator fact, back off, change no artifact.
 *
 * The workspace keeps its `attempts` (refused artifacts) untouched on purpose — an outage is not a
 * malformed answer, and spending the retry budget on one would end with a pause that tells a human to
 * go fix a provider they cannot reach from here.
 */
function modelOut(context, state, step, failure) {
  const { store, now, log } = context
  const outcome = recordModelUnavailable({
    store,
    now,
    step,
    subject: `round-${Math.max(1, state.plan?.round ?? (state.round ?? 0) + 1)}`,
    failure: modelFailureOf(failure),
    attempts: state.model_attempts ?? 0,
  })
  writeState(store, { ...state, model_attempts: outcome.attempts, next_action_at: outcome.next_action_at })
  log?.(`workspace: no model answered at ${step} (${outcome.cause ?? 'unknown cause'}) — retrying in ${outcome.next_action_at - now} ms`)
  return {
    action: MODEL_UNAVAILABLE,
    phase: state.phase,
    round: state.round,
    cause: outcome.cause,
    message: outcome.message,
    attempts: outcome.attempts,
    next_action_at: outcome.next_action_at,
  }
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