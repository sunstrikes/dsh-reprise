/**
 * The external-job port: `submit` / `poll` / `collect`, plus `find` and `cancel`.
 *
 * Why a port rather than a wrapper class: the loop must run against a laptop subprocess today and
 * a Ray cluster tomorrow without the phase machine learning a second vocabulary. So the vocabulary
 * is closed here, and every implementation is held to it by the conformance suite at the bottom of
 * this file. "Implement five methods and pass one suite" is the entire onboarding story for a new
 * executor — a contributor never has to read the state machine.
 *
 * Two rules the enums encode, both learned the expensive way in the predecessor:
 *
 *  - `lost` and `unknown` are not severities of `failed`. `lost` means the platform answered 404 —
 *    it is gone and waiting longer will not help. `unknown` means *we could not find out* (the
 *    dashboard is down, the status file is unreadable). Merging either into `failed` turns "we
 *    cannot see it" into "the candidate is bad", which kills a job that was running fine across a
 *    restart — the failure mode user story 15 exists to prevent.
 *  - `canceled` is an error class, never a plain failure. A run we stopped ourselves says nothing
 *    about the candidate's code; a stop policy that cannot tell them apart stops the round for a
 *    reason the candidate never caused.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/**
 * A filesystem-safe name for a caller-supplied id. When sanitising actually changes the string a
 * short digest is appended: `cand/1` and `cand:1` both slug to `cand-1`, and a collision here would
 * make `submit()` answer "duplicate" for a *different* candidate's job. Silently adopting someone
 * else's run is worse than an ugly directory name.
 */
export function safeSlug(value) {
  const text = String(value)
  const base = text.replace(/[^A-Za-z0-9_.-]/g, '-')
  if (base === text) return base
  return `${base}-${createHash('sha256').update(text).digest('hex').slice(0, 10)}`
}

/**
 * Every value `state` may take. There is no `pending` and no `stopped`: a job the platform has
 * accepted but not finished is `running`, and a stopped job is `failed` with `error_class:
 * 'canceled'`. Two enumerations of "not done yet" would make every caller join them back together.
 */
export const STATES = Object.freeze(['running', 'succeeded', 'failed', 'lost', 'unknown'])

/** States after which no further observation can change the answer. */
export const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'lost'])

/**
 * Every value `error_class` may take. Deliberately closed: an executor that invents `cluster` or
 * `timeout` here forces every consumer to learn its dialect. `timeout` in particular is *not* an
 * error class — it is a conclusion the poller reaches and then expresses as `canceled` plus a
 * `timeout` record, because the causal fact is "we stopped it", not "it broke".
 */
export const ERROR_CLASSES = Object.freeze(['oom', 'code', 'data', 'canceled'])

export const DEFAULTS = Object.freeze({
  /** Wall-clock ceiling from the moment the platform started the job. 0 disables the limit. */
  max_wall_ms: 3_600_000,
  /** Silence ceiling: no new progress sample for this long means "alive but stuck". */
  max_idle_ms: 1_800_000,
  /** How long a cancel may take before the implementation escalates to SIGKILL. */
  kill_grace_ms: 3_000,
})

const types = {
  string: (value) => typeof value === 'string' && value !== '',
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
}

function refused(message) {
  throw new TypeError(`platform port: ${message}`)
}

/**
 * Fail fast on an implementation that cannot serve the port. Called by the conformance suite and
 * worth calling at plugin boot: a typo'd method name found at boot is a log line, found at SUBMIT
 * it is a stuck candidate.
 */
export function assertPlatform(platform) {
  if (!types.object(platform)) refused('an implementation must be an object')
  for (const method of ['submit', 'poll', 'collect', 'find', 'cancel']) {
    if (typeof platform[method] !== 'function') refused(`missing method ${method}()`)
  }
  return platform
}

/**
 * The job id a caller meant.
 *
 * `poll()` hands back a plain answer — `{state: 'succeeded', metrics: …}` — and the very next thing a
 * caller wants is that job's artifacts, so it is normal to call `collect()` with the answer rather
 * than with an id. Doing so used to interpolate the object into the request path
 * (`ray does not know job [object Object]`), get a 404, and report **`lost`** for a job that had just
 * succeeded — the one wrong answer user story 20 is about, and the worst one to hand a restart.
 *
 * So: a string is a job id, an object carrying one is the result of the call that just happened, and
 * anything else is a caller bug that throws. "We were handed nonsense" must never be spelled `lost`.
 *
 * @param {string|{job_id?: string}} value
 * @param {{method?: string}} [options] named so the error says which call was wrong
 * @returns {string}
 */
export function resolveJobId(value, { method = 'collect' } = {}) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const id = value.job_id
    if (typeof id === 'string' && id !== '') return id
    refused(`${method}() was given an object with no usable job_id — pass the job id, or the poll result that carries one`)
  }
  refused(`${method}() needs a job id (a string, or a result carrying job_id), got ${value === null ? 'null' : typeof value}`)
}

/**
 * Validate one poll answer. Enforced here rather than trusted to each implementation because the
 * closed vocabulary is the contract: a `state: 'stopped'` would be silently treated as "still
 * running" by every caller and hang the candidate forever.
 */
export function assertPollResult(result) {
  if (!types.object(result)) refused(`poll() must return an object, got ${typeof result}`)
  if (!STATES.includes(result.state)) {
    refused(`poll() returned state ${JSON.stringify(result.state)}; allowed: ${STATES.join(', ')}`)
  }
  if (result.error_class !== undefined && !ERROR_CLASSES.includes(result.error_class)) {
    refused(`poll() returned error_class ${JSON.stringify(result.error_class)}; allowed: ${ERROR_CLASSES.join(', ')} (or omit it)`)
  }
  if (result.metrics !== undefined && !types.object(result.metrics)) {
    refused('poll() returned metrics that are not an object')
  }
  return result
}

/** Validate one submit answer. `deadline_ms` is a *duration*, matching what the kernel adds to now. */
export function assertSubmitResult(result) {
  if (!types.object(result)) refused(`submit() must return an object, got ${typeof result}`)
  if (!types.string(result.job_id)) refused('submit() must return a job_id')
  if (result.state !== undefined && !STATES.includes(result.state)) {
    refused(`submit() returned state ${JSON.stringify(result.state)}; allowed: ${STATES.join(', ')}`)
  }
  if (result.deadline_ms !== undefined && !types.number(result.deadline_ms)) {
    refused('submit() deadline_ms must be a duration in milliseconds')
  }
  if (result.duplicate !== undefined && !types.boolean(result.duplicate)) {
    refused('submit() duplicate must be a boolean')
  }
  return result
}

/**
 * Validate one find answer. `undefined` is a legitimate answer ("no job for this candidate"), and
 * `deadline_ms` here is *absolute* because it describes a job that already exists — the same
 * asymmetry the kernel already relies on.
 */
export function assertFindResult(result) {
  if (result === undefined) return result
  if (!types.object(result)) refused(`find() must return an object or undefined, got ${typeof result}`)
  if (!types.string(result.job_id)) refused('find() must return a job_id')
  assertPollResult({ state: result.state, error_class: result.error_class })
  return result
}

export function assertCollectResult(result) {
  if (!types.object(result)) refused(`collect() must return an object, got ${typeof result}`)
  if (!STATES.includes(result.state)) {
    refused(`collect() returned state ${JSON.stringify(result.state)}; allowed: ${STATES.join(', ')}`)
  }
  if (result.artifacts !== undefined && !Array.isArray(result.artifacts)) {
    refused('collect() artifacts must be an array')
  }
  if (result.metrics !== undefined && !types.object(result.metrics)) {
    refused('collect() metrics that are not an object are not metrics')
  }
  return result
}

export function assertCancelResult(result) {
  if (!types.object(result)) refused(`cancel() must return an object, got ${typeof result}`)
  if (!types.boolean(result.accepted)) refused('cancel() must say whether it was accepted')
  if (!STATES.includes(result.state_after)) {
    refused(`cancel() state_after ${JSON.stringify(result.state_after)}; allowed: ${STATES.join(', ')}`)
  }
  return result
}

// ---------------------------------------------------------------- call helpers

/**
 * Await anything, because a local subprocess can answer synchronously while an HTTP-backed
 * executor cannot. The kernel calls these instead of the raw methods: it keeps today's local
 * implementation literally synchronous and still works against Ray after one `await` per call
 * site. (See README, "What the kernel has to change".)
 *
 * @param {any} platform
 * @param {{submissionId: string, candidateId: string, gpuHours?: number, spec?: object}} request
 */
export async function submitJob(platform, request) {
  if (!types.object(request) || !types.string(request.submissionId)) {
    refused('submitJob needs { submissionId } — the idempotency key, not a fresh uuid')
  }
  return assertSubmitResult(await platform.submit(request))
}

export async function pollJob(platform, jobId) {
  return assertPollResult(await platform.poll(resolveJobId(jobId, { method: 'pollJob' })))
}

export async function collectJob(platform, jobId) {
  return assertCollectResult(await platform.collect(resolveJobId(jobId, { method: 'collectJob' })))
}

export async function findJob(platform, candidateId) {
  if (!types.string(candidateId)) refused('findJob needs a candidate id')
  return assertFindResult(await platform.find(candidateId))
}

export async function cancelJob(platform, jobId) {
  return assertCancelResult(await platform.cancel(resolveJobId(jobId, { method: 'cancelJob' })))
}

// ---------------------------------------------------------------- timeout policy

/**
 * Decide whether a still-running job has outlived its limits. Pure, so the policy is testable
 * without a platform and reproducible without waiting.
 *
 * Wall clock is measured from the job's start (falling back to submission, which only makes the
 * ceiling arrive slightly later); idleness from the last progress sample. Wall wins when both
 * fire, because it is the outer bound and a candidate should be told the simplest true reason.
 *
 * @param {{job: object, now: number, limits?: object}} input
 * @returns {undefined | {kind: 'wall'|'idle', elapsed_ms: number, limit_ms: number}}
 */
export function judgeTimeout({ job, now, limits }) {
  const maxWall = limits?.max_wall_ms ?? DEFAULTS.max_wall_ms
  const maxIdle = limits?.max_idle_ms ?? DEFAULTS.max_idle_ms
  const startedAt = job?.started_at_ms ?? job?.submitted_at_ms

  if (maxWall > 0 && startedAt !== undefined && now - startedAt > maxWall) {
    return { kind: 'wall', elapsed_ms: now - startedAt, limit_ms: maxWall }
  }

  const lastSeen = job?.last_progress_at_ms ?? startedAt
  if (maxIdle > 0 && lastSeen !== undefined && now - lastSeen > maxIdle) {
    return { kind: 'idle', elapsed_ms: now - lastSeen, limit_ms: maxIdle }
  }

  return undefined
}

/**
 * Poll, and turn "over the limit" into a conclusion instead of a hang.
 *
 * The conclusion is a `failed` + `error_class: 'canceled'` answer carrying a `timeout` record. It
 * is deliberately not a bare `failed`: the candidate's code did nothing wrong, and a caller that
 * wants to retry rather than reject branches on `timeout !== null`. The cancel is issued here
 * because whoever judged the timeout owns the duty to stop the spend — leaving a timed-out job
 * running silently bills GPU hours nobody is watching.
 */
export async function pollWithLimits({ platform, job, now, limits }) {
  if (!types.object(job) || !types.string(job.job_id)) {
    refused('pollWithLimits needs a job row with a job_id')
  }
  if (!types.number(now)) refused('pollWithLimits needs a millisecond timestamp')

  const polled = await pollJob(platform, job.job_id)
  if (TERMINAL_STATES.includes(polled.state)) return { ...polled, timeout: null }

  const timeout = judgeTimeout({ job, now, limits })
  if (timeout === undefined) return { ...polled, timeout: null }

  const canceled = await cancelJob(platform, job.job_id)
  return assertPollResult({
    state: 'failed',
    error_class: 'canceled',
    metrics: polled.metrics,
    timing: polled.timing,
    error_detail: {
      message: `${timeout.kind} timeout after ${timeout.elapsed_ms}ms (limit ${timeout.limit_ms}ms); the poller stopped the job`,
      ...(polled.error_detail ?? {}),
    },
    timeout: { ...timeout, canceled: canceled.accepted, state_after: canceled.state_after },
  })
}

// ---------------------------------------------------------------- conformance

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pollUntilTerminal(platform, jobId, { tries = 500, delayMs = 10 } = {}) {
  let last
  for (let index = 0; index < tries; index += 1) {
    last = await pollJob(platform, jobId)
    if (TERMINAL_STATES.includes(last.state)) return last
    await sleep(delayMs)
  }
  throw new Error(`job ${jobId} never reached a terminal state (last observed: ${last?.state})`)
}

/**
 * Wait for the first *decisive* observation. A disturbance ("the dashboard is down", "the job record
 * is gone") takes a moment to become real on a subprocess-backed medium, and pretending otherwise
 * would only make this suite pass on a fast machine. The assertion stays sharp: whichever of
 * `wanted` shows up first must be the right one, and a job that instead reaches a terminal state is
 * returned so the test fails on the value rather than on a timeout.
 */
async function firstObservation(platform, jobId, wanted, { tries = 200, delayMs = 10 } = {}) {
  let last
  for (let index = 0; index < tries; index += 1) {
    last = await pollJob(platform, jobId)
    if (wanted.includes(last.state) || TERMINAL_STATES.includes(last.state)) return last
    await sleep(delayMs)
  }
  return last
}

/**
 * The suite every executor must pass. Exported from `lib/` on purpose: it is part of the contract,
 * not part of our test folder, so a contributor writing a Slurm backend runs the same assertions.
 *
 * `fresh()` returns one isolated world:
 *
 *   platform          the implementation under test, exactly as the kernel receives it
 *   script(id, spec)  tell the *job* what to do, before submitting it. This is test glue owned by
 *                     the implementation's own adapter — the port has no such hook, and adding one
 *                     would let a bug hide behind "the fake says so".
 *                     spec: { outcome: 'succeeded'|'code'|'oom'|'data', metrics?: object,
 *                             hang?: boolean, disturb?: 'unavailable'|'vanish' }
 *   close()           stop anything still running and release temporary state
 *
 * `disturb` is what makes `unknown` and `lost` real instead of asserted: 'unavailable' means the
 * first observation cannot be answered (network failure, unreadable status) and 'vanish' means the
 * platform says the job never existed (404, job record gone). Each implementation realizes them
 * through its own medium — a dashboard that is down, a status file that was never written.
 *
 * @param {import('node:test').TestContext} t
 * @param {{name: string, fresh: () => Promise<object>}} options
 */
export async function runPlatformConformance(t, { name, fresh }) {
  if (typeof fresh !== 'function') throw new TypeError('runPlatformConformance needs a fresh() factory')
  const label = name ?? 'platform'

  const open = async () => {
    const harness = await fresh()
    if (typeof harness?.script !== 'function' || typeof harness?.close !== 'function') {
      throw new TypeError(`${label}: fresh() must return { platform, script(), close() }`)
    }
    assertPlatform(harness.platform)
    return harness
  }

  await t.test(`${label}: submit → poll → collect carries the job's own metric back`, async () => {
    const harness = await open()
    try {
      const metrics = { val_loss: 0.3125, samples_per_s: 1234.5 }
      harness.script('cand_ok', { outcome: 'succeeded', metrics })
      const submitted = assertSubmitResult(
        await submitJob(harness.platform, { submissionId: 'cand_ok', candidateId: 'cand_ok', gpuHours: 0.2 }),
      )
      assert.equal(typeof submitted.job_id, 'string', 'a submitted job must be addressable or nothing else follows')

      const first = await pollJob(harness.platform, submitted.job_id)
      assert.ok(
        ['running', 'succeeded'].includes(first.state),
        `first poll must be running or already done, not ${first.state}`,
      )

      const done = await pollUntilTerminal(harness.platform, submitted.job_id)
      assert.equal(done.state, 'succeeded')
      assert.deepEqual(done.metrics, metrics, 'poll must report the metrics the job computed')

      const collected = assertCollectResult(await collectJob(harness.platform, submitted.job_id))
      assert.equal(collected.state, 'succeeded')
      assert.deepEqual(
        collected.metrics,
        metrics,
        'collect must agree with poll — two different numbers for one run is worse than one number',
      )
      assert.ok(Array.isArray(collected.artifacts), 'collect must always answer with an artifacts array')
    } finally {
      await harness.close()
    }
  })

  const failureCases = [
    ['code', 'code', 'a traceback out of the candidate'],
    ['oom', 'oom', 'the kernel OOM killer, not a code error'],
    ['data', 'data', 'missing input data, distinguishable from a bug'],
  ]
  for (const [outcome, expected, why] of failureCases) {
    await t.test(`${label}: a job that fails as ${outcome} is classified ${expected} — ${why}`, async () => {
      const harness = await open()
      try {
        harness.script(`cand_${outcome}`, { outcome })
        const submitted = await submitJob(harness.platform, {
          submissionId: `cand_${outcome}`,
          candidateId: `cand_${outcome}`,
          gpuHours: 0.2,
        })
        const done = await pollUntilTerminal(harness.platform, submitted.job_id)
        assert.equal(done.state, 'failed')
        assert.equal(
          done.error_class,
          expected,
          `${expected} must survive to the caller; an executor that reports every failure as "failed" hands the analyze phase nothing to decide on`,
        )
        const collected = assertCollectResult(await collectJob(harness.platform, submitted.job_id))
        assert.equal(collected.metrics, undefined, 'a failed job must never be handed back metrics')
      } finally {
        await harness.close()
      }
    })
  }

  await t.test(`${label}: a job the platform cannot see yet is unknown, not lost`, async () => {
    const harness = await open()
    try {
      harness.script('cand_unseen', { outcome: 'succeeded', metrics: { val_loss: 0.4 }, disturb: 'unavailable' })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_unseen',
        candidateId: 'cand_unseen',
        gpuHours: 0.2,
      })
      const observed = await firstObservation(harness.platform, submitted.job_id, ['unknown'])
      assert.equal(
        observed.state,
        'unknown',
        'not knowing is not the same as the job being gone: calling this lost kills a job that is running fine',
      )
      assert.equal(observed.error_class, undefined, 'we have no evidence, so we must not classify a failure')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: a job the platform says does not exist is lost`, async () => {
    const harness = await open()
    try {
      harness.script('cand_gone', { outcome: 'succeeded', metrics: { val_loss: 0.4 }, disturb: 'vanish' })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_gone',
        candidateId: 'cand_gone',
        gpuHours: 0.2,
      })
      const observed = await firstObservation(harness.platform, submitted.job_id, ['lost', 'unknown'])
      assert.equal(observed.state, 'lost', 'a 404 is a conclusion: retrying it forever is how a candidate blocks a round')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: cancel reports canceled and never collapses into a plain failure`, async () => {
    const harness = await open()
    try {
      harness.script('cand_cancel', { outcome: 'succeeded', metrics: { val_loss: 0.4 }, hang: true })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_cancel',
        candidateId: 'cand_cancel',
        gpuHours: 0.2,
      })
      assert.equal((await pollJob(harness.platform, submitted.job_id)).state, 'running')

      const canceled = assertCancelResult(await cancelJob(harness.platform, submitted.job_id))
      assert.equal(canceled.accepted, true)

      const done = await pollUntilTerminal(harness.platform, submitted.job_id)
      assert.equal(done.state, 'failed', 'canceled is an error class; state stays inside the closed five')
      assert.equal(
        done.error_class,
        'canceled',
        'a run we stopped ourselves must not look like a candidate defect — a stop policy cannot tell them apart otherwise',
      )
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: submitting the same submission_id twice lands on the same job`, async () => {
    const harness = await open()
    try {
      harness.script('cand_dup', { outcome: 'succeeded', metrics: { val_loss: 0.5 } })
      const request = { submissionId: 'cand_dup', candidateId: 'cand_dup', gpuHours: 0.2 }
      const first = await submitJob(harness.platform, request)
      const second = await submitJob(harness.platform, request)

      assert.equal(second.duplicate, true, 'the platform said "already exists"; the caller must be told')
      assert.equal(
        second.job_id,
        first.job_id,
        'a duplicate submission_id is the same job — anything else is a second job burning a second GPU',
      )

      const found = await findJob(harness.platform, 'cand_dup')
      assert.equal(found?.job_id, first.job_id, 'find must resolve the job the platform really has')

      const done = await pollUntilTerminal(harness.platform, second.job_id)
      assert.equal(done.state, 'succeeded', 'going straight to polling after a duplicate must work')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: find answers for a candidate we submitted and undefined for one we never did`, async () => {
    const harness = await open()
    try {
      assert.equal(await findJob(harness.platform, 'cand_never'), undefined)
      harness.script('cand_found', { outcome: 'succeeded', metrics: { val_loss: 0.2 } })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_found',
        candidateId: 'cand_found',
        gpuHours: 0.2,
      })
      const found = await findJob(harness.platform, 'cand_found')
      assert.equal(found.job_id, submitted.job_id)
      assert.ok(STATES.includes(found.state))
      assert.equal(typeof found.submitted_at_ms, 'number', 'recovery needs to know how old the job is')
      assert.equal(typeof found.deadline_ms, 'number', 'recovery needs the absolute deadline, not a duration')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: collect reads the same job from an id or from the poll result, and refuses anything else`, async () => {
    const harness = await open()
    try {
      const metrics = { val_loss: 0.25 }
      harness.script('cand_shape', { outcome: 'succeeded', metrics })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_shape',
        candidateId: 'cand_shape',
        gpuHours: 0.2,
      })
      const done = await pollUntilTerminal(harness.platform, submitted.job_id)

      const byId = assertCollectResult(await collectJob(harness.platform, submitted.job_id))
      const byPollResult = assertCollectResult(await collectJob(harness.platform, done))
      const raw = assertCollectResult(await harness.platform.collect(done))

      for (const answer of [byPollResult, raw]) {
        assert.equal(answer.state, byId.state, 'the poll result and the id are the same job; two answers would be worse than one')
        assert.deepEqual(answer.metrics, metrics)
      }

      // A malformed argument is a caller bug. It must never be answered as `lost`: a job we just
      // watched succeed, reported missing, is what sends a restart to resubmit a finished run.
      for (const wrong of [undefined, null, 42, {}, { job_id: 7 }, []]) {
        await assert.rejects(
          async () => harness.platform.collect(wrong),
          (error) => error instanceof TypeError,
          `collect(${JSON.stringify(wrong)}) must throw a TypeError rather than answer with a state`,
        )
      }
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: collect never invents metrics for a job that has not finished`, async () => {
    const harness = await open()
    try {
      harness.script('cand_partial', { outcome: 'succeeded', metrics: { val_loss: 0.9 }, hang: true })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_partial',
        candidateId: 'cand_partial',
        gpuHours: 0.2,
      })
      const collected = assertCollectResult(await collectJob(harness.platform, submitted.job_id))
      assert.equal(collected.state, 'running')
      assert.equal(collected.metrics, undefined, 'a partial run has no result; zeros here become a candidate score')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: a job over its wall clock is stopped by the poller and the timeout is recorded`, async () => {
    const harness = await open()
    try {
      harness.script('cand_wall', { outcome: 'succeeded', metrics: { val_loss: 0.7 }, hang: true })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_wall',
        candidateId: 'cand_wall',
        gpuHours: 0.2,
      })
      const now = 1_700_000_000_000
      const polled = await pollWithLimits({
        platform: harness.platform,
        job: { job_id: submitted.job_id, submitted_at_ms: now - 120_000, started_at_ms: now - 119_000 },
        now,
        limits: { max_wall_ms: 60_000, max_idle_ms: 0 },
      })

      assert.equal(polled.state, 'failed', 'a timed-out job must stop looking like a live one')
      assert.equal(polled.error_class, 'canceled', 'we stopped it; the candidate did not fail')
      assert.equal(polled.timeout?.kind, 'wall')
      assert.equal(polled.timeout?.canceled, true, 'judging the timeout without stopping the job bills hours nobody watches')

      const after = await pollUntilTerminal(harness.platform, submitted.job_id)
      assert.equal(after.error_class, 'canceled', 'the cancel must have reached the platform, not just the return value')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: a job alive but silent past its idle limit is stopped too`, async () => {
    const harness = await open()
    try {
      harness.script('cand_idle', { outcome: 'succeeded', metrics: { val_loss: 0.7 }, hang: true })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_idle',
        candidateId: 'cand_idle',
        gpuHours: 0.2,
      })
      const now = 1_700_000_000_000
      const polled = await pollWithLimits({
        platform: harness.platform,
        job: {
          job_id: submitted.job_id,
          submitted_at_ms: now - 90_000,
          started_at_ms: now - 89_000,
          last_progress_at_ms: now - 45_000,
        },
        now,
        limits: { max_wall_ms: 0, max_idle_ms: 30_000 },
      })
      assert.equal(polled.timeout?.kind, 'idle', 'a run whose metric stopped moving is a hang, not patience')
      assert.equal(polled.error_class, 'canceled')
    } finally {
      await harness.close()
    }
  })

  await t.test(`${label}: a job inside its limits is left alone`, async () => {
    const harness = await open()
    try {
      harness.script('cand_patient', { outcome: 'succeeded', metrics: { val_loss: 0.7 }, hang: true })
      const submitted = await submitJob(harness.platform, {
        submissionId: 'cand_patient',
        candidateId: 'cand_patient',
        gpuHours: 0.2,
      })
      const now = 1_700_000_000_000
      const polled = await pollWithLimits({
        platform: harness.platform,
        job: { job_id: submitted.job_id, submitted_at_ms: now - 1_000, started_at_ms: now - 900 },
        now,
        limits: { max_wall_ms: 60_000, max_idle_ms: 30_000 },
      })
      assert.equal(polled.state, 'running')
      assert.equal(polled.timeout, null, 'the watchdog must not stop a healthy job: that is the whole point of a grace window')
    } finally {
      await harness.close()
    }
  })
}