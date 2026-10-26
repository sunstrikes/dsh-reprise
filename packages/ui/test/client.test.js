/**
 * Guards the decision "the page follows the host's theme tokens and is served by the host, not by a
 * server of its own" (spec 展示层 "客户端自建 React 组件，用宿主主题 token 对齐"; ticket 11 AC 5).
 *
 * What is testable here, in Node, without a browser: the page and its module are real files the host
 * serves at the two asset paths, the page loads the module by a path relative to itself (so the
 * bundle is relocatable and needs no build step), the module fetches all four view routes and honours
 * the incremental cursor, and neither file hard-codes a colour — every colour is a `--dsw-*` theme
 * token, so the page follows the host's light/dark palette instead of shipping its own.
 *
 * What is NOT testable here and is stated rather than implied: whether the browser paints it. That is
 * the client-render box the testing decisions deliberately leave to a manual check.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { registerRoutes } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

const CLIENT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'client')
const read = (name) => readFileSync(join(CLIENT_DIR, name), 'utf8')

/**
 * A client file with its comments removed, for the scans that are about what the file *does*.
 *
 * A comment paints nothing and compiles to nothing, so scanning prose only forbids explaining a rule
 * — the stylesheet has to be able to say "not a hex triple, not rgb(), not hsl()" in the very header
 * that explains the colour constraint.
 */
const withoutComments = (source, name) =>
  name.endsWith('.html') ? source.replace(/<!--[\s\S]*?-->/g, '') : source.replace(/\/\*[\s\S]*?\*\//g, '')

/** One client file's code, comments stripped. */
const code = (name) => withoutComments(read(name), name)


/**
 * Every file the browser loads from `client/`. Written out rather than read from `ASSETS`: a test that
 * scans the list it is asserting proves nothing about a file nobody added to the list.
 */
const CLIENT_MODULES = ['index.html', 'dashboard.js', 'format.js', 'states.js', 'dashboard.css']

test('the page and its modules are served by the host at the asset routes', async () => {
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: '/tmp/reprise-ui-assets' })
  try {
    const page = await connection.dispatch('GET', '/api/reprise/page')
    assert.equal(page.status, 200)
    assert.match(page.contentType, /text\/html/)
    assert.match(page.text, /<script type="module" src="\.\/dashboard\.js"><\/script>/, 'the page loads its module relatively')

    const module = await connection.dispatch('GET', '/api/reprise/dashboard.js')
    assert.equal(module.status, 200)
    assert.match(module.contentType, /javascript/)
    assert.match(module.text, /export /, 'plain ESM the browser can load directly — no bundler in the path')

    // The formatting module is served beside the page, at the URL `./format.js` resolves to, because
    // the Web UI panel imports the same file later (ticket #2, spec §9.1).
    const format = await connection.dispatch('GET', '/api/reprise/format.js')
    assert.equal(format.status, 200)
    assert.match(format.contentType, /javascript/)
    assert.match(format.text, /export function clock/, 'the one formatting source, importable by both clients')

    // The stylesheet, at the URL the page's `<link href="./dashboard.css">` resolves to. It is a
    // separate file (not an inline `<style>`) because the Web UI panel injects this exact file in
    // ticket #6, and two copies of a token block is how two clients end up with two palettes.
    const stylesheet = await connection.dispatch('GET', '/api/reprise/dashboard.css')
    assert.equal(stylesheet.status, 200)
    assert.match(stylesheet.contentType, /text\/css/)
    assert.match(stylesheet.text, /--reprise-/, 'the shared token block lives here')
    assert.match(stylesheet.text, /\.ladder\b/, 'and the staircase it was added for')

    // The state vocabulary, served beside the page for the same reason `format.js` is: the page
    // imports it as `./states.js`, and ticket #6's panel needs the identical words for the identical
    // states (ticket #5).
    const vocabulary = await connection.dispatch('GET', '/api/reprise/states.js')
    assert.equal(vocabulary.status, 200)
    assert.match(vocabulary.contentType, /javascript/)
    assert.match(vocabulary.text, /export const SHAPE_WORDS/, 'one module names the candidate states')
  } finally {
    dispose()
  }
})

test('the module reads all four views and follows the incremental cursor instead of re-reading everything', () => {
  const source = read('dashboard.js')

  for (const path of ['/api/reprise/overview', '/api/reprise/rounds', '/api/reprise/candidate', '/api/reprise/conclusion']) {
    assert.match(source, new RegExp(path.replaceAll('/', '\\/')), `the page shows ${path}`)
  }
  assert.match(source, /after=/, 'it polls with the cursor the answer handed back')
  assert.match(source, /encodeURIComponent/, 'the cursor travels in a query string, so it is encoded')
})

test('no colour is hard-coded: the page follows the host theme tokens and nothing else', () => {
  // Every file the browser loads is scanned, including the formatting module: a shared module that
  // carried a colour would put the palette back on both clients at once.
  //
  // Comments are stripped first (see `code()`): a scan that reads prose would forbid explaining the
  // rule it enforces.
  for (const name of CLIENT_MODULES) {
    const source = code(name)
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${name} must not carry a hex colour`)
    assert.doesNotMatch(source, /\brgba?\(/, `${name} must not carry an rgb() colour`)
    assert.doesNotMatch(source, /\bhsla?\(/, `${name} must not carry an hsl() colour`)
    // A named colour is a colour too, and `currentColor` is the one we do want: it is the ink the
    // host's theme chose, which is what makes the shapes survive a light/dark flip.
    assert.doesNotMatch(
      source,
      /:\s*(red|green|blue|black|white|gray|grey|orange|yellow|amber)\b/,
      `${name} must not carry a named colour`,
    )
  }

  const stylesheet = read('dashboard.css')
  assert.match(stylesheet, /--dsw-alias-/, 'it paints through the host theme tokens')
  for (const token of ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l1']) {
    assert.ok(stylesheet.includes(token), `the page consumes ${token}`)
  }
  assert.match(stylesheet, /color-scheme:\s*light dark/, 'and falls back to the OS scheme (system colours) only when no host token is present')

  // The page paints from that one file and from nothing else: no inline `<style>`, and every rule in
  // the stylesheet scoped so the panel can inject it into the host document without repainting it.
  const page = code('index.html')
  assert.match(page, /<link rel="stylesheet" href="\.\/dashboard\.css"\s*\/>/, 'the page links the shared stylesheet')
  assert.doesNotMatch(page, /<style/, 'and carries no styles of its own — one file, two clients')
})

test('the page states the read-only contract it renders under', () => {
  const source = read('dashboard.js')

  assert.match(source, /method:\s*'GET'|\bGET\b/, 'every request the page makes is a read')
  assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/, 'the page has no way to ask the server to change anything')
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket/, 'no second transport: the four routes are the whole protocol')
})

test('the modules parse as modules: a bundle served straight from disk has no build step to catch a typo', () => {
  // No bundler means no compile gate. `node --check` is the gate: it parses each exact file as the
  // ESM module the browser will load, without executing code that expects a DOM. `format.js` is
  // included because it is loaded by a plain `import` in the browser and by nothing in the suite
  // before ticket #6 imports it — so a syntax error there would be invisible until the page broke.
  for (const name of ['dashboard.js', 'format.js', 'states.js']) {
    const result = spawnSync(process.execPath, ['--check', join(CLIENT_DIR, name)], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${name}: ${result.stderr}`)
  }

  // And it has to be loadable as-is: no Node built-in, no bare specifier, no build-time variable.
  const format = read('format.js')
  assert.doesNotMatch(format, /^\s*import\s/m, 'the formatter imports nothing — the browser resolves no bare specifier')
  assert.doesNotMatch(format, /import\.meta/, 'and reads nothing from a build-time environment')
})
test('the page draws the warnings the payload carries, because a warning nobody sees is not one', async () => {
  const source = readFileSync(new URL('../client/dashboard.js', import.meta.url), 'utf8')
  assert.match(source, /data\.warnings/, 'the overview must consume warnings[]')
  assert.match(source, /warning\.label/, 'and render the sentence the projection wrote, not a code')
})

test('the severity the page branches on is the one the producer actually emits', () => {
  // The page used to test `severity === 'warn'` while `warnings.js` wrote `'warning'`, so the styling
  // never fired and no test noticed: both files were "correct" on their own. Pin the two together by
  // reading the producer out of the kernel package rather than restating its value here.
  const producer = readFileSync(new URL('../../core/lib/warnings.js', import.meta.url), 'utf8')
  const emitted = [...producer.matchAll(/severity:\s*'([a-z_]+)'/g)].map((match) => match[1])
  assert.ok(emitted.length > 0, 'the producer still writes a severity, or this test has nothing to compare')

  const source = read('dashboard.js')
  const branched = [...source.matchAll(/warning\.severity === '([a-z_]+)'/g)].map((match) => match[1])
  assert.ok(branched.length > 0, 'the page still branches on severity')
  for (const value of branched) {
    assert.ok(emitted.includes(value), `the page compares against ${JSON.stringify(value)}, which the producer never writes (it writes ${JSON.stringify([...new Set(emitted)])})`)
  }

  // A class the stylesheet does not define is a class that cannot make a warning look like one.
  assert.match(read('dashboard.css'), /\.warning\s*\{/, 'the stylesheet defines the class it puts on a warning')
})

test('the page draws the four observability panels, because a value nobody renders is not a panel', () => {
  // CODING_STANDARDS §3: an acceptance criterion phrased in terms of what a person sees holds on the
  // screen, not in the payload. These assertions are the cheapest honest check of that without a
  // browser: the page consumes the fields the projection puts there.
  const source = read('dashboard.js')

  // 总览: cards in use, the ledger floor, and the queue — with "unknown" as a word of its own.
  assert.match(source, /cluster\.cards\.inUse/, 'the overview renders the card count')
  assert.match(source, /cardsInUse/, 'and goes through one place to decide how to say it')
  assert.match(source, /'unknown'/, 'an unread listing is drawn as unknown, never as 0')
  assert.match(source, /cards\.floorAbsent/, 'the ledger floor is shown beside it, in its own words when unknown')
  // Ticket #7 retired the Overview card, and with it the one-waiter-per-line list: the readings cell
  // names how many are queued. The count is the fact a reader acts on; the queue's per-candidate
  // reasons were a second rendering of the fact stream's own lines.
  assert.match(source, /queue\.count|queue\?\.count/, 'the cluster cell still says how many are waiting')

  // 候选详情: the gate chain, step by step, with the three-way status as a badge.
  assert.match(source, /detail\.gateChain/, 'the candidate page renders the gate chain')
  assert.match(source, /dataset: \{ state: step\.status \}/, 'each step carries its own status word')

  // 结论页: what we measured, against what, and what the domain published.
  assert.match(source, /comparison\.measured/, 'the conclusion renders what we measured')
  assert.match(source, /comparison\.published/, 'and what the pack published')
  assert.match(source, /publishedAbsent/, 'or says why there is nothing to compare against')

  // 审计: the list, and one call opened into its prompt and response.
  assert.match(source, /\/api\/reprise\/calls/, 'the audit list is fetched')
  assert.match(source, /\/api\/reprise\/call['"]?,?/, 'and one call is fetched on its own')
  assert.match(source, /opened\.prompt/, 'the prompt is drawn')
  assert.match(source, /opened\.response/, 'and the response')

  const page = read('index.html')
  assert.match(page, /id="audit"/, 'the page has a place for the audit panel')
  const stylesheet = read('dashboard.css')
  assert.match(stylesheet, /\.badge\[data-state='missing'\]/, 'and a style that tells "missing" apart from "failed"')
  assert.match(stylesheet, /\.badge\[data-state='failed'\]/)
  assert.match(stylesheet, /\.calls\s*\{/, 'and a style for the call list')
})

// ------------------------------- the seven regions, and the cards that retired (ticket #7)

/**
 * The information architecture is seven questions and seven regions (spec §4.1). This is that list,
 * written out: a region added or removed on purpose should have to come here and say so.
 *
 * The page shipped with two pre-redesign cards at the bottom — `Overview` (a six-cell field list) and
 * `Measured / published` — whose facts the regions above them now each say once. Ticket #7 retires
 * them, and what they *said* moved rather than vanished: the phase into the masthead capsule, warnings
 * and notes into a strip under the conclusion, tokens and the names in flight into the readings row,
 * the absolute change and the published number into the conclusion region.
 */
const REGIONS = ['headline', 'strips', 'stop', 'ladder', 'readings', 'candidate', 'audit', 'stream']

test('the page is the seven regions and nothing else: the two pre-redesign cards are gone', () => {
  const page = code('index.html')

  for (const region of REGIONS) assert.match(page, new RegExp(`id="${region}"`), `the page still has its ${region} region`)
  assert.doesNotMatch(page, /id="overview"/, 'the six-cell field list has retired')
  assert.doesNotMatch(page, /id="conclusion"/, 'and so has the measured/published card')

  const source = code('dashboard.js')
  assert.doesNotMatch(source, /\brenderOverview\b/, 'and no renderer still fills them')
  assert.doesNotMatch(source, /\brenderConclusion\b/)
  // A six-cell list is a `<dl class="stats">` of `<div class="stat">` cells; there is no such grid
  // left anywhere on the page, and the stylesheet stops paying for it.
  assert.doesNotMatch(source, /class: 'stats'/, 'the equal-weight field list is not drawn anywhere else')
  assert.doesNotMatch(code('dashboard.css'), /\.reprise \.stats?\b/, 'and its styles went with it')
})

test('the workspace phase lives in the masthead capsule, is announced when it changes, and is printed nowhere else', () => {
  const page = read('index.html')
  const masthead = page.slice(page.indexOf('<header'), page.indexOf('</header>'))
  assert.match(masthead, /id="phase"/, 'the capsule has a place in the masthead')
  assert.match(masthead, /aria-live="polite"/, 'and a phase change is worth hearing (spec §6.1)')

  const source = code('dashboard.js')
  const phaseReads = [...source.matchAll(/workspace\??\.phase/g)]
  assert.equal(phaseReads.length, 1, 'the phase is read exactly once, in the capsule — no second field elsewhere')
  assert.match(source, /phase-capsule-state/, 'the capsule carries the state word beside the phase name')
  const stylesheet = code('dashboard.css')
  assert.match(stylesheet, /\.reprise \.phase-capsule\b/, 'the capsule is a component of its own')
  assert.match(stylesheet, /\.reprise \.phase-capsule-dot\b/, 'with the dot that says running or stopped without a word')
  // `phase` is already the candidate inspector's path of eight steps (#5). Two components behind one
  // class is how this capsule rendered as the inspector's two-column grid, so the capsule must not
  // wear that class.
  assert.match(masthead, /class="phase-capsule"/, 'the capsule wears its own class')
  assert.doesNotMatch(masthead, /class="phase"[ >]/, 'and not the one the inspector\'s phase path owns')
})

test('warnings and notes are a strip under the conclusion, in the projection\'s own words', () => {
  const page = code('index.html')
  const headline = page.indexOf('id="headline"')
  const strips = page.indexOf('id="strips"')
  const stop = page.indexOf('id="stop"')
  assert.ok(strips > headline, 'the strip sits under the conclusion')
  assert.ok(strips < stop, 'and above the stop rules — spec §6.9 puts the metric-contract note there')

  const source = code('dashboard.js')
  assert.match(source, /'strips'/, 'one renderer fills the strip')
  assert.match(source, /data\.warnings/, 'with the warnings the projection wrote')
  assert.match(source, /warning\.label/, 'the sentence, not a code')
  assert.match(source, /answer\?\.notes|answer\.notes/, 'and the notes the route attached to the answer')
  assert.match(source, /metricContract/, 'and the "nothing can be ranked" note when the contract disagrees with itself')
})

test('tokens and the names of what is in flight are in the readings row, not in a card', () => {
  const source = code('dashboard.js')

  assert.match(source, /spend\?\.tokens|spend\.tokens/, 'the token count is shown somewhere')
  assert.match(source, /inFlight/, 'and what is in flight')
  assert.match(source, /inFlight\.map\(/, 'by name, one element per candidate id, not only a count')
  // The row is where they went: no card was added for them.
  assert.doesNotMatch(code('index.html'), /id="spend"/, 'no ninth card was invented for the spend figures')
})

test('the conclusion region keeps the absolute change, the published number and the direction of every objective', () => {
  const source = code('dashboard.js')

  // The percentage alone is not the comparison: the absolute delta is how much metric the run moved.
  assert.match(source, /change\(comparison\.change\)/, 'the absolute change, beside the percentage')
  // "they published / difference" is the page's only answer to "should I trust the model's number".
  assert.match(source, /comparison\.published\b/, 'the number the domain published')
  assert.match(source, /publishedChange/, 'our distance from it')
  assert.match(source, /publishedAbsent/, 'and why there is nothing to compare against when there is not')
  assert.match(source, /\.objectives\b/, 'the objectives, with the direction each one runs')
  assert.doesNotMatch(source, /measured\.value\s*[-+]\s*published/, 'and the difference is the projection\'s, never subtracted here')
})

// --------------------------------------------------------------- the conclusion line

test('the conclusion line is the first thing on the page, not the middle of the second card', () => {
  const page = read('index.html')
  const headline = page.indexOf('id="headline"')
  assert.ok(headline > 0, 'the page has a place for the conclusion line')
  assert.ok(headline < page.indexOf('id="stop"'), 'and it is above every other region — the first screen decides whether the run is worth believing')
  assert.match(read('dashboard.css'), /\.headline-number\s*\{/, 'the best result gets a size of its own, not a cell in a stats grid')
})

test('the conclusion line reads the comparison block the projection publishes, and does no arithmetic of its own', () => {
  const source = read('dashboard.js')

  assert.match(source, /from '\.\/format\.js'/, 'the page formats through the module the panel will import too')
  assert.match(source, /comparison\.changePercent/, 'the percentage is the projection\'s — one number, one derivation')
  assert.match(source, /group\.kind === 'baseline'/, 'the sentence says which kind of group it is measured against')
  assert.match(source, /previous best/, 'the other kind, which is a different claim')
  // A page that subtracts is a second derivation of a number `dump` also prints.
  assert.doesNotMatch(source, /measured\.value\s*[-+*/]\s*group\.value/, 'the page never does the subtraction itself')
  assert.doesNotMatch(source, /changePercent\s*[*+/-]/, 'nor the division that turns it into a percentage')
})

test('a run with nothing comparable says so, and a run with no baseline says that instead', () => {
  const source = read('dashboard.js')

  // State 1 of spec §6.9: facts, but no comparable number (every candidate stopped short of a metric).
  assert.match(source, /No conclusion yet/, 'the empty state has a heading of its own, not a blank line')
  assert.match(source, /was stopped at a gate/, 'and it says what to look at next')
  // State 2: a best result with nothing to measure it against — the baseline is missing, not zero.
  assert.match(source, /no comparable baseline/i, 'a missing baseline is a sentence, not a dash')
  assert.doesNotMatch(source, /group === null \? '—'/, 'and never the em dash the old page put in its place')
  // "Worse than the baseline" is news inside the sentence, not a fifth four-state name.
  assert.match(source, /behind what it is measured against/, 'a losing run is still a sentence, with no status word')
  assert.doesNotMatch(source, /'worse'/, 'the four states describe facts, not mood (CODING_STANDARDS §2)')
})

test('the rounds table and the fact stream print what they mean: a metric, and a clock time', () => {
  const source = read('dashboard.js')

  // The `undefined=` defect: the round best now carries `metric`, and the page uses it.
  assert.match(source, /entry\.best\.metric/, 'the round best names the metric the projection publishes')
  assert.doesNotMatch(source, /\$\{entry\.best\.value\}/, 'and the raw value is not dropped into a template')
  assert.match(source, /measurement\(/, 'one spelling for "metric=value" everywhere the page shows a reading')
  // The epoch defect: the stream's first column is a time.
  assert.match(source, /clock\(event\.wall_clock_ms\)/, 'the fact stream shows a clock time')
  assert.doesNotMatch(source, /text: `\$\{event\.wall_clock_ms\}`/, 'and never the raw milliseconds')
  // One formatting path for every instant: no renderer formats a date itself.
  assert.doesNotMatch(source, /toISOString|toLocaleTimeString|toTimeString/, 'instants go through format.js, not through Date')
})

// ------------------------------------------------- the staircase and the round rail (ticket #3)

test('the staircase is drawn from the published series: the page never accumulates a best of its own', () => {
  const source = read('dashboard.js')

  // Every number the chart places comes from the projection: the axis, the baseline, the running best
  // per round, and the flag that says which round raised it.
  assert.match(source, /ladder\?\.axis|data\?\.ladder/, 'the axis is read from the conclusion view')
  assert.match(source, /ladder\.baseline|baseline\.value/, 'and so is the baseline line')
  assert.match(source, /entry\.cumulative/, 'the step series is the projection\'s cumulative best')
  assert.match(source, /entry\.improving/, 'and "this round raised it" is a published flag')

  // A running maximum in the renderer would be a second derivation of the same number, and the first
  // thing to disagree with `dump`. Reductions over a series are how that starts.
  assert.doesNotMatch(source, /Math\.(max|min|abs)\(\.\.\./, 'no reduction over a series in the page')
  assert.doesNotMatch(source, /\.reduce\(/, 'and no fold that could accumulate a best')
  assert.doesNotMatch(source, /\.value\s*[<>]|\.value\s*[<>]=?\s*[\w.]*\.value/, 'two results are never compared here — the projection decides which is better')
})

test('each candidate gets the shape the projection chose, and the five shapes are told apart without hue', () => {
  const source = read('dashboard.js')
  const css = read('dashboard.css')

  // The rail is made of real buttons: keyboard reachable, `aria-pressed` for the one the inspector is
  // showing, and a click that re-points the inspector.
  assert.match(source, /class: 'rail-candidate'/, 'a candidate is a button with a class of its own')
  assert.match(source, /'data-shape': candidate\.shape/, 'the shape is the projection\'s decision, not the page\'s')
  assert.match(source, /'aria-pressed'/, 'the selected candidate says so')
  assert.match(source, /onclick: \(\) => select\(candidate\.candidate_id\)/, 'and clicking it moves the inspector')

  // The five shapes of spec §6.5, each a rule in the stylesheet. `currentColor` and gradients over it
  // are the whole palette here: a shape has to survive a greyscale screenshot.
  for (const shape of ['done', 'frontier', 'rejected', 'in-flight', 'invalid']) {
    assert.ok(
      css.includes(`.rail-candidate[data-shape='${shape}']`),
      `the stylesheet draws the "${shape}" square`,
    )
  }
  assert.match(css, /box-shadow: inset 0 -3px 0 0 var\(--reprise-surface\)/, 'the frontier square carries a notch the others do not')
  assert.match(css, /repeating-linear-gradient\(\s*45deg,\s*currentColor/, 'in-flight is a hatch — a texture, not a hue')
  assert.match(css, /linear-gradient\(\s*to top right,\s*transparent 44%,\s*currentColor/, 'invalid is struck through, which is not a hatch and not a hollow box')
})

test('the chart and the rail are laid out from one slot count, so a mark cannot drift from its round', () => {
  const source = read('dashboard.js')
  const css = read('dashboard.css')

  // One slot per round plus INIT, computed once and handed to both views as `--reprise-slot`.
  assert.equal(
    [...code('dashboard.js').matchAll(/--reprise-slot/g)].length,
    1,
    'the slot width is written once — a second copy is a second scale',
  )
  assert.match(source, /rounds\.length \+ 1/, 'the slot count is the number of rounds plus the INIT slot')
  assert.match(source, /grid\.append\(rail\(/, 'the rail is placed inside the staircase\'s own grid')

  // Both live in the grid's second column: the same left edge, the same width, the same division.
  assert.match(css, /\.ladder-plot\s*\{[^}]*grid-column: 2;/, 'the plot starts where the axis gutter ends')
  assert.match(css, /\.rail\s*\{[^}]*grid-column: 2;/, 'and the rail starts at the same place')
  assert.match(css, /\.rail-cell\s*\{[^}]*flex: 1 1 0;/, 'the cells divide that width into equal slots')
})

test('the staircase is readable without being seen: a sentence, a role, and the rounds as a table', () => {
  const source = read('dashboard.js')

  assert.match(source, /role: 'img'/, 'the plot is an image to a screen reader')
  assert.match(source, /'aria-label': summary/, 'carrying the one sentence that says what it shows')
  assert.match(source, /ladder-summary/, 'and the same sentence is on screen, not only on the image')
  // The rail replaces the old Rounds table, so the table moves under `<details>` — a chart cannot be
  // read aloud, and a reader who wants the numbers should not have to ask for a screenshot.
  assert.match(source, /el\('details'/, 'the per-round table is expandable')
  assert.match(source, /Read it as a table/, 'and says what it is for')
  assert.match(source, /entry\.best\.metric/, 'it prints the round best with its metric')
  assert.match(source, /candidate\.verdict \?\? candidate\.status/, 'and names each candidate with the four-state word it has')
})

test('the chart says what is missing instead of drawing a zero: no axis, no baseline', () => {
  const source = read('dashboard.js')

  // Spec §6.9: no comparable result → no axis, and the page says why rather than drawing an empty
  // frame; no recorded baseline → no line, and the key says it was not recorded. `0` appears in
  // neither place, because a zero baseline is a number somebody would act on.
  assert.match(source, /axis === null/, 'an absent axis is a state the page branches on')
  assert.match(source, /ladder\?\.axisAbsent/, 'with the projection\'s own sentence for it')
  assert.match(source, /baseline === null/, 'and so is an absent baseline')
  assert.match(source, /baseline not recorded/, 'which the key spells out in words')
  assert.doesNotMatch(source, /baseline[^\n]*\?\?\s*0/, 'a missing baseline is never defaulted to zero')
})

test('the stylesheet is scoped, so the panel can inject it without repainting the host document', () => {
  // Ticket #6 injects this file verbatim into the Web UI panel. A bare `table`, `button` or `body`
  // rule would restyle the host's own chrome, which is why every rule is scoped under `.reprise`
  // (or is the `:root` token block, which only declares `--reprise-*` custom properties).
  const css = read('dashboard.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = []
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    for (const part of match[1].split(',')) {
      const selector = part.trim()
      if (selector === '' || selector.startsWith('@')) continue
      selectors.push(selector)
    }
  }
  assert.ok(selectors.length > 40, 'the scan found the stylesheet, not an empty file')
  for (const selector of selectors) {
    assert.match(selector, /^(\.reprise\b|:root$)/, `"${selector}" is not scoped under .reprise`)
  }
  // And the tokens it declares are ours, so injecting them onto the host's `:root` collides with
  // nothing the host already defines.
  for (const match of read('dashboard.css').matchAll(/^\s+(--[a-z0-9-]+):/gm)) {
    assert.match(match[1], /^--reprise-/, `${match[1]} is not a --reprise-* token`)
  }
})

// --------------------------------------- the candidate-state vocabulary (ticket #5)

test('the words a candidate state goes by exist once, and both halves of the page import them', async () => {
  // The rail drew "completed, on the frontier" as a label and the inspector says the same sentence
  // beside the same candidate. Two copies of that vocabulary is two places to change, and the day one
  // of them changes the page names one state two ways — the drift constraint 2 forbids for numbers,
  // applied to the words that stand in for them.
  const source = read('dashboard.js')

  assert.match(source, /from '\.\/states\.js'/, 'the page imports the vocabulary served beside it')
  assert.doesNotMatch(code('dashboard.js'), /\bSHAPE_WORDS\s*=\s*\{/, 'and keeps no second copy of the shapes\' words')
  assert.doesNotMatch(code('dashboard.js'), /\bVERDICT_WORDS\s*=\s*\{/, 'nor a second copy of a round verdict\'s')

  const states = await import(pathToFileURL(join(CLIENT_DIR, 'states.js')).href)
  assert.equal(states.SHAPE_WORDS.frontier, 'completed, on the frontier', 'one state, one name')
  assert.equal(states.SHAPE_WORDS.invalid, 'invalid artifact', 'and the coarse shape keeps the precise word in it')
  assert.deepEqual([...states.STATE_ORDER], ['ok', 'missing', 'invalid', 'conflict'], 'the four states, named')
})

test('the four states are told apart by mark, and "never got there" is a fifth fact with a mark of its own', async () => {
  const states = await import(pathToFileURL(join(CLIENT_DIR, 'states.js')).href)

  const marks = ['ok', 'missing', 'invalid', 'conflict'].map((status) => states.phaseMark({ status, reached: true }))
  assert.deepEqual(
    marks.map((mark) => mark.word),
    ['ok', 'missing', 'invalid', 'conflict'],
    'the four-state word is always on screen beside its mark, never replaced by a colour',
  )
  assert.equal(new Set(marks.map((mark) => mark.mark)).size, 4, 'four states, four marks')

  const unjudged = states.phaseMark({ status: null, reached: true })
  const never = states.phaseMark({ status: null, reached: false })
  assert.equal(unjudged.word, 'no verdict', 'a phase nothing judged says so instead of borrowing a state')
  assert.equal(never.word, 'not reached', 'and a phase the candidate never entered is its own word')
  assert.notEqual(never.mark, states.phaseMark({ status: 'missing', reached: true }).mark,
    '"the artifact is absent" and "the candidate never got there" are one word apart: they must be two marks apart as well')
  assert.equal(
    new Set([...marks, unjudged, never].map((mark) => mark.mark)).size,
    6,
    'six marks, no two alike — a greyscale screenshot still separates them',
  )
})

test('each of the six marks is a shape in the stylesheet: fill, dash, hatch, heavy border, and two outlines', () => {
  const css = read('dashboard.css')
  /** One rule's body, so the check reads what the rule draws rather than that the class exists. */
  const body = (mark) => {
    const selector = `.phase[data-mark='${mark}'] .phase-mark`
    const start = css.indexOf(selector)
    assert.ok(start >= 0, `the stylesheet draws the "${mark}" mark (${selector})`)
    const open = css.indexOf('{', start)
    return css.slice(open + 1, css.indexOf('}', open))
  }

  assert.match(body('ok'), /background:\s*currentColor/, 'ok is a filled square')
  assert.match(body('missing'), /border-style:\s*dashed/, 'missing is a dashed outline — nothing was read')
  assert.match(body('invalid'), /repeating-linear-gradient/, 'invalid is hatched — the artifact arrived and broke its schema')
  assert.match(body('conflict'), /border-width:\s*2(\.5)?px/, 'conflict is a heavy border — two facts disagree')
  assert.match(body('not-reached'), /border-style:\s*dotted/, 'never reached is the faintest of the six')
  assert.equal(new Set(['ok', 'missing', 'invalid', 'conflict', 'no-verdict', 'not-reached'].map(body)).size, 6,
    'six marks, six drawings')
})

// ------------------------------------------------- the candidate inspector (ticket #5)

test('the inspector draws the published phase path, and every phase carries a word as well as a mark', () => {
  const source = read('dashboard.js')

  assert.match(source, /detail\.phasePath/, 'the path is the projection\'s, in the kernel\'s order')
  assert.match(source, /phaseMark\(/, 'each phase\'s mark and word come from the shared vocabulary')
  assert.match(source, /class: 'phase-word'/, 'the word is drawn, not only the shape')
  // Constraint 2: the page does not order, count or classify phases itself.
  assert.doesNotMatch(source, /CANDIDATE_PHASES|'SUBMIT_QUEUED'/, 'the phase list never appears in the client')
})

test('a rejection carries its original words, when it was recorded, and which fact recorded it — and no state badge', () => {
  const source = read('dashboard.js')
  const rejection = source.slice(source.indexOf('function renderRejection'), source.indexOf('function renderPhaseChain'))

  assert.ok(rejection.length > 0, 'the inspector renders the rejection block')
  assert.match(rejection, /el\('pre'/, 'the reason is verbatim: a <pre>, in the words the fact plane recorded')
  assert.match(rejection, /rejection\.message/, 'the gate\'s own failure text')
  assert.match(rejection, /rejection\.seq/, 'and the #seq of the fact that recorded it')
  assert.match(rejection, /rejection\.eventType/, 'and the event type, so a reader can look it up')
  assert.match(rejection, /clock\(rejection\.atMs\)/, 'and a readable time, formatted through format.js')
  // CODING_STANDARDS §2: "the answer was no" is not one of the four states.
  assert.doesNotMatch(rejection, /class: 'badge'/, 'a rejection is not given a four-state badge')
})

test('the page can be pointed at one candidate from its own URL, so a link can name what it shows', () => {
  const source = read('dashboard.js')

  assert.match(source, /new URLSearchParams\(location\.search\)/, 'the candidate is read from the page\'s own URL')
  assert.match(source, /state\.selected = requestedCandidate\(\)/, 'and it is what the inspector opens on')
  // Read-only, and stay out of the reader's history: the page shows a run, it does not navigate one.
  assert.doesNotMatch(source, /pushState|replaceState/, 'the page does not rewrite the browser history')
})

test('the fact stream is a column of stamped rows: a readable time, and #seq on every one', () => {
  const source = read('dashboard.js')
  const stream = source.slice(source.indexOf('function renderStream'), source.indexOf('// -------', source.indexOf('function renderStream')))

  assert.match(stream, /clock\(event\.wall_clock_ms\)/, 'the time reads as a clock, never as an epoch')
  assert.match(stream, /seqStamp\(event\.local_seq\)/, 'every row carries the seq a reader can quote')
  assert.match(source, /const seqStamp = \(seq\) => `#\$\{seq\}`/, 'written as #seq — one spelling for the inspector and the stream')
  assert.match(stream, /title:/, 'the summary is one line, with the whole of it on hover')
})

test('the audit is one collapsed line that opens into call sites and refs, and fetches a call only when asked', () => {
  const source = read('dashboard.js')
  const audit = source.slice(source.indexOf('function renderAudit'), source.indexOf('function renderStream'))

  assert.match(audit, /el\('details'/, 'collapsed by default: nobody reads prompts while skimming')
  assert.match(audit, /model calls/, 'and the one line says what it counts')
  assert.match(source, /async function openCall\(ref\)/, 'opening one call is its own request')
  assert.match(source, /readOnce\('call', \{ ref \}\)/, 'through the route that already serves it')
  assert.match(audit, /opened\.prompt/, 'and the prompt it was given is drawn verbatim')
  assert.match(audit, /opened\.response/, 'as is what came back')
})

// ------------------------------------------- the two instants and the reason it is waiting

test('the masthead stamps come from the published cursor, not from a running tally in the page', () => {
  // Gate finding: `last fact` was a running maximum over whatever facts this page had happened to
  // read, while `cursor` beside it came from the server. Two readers of one run could therefore print
  // two instants — and the Web UI panel, which sees only its own window, a third. The envelope's
  // `cursor` already names the newest fact; both stamps now read it, through one parser.
  const source = code('dashboard.js')

  assert.doesNotMatch(source, /lastFactMs/, 'no running maximum over the fact window')
  assert.match(source, /cursorAt\(/, 'the instant comes from the published cursor')
  assert.match(source, /cursorAt\(\w+\??\.cursor\)/, 'read off the answer envelope')
  // Both stamps read one value: `last fact` is the cursor's instant, `cursor` is the same key rendered.
  assert.match(source, /clock\(cursorAt\(/, 'the `last fact` stamp is the cursor\'s instant')
  assert.match(source, /cursor\(\w+\??\.cursor\)/, 'and the cursor stamp renders the same key')
})

test('the cluster cell says why a queued candidate is waiting, not just that one is', () => {
  // Gate finding: `holdReason()` — "budget" / "single_job_gpu" — lost its only renderer when the
  // Overview card retired, so the cell showed a count with no cause. The payload carries the reason
  // (`cluster.queue.waiting[]`), so the cell is where it speaks.
  const source = code('dashboard.js')

  assert.match(source, /queue\?\.waiting|queue\.waiting/, 'the cluster cell reads the waiting list')
  assert.match(source, /reason/, 'and prints the reason the projection recorded for each waiter')
  assert.match(source, /single_job_gpu|budget/, 'in the decision\'s own vocabulary, not a new one')
  // The reason is a published word; the page maps it to a sentence, it does not re-decide the hold.
  assert.doesNotMatch(source, /holdReason\(/, 'the page does not recompute the hold')
})
