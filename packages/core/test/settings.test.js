/**
 * The two settings an operator may change from the page (`runs_root`, `max_active_runs`).
 *
 * The contract guarded here is **precedence, and the honesty about it**: what the page wrote wins over
 * the plugin configuration (otherwise the form would be decoration), every reader reports which of the
 * two answered, and clearing a key hands the question back to the configuration. The other half is the
 * refusal shape — a corrupt file or a key this file does not own is reported by name, never defaulted,
 * because a settings file read as "nothing set" silently moves where new runs land.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SETTINGS_FILENAME,
  effectiveSettings,
  readSettings,
  settingsPath,
  writeSettings,
} from '../lib/settings.js'

const home = () => mkdtempSync(join(tmpdir(), 'reprise-home-'))
const env = (dir) => ({ DSH_HOME: dir })
const fileIn = (dir) => join(dir, 'reprise', SETTINGS_FILENAME)

test('the settings live under the Harness home, and a host without one has nowhere to write', () => {
  const dir = home()
  assert.equal(settingsPath({ env: env(dir) }), fileIn(dir))
  assert.equal(settingsPath({ env: {} }), undefined)

  assert.throws(() => writeSettings({ runs_root: '/abs/runs' }, { env: {} }), /DSH_HOME is not set/)
})

test('an absent file is "nothing has been set", not an error', () => {
  const dir = home()
  const read = readSettings({ env: env(dir) })
  assert.equal(read.status, 'absent')
  assert.deepEqual(read.value, {})
})

test('writing creates the directory, replaces the whole document, and says whether it changed', () => {
  const dir = home()
  const first = writeSettings({ runs_root: '/abs/runs' }, { env: env(dir) })
  assert.equal(first.changed, true)
  assert.deepEqual(JSON.parse(readFileSync(fileIn(dir), 'utf8')), { v: 1, runs_root: '/abs/runs' })

  // Same value again is not a write: a form resubmitted unchanged must not churn the file.
  assert.equal(writeSettings({ runs_root: '/abs/runs' }, { env: env(dir) }).changed, false)

  // `undefined` leaves a key alone; `null` removes it (back to the configuration's value).
  const second = writeSettings({ max_active_runs: 3 }, { env: env(dir) })
  assert.deepEqual(second.value, { runs_root: '/abs/runs', max_active_runs: 3 })
  const cleared = writeSettings({ runs_root: null }, { env: env(dir) })
  assert.deepEqual(cleared.value, { max_active_runs: 3 })
  assert.deepEqual(readSettings({ env: env(dir) }).value, { max_active_runs: 3 })
})

test('a corrupt file, an unknown key and a bad value are refused by name', () => {
  const dir = home()
  writeSettings({ max_active_runs: 1 }, { env: env(dir) })
  writeFileSync(fileIn(dir), '{ not json')
  assert.equal(readSettings({ env: env(dir) }).status, 'invalid')
  assert.throws(() => writeSettings({ runs_root: '/abs/runs' }, { env: env(dir) }), /not valid JSON/)
  assert.equal(readFileSync(fileIn(dir), 'utf8'), '{ not json', 'the record of what somebody chose survives a refusal')

  const fresh = home()
  assert.throws(() => writeSettings({ domain: '/abs/pack' }, { env: env(fresh) }), /is not a setting this page owns/)
  assert.throws(
    () => writeSettings({ runs_root: 'relative/runs' }, { env: env(fresh) }),
    /runs_root must be an absolute directory/,
  )
  assert.throws(() => writeSettings({ max_active_runs: 0 }, { env: env(fresh) }), /max_active_runs must be a positive whole number/)

  // A file written by hand is read with the same rules: nothing here is trusted because it is on disk.
  mkdirSync(join(fresh, 'reprise'), { recursive: true })
  writeFileSync(fileIn(fresh), JSON.stringify({ v: 1, runs_root: 'relative', extra: 1 }))
  const invalid = readSettings({ env: env(fresh) })
  assert.equal(invalid.status, 'invalid')
  assert.equal(invalid.problems.length, 2, 'both the relative path and the foreign key are named')
})

test('the page wins over the configuration, and every answer says which one spoke', () => {
  const dir = home()
  const config = { runs_root: '/abs/from-config', max_active_runs: 2 }

  const untouched = effectiveSettings({ config, env: env(dir) })
  assert.equal(untouched.runsRoot, '/abs/from-config')
  assert.equal(untouched.runsRootFrom, 'config')
  assert.equal(untouched.maxActiveRuns, 2)
  assert.equal(untouched.maxActiveRunsFrom, 'config')

  writeSettings({ runs_root: '/abs/from-page', max_active_runs: 5 }, { env: env(dir) })
  const overridden = effectiveSettings({ config, env: env(dir) })
  assert.equal(overridden.runsRoot, '/abs/from-page')
  assert.equal(overridden.runsRootFrom, 'settings')
  assert.equal(overridden.maxActiveRuns, 5)
  assert.equal(overridden.maxActiveRunsFrom, 'settings')

  // Clearing hands the question back without the caller having to know the configured value.
  writeSettings({ runs_root: null, max_active_runs: null }, { env: env(dir) })
  const back = effectiveSettings({ config, env: env(dir) })
  assert.equal(back.runsRoot, '/abs/from-config')
  assert.equal(back.runsRootFrom, 'config')
  assert.equal(back.maxActiveRunsFrom, 'config')
})

test('a configuration with no runs_root and no settings answers none, and says so', () => {
  const dir = home()
  const none = effectiveSettings({ config: { max_active_runs: 2 }, env: env(dir) })
  assert.equal(none.runsRoot, undefined)
  assert.equal(none.runsRootFrom, null)
  assert.equal(none.status, 'absent')
})

test('a corrupt settings file falls back to the configuration, with its problems reported', () => {
  const dir = home()
  mkdirSync(join(dir, 'reprise'), { recursive: true })
  writeFileSync(join(dir, 'reprise', SETTINGS_FILENAME), 'nope')
  assert.equal(readSettings({ env: env(dir) }).status, 'invalid')

  const effective = effectiveSettings({ config: { runs_root: '/abs/config', max_active_runs: 4 }, env: env(dir) })
  assert.equal(effective.runsRoot, '/abs/config', 'the loop keeps the value it was configured with')
  assert.equal(effective.maxActiveRuns, 4)
  assert.equal(effective.status, 'invalid')
  assert.ok(effective.problems.length > 0)
})