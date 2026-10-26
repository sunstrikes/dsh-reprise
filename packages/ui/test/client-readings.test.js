/**
 * Guards ticket #4's rendering half: the stop gauges, the readings row, the budget bar and the
 * cluster cell (spec §6.3, §6.6, §6.9).
 *
 * A Node test cannot see a bar, so what is held here is the part that *can* be checked without a
 * browser — the same discipline `client.test.js` applies to the rest of the page:
 *
 *   - the page reads the numbers the projection publishes and computes none of its own (constraint 2:
 *     one derivation per number);
 *   - the three materials of the budget bar are a fill, a hatch and an emptiness, each named in the
 *     legend, so a greyscale screenshot still separates settled from reserved from remaining
 *     (constraint 3, and spec §5's "one texture, no hues");
 *   - the words over `reserved − settled` say what the number is — a reservation, including what a
 *     finished candidate did not spend — and never "in flight".
 *
 * The screenshots are the other half — a throwaway harness outside the repo, and the screenshots
 * taken beside this suite; this file is what fails in CI when the two drift apart.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'client')
const read = (name) => readFileSync(join(CLIENT_DIR, name), 'utf8')

/** Comments explain the rules and paint nothing, so the scans below read code only. */
const code = (name) => read(name).replace(/\/\*[\s\S]*?\*\//g, '')

test('the stop section and the readings row sit where the eye looks for them: above and below the staircase', () => {
  const page = read('index.html')

  const stop = page.indexOf('id="stop"')
  const ladder = page.indexOf('id="ladder"')
  const readings = page.indexOf('id="readings"')

  assert.ok(stop > 0, 'the page has a place for the stop rules')
  assert.ok(readings > 0, 'and one for the readings')
  assert.ok(stop < ladder, '"how close is it to stopping" is answered before the chart')
  assert.ok(ladder < readings, 'and "how much has it spent" comes after the evidence, not before it')
  assert.ok(readings < page.indexOf('id="candidate"'), 'the inspector keeps the lower half of the page')
})

test('the budget bar draws the three materials and the two markers the projection published', () => {
  const source = code('dashboard.js')
  const css = read('dashboard.css')

  // Every share is the projection's: a page that divided here would be a second derivation of a
  // number the panel will also print (constraint 2).
  for (const field of ['settledPercent', 'reservedPercent', 'remainingPercent', 'softLimitPercent']) {
    assert.match(source, new RegExp(`\\b${field}\\b`), `the bar is drawn from ${field}`)
  }
  assert.match(source, /scaleGpuHours/, 'and from the scale the projection chose, not one of its own')

  // The three materials, each a rule of its own: a solid fill, a hatch, and nothing (the track).
  assert.match(source, /'data-material': 'settled'/, 'settled is drawn as its own material')
  assert.match(source, /'data-material': 'reserved'/, 'so is the reservation')
  assert.match(source, /'data-material': 'remaining'/, 'and the rest of the cap')
  assert.match(css, /\.budget-segment\[data-material='settled'\]\s*\{[^}]*background: currentColor/, 'settled is a solid ink fill')
  assert.match(
    css,
    /\.budget-segment\[data-material='reserved'\]\s*\{[^}]*repeating-linear-gradient/,
    'reserved is a hatch: a texture survives a greyscale screenshot, a hue does not',
  )

  // The two markers, and the legend that names them ("a marker nobody can name is not information").
  assert.match(source, /'data-marker': 'soft'/, 'the soft limit is a marker of its own')
  assert.match(source, /'data-marker': 'limit'/, 'and so is the cap')
  assert.match(css, /\.budget-marker\[data-marker='soft'\]/, 'the stylesheet draws the soft-limit marker')
  assert.match(css, /\.budget-marker\[data-marker='limit'\]/, 'and the cap marker')
  assert.match(source, /soft limit/, 'the legend names the soft limit')
  assert.match(source, /cap /, 'and the cap')
})

test('the reserved material is named for what it is, and never called work in flight', () => {
  const source = code('dashboard.js')

  assert.match(source, /reserved, not yet settled/, 'the reservation says so in words, in the legend and in the cell')
  assert.match(
    source,
    /reservedUnsettledGpuHours/,
    'and it is read under a field named for what it is, not under the ledger\'s `inFlightGpuHours`',
  )
  assert.doesNotMatch(
    source,
    /inFlightGpuHours/,
    'the ledger field whose name suggests "in flight" is never what this page puts on screen: it is a leftover reservation',
  )
  // The one clause that makes the number honest: it is not work that is running.
  assert.match(source, /did not spend|has not been settled|not yet settled/, 'the cell explains the reservation in one clause')
})

test('the page divides nothing: the shares, the distance and the floor all arrive computed', () => {
  const source = code('dashboard.js')

  // The published shares and distances are *drawn*, never recomputed: any operator applied to one of
  // these fields would be a second derivation of a number the panel also prints. (The staircase's one
  // division — where a value sits between two published axis bounds — is placement, and is not one of
  // these fields.)
  for (const field of ['settledPercent', 'reservedPercent', 'remainingPercent', 'softLimitPercent', 'distancePercent']) {
    assert.doesNotMatch(source, new RegExp(`${field}\\s*[*/+-]`), `${field} is used as published`)
  }
  assert.doesNotMatch(
    source,
    /(GpuHours|Percent|observed)\s*\/\s*[\w.$]+/,
    'no renderer divides one reading by another — the reading is "3 / 3" to a reader, and never a ratio',
  )
  assert.doesNotMatch(source, /GpuHours\s*[-+]/, 'nor subtracts two spend readings')
  assert.match(source, /rule\.distancePercent/, 'the gauge fill is the projection\'s distance')
})

test('no cap is a state: the cell says so and the bar is scaled by what was used', () => {
  const source = code('dashboard.js')

  assert.match(source, /budget\.limited/, 'the page branches on whether there is a cap at all')
  assert.match(source, /no cap/i, 'and says so rather than printing a 0 it made up')
  assert.doesNotMatch(source, /scaleGpuHours\s*(\?\?|\|\|)\s*0/, 'a missing scale is never defaulted to zero')
  assert.match(source, /nothing spent yet/i, 'and a run that has spent nothing says that instead of drawing 0/0')
})

test('every stop rule the kernel declares has a name on the page, and no rule is left unnamed', () => {
  // Read the producer's list rather than restating it: a rule added to the kernel and forgotten here
  // would render as a raw `max_something` in the gauge row, which is the defect this prevents.
  const kernel = readFileSync(new URL('../../core/lib/stop.js', import.meta.url), 'utf8')
  const declared = /export const STOP_RULES = Object\.freeze\(\[([^\]]+)\]\)/.exec(kernel)?.[1]
  const rules = [...(declared ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  assert.ok(rules.length >= 5, 'the kernel still declares its workspace rules')

  const source = code('dashboard.js')
  const words = [...source.matchAll(/^\s{2}([a-z_]+): '/gm)].map((match) => match[1])

  for (const rule of rules) {
    assert.ok(words.includes(rule), `the page names ${rule} instead of printing its identifier`)
  }
})

test('a rule with no reading says so instead of drawing a zero-length gauge', () => {
  const source = code('dashboard.js')
  const css = read('dashboard.css')

  assert.match(source, /rule\.enabled/, 'a rule that is configured off is a state the page branches on')
  assert.match(source, /rule\.observed === null/, 'and a rule nobody measured is a different state from a rule at zero')
  assert.match(source, /unmeasured/, 'the page shows the sentence the projection wrote for it')
  assert.match(source, /none of them has fired/, 'while a running run says that plainly')
  // The three states a gauge can be in, each with a rule: off, measured, and the one that fired.
  for (const state of ['disabled', 'measured', 'fired']) {
    assert.ok(css.includes(`.stop-rule[data-state='${state}']`), `the stylesheet draws a rule in state "${state}"`)
  }
  // "Fired" is marked by weight and a dot, not by a colour.
  assert.match(
    css,
    /\.stop-rule\[data-state='fired'\][^{]*\{[^}]*font-weight: 600/,
    'the rule that fired is bold',
  )
  assert.match(source, /stop-dot/, 'and carries a filled dot at the end of its row')
})

test('the cluster cell keeps "unknown" a word and answers it with what our own ledger holds', () => {
  const source = code('dashboard.js')

  assert.match(source, /cards\.floorAbsent/, 'a floor nobody could compute arrives as a sentence, not a dash')
  assert.match(source, /at least/, 'and the sentence the page writes names what the ledger can support')
  assert.match(source, /queue\?\.count|queue\.count/, 'the cell also names how many candidates are waiting')
  assert.doesNotMatch(source, /floor\s*(\?\?|\|\|)\s*0/, 'the floor is never defaulted to zero')
})