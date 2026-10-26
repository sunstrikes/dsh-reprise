/**
 * The BASELINE phase's executor path: produce this run's denominator the way every other number in
 * the run is produced — submit a job, wait for it, collect what it measured.
 *
 * Why this is a job and not a number: the denominator is what every candidate is compared against,
 * so a baseline that arrived from outside (a published table, a file someone wrote) makes the whole
 * run a comparison between two different experiments. Only the executor path measures the baseline
 * in the same medium, on the same cluster, with the same scripts as a candidate — which is what "the
 * same path as a candidate" has to mean to be worth claiming.
 *
 * Four properties this module holds, each with a failure it prevents:
 *
 *   1. **Frozen means frozen.** A baseline already in the workspace is never re-measured. A second
 *      boot of the same workspace therefore cannot silently replace the number earlier rounds were
 *      compared against, which would rewrite history without touching a fact.
 *   2. **A baseline that cannot run stops the workspace, with a named reason.** The job can fail, it
 *      can report no metric, it can report no window, and the samples it does report can be malformed
 *      (`invalid`) or hold two accounts of one window (`conflict`). None of these is a candidate
 *      rejection — there is no candidate — and none may be absorbed into "an empty denominator",
 *      which would turn every later comparison into a win.
 *   3. **The job is marked.** Its ledger row says `kind: 'baseline'` and its submission id is
 *      `reprise:baseline`, so neither our own dispatch path nor a cluster listing can mistake it for
 *      a candidate (ticket 16's marker work hangs off the same row).
 *   4. **It spends budget like any other job**: reserved on dispatch, settled on completion. A free
 *      lane would make the remaining budget a lie in exactly the tick a candidate asks about it.
 *
 * @module
 */

import { judgeTimeout } from '@dsh-reprise/exec'

import { budgetOf, canDispatch } from './budget.js'
import { baselineMarker, submissionIdFor } from './jobs.js'
import { recordWindowSamples, seriesOf } from './samples.js'

/**
 * The subject a baseline's facts are written under.
 *
 * It has to be recognisable as *not a candidate*: `createCandidate` names its children
 * `r<round>-<hypothesis>`, and the store's `_workspace` convention already reserves the leading
 * underscore for subjects that are not candidates.
 */
export const BASELINE_SUBJECT = '_baseline'

/**
 * The cluster-visible idempotency key. A resubmission after a crash resolves to the same job.
 *
 * It is the baseline's marker (`reprise:baseline`) rather than the bare word `baseline`, because the
 * key is the only field the cluster's job listing is guaranteed to carry: reading "this is the
 * denominator of a run of this repository" back out of it is what keeps the baseline out of the
 * `foreign` pile — and out of reach of anything that stops unknown jobs.
 */
export const BASELINE_SUBMISSION_ID = submissionIdFor({ baseline: true })

/** Poll cadence defaults; a configuration may override either number. */
const POLL = Object.freeze({ base_ms: 1_000, max_ms: 60_000 })

const numberOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Is this workspace's denominator already a fact? */
export const baselineFrozen = (state) => state?.baseline !== undefined

/** Append a baseline fact. The subject is the reserved baseline id, so the event belongs to someone. */
function emit(store, clock, eventType, payload) {
  const { local_seq: seq } = store.appendEvent({
    candidate_id: BASELINE_SUBJECT,
    wall_clock_ms: clock.now(),
    event_type: eventType,
    payload,
  })
  return seq
}

/**
 * A workspace-level stop, in the vocabulary `stop.js` records.
 *
 * `status` is set only when something the *contract* refused is the cause: a malformed series is
 * `invalid`, two accounts of one window are `conflict`. A job that failed, a run that measured
 * nothing and a run that reported no window are bad news with no four-state status — merging them
 * into `invalid` would send the next reader hunting for a malformed artifact that never existed
 * (CODING_STANDARDS §2).
 */
const stopWith = (rule, message, detail, status) => ({
  status: 'stopped',
  action: `stopped:${rule}`,
  decision: { rule, message, detail, ...(status === undefined ? {} : { status }) },
})

/**
 * One step of the BASELINE phase when an executor is available.
 *
 * @param {{
 *   store: any, clock: {now: () => number}, platform: any, artifacts?: any, config?: any,
 *   settings: {metric: {name: string}}, now: number, log?: Function, crashAt?: Function,
 * }} context
 * @param {object} state the `rounds` workspace state
 * @returns {Promise<
 *   {status: 'waiting', action: string, next_action_at?: number} |
 *   {status: 'frozen', baseline: object, action: string} |
 *   {status: 'stopped', decision: object, action: string}
 * >}
 */
export async function stepBaseline(context, state) {
  // Frozen already: read it back, never re-measure. This is checked before the ledger is consulted,
  // because a workspace can reach BASELINE again (a rebuilt state row, a resumed old workspace) and
  // the frozen number has to win regardless of what job rows survive.
  if (baselineFrozen(state)) {
    return {
      status: 'frozen',
      baseline: state.baseline,
      action: `baseline already frozen (${state.baseline.metric}=${state.baseline.value})`,
    }
  }

  const job = context.store.jobFor(BASELINE_SUBJECT)
  if (job === undefined) return dispatch(context, state)
  return poll(context, job)
}

/**
 * Submit the baseline job, reserving its budget first.
 *
 * Order matters: reserve, then submit. A crash between the two leaves hours in flight for work that
 * may not exist upstream — detectable in the ledger — while submitting first would let a crash hide
 * a job that is really running and really billing.
 */
async function dispatch(context, state) {
  const { store, clock, platform, config, now, log, crashAt } = context
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  const poll = { ...POLL, ...(config?.poll ?? {}) }
  // A refused submission backs off like any retry: the platform being down must not become a hot loop
  // in which the workspace asks a dead endpoint once per tick for a night.
  const retryDelay = Math.min(poll.base_ms * 2 ** Math.min((state?.attempts ?? 0) + 1, 10), poll.max_ms)

  const permit = canDispatch(store, workspace, config, now)
  if (!permit.ok) {
    // The baseline is new work, so the soft limit stops it exactly as it stops a candidate: nothing
    // has been spent on it yet, and going past the limit is a decision a human makes.
    log?.(`BASELINE: held by the ${permit.reason} limit ${permit.decision.usedGpuHours}/${permit.decision.gpuLimitHours}`)
    return { status: 'waiting', action: `baseline held by ${permit.reason} limit`, next_action_at: now + retryDelay }
  }

  // One reservation per baseline, not one per attempt: a refused submission is retried, and reserving
  // again on every retry would make the same hours count twice against the limit.
  if (store.inFlightGpuHours(BASELINE_SUBJECT) === 0 && store.totals(BASELINE_SUBJECT).settledGpuHours === 0) {
    store.reserve(BASELINE_SUBJECT, budgetOf(workspace, config).candidate_gpu_hours, now)
  }

  let submitted
  try {
    submitted = await platform.submit({
      submissionId: BASELINE_SUBMISSION_ID,
      candidateId: BASELINE_SUBJECT,
      gpuHours: budgetOf(workspace, config).candidate_gpu_hours,
    })
  } catch (error) {
    const message = String(error?.conclusion ?? error?.message ?? error)
    emit(store, clock, 'baseline_submit_refused', { message, retryable: error?.retryable !== false })
    // The platform being unavailable is not the baseline being wrong: hold the phase and try again.
    // A `retryable: false` refusal is different — waiting changes nothing about it, so the workspace
    // stops with the platform's own words instead of retrying forever.
    if (error?.retryable === false) {
      return stopWith('baseline_run_failed', `the baseline could not be submitted: ${message}`, {
        phase: 'BASELINE',
        retryable: false,
      })
    }
    log?.(`BASELINE: submit refused — ${message}`)
    return { status: 'waiting', action: 'baseline submit refused, retrying', next_action_at: now + retryDelay }
  }

  // The dangerous window: the platform knows about this job and we do not yet. Submission ids are
  // idempotent, so the next tick's submit resolves to this job rather than creating a second one.
  crashAt?.('after_baseline_submit')

  store.putJob({
    job_id: submitted.job_id,
    candidate_id: BASELINE_SUBJECT,
    submission_id: BASELINE_SUBMISSION_ID,
    kind: 'baseline',
    marker: baselineMarker(),
    round: null,
    harness: submitted.harness ?? 'unknown',
    submitted_at_ms: now,
    deadline_ms: now + (submitted.deadline_ms ?? 3_600_000),
    next_poll_at_ms: 0,
    state: submitted.state ?? 'running',
    attempts: 0,
  })
  emit(store, clock, 'baseline_submitted', { job_id: submitted.job_id, duplicate: submitted.duplicate === true })
  log?.(`BASELINE: submitted ${submitted.job_id}`)
  return { status: 'waiting', action: `baseline submitted ${submitted.job_id}` }
}

/** Poll the baseline job, and finish — freeze or stop — once it is terminal. */
async function poll(context, job) {
  const { store, clock, platform, config, now, log } = context
  const pollConfig = { ...POLL, ...(config?.poll ?? {}) }
  const answered = await platform.poll(job.job_id)
  store.updateJob(job.job_id, { last_polled_at_ms: now })

  const timeout = judgeTimeout({ job, now, limits: config?.limits })
  if (timeout !== undefined && !['succeeded', 'failed', 'lost'].includes(answered.state)) {
    let canceled = false
    try {
      canceled = (await platform.cancel?.(job.job_id)) !== undefined
    } catch {
      canceled = false
    }
    settle(store, now)
    // The row says how the job ended, so a reader of the ledger is not told a stopped job is running.
    store.updateJob(job.job_id, { state: 'failed', error_class: 'canceled' })
    emit(store, clock, 'baseline_timeout', {
      kind: timeout.kind,
      elapsed_ms: timeout.elapsed_ms,
      limit_ms: timeout.limit_ms,
      canceled,
      state_after: answered.state,
    })
    return stopWith(
      'baseline_timeout',
      `the baseline job hit its ${timeout.kind} limit after ${timeout.elapsed_ms}ms (limit ${timeout.limit_ms}ms); ` +
        'nothing may be compared against a denominator that never finished',
      { job_id: job.job_id, kind: timeout.kind, canceled },
    )
  }

  if (answered.state === 'failed' || answered.state === 'lost') {
    // Settled, not refunded: the hours were spent whether or not the run produced a number.
    settle(store, now)
    store.updateJob(job.job_id, { state: answered.state, error_class: answered.error_class ?? null })
    emit(store, clock, 'baseline_run_failed', {
      job_id: job.job_id,
      state: answered.state,
      error_class: answered.error_class ?? null,
    })
    return stopWith(
      'baseline_run_failed',
      `the baseline job ended ${answered.state} (${answered.error_class ?? 'no error class'}): ` +
        'a run whose denominator did not run has nothing to compare candidates against',
      { job_id: job.job_id, state: answered.state, error_class: answered.error_class ?? null },
    )
  }

  if (answered.state !== 'succeeded') {
    const attempts = job.attempts + 1
    const delay = Math.min(pollConfig.base_ms * 2 ** Math.min(attempts, 10), pollConfig.max_ms)
    store.updateJob(job.job_id, { attempts, next_poll_at_ms: now + delay, state: answered.state })
    log?.(`BASELINE: still ${answered.state}`)
    return { status: 'waiting', action: `baseline still ${answered.state} (backoff ${delay}ms)`, next_action_at: now + delay }
  }

  return collect(context, job, answered)
}

/** The job succeeded. Freeze the numbers it reported — or name what is missing and stop. */
async function collect(context, job, answered) {
  const { store, clock, platform, settings, now, log, artifacts } = context

  // `poll` carries the metric table; `collect` carries what the job left behind. Both are asked for,
  // because a windowed series can arrive in either place depending on the executor.
  let collected
  if (typeof platform.collect === 'function') {
    try {
      collected = await platform.collect(job.job_id)
    } catch {
      collected = undefined
    }
  }

  // Settle what the job actually used, capped at what was reserved — the same arithmetic a candidate
  // gets, because a baseline job is not a cheaper kind of job.
  settle(store, now, {
    tokens: numberOf(collected?.usage?.total_tokens) ?? numberOf(answered?.tokens) ?? 0,
    actual: numberOf(collected?.gpu_hours) ?? numberOf(answered?.gpu_hours),
  })
  // The job *did* succeed; what failed below is what it reported, which is a different fact.
  store.updateJob(job.job_id, { state: 'succeeded' })

  const metricName = settings.metric.name
  const value = numberOf(collected?.metrics?.[metricName]) ?? numberOf(answered.metrics?.[metricName])
  if (value === undefined) {
    emit(store, clock, 'baseline_run_failed', {
      job_id: job.job_id,
      error_class: 'no_metric',
      metric: metricName,
      reported: Object.keys(answered.metrics ?? {}),
    })
    return stopWith(
      'baseline_no_metrics',
      `the baseline job succeeded but reported no ${JSON.stringify(metricName)} ` +
        `(it reported ${Object.keys(answered.metrics ?? {}).join(', ') || 'nothing'}): a denominator with no number is not a denominator`,
      { job_id: job.job_id, metric: metricName, error_class: 'no_metric' },
    )
  }

  // The series is the evidence pairing needs, in the contract's shape. Asked for *after* the metric,
  // because "no number" is the smaller failure and should be the one named first.
  const samples = seriesOf({ ...answered, ...(collected ?? {}) })
  if (samples.status !== 'ok') {
    const rule =
      samples.status === 'invalid'
        ? 'baseline_samples_invalid'
        : samples.status === 'conflict'
          ? 'baseline_samples_conflict'
          : 'baseline_no_windows'
    emit(store, clock, 'baseline_samples_unusable', {
      job_id: job.job_id,
      status: samples.status,
      source: samples.source,
      message: samples.message,
    })
    // Only a contract refusal carries a four-state status; "no window at all" does not.
    const status = samples.status === 'invalid' || samples.status === 'conflict' ? samples.status : undefined
    return stopWith(
      rule,
      `the baseline measured ${metricName}=${value} but reported no usable window samples (${samples.status}): ${samples.message}`,
      { job_id: job.job_id, source: samples.source },
      status,
    )
  }

  // The same recorder a candidate uses: one artifact shape, one event type, one shape of sample.
  const series = recordWindowSamples(
    { store, clock, artifacts },
    {
      subject: BASELINE_SUBJECT,
      subjectKind: 'baseline',
      jobId: job.job_id,
      series: samples.series,
      source: samples.source,
      metric: { name: metricName, value },
    },
  )

  const baseline = {
    metric: metricName,
    value,
    unit: samples.series.unit,
    windows: samples.series.windows.length,
    window_series: series,
    job_id: job.job_id,
    source: 'executor',
    frozen_at_ms: now,
  }
  emit(store, clock, 'baseline_frozen', {
    metric: baseline.metric,
    value: baseline.value,
    unit: baseline.unit,
    windows: baseline.windows,
    job_id: job.job_id,
    artifact: series.artifact,
  })
  log?.(`BASELINE: frozen ${metricName}=${value} over ${baseline.windows} window(s) of ${job.job_id}`)
  return { status: 'frozen', baseline, action: 'baseline frozen -> round_plan' }
}

/**
 * Settle whatever is still in flight for the baseline: the ledger shows it spent, not owed.
 *
 * `actual` is what the job reported it used; it is capped at the reservation the way the candidate
 * path caps it, so an executor that reports more hours than it was granted cannot spend past a limit
 * that was already enforced at dispatch.
 */
function settle(store, now, { tokens = 0, actual } = {}) {
  const reserved = store.inFlightGpuHours(BASELINE_SUBJECT)
  if (reserved > 0) store.settle(BASELINE_SUBJECT, Math.min(numberOf(actual) ?? reserved, reserved), now, tokens)
}
