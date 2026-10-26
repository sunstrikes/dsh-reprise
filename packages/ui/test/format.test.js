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

import { EM_DASH, change, clock, cursor, cursorAt, fixed, number, pathTail, percent, stamp } from '../client/format.js'

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

test('the axis gets a number of one fixed width, because three labels of different widths read as three scales', () => {
  // `number()` trims, which is right for a reading ("0.7 is visibly round") and wrong for an axis:
  // `0.72` over `0.7183` over `0.71` makes the top and bottom labels look like coarser quantities than
  // the middle one. One padded variant, so the padding is not re-invented at three call sites.
  assert.equal(fixed(0.72), '0.7200')
  assert.equal(fixed(0.7183), '0.7183')
  assert.equal(fixed(0.70227958), '0.7023')
  assert.equal(fixed(2), '2.0000')
  assert.equal(fixed(0.7331, 5), '0.73310', 'another width, when a metric needs one')
  for (const value of ABSENT) assert.equal(fixed(value), EM_DASH, `fixed(${String(value)})`)
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

test('a cursor names one instant, and both surfaces read that instant the same way', () => {
  // The `last fact` stamp used to be a running maximum the renderer kept over the facts it happened
  // to have read, while the cursor beside it came from the server. Two readers of one page could then
  // print two different instants for "the newest fact" — and the Web UI panel, which sees only a
  // window of facts, would have printed a third. The envelope's `cursor` already names the instant, so
  // that is where it comes from, and `cursor()` is parsed by this one function.
  assert.equal(cursorAt('1792679080000:r6-g1:8'), 1792679080000)
  assert.equal(cursor('1792679080000:r6-g1:8'), `${clock(cursorAt('1792679080000:r6-g1:8'))} · r6-g1 · seq 8`)

  for (const value of ABSENT_CURSOR) assert.equal(cursorAt(value), null, `cursorAt(${String(value)})`)
  assert.equal(cursorAt(''), null, 'an empty cursor names no instant')
  assert.equal(cursorAt('some-new-cursor-shape'), null, 'a string that is not a cursor names no instant')
})

test('a workspace path is shortened to its last segments, and a short one is left alone', () => {
  // Spec §6.1: the masthead names the workspace by its last three segments. The full path stays
  // available on the element (`title`), because a shortened path nobody can recover is a path lost.
  assert.equal(pathTail('/Users/sunminqi/code/x/design/ws/run'), '…/design/ws/run')
  assert.equal(pathTail('/a/b/c/d'), '…/b/c/d')
  assert.equal(pathTail('/tmp/reprise-ui'), '/tmp/reprise-ui', 'a path with nothing to cut is printed whole')
  assert.equal(pathTail('/a/b/c'), '/a/b/c')
  assert.equal(pathTail(undefined), EM_DASH)
  assert.equal(pathTail(''), EM_DASH)
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