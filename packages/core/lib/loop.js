/**
 * The deterministic loop. Code owns the driver; the model is never consulted here.
 *
 * One tick advances at most one step per candidate. Everything the kernel cannot compute itself
 * arrives through a port — clock, platform, harness, judge — so the entire phase machine is
 * reproducible in a test without a host, a cluster, or a model.
 *
 * Facts are written before state, always: the event lands first, then the phase advances and
 * records the sequence it folded (`applied_seq`). A crash between the two leaves a *detectable*
 * lag rather than a silent divergence, and `reconcile` folds it back.
 *
 * @module
 */

import { isBlocking, isTerminal, validateArtifact, validateCandidate } from '@dsh-reprise/contract'

import { judgeTimeout } from '@dsh-reprise/exec'

import { autoResumeIfClear, budgetOf, canDispatch, evaluate, pause } from './budget.js'
import { consumePending } from './intents.js'
import { stepWorkspace } from './rounds.js'
import { evaluateStop } from './stop.js'

export const DEFAULTS = Object.freeze({
  poll: { base_ms: 1_000, max_ms: 60_000, grace_attempts: 2 },
})

const pollConfig = (config) => ({ ...DEFAULTS.poll, ...(config?.poll ?? {}) })

const numberOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

// ---------------------------------------------------------------- facts

/**
 * Append one event and return its sequence number. Identity is the pair, so the store assigns it.
 * @returns {{seq: number, status: string}}
 */
function emit(store, clock, candidateId, eventType, payload) {
  const result = store.appendEvent({
    candidate_id: candidateId,
    wall_clock_ms: clock.now(),
    event_type: eventType,
    payload,
  })
  return { seq: result.local_seq, status: result.status }
}

/**
 * Advance the phase *after* the event that justifies it is on disk.
 * @param {number} seq the event this transition folded
 */
function advance(store, candidateId, phase, patch, seq) {
  const previous = store.getState(candidateId, 'phase', {}) ?? {}
  store.setState(candidateId, 'phase', {
    ...previous,
    ...patch,
    phase,
    next_action_at: patch.next_action_at ?? 0,
  })
  if (seq !== undefined) store.setAppliedSeq(candidateId, seq)
}

/** Emit, then advance — with a crash point in between so the window is testable. */
function transition(ports, candidateId, eventType, payload, phase, patch) {
  const { store, clock, crashAt } = ports
  const { seq } = emit(store, clock, candidateId, eventType, payload)
  crashAt?.('after_event')
  advance(store, candidateId, phase, patch ?? {}, seq)
}

/** Seed a candidate at LAND. Used by the loop, the tests and later by the workspace phase. */
export function createCandidate({ store, clock }, { candidateId, round = 1, hypothesis }) {
  if (store.getState(candidateId, 'phase') !== undefined) return { status: 'exists' }
  const { seq } = emit(store, clock, candidateId, 'candidate_created', { round, hypothesis })
  advance(store, candidateId, 'LAND', { round, hypothesis }, seq)
  return { status: 'created', seq }
}

/**
 * Stop a candidate. `verdict.status` is present only when the *contract* refused the artifact;
 * a candidate that legitimately failed its checks is rejected with no four-state status at all,
 * because "your verify did not pass" and "your verify is malformed" are different events and
 * merging them would undo the distinction the whole contract exists for.
 */
function reject(ports, candidateId, phase, verdict, extra = {}) {
  const payload = {
    phase,
    blocking_message: verdict.message,
    reject_reason: verdict.message,
    ...extra,
  }
  if (verdict.status !== undefined) payload.status = verdict.status
  transition(
    ports,
    candidateId,
    'candidate_rejected',
    payload,
    'REJECTED',
    { reject_reason: verdict.message, rejected_at_phase: phase },
  )
  return { candidateId, phase, action: `rejected:${verdict.status}`, message: verdict.message }
}

// ------------------------------------------------------------- workspace

/**
 * The workspace record, seeded on first sight. The start time is recorded once because wall-clock
 * pacing is measured from it — and it is *not* seeded with a budget: a budget in the workspace
 * would silently override the one in config, which is exactly the "knobs look hot-tunable but are
 * frozen at init" trap the predecessor fell into.
 */
function workspaceState(store, clock, config) {
  const existing = store.getState(undefined, 'workspace')
  if (existing === undefined || existing.started_at_ms === undefined) {
    const seeded = { paused: null, ...(existing ?? {}), started_at_ms: existing?.started_at_ms ?? clock.now() }

    // Record what the run was configured with, once, as a fact. Without this the metric contract
    // and the stop rules exist only inside the tick call, so `dump` and the dashboard cannot say
    // how a still-running run is being judged — they would have to be told again on the command
    // line, and two readers with two different flags would disagree about the same workspace.
    // `executor` is here for the same reason: the dashboard must be able to say whether this run is
    // spending real GPU hours and whether anything caps them (see `warnings.js`), and asking the
    // *current* configuration instead of the frozen one would answer about a different run.
    for (const key of ['metrics', 'stop', 'budget', 'injection', 'executor']) {
      if (config?.[key] !== undefined && seeded[key] === undefined) seeded[key] = config[key]
    }

    store.setState(undefined, 'workspace', seeded)
    return seeded
  }
  return existing
}

/*
 * Pausing, resuming and the limit arithmetic all live in budget.js. The kernel asks one question —
 * may we dispatch? — and honours one answer.
 */

// ----------------------------------------------------------------- tick

/**
 * @param {{
 *   store: Store,
 *   clock: { now: () => number },
 *   platform: any,
 *   harness: any,
 *   judge: any,
 *   config?: any,
 *   log?: (message: string, detail?: unknown) => void,
 *   crashAt?: (point: string) => void,
 * }} ports
 */
export async function tick(ports) {
  const { store, clock, config, log } = ports
  const now = clock.now()

  // Human intents are files, and the tick is where they become facts. Consumed *before* the pause
  // is honoured on purpose: a grant raises the limit that caused an automatic pause, so that pause
  // clears in this same tick instead of needing a restart.
  consumePending({
    ...ports,
    now,
    createCandidate: ({ candidate_id: candidateId, hypothesis, round }) =>
      createCandidate(ports, { candidateId, hypothesis, round }),
  })

  // An automatic pause clears itself the moment its cause is gone; a manual one never does.
  autoResumeIfClear(store, clock, config, now)
  const workspace = workspaceState(store, clock, config)

  if (workspace.paused) {
    log?.(`paused: ${workspace.paused.reason}`)
    return { actions: [], paused: workspace.paused }
  }

  const decision = evaluate(store, workspace, config, now)
  if (decision.verdict === 'hard' || decision.verdict === 'runtime') {
    // Spending the budget, or the wall clock, pauses. It never finalises: "we ran out of money"
    // is not "the experiment is over", and collapsing the two makes a run unexplainable later.
    const paused = pause(store, clock, {
      reason: decision.verdict === 'hard' ? 'budget_exhausted' : 'runtime_exhausted',
      automatic: true,
      used_gpu_hours: decision.usedGpuHours,
      gpu_hours_limit: decision.gpuLimitHours,
      elapsed_hours: decision.elapsedHours,
      max_runtime_hours: decision.runtimeLimitHours,
    })
    log?.(`HARD LIMIT: pause (${decision.verdict}) at ${decision.usedGpuHours}/${decision.gpuLimitHours} GPU hours`)
    return { actions: [{ action: 'paused', reason: paused.reason, decision }], paused }
  }

  // Workspace-level verdict, before any candidate moves: a stop rule is a conclusion about the whole
  // run, and stepping a candidate after reaching it would be work the conclusion then discards.
  // Evaluating it here — once per tick, above the candidate loop — is what keeps the decision in code
  // instead of spread across nine phase branches.
  const stopped = evaluateStop(ports)
  if (stopped.stopped) {
    if (stopped.already !== true) log?.(`finalize: ${stopped.rule}`)
    return {
      actions: stopped.already === true ? [] : [{ action: 'finalize', rule: stopped.rule, message: stopped.message }],
      paused: null,
      stopped,
    }
  }

  const actions = []

  // Workspace phases (INIT → BASELINE → ROUND_PLAN → FINALIZE): one step per tick, and `skipped`
  // when this workspace runs no round workflow, so a candidate-only workspace is unchanged.
  const workspaceStep = await stepWorkspace(ports)
  if (workspaceStep.action !== 'skipped') actions.push(workspaceStep)

  for (const candidateId of store.candidateIds()) {
    const state = store.getState(candidateId, 'phase')
    if (state === undefined || isTerminal(state.phase)) continue
    if ((state.next_action_at ?? 0) > now) continue
    actions.push(await stepFor({ ...ports, now, workspace }, candidateId, state))
  }
  return { actions, paused: null, stopped }
}

async function stepFor(ports, candidateId, state) {
  const { store, clock, config, crashAt, log } = ports
  const now = clock.now()

  const verdict = validateCandidate({
    state,
    bindings: store.bindings(candidateId),
    job: store.jobFor(candidateId),
  })
  if (isBlocking(verdict)) {
    log?.(`${candidateId}: contract ${verdict.status} at ${state.phase} — ${verdict.message}`)
    return reject(ports, candidateId, state.phase, verdict)
  }

  switch (state.phase) {
    case 'LAND':
      return land(ports, candidateId, state)

    case 'BUILD': {
      // Model mode: BUILD exists only for the framework-optimisation dual-repo path (ADR-0022).
      transition(ports, candidateId, 'build_skipped', { reason: 'model_mode' }, 'VERIFY')
      return { candidateId, phase: 'BUILD', action: 'noop -> verify' }
    }

    case 'VERIFY':
      return verify(ports, candidateId, state)

    case 'SUBMIT_QUEUED': {
      const permit = canDispatch(store, ports.workspace ?? workspaceState(store, clock, config), config, now)
      if (!permit.ok) {
        // Only NEW dispatch stops. Money already spent on an in-flight candidate is not recoverable
        // by killing it, so the soft limit lets those finish.
        const poll = pollConfig(config)
        advance(store, candidateId, 'SUBMIT_QUEUED', { next_action_at: now + poll.base_ms })
        log?.(`${candidateId}: ${permit.reason} limit ${permit.decision.usedGpuHours}/${permit.decision.gpuLimitHours} — holding at SUBMIT_QUEUED`)
        return { candidateId, phase: 'SUBMIT_QUEUED', action: `held_by_${permit.reason}_limit` }
      }
      const gpuHours = budgetOf(ports.workspace ?? workspaceState(store, clock, config), config).candidate_gpu_hours
      store.reserve(candidateId, gpuHours, now)
      transition(
        ports,
        candidateId,
        'budget_reserved',
        { gpu_hours: gpuHours },
        'SUBMIT',
        { reserved_gpu_hours: gpuHours },
      )
      return { candidateId, phase: 'SUBMIT_QUEUED', action: `reserved ${gpuHours}h -> submit` }
    }

    case 'SUBMIT':
      return submit(ports, candidateId, state)

    case 'MONITOR_POLL':
      return monitor(ports, candidateId, state)

    case 'CAND_ANALYZE':
      return analyze(ports, candidateId, state)

    default:
      return { candidateId, phase: state.phase, action: 'noop' }
  }
}

// --------------------------------------------------------------- phases

async function land(ports, candidateId, state) {
  const { store, clock, harness } = ports

  // Every path into LAND must present a hypothesis. The round planner freezes a full
  // `land_hypothesis` artifact and it is validated here; a candidate a human proposal created
  // bypasses the planner, so this is the only gate it will ever meet — and a candidate with
  // nothing to state is rejected rather than handed to an implementer to guess at.
  if (state.land_hypothesis !== undefined) {
    const artifact = validateArtifact('land_hypothesis', state.land_hypothesis)
    if (isBlocking(artifact)) return reject(ports, candidateId, 'LAND', artifact)
  } else if (typeof state.hypothesis !== 'string' || state.hypothesis.trim() === '') {
    return reject(ports, candidateId, 'LAND', {
      status: 'missing',
      message: 'this candidate reached LAND with no structural hypothesis to land',
    })
  }

  // The runner owns the worktree and the base ref; the adapter only edits files inside it.
  const worktreeDir = state.worktree_dir ?? ports.worktreeDir
  const baseRef = state.base_ref ?? ports.baseRef
  const parentId = state.parent_id ?? ports.parentId ?? null

  const result = await harness.land({
    candidateId,
    hypothesis: state.hypothesis,
    round: state.round,
    worktreeDir,
    baseRef,
    parentId,
  })

  if (result.ok === false) {
    // A landing that failed on a cross-check is a *conflict*: two accounts of the same edit
    // disagree. Everything else the harness refuses is an invalid artifact, not a contradiction.
    const status = result.conflict === true ? 'conflict' : 'invalid'
    return reject(
      ports,
      candidateId,
      'LAND',
      { status, message: result.message ?? `landing failed: ${result.error_class}` },
      { error_class: result.error_class ?? null, files: result.files ?? [] },
    )
  }

  store.freezeBinding(
    candidateId,
    'parent_binding',
    {
      parent_id: result.parent_id,
      parent_commit: result.parent_commit,
      frozen_at_ms: clock.now(),
    },
    clock.now(),
  )
  ports.crashAt?.('after_binding')

  transition(
    ports,
    candidateId,
    'land_done',
    { engine: result.engine, files_changed: result.files_changed ?? 0 },
    'BUILD',
  )
  return { candidateId, phase: 'LAND', action: `landed by ${result.engine} -> build` }
}

async function verify(ports, candidateId, state) {
  const { store, clock, judge } = ports
  const parent = store.binding(candidateId, 'parent_binding')

  const artifact = await judge.verify({ candidateId, state, parent, now: clock.now() })
  const verdict = validateArtifact('verify_verdict', artifact)

  if (isBlocking(verdict)) {
    // Fail closed, but say which of the four states it was — that is the whole point of having four.
    return reject(ports, candidateId, 'VERIFY', verdict, { artifact: `verify_verdict:${candidateId}` })
  }

  if (artifact.passed !== true) {
    return reject(
      ports,
      candidateId,
      'VERIFY',
      { message: 'the verify gate did not pass' },
      {
        artifact: `verify_verdict:${candidateId}`,
        review: artifact.reviewer ?? null,
        failed_checks: (artifact.checks ?? []).filter((check) => check.result === 'fail').map((check) => check.name),
      },
    )
  }

  store.freezeBinding(
    candidateId,
    'verify_gate',
    {
      parent_id: parent?.parent_id,
      passed: true,
      decided_at_ms: artifact.decided_at_ms,
      checks: artifact.checks?.length ?? 0,
    },
    clock.now(),
  )
  ports.crashAt?.('after_binding')

  transition(
    ports,
    candidateId,
    'gate_result',
    { phase: 'VERIFY', status: 'ok', passed: true, message: '' },
    'SUBMIT_QUEUED',
  )
  return { candidateId, phase: 'VERIFY', action: 'gate pass -> submit_queued' }
}

async function submit(ports, candidateId, state) {
  const { store, clock, platform, config } = ports
  const budget = budgetOf(ports.workspace ?? workspaceState(store, clock, config), config)

  let submitted
  try {
    submitted = await platform.submit({
      submissionId: candidateId,
      candidateId,
      gpuHours: state.reserved_gpu_hours ?? budget.candidate_gpu_hours,
    })
  } catch (error) {
    // Two kinds of throw, and conflating them is a bug in both directions.
    //
    // `retryable === false` is the platform saying *this candidate cannot be shipped at all* — a
    // tree over the package limit, or one whose archive disagrees with the runner's git diff. Waiting
    // changes nothing about it, so it is a decision: reject the candidate and put the conclusion in
    // the reason a person reads. Note what is deliberately absent: no `status`. Nothing is malformed
    // (that would be `invalid`) and no two facts contradict each other in a way we can call
    // `conflict` — the news is bad and the platform said why, which is not one of the four states
    // (CODING_STANDARDS §2).
    if (error?.retryable === false) {
      return reject(ports, candidateId, 'SUBMIT', {
        message: [error.conclusion, error.message].filter((part) => typeof part === 'string' && part !== '').join(': '),
      })
    }

    // Everything else — cluster down, no resources, nothing to run — is the platform being
    // unavailable, not the candidate being wrong. Hold the candidate here and try again later.
    const poll = pollConfig(config)
    const delay = Math.min(poll.base_ms * 2 ** Math.min((state.submit_attempts ?? 0) + 1, 10), poll.max_ms)
    const { seq } = emit(store, clock, candidateId, 'submit_refused', {
      message: String(error?.message ?? error),
    })
    advance(store, candidateId, 'SUBMIT', { next_action_at: clock.now() + delay, submit_attempts: (state.submit_attempts ?? 0) + 1 }, seq)
    return { candidateId, phase: 'SUBMIT', action: `submit refused, retry in ${delay}ms` }
  }

  // The dangerous window: the platform knows about this job and we do not yet.
  ports.crashAt?.('after_submit')

  store.putJob({
    job_id: submitted.job_id,
    candidate_id: candidateId,
    submission_id: candidateId,
    harness: submitted.harness ?? 'unknown',
    submitted_at_ms: clock.now(),
    deadline_ms: clock.now() + (submitted.deadline_ms ?? 3_600_000),
    next_poll_at_ms: 0,
    state: submitted.state ?? 'running',
    attempts: 0,
  })

  transition(
    ports,
    candidateId,
    'submitted',
    { job_id: submitted.job_id, duplicate: submitted.duplicate === true },
    'MONITOR_POLL',
  )
  return { candidateId, phase: 'SUBMIT', action: `submitted ${submitted.job_id} -> monitor` }
}

async function monitor(ports, candidateId, state) {
  const { store, clock, platform, config } = ports
  const poll = pollConfig(config)
  const now = clock.now()
  const job = store.jobFor(candidateId)

  if (job === undefined) {
    // Past SUBMIT with no job row: the contract already flagged it as missing.
    return reject(ports, candidateId, 'MONITOR_POLL', {
      status: 'missing',
      message: 'no job ledger row for a candidate in MONITOR_POLL',
    })
  }

  const polled = await platform.poll(job.job_id)
  store.updateJob(job.job_id, { last_polled_at_ms: now })

  // Nothing else can stop a job that hangs, and a hung job is the one failure mode that never
  // recovers by itself. The poller judges, cancels, and records — the candidate is then rejected.
  const timeout = judgeTimeout({ job, now, limits: config?.limits })
  if (timeout !== undefined && !['succeeded', 'failed', 'lost'].includes(polled.state)) {
    let canceled = false
    try {
      canceled = (await platform.cancel?.(job.job_id)) !== undefined
    } catch {
      canceled = false
    }
    transition(
      ports,
      candidateId,
      'job_timeout',
      {
        kind: timeout.kind,
        elapsed_ms: timeout.elapsed_ms,
        limit_ms: timeout.limit_ms,
        canceled,
        state_after: polled.state,
      },
      'MONITOR_POLL',
    )
    return reject(ports, candidateId, 'MONITOR_POLL', {
      message: `${timeout.kind} timeout after ${timeout.elapsed_ms}ms (limit ${timeout.limit_ms}ms); the poller stopped the job`,
    })
  }

  if (polled.state === 'succeeded') {
    transition(
      ports,
      candidateId,
      'metrics_collected',
      { job_id: job.job_id, metrics: polled.metrics ?? {} },
      'CAND_ANALYZE',
      { metrics: polled.metrics ?? {} },
    )
    return { candidateId, phase: 'MONITOR_POLL', action: 'succeeded -> analyze' }
  }

  if (polled.state === 'failed' || polled.state === 'lost') {
    // No four-state status: nothing was malformed, the job simply did not produce a result. The
    // platform's error class is the diagnosis, and cancel() is a different class again.
    return reject(
      ports,
      candidateId,
      'MONITOR_POLL',
      { message: `job ${polled.state}: ${polled.error_class ?? 'no error class'}` },
      { job_id: job.job_id, error_class: polled.error_class ?? null },
    )
  }

  // Still running, or not visible upstream yet: back off, never spin.
  const attempts = job.attempts + 1
  const delay = Math.min(poll.base_ms * 2 ** Math.min(attempts, 10), poll.max_ms)
  store.updateJob(job.job_id, { attempts, next_poll_at_ms: now + delay, state: polled.state })
  advance(store, candidateId, 'MONITOR_POLL', { next_action_at: now + delay })
  return { candidateId, phase: 'MONITOR_POLL', action: `still ${polled.state} (backoff ${delay}ms)` }
}

async function analyze(ports, candidateId, state) {
  const { store, clock, judge, platform } = ports
  const job = store.jobFor(candidateId)

  // poll() carries metrics; collect() carries what the job left behind. Ask for it before
  // asking for an opinion, so the analysis is grounded in artifacts rather than in a summary.
  let collected
  if (typeof platform.collect === 'function' && job !== undefined) {
    try {
      collected = await platform.collect(job.job_id)
    } catch {
      collected = undefined
    }
  }

  const artifact = await judge.analyze({ candidateId, state, job, collected, now: clock.now() })
  const verdict = validateArtifact('analyze_report', artifact)
  if (isBlocking(verdict)) {
    return reject(ports, candidateId, 'CAND_ANALYZE', verdict, { artifact: `analyze_report:${candidateId}` })
  }

  const reserved = store.inFlightGpuHours(candidateId)
  const actual = numberOf(collected?.gpu_hours) ?? numberOf(job?.gpu_hours) ?? reserved
  const tokens = numberOf(collected?.usage?.total_tokens) ?? numberOf(job?.tokens) ?? 0
  if (reserved > 0) store.settle(candidateId, Math.min(actual, reserved), clock.now(), tokens)

  transition(
    ports,
    candidateId,
    'cand_analyze',
    {
      verdict: artifact.verdict,
      root_cause: artifact.root_cause,
      gpu_hours: reserved,
      artifacts: collected?.artifacts ?? [],
    },
    'DONE',
  )
  return { candidateId, phase: 'CAND_ANALYZE', action: `settled ${reserved}h -> done` }
}

// ------------------------------------------------------------ reconcile

/** What phase an event implies. A fold is a lookup, not a second state machine. */
const PHASE_FROM_EVENT = {
  candidate_created: 'LAND',
  land_done: 'BUILD',
  build_skipped: 'VERIFY',
  budget_reserved: 'SUBMIT',
  submitted: 'MONITOR_POLL',
  metrics_collected: 'CAND_ANALYZE',
  cand_analyze: 'DONE',
  candidate_rejected: 'REJECTED',
}

/**
 * Fold events the state never saw — the "event landed, state did not" window.
 * Idempotent: folding again over an empty backlog does nothing.
 */
export function foldEvents(store, candidateId) {
  const applied = store.appliedSeq(candidateId)
  const pending = store.eventsAfter(candidateId, applied)
  if (pending.length === 0) return { folded: 0, phase: store.getState(candidateId, 'phase')?.phase }

  const state = { ...(store.getState(candidateId, 'phase', {}) ?? {}) }
  for (const event of pending) {
    if (event.event_type === 'gate_result') {
      state.phase = event.payload?.status === 'ok' ? 'SUBMIT_QUEUED' : 'REJECTED'
      if (state.phase === 'REJECTED') state.reject_reason = event.payload?.message
      continue
    }
    const phase = PHASE_FROM_EVENT[event.event_type]
    if (phase !== undefined) state.phase = phase
    if (event.event_type === 'candidate_created') {
      if (state.round === undefined) state.round = event.payload?.round
      if (state.hypothesis === undefined) state.hypothesis = event.payload?.hypothesis
    }
    if (event.event_type === 'candidate_rejected') state.reject_reason = event.payload?.reject_reason
  }

  state.next_action_at = 0
  store.setState(candidateId, 'phase', state)
  store.setAppliedSeq(candidateId, pending[pending.length - 1].local_seq)
  return { folded: pending.length, phase: state.phase }
}

/**
 * Startup reconciliation: ask the platform before trusting the last row we wrote.
 *
 * The grace period is not politeness. A job submitted a second before the crash may not be
 * visible upstream yet; without the grace window, every restart kills jobs that are running fine.
 */
export async function reconcile(ports) {
  const { store, clock, platform, config, log } = ports
  const poll = pollConfig(config)
  const repairs = []

  for (const candidateId of store.candidateIds()) {
    const folded = foldEvents(store, candidateId)
    if (folded.folded > 0) repairs.push({ candidateId, action: 'replayed events', ...folded })

    const state = store.getState(candidateId, 'phase')
    if (state === undefined || isTerminal(state.phase)) continue
    if (!['SUBMIT_QUEUED', 'SUBMIT', 'MONITOR_POLL'].includes(state.phase)) continue

    const remote = await platform.find(candidateId)
    const local = store.jobFor(candidateId)

    if (remote !== undefined && local === undefined) {
      // We submitted, then died before recording it. Adopt the platform's truth; do not resubmit.
      store.putJob({
        job_id: remote.job_id,
        candidate_id: candidateId,
        submission_id: candidateId,
        harness: remote.harness ?? 'unknown',
        submitted_at_ms: remote.submitted_at_ms ?? clock.now(),
        deadline_ms: remote.deadline_ms ?? clock.now() + 3_600_000,
        next_poll_at_ms: 0,
        state: remote.state ?? 'running',
        attempts: 0,
      })
      const { seq } = emit(store, clock, candidateId, 'job_adopted_on_recovery', {
        job_id: remote.job_id,
        remote_state: remote.state,
      })
      if (state.phase === 'SUBMIT') advance(store, candidateId, 'MONITOR_POLL', {}, seq)
      repairs.push({ candidateId, action: 'adopted remote job', job_id: remote.job_id })
      continue
    }

    if (remote !== undefined && local !== undefined && remote.state !== local.state) {
      store.updateJob(local.job_id, { state: remote.state })
      const corrected = emit(store, clock, candidateId, 'job_state_corrected', { job_id: local.job_id, from: local.state, to: remote.state })
      // Folded into state here and now: applied_seq means "no event is waiting to be folded",
      // so an event that changed nothing still counts as folded.
      store.setAppliedSeq(candidateId, corrected.seq)
      repairs.push({ candidateId, action: 'corrected job state', from: local.state, to: remote.state })
      continue
    }

    if (remote === undefined && local !== undefined && local.attempts < poll.grace_attempts) {
      store.updateJob(local.job_id, { state: 'unknown', attempts: local.attempts + 1 })
      const grace = emit(store, clock, candidateId, 'job_grace_period', {
        job_id: local.job_id,
        attempts: local.attempts + 1,
      })
      store.setAppliedSeq(candidateId, grace.seq)
      repairs.push({ candidateId, action: 'grace period (not visible upstream yet)' })
    }
  }

  if (repairs.length > 0) log?.(`reconcile: ${repairs.length} repair(s)`, repairs)
  return repairs
}

