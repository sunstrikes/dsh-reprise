/**
 * Guards ADR 0002's route surface: one run registry behind the dashboard's URLs, `?run=` on every
 * view, the list, and the two writes.
 *
 * The seam is still `registerRoutes`: a registry goes in (or nothing, and the mount builds one from
 * its workspace), the host's exact Fetch routes come out, and a disposer takes them away. What this
 * file owns, and what nothing else can observe:
 *
 *   - **An absent `?run=` means the default run, and means it byte for byte.** The payload a mount
 *     with a registry sends for a bare URL is the payload the pre-registry mount sent — asserted
 *     against the plain handler rather than against a hand-written expectation, so a change to the
 *     projection shows up as a change on both sides or on neither;
 *   - **a named run is the run you get**, on all seven views;
 *   - **an id nobody registered is a 404 that names it**, never a quiet fall back to the default;
 *   - **the cluster listing is the default run's**, so another run's page says the cluster was not
 *     read instead of printing the ticking run's cards;
 *   - **the list's rows** come from each run's own fact plane, and a run with no facts, no
 *     configuration, or a configuration the reader refused is a row with a reason rather than an error;
 *   - **the two writes**: a created run lands under `runs_root` and answers with what was written, and
 *     a placed intent is the same file the CLI would have written — and neither of them writes a fact.
 *
 * The write surface's scope (`no other path accepts a verb that writes`, `every view is GET-only`) is
 * `read-only.test.js`'s; this file proves behaviour, not the fence.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { tick } from '../../core/lib/loop.js'
import { createRunRegistry } from '../../core/lib/runs.js'
import { Store } from '../../core/lib/store.js'
import { CONFIG_ONLY_PACK_DIR } from '../../core/test/support/domain.js'
import { AT, openWorkspace, runCandidate, seedConfig } from '../../core/test/support/fake-ports.js'
import { conclusionHandler, overviewHandler, registerRoutes, roundsHandler } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

/** A fresh directory to fill with runs. Never in the repository: a test must not write into its own tree. */
const directory = (prefix) => mkdtempSync(join(tmpdir(), prefix))

/** The clock the routes read with. Pinned, so "byte-identical" is a claim a byte comparison can check. */
const CLOCK = Object.freeze({ now: () => AT + 60_000 })

const RUN_CONFIG = ({ domain = CONFIG_ONLY_PACK_DIR } = {}) => `workspace = "."
domain = ${JSON.stringify(domain)}

# The one block a form cannot fill in, which is why a created run's file comments it out.
[model]
kind = "command"
command = ["node", "/dev/null"]
`

/**
 * A run that has lived: two candidates, a best result, and a stop decision, then **no open store** —
 * the state the dashboard reads when the process that ran the loop has exited.
 */
async function livedRun(dir) {
  mkdirSync(dir, { recursive: true })
  const ports = openWorkspace({
    dir,
    config: { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_rounds: 1 }, budget: { gpu_hours_limit: 4 } },
  })
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7001 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })
  await tick(ports)
  ports.store.close()
  return dir
}

/** A run directory with a configuration file and nothing else: no facts, no `workspace.db`. */
function quietRun(dir, config) {
  mkdirSync(dir, { recursive: true })
  if (config !== undefined) writeFileSync(join(dir, 'reprise.toml'), config)
  return dir
}

/** Every fact a run's fact plane holds, through the store's own readers. */
function factsOf(dir) {
  const store = Store.openReadOnly(dir)
  try {
    return {
      workspace: store.getState(undefined, 'workspace') ?? null,
      events: store.eventSubjects().map((subject) => [subject, store.eventsFor(subject)]),
    }
  } finally {
    store.close()
  }
}

/** A root with the three interesting kinds of entry: one run that lived, one quiet one, one bad name. */
async function registryWithRuns() {
  const root = directory('reprise-ui-runs-')
  const alpha = await livedRun(join(root, 'alpha'))
  // The run that lived also carries a configuration, so its row has both halves to report: facts, and a
  // file a host would boot.
  writeFileSync(join(alpha, 'reprise.toml'), RUN_CONFIG())
  const beta = quietRun(join(root, 'beta'))
  const gamma = quietRun(join(root, 'gamma'), 'x = 1\nx = 2\n')
  const badName = join(root, 'not a run id')
  mkdirSync(badName, { recursive: true })
  return { root, alpha, beta, gamma, badName }
}

// ------------------------------------------------------------- the default run

test('an absent ?run= sends the payload the route sent before the registry existed, byte for byte', async () => {
  const root = directory('reprise-ui-runs-')
  const alpha = await livedRun(join(root, 'alpha'))

  const legacy = fakeConnection()
  const withRegistry = fakeConnection()
  const disposeLegacy = registerRoutes({ connection: legacy, workspace: alpha, clock: CLOCK })
  const disposeRegistry = registerRoutes({
    connection: withRegistry,
    workspace: alpha,
    registry: createRunRegistry({ workspace: alpha, runsRoot: root }),
    clock: CLOCK,
  })

  for (const [path, handler] of [
    ['/api/reprise/overview', (workspace) => overviewHandler(workspace, {}, { clock: CLOCK })],
    ['/api/reprise/rounds', (workspace) => roundsHandler(workspace, {})],
    ['/api/reprise/conclusion', (workspace) => conclusionHandler(workspace, {})],
  ]) {
    const bare = await withRegistry.dispatch('GET', path)
    assert.equal(bare.status, 200, `${path} answers`)
    assert.equal(
      bare.text,
      JSON.stringify(await handler(alpha)),
      `${path} is the plain handler's own payload: the registry changed which run a URL means, not what a run looks like`,
    )
    assert.equal((await legacy.dispatch('GET', path)).text, bare.text, `${path} answers the same with no registry mounted`)
  }

  // The explicit spelling of the default run is the same page, and the same bytes: a bookmark may carry
  // `?run=` without turning the default run into a different subject.
  assert.equal((await withRegistry.dispatch('GET', '/api/reprise/overview?run=alpha')).text, (await withRegistry.dispatch('GET', '/api/reprise/overview')).text)

  disposeLegacy()
  disposeRegistry()
})

test('?run= names the run every view answers for', async () => {
  const { root, beta } = await registryWithRuns()
  const registered = fakeConnection()
  const disposeRegistered = registerRoutes({
    connection: registered,
    workspace: join(root, 'alpha'),
    registry: createRunRegistry({ workspace: join(root, 'alpha'), runsRoot: root }),
    clock: CLOCK,
  })

  for (const path of [
    '/api/reprise/overview',
    '/api/reprise/rounds',
    '/api/reprise/tree',
    '/api/reprise/conclusion',
    '/api/reprise/calls',
  ]) {
    const answer = await registered.dispatch('GET', `${path}?run=beta`)
    assert.equal(answer.status, 200, `${path}?run=beta answers`)
    assert.equal(answer.json.workspace, beta, `${path} names the run the query named, not the ticking one`)
    assert.equal(answer.json.data, null, 'and reads that run: beta has no facts, so it says so instead of borrowing alpha\'s')
  }

  const overview = await registered.dispatch('GET', '/api/reprise/overview?run=alpha')
  assert.equal(overview.json.workspace, join(root, 'alpha'))
  assert.equal(overview.json.data.candidates.total, 2, 'alpha keeps its own two candidates')

  disposeRegistered()
})

test('an id the registry does not know is a 404 naming it — on every view, never a fall back', async () => {
  const { root } = await registryWithRuns()
  const connection = fakeConnection()
  const dispose = registerRoutes({
    connection,
    workspace: join(root, 'alpha'),
    registry: createRunRegistry({ workspace: join(root, 'alpha'), runsRoot: root }),
    clock: CLOCK,
  })

  const paths = [
    '/api/reprise/overview',
    '/api/reprise/rounds',
    '/api/reprise/candidate',
    '/api/reprise/tree',
    '/api/reprise/conclusion',
    '/api/reprise/calls',
    '/api/reprise/call',
  ]
  for (const path of paths) {
    const answer = await connection.dispatch('GET', `${path}?run=nobody`)
    assert.equal(answer.status, 404, `${path} refuses an id nobody registered`)
    assert.match(answer.json.error.message, /nobody/, `${path} names the id it could not find`)
    assert.match(answer.json.error.message, /GET \/api\/reprise\/runs/, `${path} says where the list is`)
    assert.equal(answer.json.data, undefined, `${path} answers no page at all rather than another run's`)
  }

  // An empty id is an id: `?run=` is a request for a run called "", and it is not registered either.
  const empty = await connection.dispatch('GET', '/api/reprise/overview?run=')
  assert.equal(empty.status, 404)
  assert.match(empty.json.error.message, /""/)

  // A traversal is not resolved: the registry is the allow-list, so it is simply unknown.
  const traversal = await connection.dispatch('GET', '/api/reprise/overview?run=../alpha')
  assert.equal(traversal.status, 404)

  dispose()
})

test('the cluster listing and the host notice belong to the default run, and no other run is given either', async () => {
  // Two runs that have both lived: the question here is which one's page may ask the cluster, so both
  // sides of the comparison need a fact plane to draw.
  const root = directory('reprise-ui-runs-')
  const alpha = await livedRun(join(root, 'alpha'))
  await livedRun(join(root, 'delta'))
  const platform = {
    calls: 0,
    async list() {
      this.calls += 1
      return { ok: true, jobs: [] }
    },
  }
  const notice = 'this run is not ticking: the configuration was refused (no domain configured)'
  const connection = fakeConnection()
  const dispose = registerRoutes({
    connection,
    workspace: alpha,
    registry: createRunRegistry({ workspace: alpha, runsRoot: root }),
    platform,
    clock: CLOCK,
    notice,
  })

  const bare = await connection.dispatch('GET', '/api/reprise/overview')
  assert.equal(platform.calls, 1, 'a bare URL is the run the host ticks, so its page may ask the cluster')
  assert.equal(bare.json.data.cluster.read, true, 'and the listing it got is the one it drew')
  assert.equal(bare.json.notes[0], notice, 'the notice is about that run, so that run carries it')

  const named = await connection.dispatch('GET', '/api/reprise/overview?run=alpha')
  assert.equal(platform.calls, 2, 'naming the default run explicitly still means the default run')

  const other = await connection.dispatch('GET', '/api/reprise/overview?run=delta')
  assert.equal(other.status, 200)
  assert.equal(platform.calls, 2, 'another run\'s page does not read the default run\'s cluster listing')
  assert.equal(other.json.data.cluster.read, false, 'it says the cluster was not read')
  assert.match(other.json.data.cluster.reason, /not asked/, 'and says why: this page has no listing source of its own')
  assert.equal(
    JSON.stringify(other.json).includes(notice),
    false,
    'the host\'s sentence about the ticking run is not repeated as another run\'s news',
  )

  dispose()
})

// ------------------------------------------------------------------- the list

test('GET /api/reprise/runs answers one row per run, with the three kinds of empty reported as themselves', async () => {
  const { root, alpha, beta, gamma, badName } = await registryWithRuns()
  const connection = fakeConnection()
  const dispose = registerRoutes({
    connection,
    workspace: alpha,
    registry: createRunRegistry({ workspace: alpha, runsRoot: root }),
    clock: CLOCK,
  })

  const answer = await connection.dispatch('GET', '/api/reprise/runs')
  assert.equal(answer.status, 200)
  assert.deepEqual(Object.keys(answer.json).sort(), [
    // T2 added the activation set: which runs this host is allowed to advance is host state, and a list
    // that answered the facts without it would make the panel ask twice for one screen.
    'activation',
    'active',
    'default_run',
    'ok',
    'runs',
    'runs_root',
    'skipped',
  ])
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.runs_root, root)
  assert.equal(answer.json.default_run, 'alpha', 'the run the host ticks is the one a bare request means')
  assert.deepEqual(answer.json.runs.map((row) => row.id).sort(), ['alpha', 'beta', 'gamma'])

  const rows = new Map(answer.json.runs.map((row) => [row.id, row]))

  const lived = rows.get('alpha')
  assert.deepEqual(Object.keys(lived).sort(), [
    'active',
    'best',
    'config',
    'dir',
    'has_facts',
    'id',
    'phase',
    'runnable',
    'source',
    'started_at_ms',
    'stopped',
    // `active` is the operator's decision and `ticking` is that decision AND a usable configuration —
    // two columns, because a switch that is on over a run that cannot move is a lie in one column.
    'ticking',
  ], 'the row is the ADR\'s fields, and no others')
  assert.equal(lived.has_facts, true)
  assert.equal(lived.source, 'workspace', 'the ticking run says which declaration found it')
  assert.equal(lived.phase, 'FINALIZE', 'the phase comes from the run\'s own fact plane')
  assert.equal(lived.stopped, true, 'a concluded run says it stopped')
  assert.equal(lived.started_at_ms, AT, 'and when it started, from the fact that recorded it')
  assert.deepEqual(
    lived.best,
    { candidate_id: 'r2-c1', round: 2, metric: 'auc', value: 0.7401 },
    'the best result is the ranking\'s own answer, carried as it computes it',
  )
  assert.equal(lived.config.status, 'ok')
  assert.equal(lived.config.path, join(alpha, 'reprise.toml'))
  assert.deepEqual(lived.runnable, { ok: true }, 'a configuration the host would boot is runnable, with nothing to report')

  const noFacts = rows.get('beta')
  assert.equal(noFacts.has_facts, false, 'a directory created a second ago has no facts, and that is a row, not an error')
  assert.equal(noFacts.phase, null)
  assert.equal(noFacts.stopped, null)
  assert.equal(noFacts.started_at_ms, null)
  assert.equal(noFacts.best, null)
  assert.equal(noFacts.config.status, 'missing')
  assert.equal(noFacts.runnable.ok, false)
  assert.match(noFacts.runnable.problem, /reprise\.toml is missing/, 'the refusal says which file is missing and where')

  const refused = rows.get('gamma')
  assert.equal(refused.config.status, 'invalid', 'a file the reader refused is `invalid`, not "the run is bad"')
  assert.ok(refused.config.problems.length > 0, 'and it carries the reader\'s own words')
  assert.equal(refused.runnable.ok, false)
  assert.equal(
    refused.runnable.problem,
    refused.config.problems.join('; '),
    'the row\'s refusal is the reader\'s sentence, not a second summary of it',
  )

  assert.equal(answer.json.skipped.length, 1)
  assert.equal(answer.json.skipped[0].dir, badName)
  assert.match(answer.json.skipped[0].reason, /not a run id/, 'a bad directory name is reported with its reason, never renamed')

  dispose()
})

// ------------------------------------------------------------- creating a run

test('POST /api/reprise/runs scaffolds one run under runs_root and answers with what was written', async () => {
  const root = directory('reprise-ui-runs-')
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, registry: createRunRegistry({ runsRoot: root }) })

  const answer = await connection.dispatch('POST', '/api/reprise/runs', {
    id: 'new-run',
    mode: 'empty',
    domain: CONFIG_ONLY_PACK_DIR,
    max_rounds: 4,
    candidates_per_round: 3,
    candidate_gpu_hours: 1.5,
  })

  assert.equal(answer.method, 'POST')
  assert.equal(answer.status, 200, 'a created run is an answer, not a redirect or an empty 204')
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.run.id, 'new-run')
  assert.equal(answer.json.run.dir, join(root, 'new-run'))
  assert.equal(answer.json.run.config.status, 'ok', 'the answer carries the file as it was read back, not as it was requested')
  assert.equal(answer.json.run.config.value.domain, CONFIG_ONLY_PACK_DIR)
  assert.deepEqual(
    answer.json.run.config.value.rounds,
    { max_rounds: 4, candidates_per_round: 3 },
    'the flat body fields land on the keys the run configuration uses',
  )
  assert.equal(answer.json.run.config.value.budget.candidate_gpu_hours, 1.5)

  assert.ok(existsSync(join(root, 'new-run', 'reprise.toml')), 'and the run is a directory with a configuration, on disk')

  // The list is the proof that the two routes are one resource: the run created a moment ago is a row
  // with no facts, and its configuration is reported exactly as the create answered it.
  const listed = await connection.dispatch('GET', '/api/reprise/runs')
  assert.deepEqual(listed.json.runs.map((row) => row.id), ['new-run'])
  assert.equal(listed.json.default_run, 'new-run', 'with no `workspace` configured, the first run in registry order is the default')
  assert.equal(listed.json.runs[0].has_facts, false)
  assert.equal(listed.json.runs[0].config.status, 'ok')
  assert.equal(listed.json.runs[0].runnable.ok, false, 'a scaffolded run is honestly not runnable yet')
  assert.match(
    listed.json.runs[0].runnable.problem,
    /model\.command/,
    'it says what is missing: the file the form cannot fill in is commented out, and the row says so',
  )

  dispose()
})

test('POST /api/reprise/runs refuses with the sentence naming what was wrong, and writes nothing', async () => {
  const root = directory('reprise-ui-runs-')
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, registry: createRunRegistry({ runsRoot: root }) })

  const created = await connection.dispatch('POST', '/api/reprise/runs', {
    id: 'taken',
    mode: 'empty',
    domain: CONFIG_ONLY_PACK_DIR,
  })
  assert.equal(created.status, 200)

  const cases = [
    [{ id: 'taken', mode: 'empty', domain: CONFIG_ONLY_PACK_DIR }, /already exists/, 'a duplicate id'],
    [{ id: 'relative-domain', mode: 'empty', domain: 'packs/feed' }, /domain must be the absolute path/, 'a relative domain'],
    [{ id: 'no-mode', mode: 'sideways', domain: CONFIG_ONLY_PACK_DIR }, /mode must be "clone" or "empty"/, 'an unknown mode'],
    [{ mode: 'empty', domain: CONFIG_ONLY_PACK_DIR }, /run id must match/, 'a missing id'],
    [{ id: 'bad numbers', mode: 'empty', domain: CONFIG_ONLY_PACK_DIR, max_rounds: '4' }, /max_rounds must be a positive whole number/, 'a number sent as a string'],
    [{ id: 'bad-hours', mode: 'empty', domain: CONFIG_ONLY_PACK_DIR, candidate_gpu_hours: 0 }, /candidate_gpu_hours must be a positive number/, 'a non-positive number'],
    [{ id: 'escaping', mode: 'empty', domain: CONFIG_ONLY_PACK_DIR, repo_dir: '../elsewhere' }, /repo_dir must stay inside the run directory/, 'a repository path outside the run'],
  ]
  for (const [body, expected, what] of cases) {
    const answer = await connection.dispatch('POST', '/api/reprise/runs', body)
    assert.equal(answer.status, 400, `${what} is a client error, not a server fault`)
    assert.match(answer.json.error.message, expected)
  }

  // What a body can be wrong about is a 400 too: an empty one, one that is not JSON, one that is not an
  // object, and one the transport could not deliver at all.
  const bodiless = await connection.dispatch('POST', '/api/reprise/runs')
  assert.equal(bodiless.status, 400)
  assert.match(bodiless.json.error.message, /no body/)

  const notJson = await connection.dispatch('POST', '/api/reprise/runs', '{id: "x",}')
  assert.equal(notJson.status, 400)
  assert.match(notJson.json.error.message, /not JSON/)

  const array = await connection.dispatch('POST', '/api/reprise/runs', '[{"id":"x"}]')
  assert.equal(array.status, 400)
  assert.match(array.json.error.message, /JSON object/)

  const unreadable = await connection.dispatch(
    'POST',
    '/api/reprise/runs',
    new ReadableStream({
      start(controller) {
        controller.error(new Error('the connection dropped'))
      },
    }),
  )
  assert.equal(unreadable.status, 400, 'a body that cannot be read is still the caller\'s error, never a 500')
  assert.match(unreadable.json.error.message, /could not be read/)

  assert.deepEqual(readdirSync(root), ['taken'], 'no refused request left a directory behind, and nothing outside the root was written')

  dispose()
})

// -------------------------------------------------------------- placing intents

test('POST /api/reprise/intent places the file the CLI would have written, then reports the id is taken', async () => {
  const { root, alpha } = await registryWithRuns()
  const before = factsOf(alpha)
  const connection = fakeConnection()
  const dispose = registerRoutes({
    connection,
    workspace: alpha,
    registry: createRunRegistry({ workspace: alpha, runsRoot: root }),
    clock: CLOCK,
  })

  const intent = { kind: 'pause', intent_id: 'pause-1', reason: 'stop spending on this direction' }
  const first = await connection.dispatch('POST', '/api/reprise/intent', { run: 'alpha', intent })

  assert.equal(first.method, 'POST')
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.status, 'placed')
  assert.equal(first.json.path, join(alpha, 'pending', 'pause-1.json'))

  const written = JSON.parse(readFileSync(first.json.path, 'utf8'))
  assert.deepEqual(
    Object.keys(written).sort(),
    ['intent_id', 'kind', 'placed_at_ms', 'reason'],
    'the file has the intent\'s own fields and the placement stamp — the kernel\'s format, not a transport format',
  )
  assert.equal(written.intent_id, 'pause-1')
  assert.equal(Number.isSafeInteger(written.placed_at_ms), true)

  const second = await connection.dispatch('POST', '/api/reprise/intent', { run: 'alpha', intent })
  assert.equal(second.status, 200, 'a second placement is an answer, not a failure: the file is the fact')
  assert.equal(second.json.status, 'exists')
  assert.equal(second.json.path, first.json.path)

  // The one write a run's own state accepts from the page is a file under `pending/`. Nothing in the
  // fact plane moved: no pause was applied, no event was appended — the kernel that reads the file does
  // that, and it is not this process.
  assert.deepEqual(factsOf(alpha), before, 'placing an intent changed no fact')

  const unknown = await connection.dispatch('POST', '/api/reprise/intent', { run: 'nobody', intent })
  assert.equal(unknown.status, 404)
  assert.match(unknown.json.error.message, /nobody/)
  assert.match(unknown.json.error.message, /GET \/api\/reprise\/runs/)

  // A refusal from the intent writer keeps its own reason: the caller learns which field was wrong.
  const refused = await connection.dispatch('POST', '/api/reprise/intent', {
    run: 'alpha',
    intent: { kind: 'grant', intent_id: 'grant-1' },
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.json.error.message, 'nothing_to_grant')

  const bodiless = await connection.dispatch('POST', '/api/reprise/intent')
  assert.equal(bodiless.status, 400)
  assert.match(bodiless.json.error.message, /no body/)

  // The intent route reads no file back: a GET is not declared, so the host 404s it before a handler.
  assert.equal((await connection.dispatch('GET', '/api/reprise/intent')).status, 404)

  dispose()
})
// -------------------------------------------------- start / stop a run (T2, host-level intent)

test('activating a run records it beside the runs, and the list says what that means', async () => {
  const { root, alpha } = await registryWithRuns()
  const registry = createRunRegistry({ workspace: alpha, runsRoot: root })
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, workspace: alpha, registry, clock: CLOCK })

  const before = await connection.dispatch('GET', '/api/reprise/runs')
  assert.deepEqual(before.json.active, ['alpha'], 'an absent activation file means exactly the run this host ticks')
  assert.equal(before.json.activation.status, 'absent')
  const beta = before.json.runs.find((row) => row.id === 'beta')
  assert.equal(beta.active, false)
  assert.equal(beta.ticking, false, 'a run nobody activated is not being advanced')

  const started = await connection.dispatch('POST', '/api/reprise/intent', { run: 'beta', intent: { kind: 'activate' } })
  assert.equal(started.status, 200)
  assert.equal(started.json.scope, 'host', 'this is the host\'s decision, not a fact of the run')
  assert.equal(started.json.status, 'active')
  assert.deepEqual(started.json.active, ['beta'])
  assert.match(started.json.path, /\.reprise-host\.json$/)

  const after = await connection.dispatch('GET', '/api/reprise/runs')
  assert.deepEqual(after.json.active, ['beta'], 'the list reads the recorded decision, not a guess')
  const betaAfter = after.json.runs.find((row) => row.id === 'beta')
  assert.equal(betaAfter.active, true)
  // `beta` has a configuration file with no rounds/budget/model problems only if it resolves; either
  // way the two columns stay distinct: activated is the operator's word, ticking needs a usable config.
  assert.equal(betaAfter.ticking, betaAfter.active && betaAfter.runnable.ok === true)

  const stopped = await connection.dispatch('POST', '/api/reprise/intent', { run: 'beta', intent: { kind: 'deactivate' } })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.json.status, 'inactive')
  assert.deepEqual((await connection.dispatch('GET', '/api/reprise/runs')).json.active, [])

  dispose()
})

test('activating refuses an unknown run, and refuses outright on a host with no runs_root', async () => {
  const { root, alpha } = await registryWithRuns()
  const withRoot = fakeConnection()
  const disposeRoot = registerRoutes({
    connection: withRoot,
    workspace: alpha,
    registry: createRunRegistry({ workspace: alpha, runsRoot: root }),
    clock: CLOCK,
  })

  const unknown = await withRoot.dispatch('POST', '/api/reprise/intent', { run: 'nobody', intent: { kind: 'activate' } })
  assert.equal(unknown.status, 404, 'the allow-list is the same one the reads use')

  // The same route keeps behaving like the pre-T2 intent writer for the run-scoped kinds.
  const pause = await withRoot.dispatch('POST', '/api/reprise/intent', {
    run: 'alpha',
    intent: { kind: 'pause', intent_id: 'pause-1', reason: 'night' },
  })
  assert.equal(pause.status, 200)
  assert.equal(pause.json.scope, 'run')

  // A host configured with one workspace and no registry has nowhere to record a set of runs, so it
  // says so instead of accepting a decision it cannot keep.
  const solo = fakeConnection()
  const disposeSolo = registerRoutes({ connection: solo, workspace: alpha })
  const noRoot = await solo.dispatch('POST', '/api/reprise/intent', { run: 'alpha', intent: { kind: 'activate' } })
  assert.equal(noRoot.status, 400)
  assert.match(noRoot.json.error.message, /runs_root/)

  disposeRoot()
  disposeSolo()
})
