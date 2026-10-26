/**
 * Guards the decision "one formatting source for time, numbers, percentages and the cursor" (ticket
 * #2, spec §9.1).
 *
 * The module under test is `client/format.js`: the file the *browser* loads as a plain ES module from
 * `/api/reprise/format.js`, and the file the Web UI panel will import later. It is tested on its own,
 * in Node, for the same reason it exists at all — it is the one place the two clients agree, so it has
 * to be right before either of them leans on it.
 *
 * Two rules the assertions below are built around:
 *
 *   - **Every instant is built from local components** (`new Date(2026, 9, 22, 14, 36, 48)`) so the
 *     expected string is knowable in any timezone. A formatter tested with a UTC epoch would pass in
 *     Shanghai and fail in CI, or worse, pass in both and be wrong in one.
 *   - **Absence has a word.** `undefined`, `null`, `NaN` and a string where a number belongs all
 *     render as the em dash, because the page's whole complaint was `undefined=` on screen. No
 *     formatter may ever emit the text "undefined" or "NaN".
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EM_DASH, change, clock, cursor, number, percent, stamp } from '../client/format.js'

/** A local wall clock the test can state exactly: 2026-10-22 14:36:48 in whatever zone this runs. */
const LOCAL = new Date(2026, 9, 22, 14, 36, 48, 0).getTime()

/** Values that are not the number or instant a formatter needs. */
const ABSENT = [undefined, null, NaN, Infinity, -Infinity, '0.5', {}, []]
/** The same absence, for the one function whose argument *is* a string. */
const ABSENT_CURSOR = [undefined, null, 0, {}, []]

test('clock renders the local wall clock, never an epoch and never a locale string', () => {
  assert.equal(clock(LOCAL), '14:36:48')
  // The oracle is Node's own locale-independent formatter, not the padding the module does.
  assert.equal(clock(LOCAL), new Date(LOCAL).toTimeString().slice(0, 8), 'the same instant, the same clock')
  assert.match(clock(1_792_679_808_000), /^\d{2}:\d{2}:\d{2}$/, 'a raw epoch renders as a time, not as digits')
})

test('stamp renders a local date and its clock, for a line that has to say when', () => {
  assert.equal(stamp(LOCAL), '2026-10-22 14:36:48')
  assert.ok(stamp(LOCAL).endsWith(clock(LOCAL)), 'the two renderings of one instant cannot disagree')
})

test('a number keeps the digits it was measured with, and never grows a sixth decimal of noise', () => {
  assert.equal(number(0.7331), '0.7331', 'the best result, as the fact recorded it')
  assert.equal(number(0.706981), '0.706981', 'a baseline keeps all six digits — rounding it would hide the change')
  assert.equal(number(0.7), '0.7', 'and a round number does not get padded with zeros it never had')
  assert.equal(number(2), '2')
  assert.equal(number(20.9), '20.9')
  assert.equal(number(0.123456789), '0.123457', 'at most six decimals, so two readings of one number stay comparable')
})

test('a change says which way it went, without a colour to say it', () => {
  assert.equal(change(0.026119), '+0.026119')
  assert.equal(change(-0.0021), '-0.0021')
  assert.equal(change(0), '0', 'no change is not a change in either direction')
})

test('a percentage says it is a percentage, and a signed one says which way', () => {
  assert.equal(percent(3.694549), '3.69%')
  assert.equal(percent(3.694549, { digits: 1 }), '3.7%')
  assert.equal(percent(3.694549, { sign: true }), '+3.69%')
  assert.equal(percent(-3.694549, { sign: true }), '-3.69%')
  assert.equal(percent(0, { sign: true }), '0.00%')
})

test('the cursor becomes a time, a subject and a sequence instead of eighteen digits', () => {
  assert.equal(cursor('1792679080000:r6-g1:8'), `${clock(1792679080000)} · r6-g1 · seq 8`)
  // A string that is not a cursor is still what the server called the cursor: pass it through.
  assert.equal(cursor('some-new-cursor-shape'), 'some-new-cursor-shape')
})

test('nothing absent ever prints as a number, a date, or the word undefined', () => {
  for (const value of ABSENT) {
    assert.equal(clock(value), EM_DASH, `clock(${String(value)})`)
    assert.equal(stamp(value), EM_DASH, `stamp(${String(value)})`)
    assert.equal(number(value), EM_DASH, `number(${String(value)})`)
    assert.equal(change(value), EM_DASH, `change(${String(value)})`)
    assert.equal(percent(value), EM_DASH, `percent(${String(value)})`)
  }
  for (const value of ABSENT_CURSOR) assert.equal(cursor(value), EM_DASH, `cursor(${String(value)})`)
  assert.equal(cursor(''), EM_DASH, 'an empty cursor is no cursor')

  const spoken = [clock(LOCAL), stamp(LOCAL), number(0.7331), change(-0.1), percent(1.5), cursor('1:x:2')].join(' ')
  assert.doesNotMatch(spoken, /undefined|NaN/, 'a page that prints these has not formatted anything')
})