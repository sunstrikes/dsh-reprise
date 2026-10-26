/**
 * What the kernel does when no model answered — in one place, at every judgement point.
 *
 * Five places consult a model (LAND, VERIFY, CAND_ANALYZE, ROUND_PLAN, ROUND_REFLECT) and each one
 * asked through a different piece of code. Before this module, an outage reached each of them as a
 * different story: the review "rejected", the analysis "had no root cause", the plan "named no
 * hypothesis", the landing "failed", and the round workflow retried the lot three times before
 * asking a human to fix a provider. All of those turn "the model is unreachable" into a fact about a
 * candidate, and a candidate rejected for a provider outage is a decision nobody made.
 *
 * Three decisions hold here:
 *
 * 1. **The condition is one name**, re-exported from the adapter (`model_unavailable`) rather than
 *    re-spelled per phase, so the boot log, the ops log and the dashboard cannot drift apart.
 * 2. **It is an operator fact, not a candidate fact.** The row goes to `ops_log` — the table for
 *    bookkeeping that is not an event — because no candidate changed phase and no artifact was
 *    refused. Nothing is inferred from it by the phase machine.
 * 3. **It backs off; it does not reject and it does not wait.** The step returns immediately with
 *    `next_action_at`, so the tick loop keeps breathing and the operator sees the outage on the next
 *    read instead of a phase that looks hung. There is no attempt budget: a provider coming back is
 *    a matter of when, not of how many tries, and pausing for a human would ask them to fix something
 *    that is not theirs.
 *
 * @module
 */

import { MODEL_UNAVAILABLE, isModelUnavailable, isNoAnswerClass } from '@dsh-reprise/exec/model'

export { MODEL_UNAVAILABLE, isModelUnavailable, isNoAnswerClass }

/** The ops-log row type. One spelling, so a reader greps one word. */
export const MODEL_UNAVAILABLE_OP = MODEL_UNAVAILABLE

/**
 * An outage doubles from a minute, capped at an hour. Not the candidate's retry budget: that budget
 * exists because a malformed artifact might be a bad first roll, while an unreachable provider is a
 * condition of the outside world.
 */
export const OUTAGE_BACKOFF = Object.freeze({ base_ms: 60_000, max_ms: 3_600_000 })

/**
 * A machine that could not start the process is a local condition that clears by itself, so it is
 * retried in seconds. Lumping it in with "the provider is down" would turn a busy host into an hour
 * of silence, which is the failure mode a backoff is supposed to prevent.
 */
export const RESOURCE_BACKOFF = Object.freeze({ base_ms: 1_000, max_ms: 60_000 })

const backoffFor = (cause, retry) => {
  if (retry !== undefined) return retry
  return cause === 'resource_exhausted' ? RESOURCE_BACKOFF : OUTAGE_BACKOFF
}

/** The failure shape every caller passes on, whatever threw it. */
export function modelFailureOf(error) {
  if (error !== null && typeof error === 'object') {
    return {
      error_class: typeof error.error_class === 'string' ? error.error_class : MODEL_UNAVAILABLE,
      cause: typeof error.cause === 'string' ? error.cause : null,
      message: typeof error.message === 'string' && error.message !== '' ? error.message : 'no model answered',
    }
  }
  return { error_class: MODEL_UNAVAILABLE, cause: null, message: String(error) }
}

/** Would this harness result mean "no model answered" rather than "the answer was no"? */
export const isOutage = (errorClass) => isNoAnswerClass(errorClass)

/**
 * Record one outage and compute when to try again.
 *
 * @param {{store: any, now: number, step: string, subject?: string|null,
 *          failure: {error_class: string, cause: string|null, message: string},
 *          attempts?: number, retry?: {base_ms: number, max_ms: number}}} input
 * @returns {{action: string, step: string, subject: string|null, error_class: string,
 *            cause: string|null, message: string, attempts: number, next_action_at: number}}
 */
export function recordModelUnavailable({
  store,
  now,
  step,
  subject = null,
  failure,
  attempts: previous = 0,
  retry = undefined,
}) {
  const attempts = (Number.isSafeInteger(previous) ? previous : 0) + 1
  const ladder = backoffFor(failure.cause, retry)
  const base = Number.isSafeInteger(ladder?.base_ms) ? ladder.base_ms : OUTAGE_BACKOFF.base_ms
  const ceiling = Number.isSafeInteger(ladder?.max_ms) ? ladder.max_ms : OUTAGE_BACKOFF.max_ms
  const delay = Math.min(base * 2 ** Math.min(attempts - 1, 10), ceiling)
  const detail = {
    step,
    subject: subject ?? null,
    error_class: failure.error_class,
    cause: failure.cause,
    message: failure.message,
    attempts,
  }

  // The operator's table, not the candidate's: no phase moved and no artifact was refused.
  store.logOp(MODEL_UNAVAILABLE_OP, detail, now)
  return { ...detail, action: MODEL_UNAVAILABLE_OP, next_action_at: now + delay }
}