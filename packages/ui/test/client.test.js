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
import { fileURLToPath } from 'node:url'

import { registerRoutes } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

const CLIENT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'client')
const read = (name) => readFileSync(join(CLIENT_DIR, name), 'utf8')

test('the page and its module are served by the host at the two asset routes', async () => {
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
  for (const name of ['index.html', 'dashboard.js']) {
    const source = read(name)
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${name} must not carry a hex colour`)
    assert.doesNotMatch(source, /\brgba?\(/, `${name} must not carry an rgb() colour`)
    assert.doesNotMatch(source, /\bhsla?\(/, `${name} must not carry an hsl() colour`)
  }

  const page = read('index.html')
  assert.match(page, /--dsw-alias-/, 'it paints through the host theme tokens')
  for (const token of ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l1']) {
    assert.ok(page.includes(token), `the page consumes ${token}`)
  }
  assert.match(page, /color-scheme:\s*light dark/, 'and falls back to the OS scheme (system colours) only when no host token is present')
})

test('the page states the read-only contract it renders under', () => {
  const source = read('dashboard.js')

  assert.match(source, /method:\s*'GET'|\bGET\b/, 'every request the page makes is a read')
  assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/, 'the page has no way to ask the server to change anything')
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket/, 'no second transport: the four routes are the whole protocol')
})

test('the module parses as one module: a bundle served straight from disk has no build step to catch a typo', () => {
  // No bundler means no compile gate. `node --check` is the gate: it parses this exact file as the
  // ESM module the browser will load, without executing code that expects a DOM.
  const result = spawnSync(process.execPath, ['--check', join(CLIENT_DIR, 'dashboard.js')], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
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
  assert.match(read('index.html'), /\.warning\s*\{/, 'the page defines the class it puts on a warning')
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
  assert.match(source, /cluster\.cards\.floor/, 'the ledger floor is shown beside it')
  assert.match(source, /cluster\?\.queue\?\.waiting/, 'and the queue is drawn, one waiter per line')

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
  assert.match(page, /\.badge\[data-state='missing'\]/, 'and a style that tells "missing" apart from "failed"')
  assert.match(page, /\.badge\[data-state='failed'\]/)
  assert.match(page, /\.calls\s*\{/, 'and a style for the call list')
})
