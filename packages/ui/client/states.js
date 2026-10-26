/**
 * The candidate-state vocabulary: one copy of the words and the mark names a state goes by.
 *
 * Three surfaces name the same states — the round rail (a square per candidate), the candidate
 * inspector (the phase path, and the sentence beside the candidate's id), and the Web UI panel, which
 * ticket #6 mounts over the same projection. A word kept in each renderer is three copies to change
 * and two chances to disagree, which is the drift constraint 2 forbids for numbers; ticket #5 asks
 * for the same discipline over the words that stand in for them.
 *
 * Two rules govern what is in here:
 *
 *   - **Facts, not mood** (CODING_STANDARDS §2). `ok` / `missing` / `invalid` / `conflict` answer "is
 *     this fact present and trustworthy". "The answer was no" — a candidate that lost, a comparison
 *     that came out behind — is never one of them, and has no word here.
 *   - **A shape is a coarse read of a word, never a substitute for it.** `phaseMark()` returns both
 *     the mark a phase draws and the word printed beside it, because a mark alone asks the reader to
 *     remember a legend and fails a reader who cannot see it.
 *
 * This module is deliberately free of the DOM and of colour: it names things. The stylesheet decides
 * what a mark looks like, and it does that with fill, dash, hatch and border weight only — six marks,
 * no hue, so a greyscale screenshot separates them as well as a colour one does.
 *
 * @module
 */

/** The four states, in the contract's order: present and good, absent, present and broken, and two facts disagreeing. */
export const STATE_ORDER = Object.freeze(['ok', 'missing', 'invalid', 'conflict'])

/** The four-state words themselves. The contract's own spelling, not a friendlier synonym. */
export const STATE_WORDS = Object.freeze({ ok: 'ok', missing: 'missing', invalid: 'invalid', conflict: 'conflict' })

/**
 * The five shapes the rail draws, in the order the key lists them.
 *
 * A shape is the projection's decision (`shapeOf`): rejected-because-invalid is its own shape, and
 * "completed, on the frontier" is a different thing to look at than "completed".
 */
export const SHAPE_WORDS = Object.freeze({
  done: 'completed',
  frontier: 'completed, on the frontier',
  rejected: 'rejected',
  'in-flight': 'in flight',
  invalid: 'invalid artifact',
})

/**
 * What a round did to the best result — the projection decides which one applies, this names it.
 *
 * `running` is the unfinished round: its candidates are still spending, so it has not produced nothing
 * (that is `empty`), it simply has not concluded. A rail that called it "empty round" while drawing
 * its squares as in flight said two things about one cell.
 */
export const VERDICT_WORDS = Object.freeze({ raised: 'raised', held: 'held', empty: 'empty round', running: 'running' })

/** The two facts about a phase that are not states: never entered, and entered but never judged. */
export const MARK_WORDS = Object.freeze({ 'no-verdict': 'no verdict', 'not-reached': 'not reached' })

/**
 * One phase of the path, as a mark and a word.
 *
 * `status` is the four-state word the projection recorded at that phase, or `null`. The order of the
 * questions matters: a recorded verdict wins (it is what a gate concluded), then "the candidate got
 * here but nothing judged it", then "the candidate never got here at all".
 *
 * The last two are the distinction ticket 29 exists for. `missing` means the artifact is not there;
 * "not reached" means the candidate never arrived to look. Drawing both as an empty square is how a
 * reader concludes a candidate was refused by a check nobody ran.
 *
 * @param {{ status?: string | null, reached?: boolean }} phase one entry of the projection's `phasePath`
 * @returns {{ mark: string, word: string }} the `data-mark` a renderer puts on the phase, and the word beside it
 */
export function phaseMark({ status, reached } = {}) {
  if (STATE_ORDER.includes(status)) return { mark: status, word: STATE_WORDS[status] }
  return reached === true
    ? { mark: 'no-verdict', word: MARK_WORDS['no-verdict'] }
    : { mark: 'not-reached', word: MARK_WORDS['not-reached'] }
}
