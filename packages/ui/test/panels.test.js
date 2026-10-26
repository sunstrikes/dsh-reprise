/**
 * Guards the four observability panels at the surface the ticket names (ticket 29; spec 展示层
 * "v1 无写端点"; Testing Decisions "客户端 DOM 渲染 —— v1 只测路由返回的 JSON 形状").
 *
 * Each test asks one question the way a person would, through the route a browser calls:
 *
 *   总览        how many cards does this run hold, and is anything waiting? An unread listing is
 *               `null` — an unreadable cluster is never drawn as "0 cards".
 *   候选详情    which gate steps passed, which failed, and which were never reached? `missing` is
 *               its own answer, not a failure.
 *   结论页      what did we measure, against what, and what did the domain publish?
 *   调用审计    which judgements were asked, and — opened one at a time — what was the prompt and
 *               what came back, verbatim?
 *
 * The workspace is a real one (SQLite plus artifact files) with the loop's own tick driving it, and
 * every handler is called with the *directory*: no session, no store handle, nothing live.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Store } from '../../core/lib/store.js'
import { createCandidate, tick } from '../../core/lib/loop.js'
import { loadDomainPack } from '../../core/lib/domain.js'
import { buildQuestion, modelCallName, modelCallRecord } from '@dsh-reprise/exec/model'
import { fileArtifacts } from '../../core/lib/artifacts.js'
import { openWorkspace, runCandidate, seedMetrics } from '../../core/test/support/fake-ports.js'
import * as stopRules from '../../core/lib/stop.js'
import { callHandler, callsHandler, candidateHandler, conclusionHandler, overviewHandler, registerRoutes } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

const GENERATIVE_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'generative-recommenders')

const CONTRACT = { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_rounds: 0 } }

const EXECUTOR = { kind: 'local', command: ['node', 'train.mjs'], num_gpus: 2 }

/** Record what a host records at INIT: the contract, the stop rules and the executor (for the cards). */
function seed(store, config, executor = EXECUTOR) {
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', { ...workspace, metrics: config.metrics, stop: config.stop, executor })
}

const phaseOf = (ports, candidateId) => ports.store.getState(candidateId, 'phase')?.phase

/** Tick until `done()`, advancing the clock so gate backoff and poll deadlines elapse. */
async function untilDone(ports, done, what, { limit = 20 } = {}) {
  for (let index = 0; index < limit; index += 1) {
    await tick(ports)
    if (done()) return
    ports.clock.advance(10_000)
  }
  throw new Error(`fixture never reached ${what}`)
}

// ------------------------------------------------------------------- 总览

test('the overview route answers "how many cards, is anything waiting" from the ledger, and never invents 0 cards', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, executor: EXECUTOR } })
  seed(ports.store, CONTRACT)
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => ports.store.jobFor('c1') !== undefined, 'a submitted job')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = await overviewHandler(dir, {})
  const cluster = answer.data.cluster

  assert.equal(cluster.read, false, 'the page has no platform port, and it says the listing was not read')
  assert.match(cluster.reason, /listing/i)
  assert.equal(cluster.cards.perJob, 2)
  assert.equal(cluster.cards.inUse, null, 'unknown, never 0 — "0 cards" is the answer somebody acts on')
  assert.equal(cluster.cards.floor, 2, 'what our own ledger supports, stated as a floor')
  assert.deepEqual(cluster.jobs.open, ['c1'])
  assert.equal(cluster.queue.count, 0, 'nothing is waiting for the cards here')
})

test('the overview route asks the cluster when it is given a platform, and says "cannot read" when it cannot', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, executor: EXECUTOR } })
  seed(ports.store, CONTRACT)
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => ports.store.jobFor('c1') !== undefined, 'a submitted job')
  const job = ports.store.jobFor('c1')
  const dir = dirname(ports.store.path)
  ports.store.close()

  // 1. An executor that can list: the page reports the cluster's own numbers, not the ledger's floor.
  const listing = {
    ok: true,
    jobs: [{ job_id: job.job_id, submission_id: job.submission_id, status: 'RUNNING', metadata: {} }],
  }
  const readable = await overviewHandler(dir, {}, { platform: { list: async () => listing } })
  assert.equal(readable.data.cluster.read, true, 'the route read the listing it was given')
  assert.equal(readable.data.cluster.cards.inUse, 2, 'two cards really are in use, because the cluster said so')
  assert.equal(readable.data.cluster.queue.upstream, 0, 'and nothing is pending upstream, which only a listing can say')
  assert.equal(readable.data.cluster.reason, null)

  // 2. A platform that cannot list: "cannot read", in the executor's own words — not "0 cards".
  const blind = await overviewHandler(dir, {}, { platform: {} })
  assert.equal(blind.data.cluster.read, false)
  assert.match(blind.data.cluster.reason, /cannot list/)
  assert.equal(blind.data.cluster.cards.inUse, null, 'unknown, never 0')

  // 3. No platform at all (a headless host): the same null, with its own reason.
  const unasked = await overviewHandler(dir, {})
  assert.equal(unasked.data.cluster.read, false)
  assert.match(unasked.data.cluster.reason, /no cluster-listing source/)
  assert.equal(unasked.data.cluster.cards.inUse, null)
})

test('the mounted overview route carries the platform through, so the page a browser fetches is the one with numbers', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, executor: EXECUTOR } })
  seed(ports.store, CONTRACT)
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => ports.store.jobFor('c1') !== undefined, 'a submitted job')
  const job = ports.store.jobFor('c1')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const connection = fakeConnection()
  const dispose = registerRoutes({
    connection,
    workspace: dir,
    platform: {
      list: async () => ({ ok: true, jobs: [{ job_id: job.job_id, submission_id: job.submission_id, status: 'RUNNING', metadata: {} }] }),
    },
  })
  const answer = await connection.dispatch('GET', '/api/reprise/overview')

  assert.equal(answer.status, 200)
  assert.equal(answer.json.data.cluster.read, true, 'the route registered with a platform is the route that asks')
  assert.equal(answer.json.data.cluster.cards.inUse, 2)
  dispose()
})

// --------------------------------------------------------------- 候选详情

test('the candidate route lists every gate step, and a gate that never ran is missing rather than failed', async () => {
  const ports = openWorkspace({ config: CONTRACT })
  seed(ports.store, CONTRACT)
  // An implementer that refuses the task: the candidate stops at LAND, before any gate exists.
  ports.harness = { land: () => ({ ok: false, error_class: 'deterministic_fail', message: 'no module named evals' }) }
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => phaseOf(ports, 'c1') === 'REJECTED', 'a rejection at LAND')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = candidateHandler(dir, { candidate: 'c1' })
  const chain = answer.data.gateChain

  assert.equal(chain.reached, false)
  assert.equal(chain.stoppedAt, 'LAND')
  assert.deepEqual(
    chain.chain.map((step) => step.status),
    ['missing', 'missing', 'missing', 'missing', 'missing', 'missing', 'missing'],
    'a reader must see "nobody looked", not a wall of red',
  )
  assert.equal(chain.chain.some((step) => step.status === 'failed'), false)
})

test('the candidate route carries the per-check result of the attempt that decided', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'reprise-ui-gate-'))
  const records = fileArtifacts(join(workspace, 'artifacts'))
  const ports = openWorkspace({
    config: CONTRACT,
    dir: workspace,
    judge: judgeWithAttempts(
      [
        { verdict: 'reject', rationale: 'the diff moves the eval split', concerns: [] },
        { verdict: 'accept', rationale: 'only the knob moved', concerns: [] },
      ],
      records,
    ),
  })
  seed(ports.store, CONTRACT)
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the embedding table' })
  await untilDone(ports, () => phaseOf(ports, 'c1') === 'SUBMIT_QUEUED', 'SUBMIT_QUEUED')
  const dir = dirname(ports.store.path)
  ports.store.close()

  const chain = candidateHandler(dir, { candidate: 'c1' }).data.gateChain

  assert.deepEqual(
    chain.attempts.map((attempt) => attempt.attempt),
    [1, 2],
    'both attempts are on the page: "it refused once and then passed" is the answer, not just the verdict',
  )
  assert.equal(chain.attempts[0].review.verdict, 'reject')
  assert.equal(chain.attempts[1].review.verdict, 'accept')
  assert.equal(chain.chain.every((step) => step.status === 'passed'), true)
})

// --------------------------------------------------------------- 结论页

test('the conclusion route prints the number we measured next to the number the pack published', async () => {
  const pack = loadDomainPack(GENERATIVE_PACK_DIR)
  const published = pack.metricContract.published
  const reference = published.rows.find((row) => row.method === published.reference)
  const ports = openWorkspace({ config: { metrics: pack.metricContract, stop: { max_rounds: 0 } } })
  seedMetrics(ports.store, pack.metricContract)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { 'hr@10': 0.3001, 'ndcg@10': 0.17 } })
  const dir = dirname(ports.store.path)
  ports.store.close()

  const answer = conclusionHandler(dir, {})
  const comparison = answer.data.comparison

  assert.equal(comparison.measured.value, 0.3001)
  assert.equal(comparison.published.method, 'HSTU')
  assert.equal(comparison.published.value, reference.metrics['hr@10'], 'the published side is the pack\'s own number')
  assert.equal(comparison.published.source.file, published.source.file)
  assert.equal(Number(comparison.publishedChange.toFixed(4)), Number((0.3001 - reference.metrics['hr@10']).toFixed(4)))
})

// --------------------------------------------------------------- 调用审计

/** A record filed the way the model port files it, in the workspace's artifact directory. */
function fileCall(dir, { callSite, subject = null, ref = null, prompt, facts = {}, answer = null, response = '', errorClass = null }) {
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  const question = buildQuestion({ call_site: callSite, subject, ref, prompt, facts, answer_schema: '{"a": 1}' })
  artifacts.write(
    modelCallName({ call_site: callSite, subject, ref }),
    modelCallRecord({ question, answer, response, error_class: errorClass }),
  )
}

test('the audit route lists the calls and opens one of them into its prompt and response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-ui-audit-'))
  const store = Store.open(dir)
  store.close()
  fileCall(dir, { callSite: 'round_plan', subject: 'round-1', prompt: 'Plan round 1.', answer: { hypotheses: [] }, response: '{"hypotheses":[]}' })
  fileCall(dir, { callSite: 'verify', subject: 'r1-h1', ref: 'a1', prompt: 'Review this diff.', answer: { verdict: 'reject' }, response: '{"verdict":"reject"}' })

  const list = callsHandler(dir, {})
  assert.deepEqual(list.data.calls.map((call) => call.ref), ['model_call:round_plan:round-1', 'model_call:verify:r1-h1:a1'])
  assert.equal(list.data.count, 2)
  assert.equal(list.data.call_site, null, 'no filter means every call site')

  const filtered = callsHandler(dir, { site: 'verify' })
  assert.deepEqual(filtered.data.calls.map((call) => call.ref), ['model_call:verify:r1-h1:a1'])

  const opened = callHandler(dir, { ref: 'model_call:verify:r1-h1:a1' })
  assert.equal(opened.view, 'call')
  assert.equal(opened.data.prompt, 'Review this diff.', 'the prompt the model read, verbatim')
  assert.equal(opened.data.response, '{"verdict":"reject"}', 'and the words it returned')
  assert.deepEqual(opened.data.answer, { verdict: 'reject' })
})

test('the audit routes refuse a bad query as a 400 and a non-record as a missing page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-ui-audit-empty-'))
  const store = Store.open(dir)
  store.close()

  assert.throws(() => callHandler(dir, {}), /ref/)
  // A path dressed as a reference is not one of our records, and the answer says "no such record"
  // rather than opening a file.
  const escaped = callHandler(dir, { ref: 'model_call:../../workspace' })
  assert.equal(escaped.data, null)
  assert.equal(escaped.missing, true)

  assert.deepEqual(callsHandler(dir, {}).data, { calls: [], count: 0, call_site: null, reason: null })
})

/**
 * A judge whose verdicts come from a script, filing each attempt's record where the real judge does.
 *
 * The loop's gate tests already cover the real judge; what this fixture owes the *route* test is a
 * workspace whose attempt records exist on disk, so the panel reads them the way it will in a run.
 */
function judgeWithAttempts(answers, artifacts) {
  let calls = 0
  return {
    async verify({ candidateId, now }) {
      const next = answers[Math.min(calls, answers.length - 1)]
      calls += 1
      const attempt = calls
      const artifact = {
        schema_version: 1,
        candidate_id: candidateId,
        attempt,
        passed: next.verdict === 'accept',
        checks: [
          { name: 'hypothesis_recorded', result: 'pass' },
          { name: 'round_recorded', result: 'pass' },
          { name: 'parent_binding_frozen', result: 'pass' },
          { name: 'syntax', result: 'pass' },
          { name: 'allowed_surface', result: 'pass' },
          { name: 'conflict_markers', result: 'pass' },
        ],
        reviewer: next,
        decided_at_ms: now,
      }
      artifacts.write(`verify_verdict:${candidateId}`, artifact)
      artifacts.write(`verify_verdict:${candidateId}:a${attempt}`, artifact)
      return artifact
    },
    async analyze() {
      throw new Error('not used by this fixture')
    },
  }
}
// ============================================================ the Web UI panel (ticket #6)
//
// The panel is the same design as the page or it is a second design. Nothing here can see a rendered
// React tree (there is no DOM in Node and no React on this machine), so these tests read the two
// things that *decide* whether the two surfaces agree:
//
//   - the **source** the Host loads — which stylesheet it injects, which modules it formats through,
//     which routes it asks, and whether a hardcoded Chinese string survived in a template;
//   - the **plugin object** its factory returns, driven here through a fake `ctx`: the dictionaries
//     it registers, and the one `<style>` its effect puts in the document head.
//
// The rendering itself is proved by a throwaway harness outside the repo, whose screenshots sit
// beside the page's — a browser is the only thing that can show either surface painting.

const PANEL_PATH = fileURLToPath(new URL('../../core/client/index.js', import.meta.url))
const PAGE_JS = fileURLToPath(new URL('../client/dashboard.js', import.meta.url))
const PAGE_HTML = fileURLToPath(new URL('../client/index.html', import.meta.url))
const PAGE_CSS = fileURLToPath(new URL('../client/dashboard.css', import.meta.url))
const STATES_JS = fileURLToPath(new URL('../client/states.js', import.meta.url))
const panelSource = () => readFileSync(PANEL_PATH, 'utf8')

/** The panel's source without its comments: the scans below are about what it *does*. */
const panelCode = () => panelSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * The smallest `document` the panel's effect needs, so the test can see what it appended.
 *
 * A `<style>` element is the whole of it: the panel paints from the page's stylesheet and from
 * nothing else, so proving "exactly one style element, carrying that file's text, removed on unload"
 * is proving the one thing the panel is allowed to do to the document.
 */
function fakeDocument() {
  const appended = []
  const make = (tagName) => ({
    tagName: String(tagName).toUpperCase(),
    textContent: '',
    id: '',
    removed: false,
    setAttribute(name, value) {
      this[name] = value
    },
    remove() {
      this.removed = true
      const at = appended.indexOf(this)
      if (at >= 0) appended.splice(at, 1)
    },
  })
  const parent = {
    appendChild(node) {
      appended.push(node)
      return node
    },
    removeChild(node) {
      node.remove()
    },
  }
  return { appended, head: parent, body: parent, createElement: make }
}

/**
 * The plugin the Host would get, plus the dictionaries and effects its `apply` registered.
 *
 * `require` returns a React stand-in: enough for the module to build its element tree (never called
 * with hooks, because nothing renders here). `locale.bind` answers from the dictionaries captured by
 * `locale.register`, which is what makes the key-coverage assertions below possible without a browser.
 */
async function loadPanel({ document = fakeDocument(), css = readFileSync(PAGE_CSS, 'utf8') } = {}) {
  let definition = null
  const globals = { previousWindow: globalThis.window, previousDocument: globalThis.document, previousFetch: globalThis.fetch }

  const dictionaries = new Map()
  const disposers = []
  const seats = []
  let plugin = null

  globalThis.window = { __ModuleLoader__: { load: (loaded) => (definition = loaded) } }
  globalThis.document = document
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => (String(url) === '/api/reprise/dashboard.css' ? css : '') })
  try {
    // One import per call is fine: the loader runs once per module instance, so each call gets a
    // fresh registration and the assertions cannot leak into one another through a shared cache.
    await import(`${PANEL_PATH}?register=${Math.random()}`)
    plugin = definition.factory((name) => {
    if (name === 'react') {
      const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
      return {
        createElement,
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
        useCallback: (fn) => fn,
      }
    }
    throw new Error(`the panel imported ${name}, which the browser module table does not provide`)
  })
  const ctx = {
    effect: (fn) => {
      disposers.push(fn())
    },
    locale: {
      register: (ns, code, dictionary) => {
        assert.equal(ns, 'reprise')
        dictionaries.set(code, dictionary)
        return () => dictionaries.delete(code)
      },
      bind: (ns) => (key) => dictionaries.get('en')?.[key] ?? key,
    },
    slots: {
      inject: (seat, register) => register(),
      register: (seat, component) => {
        seats.push({ seat, component })
        return () => {}
      },
    },
  }
    plugin.apply(ctx)
    // The stylesheet arrives through a promise; let it land while the fake `fetch` is still installed.
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    globalThis.window = globals.previousWindow
    globalThis.document = globals.previousDocument
    globalThis.fetch = globals.previousFetch
  }

  assert.ok(definition !== null, 'the module registered itself with the Host module loader')
  assert.equal(definition.id, 'dsh-reprise')
  return { plugin, dictionaries, disposers, seats, document }
}

test('the panel paints from the page\'s stylesheet, one <style> injected through ctx.effect', async () => {
  const loaded = await loadPanel()
  const styles = loaded.document.appended.filter((node) => node.tagName === 'STYLE')

  assert.equal(styles.length, 1, 'one stylesheet, not a second copy of the tokens')
  assert.equal(styles[0].textContent, readFileSync(PAGE_CSS, 'utf8'), 'carrying the page\'s own file, verbatim')
  assert.equal(styles[0].id, 'reprise-dashboard-css', 'with an id, so a re-mount replaces it instead of stacking')

  for (const dispose of loaded.disposers) dispose()
  assert.equal(styles[0].removed, true, 'and unloading the plugin takes it out of the host document')
})

test('a shared module that will not load says so and asks again, instead of waiting forever', () => {
  const source = panelCode()

  // The panel's first act is to import the page's `format.js` and `states.js`. Those two routes are
  // mounted by the *Host half* of the plugin, at plugin load: a Host that reloaded this bundle while
  // its route table stayed put answers 404, and a cached rejection left the dock saying "reading the
  // fact plane" for the lifetime of the window. Observed in a real Host, on a process that started
  // before those routes existed. So: the rejection is named, not cached, and retried.
  assert.match(source, /panel\.sharedFailed/, 'the failure is a sentence the panel can print')
  assert.match(source, /importing = null/, 'a rejected import is not cached, so the next attempt asks again')
  assert.match(source, /setTimeout\(attempt, POLL_MS\)/, 'and the attempt repeats on the poll cadence')
  assert.match(source, /className: failure === null \? 'empty' : 'warning'/, 'an ordinary wait and a failure do not look alike')
})

test('the panel owns no styles of its own: no style object, and inline styles are geometry only', () => {
  const source = panelCode()

  // The ~100-line `styles` object is what made the two clients two designs. It must not come back,
  // in any spelling.
  assert.doesNotMatch(source, /const styles\s*=/, 'no style table')
  assert.doesNotMatch(source, /styles\.[a-zA-Z]+/, 'and nothing reads one')
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'color', 'background', 'border', 'padding', 'margin', 'borderRadius']) {
    assert.equal(
      source.includes(`${property}:`),
      false,
      `${property} is a design decision, and design decisions live in dashboard.css`,
    )
  }

  // What is left is placement: the projection's percentages, put where the chart or bar draws them.
  const allowed = new Set(['top', 'left', 'width', 'height', '--reprise-slot'])
  for (const match of panelSource().matchAll(/style:\s*\{([^}]*)\}/g)) {
    for (const key of match[1].matchAll(/'?(--?[a-zA-Z-]+|[a-zA-Z]+)'?\s*:/g)) {
      assert.ok(allowed.has(key[1]), `inline style "${key[1]}" is not placement — it belongs in the stylesheet`)
    }
  }
  assert.match(source, /className: 'reprise'/, 'the container wears the class every rule is scoped under')
  assert.match(source, /'data-mount': 'panel'/, 'and says it is a docked mount, so the stylesheet can give it a scrollbar')
  // The hook is not decoration: the stylesheet has to answer it, or a docked panel is clipped.
  assert.match(
    readFileSync(PAGE_CSS, 'utf8'),
    /\.reprise\[data-mount='panel'\]\s*\{[^}]*overflow:\s*auto/,
    'the stylesheet gives the docked mount its own scrollbar',
  )
})

test('the panel formats through the page\'s module and names states through the page\'s vocabulary', () => {
  const source = panelCode()

  // Two formatters is how one surface says `0.7331` while the other says `0.73`.
  assert.match(source, /\/api\/reprise\/format\.js/, 'the formatter is fetched from the route the page uses')
  assert.match(source, /\/api\/reprise\/states\.js/, 'and so is the state vocabulary')
  assert.match(source, /import\(/, 'as plain ESM modules, at run time — no bundler, no second copy')
  for (const local of [/function clock\s*\(/, /const clock\s*=/, /function number\s*\(/, /const pad\s*=/, /SHAPE_WORDS\s*=/, /STATE_ORDER\s*=/, /function phaseMark\s*\(/]) {
    assert.doesNotMatch(source, local, `the panel must not re-implement ${local}`)
  }
  // One clock, one number: the panel never builds a time out of Date parts itself.
  assert.doesNotMatch(source, /toLocaleTimeString|toTimeString|getHours\(\)/, 'instants go through the shared formatter')
})

test('every string the panel shows is a locale key, and both dictionaries carry the same keys', async () => {
  const loaded = await loadPanel()
  const en = loaded.dictionaries.get('en')
  const zh = loaded.dictionaries.get('zh')

  assert.ok(en !== undefined && zh !== undefined, 'the panel registers both dictionaries')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'a key in one language and not the other is a blank line for someone')

  // Every key the code mentions exists, so no reader ever sees a raw `panel.something`.
  const used = new Set(
    [...panelSource().matchAll(/\b(?:t|say)\(\s*(?:t\s*,\s*)?'([^']+)'/g)].map((match) => match[1]),
  )
  assert.ok(used.size > 80, `the panel localises its copy (${used.size} keys seen)`)
  for (const key of used) {
    assert.ok(Object.hasOwn(en, key), `"${key}" is missing from EN`)
    assert.ok(Object.hasOwn(zh, key), `"${key}" is missing from ZH`)
  }

  // And nothing else: no CJK outside the ZH dictionary, and no sentence assembled next to a number.
  const withoutZh = panelSource().slice(0, panelSource().indexOf('const ZH =')) + panelSource().slice(panelSource().indexOf('const SHARED', panelSource().indexOf('const ZH =')))
  assert.doesNotMatch(withoutZh, /[\u4e00-\u9fff]/, 'no hardcoded Chinese outside the ZH dictionary')
  for (const value of Object.values(en)) assert.doesNotMatch(String(value), /[\u4e00-\u9fff]/, 'and none smuggled into an EN value')
})

test('the panel speaks the page\'s words for a shape, a verdict and a mark', async () => {
  const loaded = await loadPanel()
  const en = loaded.dictionaries.get('en')
  const states = await import(STATES_JS)

  // `states.js` decides which words exist; the dictionary decides how they are spelled per language.
  // Pinning the EN side to the shared module means the panel cannot invent a second word for a shape
  // — the page's rail and the panel's rail call one candidate one thing.
  for (const [shape, word] of Object.entries(states.SHAPE_WORDS)) {
    assert.equal(en[`shape.${shape}`], word, `shape "${shape}"`)
  }
  for (const [verdict, word] of Object.entries(states.VERDICT_WORDS)) {
    assert.equal(en[`verdict.${verdict}`], word, `verdict "${verdict}"`)
  }
  for (const [mark, word] of Object.entries(states.MARK_WORDS)) {
    assert.equal(en[`mark.${mark}`], word, `mark "${mark}"`)
  }
  for (const state of states.STATE_ORDER) {
    assert.equal(en[`state.${state}`], state, `the contract's own spelling for "${state}"`)
  }

  // The families whose key is built from a payload word: every word the projection can send has an
  // entry in both languages, or a reader meets a raw `rule.max_windows` where a sentence should be.
  const zh = loaded.dictionaries.get('zh')
  // The rule names come from the kernel, not from this file: a rule added to `STOP_RULES` used to
  // leave the suite green while the panel met a reader with a raw `rule.max_cost`. Now the family is
  // derived, so a new rule fails here until both languages have a word for it.
  const families = {
    'rule.': stopRules.STOP_RULES,
    'hold.': ['budget', 'single_job_gpu', 'none'],
    'shape.': Object.keys(states.SHAPE_WORDS),
    'verdict.': Object.keys(states.VERDICT_WORDS),
    'mark.': Object.keys(states.MARK_WORDS),
    'state.': states.STATE_ORDER,
  }
  for (const [prefix, words] of Object.entries(families)) {
    for (const word of words) {
      assert.ok(Object.hasOwn(en, `${prefix}${word}`), `EN is missing ${prefix}${word}`)
      assert.ok(Object.hasOwn(zh, `${prefix}${word}`), `ZH is missing ${prefix}${word}`)
    }
  }

  // The kernel's *candidate* rules are the other half of that vocabulary, and no surface draws them:
  // the inspector prints the rejection's own reason instead. So they get no dictionary entry — a word
  // nobody reads is the copy item 13 of this pass deleted — and the fallback is what a reader would
  // meet if one ever is drawn: the identifier the payload carried, not a raw `rule.` key.
  assert.ok(stopRules.CANDIDATE_STOP_RULES.length > 0, 'the kernel still declares candidate rules')
  for (const name of stopRules.CANDIDATE_STOP_RULES) {
    assert.equal(
      Object.hasOwn(en, `rule.${name}`),
      false,
      `${name} is not drawn anywhere, so it must not carry copy in either language`,
    )
  }
})

test('a word built from a payload identifier falls back to the identifier, never to its key', () => {
  // `rule.*` and `hold.*` are the two families whose key is assembled at run time, so no scan can
  // prove the dictionary has the entry. `hold.*` already answered with the raw identifier when the
  // dictionary had none; `rule.*` printed the whole key, so a rule the kernel adds met a reader as
  // `rule.max_cost` — wrong, and unreadable with it. Both now go through one reader.
  const source = panelCode()

  assert.match(source, /const wordFor = \(t, family, id\)/, 'one reader for both families')
  assert.match(source, /word === key \? String\(id\) : word/, 'the fallback is the identifier the payload carried')
  assert.doesNotMatch(source, /say\(t, `rule\.\$\{/, 'and no rule word is assembled straight into the dictionary lookup')
  assert.doesNotMatch(source, /say\(t, `hold\.\$\{/, 'nor a hold word')

  // The two places that name a rule: the gauge row and the note under it.
  assert.equal([...source.matchAll(/wordFor\(t, 'rule'/g)].length, 2, 'both rule labels go through it')
})

test('the panel\'s styles are geometry objects: no string style, no presentation attribute', () => {
  // `style: { … }` was the only spelling the whitelist knew, so `style: 'color:#f00'` and an SVG
  // `stroke` passed it. Both are design decisions wearing a different shape.
  const source = panelCode()

  assert.doesNotMatch(source, /style:\s*['"`]/, 'no string style: it cannot be checked property by property')
  for (const attribute of ['boxShadow', 'textShadow', 'filter']) {
    assert.equal(source.includes(`${attribute}:`), false, `${attribute} is a design decision, and design decisions live in dashboard.css`)
  }
  // The one SVG is the sidebar glyph, which lives in the host's rail — outside any `.reprise`
  // container, so no rule of ours can reach it. Its presentation attributes may therefore only say
  // "no paint" or "inherit the host's ink"; a literal here is a colour the token sheet never sees.
  for (const match of source.matchAll(/\b(stroke|fill|color|stopColor)\s*:\s*'([^']+)'/g)) {
    assert.match(match[2], /^(none|currentColor|inherit)$/, `${match[1]}: "${match[2]}" is a colour literal`)
  }
})

test('the panel does not paint over a newer read with an older one', () => {
  const source = panelCode()

  assert.match(source, /const gen = useRef\(0\)/, 'the panel keeps a generation for the read in flight')
  assert.match(source, /const mine = \+\+gen\.current/, 'each read takes the next one when it starts')
  assert.equal(
    [...source.matchAll(/if \(!alive\.current \|\| mine !== gen\.current\) return/g)].length,
    2,
    'and checks it before applying an answer or a failure',
  )
})

test('the panel says why the baseline line is missing, not only that it is', async () => {
  const source = panelCode()
  const en = (await loadPanel()).dictionaries.get('en')

  assert.match(source, /ladder\?\.baselineAbsent/, 'the panel reads the projection\'s reason')
  assert.match(source, /ladder\.baselineMissingWhy/, 'and prints it in the key')
  assert.match(source, /ladder\.noBaselineWhy/, 'and in the sentence the chart is read aloud by')
  assert.ok(Object.hasOwn(en, 'ladder.baselineMissingWhy') && Object.hasOwn(en, 'ladder.noBaselineWhy'), 'both keys exist')
  assert.match(en['ladder.baselineMissingWhy'], /\{why\}/, 'and take the reason as a parameter')
})

test('the panel is the page\'s regions in the page\'s order', () => {
  const source = panelCode()
  const root = source.slice(source.indexOf("className: 'reprise'"))
  const regions = ['RegionMasthead', 'RegionHeadline', 'RegionStrips', 'RegionStop', 'RegionLadder', 'RegionReadings', 'RegionTree', 'RegionInspector', 'RegionAudit', 'RegionStream']
  const at = regions.map((name) => root.indexOf(name))
  assert.ok(at.every((index) => index >= 0), `every region is rendered by the root (${regions.filter((_, index) => at[index] < 0).join(', ')})`)
  assert.deepEqual([...at].sort((left, right) => left - right), at, 'masthead → conclusion → strips → stop → staircase → readings → tree → inspector → audit → stream')
})

test('the tree region draws the lineage the projection published, and a node opens its candidate', () => {
  const source = panelCode()

  assert.match(source, /function RegionTree\(/, 'the panel has the page\'s tree region')
  assert.match(source, /continuation\?\.kind/, 'the reason a branch ends is the projection\'s, not the panel\'s guess')
  assert.match(source, /className: 'tree-map'/, 'the map scrolls sideways, so it is its own box')
  assert.match(source, /'data-continuation'/, 'every node carries why its branch ends')
  assert.match(source, /onClick: \(\) => onSelect\(node\.candidate_id\)/, 'a node opens the candidate it names')
  assert.match(source, /className: 'rail-candidate tree-node-shape'/, 'it wears the rail\'s square, not a second vocabulary')
  assert.match(source, /say\(t, `shape\.\$\{node\.shape\}`\)/, 'and the word for a shape is the dictionary\'s')
  assert.doesNotMatch(source, /Math\.(max|min|abs)\(\.\.\./, 'the layout allocates rows; it never reduces a series')
})

test('the two clients draw the same regions in the same order — the page\'s DOM order is the panel\'s component order', () => {
  const page = readFileSync(PAGE_HTML, 'utf8')
  // `readings` is a `<dl>`, not a `<section>`: the row is one line of five cells, and the markup says so.
  const ids = [...page.matchAll(/<(?:section|dl)[^>]*\sid="([^"]+)"/g)].map((match) => match[1])
  const source = panelCode()
  const root = source.slice(source.indexOf("className: 'reprise'"))
  const regions = [...root.matchAll(/h\((Region[A-Za-z]+),/g)].map((match) => match[1])

  // The masthead is a `<header>` on the page and a region in the panel, so it is the one name that
  // does not appear in the `<section>` list; every other region has one id on each side.
  const NAMES = {
    RegionHeadline: 'headline',
    RegionStrips: 'strips',
    RegionStop: 'stop',
    RegionLadder: 'ladder',
    RegionReadings: 'readings',
    RegionTree: 'tree',
    RegionInspector: 'candidate',
    RegionAudit: 'audit',
    RegionStream: 'stream',
  }
  assert.deepEqual(
    regions.filter((name) => name !== 'RegionMasthead').map((name) => NAMES[name]),
    ids,
    'a region added, dropped or moved on one surface and not the other is two designs, and the two suites must not disagree about which order is right',
  )
})

test('both clients draw the tree on the same grid, with the same class names', () => {
  const page = readFileSync(PAGE_JS, 'utf8')
  const panel = panelCode()
  const grid = (source, name) => {
    const match = new RegExp(`const ${name} = Object\\.freeze\\(\\{([^}]*)\\}\\)`).exec(source)
    assert.ok(match !== null, `${name} is declared`)
    return Object.fromEntries(
      [...match[1].matchAll(/(\w+):\s*(\d+)/g)].map((entry) => [entry[1], Number(entry[2])]),
    )
  }

  assert.deepEqual(grid(page, 'TREE'), grid(panel, 'TREE_GRID'), 'one grid, or the same node is a different size on each surface')
  const classes = (source) => new Set([...source.matchAll(/'(tree-[a-z-]+)'/g)].map((match) => match[1]))
  assert.deepEqual([...classes(panel)].sort(), [...classes(page)].sort(), 'and one vocabulary of tree class names')
})

test('the panel asks the page\'s routes, always with GET, and polls at five seconds', () => {
  const source = panelCode()

  for (const path of ['overview', 'rounds', 'candidate', 'conclusion', 'tree', 'calls', 'call']) {
    assert.ok(source.includes(`/api/reprise/${path}`), `the panel reads /api/reprise/${path}`)
  }
  assert.match(source, /POLL_MS\s*=\s*5_000/, 'the panel polls at the page\'s cadence, not its own slower one')
  assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/, 'a read-only surface has no write verb')
  assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|EventSource/, 'no second transport')
  // Every fetch in the module is a GET: no method is declared anywhere, so the default applies.
  assert.doesNotMatch(source, /method:\s*'/, 'the panel declares no request method at all')
})

test('the panel never derives a number: the comparison, the axis and the shapes are the projection\'s', () => {
  const source = panelCode()

  assert.match(source, /comparison\.changePercent/, 'the percentage is the projection\'s')
  assert.match(source, /ladder\?\.axis|ladder\.axis/, 'the axis is the projection\'s')
  assert.match(source, /cumulative/, 'the step series is the projection\'s')
  assert.match(source, /candidate\.shape/, 'the shape is the projection\'s decision')
  assert.doesNotMatch(source, /Math\.(max|min|abs)\(\.\.\./, 'no reduction over a series')
  assert.doesNotMatch(source, /\.reduce\(/, 'and no fold that could accumulate a best')
  assert.doesNotMatch(source, /\.value\s*[<>]/, 'two results are never compared here')
  // The two instants and the hold reasons come from the published envelope, not from a tally.
  assert.match(source, /cursorAt\(/, 'the `last fact` stamp is the cursor\'s instant')
  assert.doesNotMatch(source, /lastFactMs/, 'not a running maximum over whatever this client happened to read')
  assert.match(source, /queue\?\.\.waiting|queue\.waiting|waiting/, 'the cluster cell names who is waiting')
  assert.match(source, /single_job_gpu|budget/, 'and why, in the decision\'s own vocabulary')
})

test('the panel keeps the rail, the inspector and the audit working across a poll', () => {
  const source = panelCode()

  // The rail's squares are buttons that re-point the inspector, exactly as on the page.
  assert.match(source, /aria-pressed/, 'the selected candidate says so')
  assert.match(source, /onClick:\s*\(\)\s*=>\s*onSelect\(/, 'and clicking a square re-points the inspector')
  // An audit that snapped shut every five seconds would be worse than one that never opened.
  assert.match(source, /auditOpen/, 'the open/closed state of the audit is component state')
  assert.match(source, /useState/, 'held in React state, so a poll cannot reset it')
  // The candidate is read at once when the selection changes, not only on the next poll.
  assert.match(source, /readView\('candidate'/, 'the inspector asks for the candidate it is showing')
  assert.match(source, /void poll\(candidateId\)/, 'and selecting a square reads it immediately')
})

test('the panel wears the page\'s class names, not its own', () => {
  const panel = panelCode()
  const page = (readFileSync(PAGE_JS, 'utf8') + readFileSync(PAGE_HTML, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
  const css = readFileSync(PAGE_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  const classesIn = (text, pattern) => new Set([...text.matchAll(pattern)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean))
  const panelClasses = classesIn(panel, /className: '([^']+)'/g)
  const pageClasses = classesIn(page, /class(?:: |=")'?([^'"]+)'?/g)
  const pageUses = pageClasses

  assert.ok(panelClasses.size > 40, `the panel renders the page's components (${panelClasses.size} classes seen)`)
  // The page is the oracle: a class the page never writes is a component this surface invented, and
  // that is exactly how the two designs drifted apart the first time. (Not every page class has a rule
  // of its own — `.identity`, `.audit-line` and `.stream-type` are structural hooks — so "defined in
  // the stylesheet" is the stylesheet test's business, and "used by the page" is this one's.)
  for (const name of panelClasses) {
    assert.ok(pageUses.has(name), `"${name}" is a class the page does not use — a second design hides here`)
  }
  // The attributes the stylesheet keys its shapes off, not just the class names.
  for (const dataAttribute of ['data-mark', 'data-shape', 'data-verdict', 'data-material', 'data-state', 'data-filled', 'data-marker', 'data-layout', 'data-slots']) {
    assert.ok(panel.includes(`'${dataAttribute}'`), `the panel carries ${dataAttribute}, which is how a shape is drawn without colour`)
  }
})
