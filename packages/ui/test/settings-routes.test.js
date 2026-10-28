/**
 * Guards the two routes an operator uses to *change* this host from the page: the settings file the page
 * owns, and the archive that takes a run out of the registry without destroying it.
 *
 * The seam is still `registerRoutes`, and the two halves of this file assert the two things nothing else
 * can observe:
 *
 *   - **`GET`/`POST /api/reprise/settings`** answer one payload — what is in force, who decided it, and
 *     what clearing a key would go back to — and the write is read back through the same reader as the
 *     GET, so the page never reconciles "what I sent" with "what landed". The file lives in a temporary
 *     `DSH_HOME`, which is why every assertion here can be about *bytes on disk* and not only about a
 *     JSON body.
 *   - **`POST /api/reprise/runs/delete`** is an archive: the directory moves to
 *     `<runs_root>/.trash/<id>-<stamp>` whole, the registry stops listing it, and the host's own file
 *     remembers where it went. Every refusal is asserted with its status *and* with the fact that it
 *     changed nothing — a 409 that had already moved the directory would pass a status-only test.
 *
 * The settings route's dependence on the caller is asserted too: a mount that was not given `{env,
 * config}` answers a 400 that says so, rather than inventing an answer from an environment it was not
 * handed.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { createRunRegistry } from '../../core/lib/runs.js'
import { readSettings, settingsPath } from '../../core/lib/settings.js'
import { AT, openWorkspace, seedConfig } from '../../core/test/support/fake-ports.js'
import { registerRoutes } from '../lib/routes.js'
import { fakeConnection } from './support/fake-connection.js'

/** A fresh directory. Never in the repository: a test must not write into its own tree. */
const directory = (prefix) => mkdtempSync(join(tmpdir(), prefix))

/** The clock the routes read with, pinned: the archive's own path carries a timestamp. */
const CLOCK = Object.freeze({ now: () => AT + 60_000 })

/** What the plugin configuration says. Both keys set, so "configured" has something to report. */
const CONFIG = Object.freeze({ runs_root: '/srv/runs', max_active_runs: 3 })

const envOf = (dshHome) => ({ DSH_HOME: dshHome })

/** The file a `DSH_HOME` implies — taken from the module under test rather than re-spelled here. */
const pathIn = (dshHome) => settingsPath({ env: envOf(dshHome) })

/** Put a settings document on disk the way a previous session would have left it. */
function seedSettings(dshHome, document) {
  mkdirSync(join(dshHome, 'reprise'), { recursive: true })
  const path = pathIn(dshHome)
  writeFileSync(path, typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`)
  return path
}

/** A mount that was given the two things the settings routes need, and nothing else. */
function settingsMount({ dshHome = directory('reprise-ui-home-'), config = CONFIG, settings } = {}) {
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, settings: settings ?? { env: envOf(dshHome), config } })
  return { connection, dispose, dshHome }
}

// ---------------------------------------------------------------- reading settings

test('GET /api/reprise/settings answers the path, the status and who decided each value, with no file', async () => {
  const { connection, dispose, dshHome } = settingsMount()

  const answer = await connection.dispatch('GET', '/api/reprise/settings')
  assert.equal(answer.method, 'GET')
  assert.equal(answer.status, 200)
  assert.deepEqual(
    Object.keys(answer.json).sort(),
    [
      'configured',
      'max_active_runs',
      'max_active_runs_from',
      'ok',
      'path',
      'problems',
      'runs_root',
      'runs_root_from',
      'status',
    ],
    'the payload is the frozen contract, and no other keys',
  )

  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.status, 'absent', 'a host that has never been told anything is not an error')
  assert.equal(answer.json.path, pathIn(dshHome), 'and it names the file it would write')
  assert.deepEqual(answer.json.problems, [])
  assert.equal(
    existsSync(answer.json.path),
    false,
    'a GET does not create the file whose path it reports: reading is not deciding',
  )

  assert.equal(answer.json.runs_root, CONFIG.runs_root, 'nothing set from the page, so the configuration answers')
  assert.equal(answer.json.runs_root_from, 'config')
  assert.equal(answer.json.max_active_runs, CONFIG.max_active_runs)
  assert.equal(answer.json.max_active_runs_from, 'config')
  assert.deepEqual(
    answer.json.configured,
    { runs_root: CONFIG.runs_root, max_active_runs: CONFIG.max_active_runs },
    'the configured half is what clearing a key would go back to',
  )

  dispose()
})

test('GET reports a settings file that exists, and says the page outranks the configuration', async () => {
  const { connection, dispose, dshHome } = settingsMount()
  seedSettings(dshHome, { v: 1, runs_root: '/srv/chosen', max_active_runs: 5 })

  const answer = await connection.dispatch('GET', '/api/reprise/settings')
  assert.equal(answer.status, 200)
  assert.equal(answer.json.status, 'ok')
  assert.deepEqual(answer.json.problems, [])
  assert.equal(answer.json.runs_root, '/srv/chosen')
  assert.equal(answer.json.runs_root_from, 'settings', 'what the page wrote wins, and the payload says so')
  assert.equal(answer.json.max_active_runs, 5)
  assert.equal(answer.json.max_active_runs_from, 'settings')
  assert.deepEqual(
    answer.json.configured,
    { runs_root: CONFIG.runs_root, max_active_runs: CONFIG.max_active_runs },
    'the configuration is still reported, unchanged: it is the fallback, not a rival',
  )

  dispose()
})

test('GET reports a corrupt settings file as invalid, with the reader\'s own sentence, and falls back', async () => {
  const { connection, dispose, dshHome } = settingsMount()
  seedSettings(dshHome, '{ this is not json')

  const answer = await connection.dispatch('GET', '/api/reprise/settings')
  assert.equal(answer.status, 200, 'a file the reader refused is a fact about the host, not a failed request')
  assert.equal(answer.json.status, 'invalid')
  assert.ok(answer.json.problems.length > 0)
  assert.match(answer.json.problems[0], /not valid JSON/, 'the problem is the reader\'s sentence, with the path in it')
  assert.ok(answer.json.problems[0].includes(pathIn(dshHome)))
  assert.equal(answer.json.runs_root, CONFIG.runs_root, 'a corrupt file falls back to the configuration rather than defaulting silently')
  assert.equal(answer.json.runs_root_from, 'config')
  assert.equal(answer.json.max_active_runs_from, 'config')

  dispose()
})

// ---------------------------------------------------------------- writing settings

test('POST /api/reprise/settings writes the file and answers what is in force, read back', async () => {
  const { connection, dispose, dshHome } = settingsMount()

  const answer = await connection.dispatch('POST', '/api/reprise/settings', { runs_root: '/srv/page', max_active_runs: 4 })
  assert.equal(answer.method, 'POST')
  assert.equal(answer.status, 200)
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.runs_root, '/srv/page')
  assert.equal(answer.json.runs_root_from, 'settings')
  assert.equal(answer.json.max_active_runs, 4)
  assert.equal(answer.json.max_active_runs_from, 'settings')
  assert.equal(answer.json.status, 'ok')
  assert.deepEqual(
    answer.json.configured,
    { runs_root: CONFIG.runs_root, max_active_runs: CONFIG.max_active_runs },
    'the configured half does not move: clearing the key still has somewhere to go back to',
  )

  const written = JSON.parse(readFileSync(pathIn(dshHome), 'utf8'))
  assert.deepEqual(written, { v: 1, runs_root: '/srv/page', max_active_runs: 4 }, 'the decision is on disk, versioned')

  const read = await connection.dispatch('GET', '/api/reprise/settings')
  assert.equal(read.text, answer.text, 'a POST is a GET after the write: one payload, one derivation, byte for byte')

  // A button is a button: writing the same values again is an answer, not a refusal.
  const again = await connection.dispatch('POST', '/api/reprise/settings', { runs_root: '/srv/page', max_active_runs: 4 })
  assert.equal(again.status, 200)
  assert.equal(again.text, answer.text)

  // An empty patch changes nothing and still answers the same payload.
  const noop = await connection.dispatch('POST', '/api/reprise/settings', {})
  assert.equal(noop.status, 200)
  assert.equal(noop.text, answer.text)

  dispose()
})

test('POST with null clears a key back to the configured value and says the configuration answered', async () => {
  const { connection, dispose, dshHome } = settingsMount()
  seedSettings(dshHome, { v: 1, runs_root: '/srv/page', max_active_runs: 4 })

  const cleared = await connection.dispatch('POST', '/api/reprise/settings', { runs_root: null })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.runs_root, CONFIG.runs_root, 'clearing hands the question back to the configuration')
  assert.equal(cleared.json.runs_root_from, 'config')
  assert.equal(cleared.json.max_active_runs, 4, 'and leaves the key it was not asked about alone')
  assert.equal(cleared.json.max_active_runs_from, 'settings')

  let written = JSON.parse(readFileSync(pathIn(dshHome), 'utf8'))
  assert.deepEqual(written, { v: 1, max_active_runs: 4 }, 'the cleared key is gone from the file, not set to null')

  const both = await connection.dispatch('POST', '/api/reprise/settings', { max_active_runs: null })
  assert.equal(both.status, 200)
  assert.equal(both.json.max_active_runs, CONFIG.max_active_runs)
  assert.equal(both.json.max_active_runs_from, 'config')
  assert.equal(both.json.runs_root_from, 'config')
  assert.equal(both.json.status, 'ok', 'an empty document is still a valid one: nothing is in force from the page')

  written = JSON.parse(readFileSync(pathIn(dshHome), 'utf8'))
  assert.deepEqual(written, { v: 1 }, 'the file keeps its version and no decisions')

  dispose()
})

test('POST refuses each way a settings body can be wrong, by name, and writes nothing', async () => {
  const { connection, dispose, dshHome } = settingsMount()

  const cases = [
    [{ runs_root: 'packs/runs' }, /runs_root must be the absolute path of a directory/, 'a relative runs_root'],
    [{ runs_root: '' }, /runs_root must be the absolute path of a directory/, 'an empty runs_root'],
    [{ runs_root: 7 }, /runs_root must be the absolute path of a directory/, 'a runs_root that is not a string'],
    [{ max_active_runs: 0 }, /max_active_runs must be a positive whole number/, 'a non-positive cap'],
    [{ max_active_runs: -1 }, /max_active_runs must be a positive whole number/, 'a negative cap'],
    [{ max_active_runs: 1.5 }, /max_active_runs must be a positive whole number/, 'a fractional cap'],
    [{ max_active_runs: '4' }, /max_active_runs must be a positive whole number/, 'a number sent as a string'],
    [{ domains: '/srv/domains' }, /"domains" is not a setting this page owns/, 'a key the page does not own'],
    [{ runs_root: '/srv/runs', tick: true }, /"tick" is not a setting this page owns/, 'an extra key beside a good one'],
  ]
  for (const [body, expected, what] of cases) {
    const answer = await connection.dispatch('POST', '/api/reprise/settings', body)
    assert.equal(answer.status, 400, `${what} is the caller's error, not a server fault`)
    assert.match(answer.json.error.message, expected)
  }

  // What the body can be wrong about as a document is refused too, with its own sentence.
  const array = await connection.dispatch('POST', '/api/reprise/settings', '[{"runs_root":"/srv/runs"}]')
  assert.equal(array.status, 400)
  assert.match(array.json.error.message, /JSON object/)

  const bodiless = await connection.dispatch('POST', '/api/reprise/settings')
  assert.equal(bodiless.status, 400)
  assert.match(bodiless.json.error.message, /no body/)

  assert.equal(existsSync(pathIn(dshHome)), false, 'no refused request created the file')

  dispose()
})

test('POST refuses when there is nowhere to write, and surfaces a corrupt file\'s own sentence verbatim', async () => {
  // A host with no DSH_HOME has no home directory, so it must say so rather than write somewhere else.
  const homeless = settingsMount({ settings: { env: {}, config: CONFIG } })
  const nowhere = await homeless.connection.dispatch('POST', '/api/reprise/settings', { max_active_runs: 2 })
  assert.equal(nowhere.status, 400)
  assert.match(nowhere.json.error.message, /DSH_HOME is not set/)
  homeless.dispose()

  // A corrupt file is the only record of what somebody chose: it is refused, and the refusal is the
  // reader's own sentence — naming the file and the fault — not a summary of it.
  const { connection, dispose, dshHome } = settingsMount()
  const path = seedSettings(dshHome, '{ "v": 1, ')
  const before = readFileSync(path, 'utf8')
  const expected = readSettings({ env: envOf(dshHome) }).problems[0]

  const refused = await connection.dispatch('POST', '/api/reprise/settings', { runs_root: '/srv/page' })
  assert.equal(refused.status, 400)
  assert.equal(refused.json.error.message, expected, 'the sentence is surfaced verbatim')
  assert.equal(readFileSync(path, 'utf8'), before, 'and the file it could not read is left exactly as it was')

  dispose()
})

test('a mount that was not given {env, config} answers one sentence instead of inventing settings', async () => {
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection })

  for (const [method, body] of [
    ['GET', undefined],
    ['POST', { max_active_runs: 2 }],
  ]) {
    const answer = await connection.dispatch(method, '/api/reprise/settings', body)
    assert.equal(answer.status, 400, `${method} is mounted, so the fault reaches the page as an answer`)
    assert.match(answer.json.error.message, /did not wire settings/)
  }

  dispose()
})

// ------------------------------------------------------------------ deleting a run

/** A run directory with nothing but a configuration file: a row with no facts. */
function quietRun(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A run that has a fact plane — the thing an archive must not destroy. */
function livedRun(dir) {
  mkdirSync(dir, { recursive: true })
  const ports = openWorkspace({ dir })
  seedConfig(ports.store, { metrics: { primary: 'auc', objectives: { auc: 'up' } }, stop: { max_rounds: 1 } })
  ports.store.close()
  return dir
}

/** A root with the run this host ticks, a run that has lived, and one quiet run. */
function rootWithRuns() {
  const root = directory('reprise-ui-delete-')
  return {
    root,
    alpha: quietRun(join(root, 'alpha')),
    beta: livedRun(join(root, 'beta')),
    gamma: quietRun(join(root, 'gamma')),
  }
}

/** The registry mount the page talks to; the delete route needs nothing else. */
function deleteMount({ root, workspace, runs }) {
  const registry = createRunRegistry({ workspace, runsRoot: root, runs })
  const connection = fakeConnection()
  const dispose = registerRoutes({ connection, registry, clock: CLOCK })
  return { connection, registry, dispose }
}

const archiveOf = (root, id, atMs) =>
  join(root, '.trash', `${id}-${new Date(atMs).toISOString().replace(/[:.]/g, '-')}`)

test('POST /api/reprise/runs/delete moves the run into the archive and the list stops showing it', async () => {
  const { root, alpha, beta } = rootWithRuns()
  const before = readdirSync(beta).sort()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  const answer = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'beta', confirm: 'beta' })
  assert.equal(answer.method, 'POST')
  assert.equal(answer.status, 200)
  assert.deepEqual(Object.keys(answer.json).sort(), ['at_ms', 'id', 'ok', 'trashed_to'])
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.id, 'beta')
  assert.equal(answer.json.trashed_to, archiveOf(root, 'beta', AT + 60_000), 'the answer says where it went')
  assert.equal(answer.json.at_ms, AT + 60_000)

  assert.equal(existsSync(beta), false, 'it is no longer a run')
  assert.equal(existsSync(answer.json.trashed_to), true, 'and it is still a directory')
  assert.deepEqual(
    readdirSync(answer.json.trashed_to).sort(),
    before,
    'the directory moved whole: a fact plane, a configuration and everything beside them are all still there',
  )

  const listed = await connection.dispatch('GET', '/api/reprise/runs')
  assert.deepEqual(listed.json.runs.map((row) => row.id).sort(), ['alpha', 'gamma'])
  assert.deepEqual(listed.json.skipped, [], 'the archive is a dot-directory, so it is not even a skipped entry')

  // "Where did it go?" is answerable a week later from the host's own file.
  const host = JSON.parse(readFileSync(join(root, '.reprise-host.json'), 'utf8'))
  assert.deepEqual(host.trashed, [
    { id: 'beta', dir: beta, trashed_to: answer.json.trashed_to, at_ms: AT + 60_000 },
  ])

  dispose()
})

test('the two-step guard refuses a confirmation that does not repeat the id, and moves nothing', async () => {
  const { root, alpha, beta } = rootWithRuns()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  for (const [body, what] of [
    [{ id: 'beta', confirm: 'gamma' }, 'a confirmation naming another run'],
    [{ id: 'beta' }, 'no confirmation at all'],
    [{ id: 'beta', confirm: true }, 'a confirmation that is not the id'],
    [{ confirm: 'beta' }, 'no id'],
  ]) {
    const answer = await connection.dispatch('POST', '/api/reprise/runs/delete', body)
    assert.equal(answer.status, 400, `${what} is refused before anything touches the disk`)
    assert.match(answer.json.error.message, /two steps|needs its id/, `${what} is named`)
  }

  const named = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'beta', confirm: 'wrong' })
  assert.match(named.json.error.message, /"beta"/, 'the refusal says which id to repeat')

  assert.equal(existsSync(beta), true, 'the run nobody confirmed is exactly where it was')
  assert.equal(existsSync(join(root, '.trash')), false, 'and no archive was opened')

  dispose()
})

test('an id nobody registered is the same 404 the read routes answer', async () => {
  const { root, alpha } = rootWithRuns()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  const answer = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'nobody', confirm: 'nobody' })
  assert.equal(answer.status, 404)
  assert.match(answer.json.error.message, /no run "nobody" is registered on this host/)
  assert.match(answer.json.error.message, /GET \/api\/reprise\/runs/, 'it points at the list, in the same words as every other 404')

  dispose()
})

test('the run this host ticks cannot be removed, in its own words and with a 409', async () => {
  const { root, alpha } = rootWithRuns()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  const answer = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'alpha', confirm: 'alpha' })
  assert.equal(answer.status, 409, 'a conflict with what the host is doing, not a bad request')
  assert.match(answer.json.error.message, /cannot be removed/)
  assert.match(answer.json.error.message, /workspace/, 'it says what to change first')
  assert.equal(existsSync(alpha), true, 'the ticking run is still where the loop points')

  dispose()
})

test('an active run must be stopped first, and the refusal does not deactivate it on the caller\'s behalf', async () => {
  const { root, alpha, gamma } = rootWithRuns()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  const started = await connection.dispatch('POST', '/api/reprise/intent', { run: 'gamma', intent: { kind: 'activate' } })
  assert.equal(started.status, 200)
  assert.deepEqual(started.json.active, ['gamma'])

  const answer = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'gamma', confirm: 'gamma' })
  assert.equal(answer.status, 409)
  assert.match(answer.json.error.message, /active/)
  assert.match(answer.json.error.message, /stop it first/)

  assert.equal(existsSync(gamma), true, 'nothing moved')
  const listed = await connection.dispatch('GET', '/api/reprise/runs')
  assert.deepEqual(listed.json.active, ['gamma'], 'and the activation record is untouched: stopping is a separate decision')

  dispose()
})

test('removing a run needs a runs_root, and only moves things inside it', async () => {
  const { root, alpha } = rootWithRuns()
  const outside = directory('reprise-ui-outside-')

  // A host configured with a workspace and an extra run, but no directory of runs: there is nowhere to
  // put an archive, so it says so instead of moving the directory somewhere of its own choosing.
  const id = basename(outside)
  const noRoot = deleteMount({ workspace: alpha, root: undefined, runs: [outside] })
  const homeless = await noRoot.connection.dispatch('POST', '/api/reprise/runs/delete', { id, confirm: id })
  assert.equal(homeless.status, 400)
  assert.match(homeless.json.error.message, /needs runs_root/)
  assert.equal(existsSync(outside), true)
  noRoot.dispose()

  // A run declared through `runs: [...]` is inside the registry but outside `runs_root`, and this route
  // only reorganises the directory it owns.
  const withRoot = deleteMount({ root, workspace: alpha, runs: [outside] })
  const escaping = await withRoot.connection.dispatch('POST', '/api/reprise/runs/delete', { id, confirm: id })
  assert.equal(escaping.status, 400)
  assert.match(escaping.json.error.message, /not inside runs_root/)
  assert.equal(existsSync(outside), true, 'a declared run in a checkout is never moved')
  withRoot.dispose()
})

test('the delete route is one POST, and never answers a GET or a DELETE', async () => {
  const { root, alpha, beta } = rootWithRuns()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  assert.equal((await connection.dispatch('GET', '/api/reprise/runs/delete')).status, 404)
  assert.equal(
    (await connection.dispatch('DELETE', '/api/reprise/runs/delete', { id: 'beta', confirm: 'beta' })).status,
    404,
    'the verb a `rm` would use is not declared at all',
  )
  assert.equal(existsSync(beta), true)

  dispose()
})
test('a second archive at the same instant is refused rather than overwriting the first', async () => {
  const { root, alpha, beta } = rootWithRuns()
  const { connection, dispose } = deleteMount({ root, workspace: alpha })

  const first = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'beta', confirm: 'beta' })
  assert.equal(first.status, 200)

  // The same id, created again a moment later — and a clock that has not moved, so the stamp the archive
  // would use is the one already on disk. The archive is an archive: it must never overwrite itself.
  quietRun(beta)
  const second = await connection.dispatch('POST', '/api/reprise/runs/delete', { id: 'beta', confirm: 'beta' })
  assert.equal(second.status, 409)
  assert.match(second.json.error.message, /the archive already holds/)
  assert.equal(existsSync(beta), true, 'the directory stayed put')
  assert.equal(existsSync(first.json.trashed_to), true, 'and the earlier archive is still there, untouched')

  dispose()
})
