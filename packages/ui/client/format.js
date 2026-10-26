/**
 * The one place a fact becomes words: a clock time, a number, a percentage, a cursor.
 *
 * The page and the Web UI panel both render the same facts, and they must render them the *same way* —
 * so the formatting lives here, is served by the host at `/api/reprise/format.js`, and is imported by
 * both clients instead of being written twice (spec §9.1). Two formatters is how one surface starts
 * saying `0.7331` while the other says `0.73`, and a reader comparing them has no way to know which
 * one is lying.
 *
 * Three properties are load-bearing:
 *
 *   1. **Plain ESM with no imports.** The browser loads this file directly from a route: there is no
 *      bundler to resolve a bare specifier, no build-time environment to read, no Node built-in. It
 *      has to pass `node --check` and run under a plain module loader, because that is all the browser
 *      gives it.
 *   2. **Absence has a word.** `undefined` on screen was one of the defects this exists to fix, so
 *      every function answers the em dash for a value it cannot render — including a string where a
 *      number belongs, and `NaN`, which is the shape a broken subtraction takes.
 *   3. **Formatting is not derivation.** Nothing here subtracts, compares or decides a direction. A
 *      percentage arrives already computed (the projection's `changePercent`), because computing it
 *      here would be a second derivation of a number the dump also prints.
 *
 * @module
 */

/** The word for "there is no value here". Not `0`, not `null` on screen, not an empty string. */
export const EM_DASH = '—'

/** At most this many decimals, so two readings of one fact stay comparable without inventing noise. */
const MAX_DECIMALS = 6

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const pad = (value, width = 2) => String(value).padStart(width, '0')

/**
 * A local wall-clock time, `22:14:40`.
 *
 * The fact stream is a column of instants, and `1792679808000` is not one a person reads. Local time
 * is deliberate: the reader is looking at a run that happened where they are, and a UTC stamp with no
 * zone named is the worse lie.
 *
 * @param {unknown} atMs epoch milliseconds
 */
export function clock(atMs) {
  if (!isNumber(atMs)) return EM_DASH
  const at = new Date(atMs)
  if (Number.isNaN(at.getTime())) return EM_DASH
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/** The same instant with its date, `2026-10-22 14:36:48`, for a line that has to say *when*. */
export function stamp(atMs) {
  if (!isNumber(atMs)) return EM_DASH
  const at = new Date(atMs)
  if (Number.isNaN(at.getTime())) return EM_DASH
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock(atMs)}`
}

/**
 * A number as the facts recorded it, trimmed to at most six decimals.
 *
 * Trimming rather than padding is the point: a baseline is `0.706981` and a result is `0.7331`, and
 * rounding either to four places hides the difference the page exists to show. `0.7` stays `0.7`
 * instead of becoming `0.700000`, so a round number is visibly round.
 *
 * @param {unknown} value
 */
export function number(value) {
  if (!isNumber(value)) return EM_DASH
  return String(Number(value.toFixed(MAX_DECIMALS)))
}

/**
 * A change, signed, so "which way" survives without a colour: `+0.026119`, `-0.0021`, `0`.
 *
 * @param {unknown} value
 */
export function change(value) {
  if (!isNumber(value)) return EM_DASH
  const text = number(value)
  return value > 0 ? `+${text}` : text
}

/**
 * A percentage number — `3.694549` in, `3.69%` out.
 *
 * The argument is a *percentage*, not a ratio: the projection already multiplied by 100, and a
 * formatter that multiplied again would be a second derivation of the same claim.
 *
 * @param {unknown} value
 * @param {{ digits?: number, sign?: boolean }} [options] `sign` prefixes a `+`, for a change
 */
export function percent(value, { digits = 2, sign = false } = {}) {
  if (!isNumber(value)) return EM_DASH
  const magnitude = Math.abs(value).toFixed(digits)
  if (value < 0) return `-${magnitude}%`
  // No `+` on zero: a change of nothing is not a change in a direction, same rule as `change()`.
  return `${sign && value > 0 ? '+' : ''}${magnitude}%`
}

/** `<wall_clock_ms>:<candidate_id>:<local_seq>` — the order key one fact, as the host spells it. */
const CURSOR = /^(\d+):(.+):(\d+)$/

/**
 * A cursor a person can read: `22:36:48 · r6-g1 · seq 8`.
 *
 * The grammar is the host's own (`views.js` `cursorOf`), and this is the reader-facing rendering of it.
 * A string that does not match is passed through unchanged rather than hidden: if the host ever sends
 * a different cursor shape, the page should show the cursor it was given, not a dash that looks like
 * "no facts".
 *
 * @param {unknown} value
 */
export function cursor(value) {
  if (typeof value !== 'string' || value === '') return EM_DASH
  const match = CURSOR.exec(value)
  if (match === null) return value
  return `${clock(Number(match[1]))} · ${match[2]} · seq ${match[3]}`
}