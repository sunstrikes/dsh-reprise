/**
 * The plugin as the host meets it: applied at boot, ticking with no session, disposed cleanly, and
 * degrading instead of taking the host down.
 *
 * Contract guarded (spec "宿主边界", user stories 13, 39, 41): `apply(ctx, config)` runs at host
 * startup rather than at session creation, `ctx.interval` is the only thing driving the loop, the
 * package declares `inject: ['timer']` (and nothing else), and a broken workspace configuration is a
 * log line — not a boot failure. The bare cordis context here has no sessions, no storageDomain and no
 * subagents, which is exactly the point: the loop must not need any of them.
 *
 * The dashboard is a separate child plugin (`dashboard.js`, `inject: ['connection']`) and is tested in
 * `dashboard.test.js`; these tests only require that its absence cannot disturb the loop.
 *
 * cordis is imported **dynamically**. It is the plugin *host* — MIT, and shipped with the DeepSeek
 * Harness profile rather than installed by this repository — so a bare clone (or a contributor who
 * only wants the laptop path) has no copy of it. These tests then report themselves skipped instead of
 * failing to even load, which is the difference between "this checkout cannot run the host tests" and
 * "this repository is broken". Everything the plugin itself does is plain ESM and runs either way.
 */
async function host() {
  try {
    const [{ Context }, { default: TimerService }] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/cordis-plugin-timer'),
    ])
    return { Context, TimerService }
  } catch {
    return undefined
  }
}
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../lib/index.js'
import { Store } from '../lib/store.js'
import { CONFIG_ONLY_PACK_DIR } from './support/domain.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempWorkspace = () => join(mkdtempSync(join(tmpdir(), 'reprise-host-')), 'workspace')

/**
 * A host needs a domain pack: the metric contract, the five prompts and the executor entry are the
 * domain's, and there is no packaged default. The pack below is configuration only, which is also
 * the proof that a second domain needs no kernel change. The local executor needs a command; nothing
 * in these tests ever runs it.
 */
const BASE = {
  domain: CONFIG_ONLY_PACK_DIR,
  executor: { kind: 'local', command: ['node', '-e', '0'] },
}

function collector() {
  const lines = []
  const onLog = (message) => lines.push(String(message))
  return { lines, onLog, text: () => lines.join('\n') }
}

test('the entry applies before any service exists, and says which half is missing', async (t) => {
  const hostRuntime = await host()
  if (hostRuntime === undefined) return t.skip('cordis is not in this checkout (it ships with the DeepSeek Harness profile)')
  const root = new hostRuntime.Context()
  const log = collector()
  await root.plugin(plugin, { ...BASE, workspace: tempWorkspace(), onLog: log.onLog })

  assert.match(log.text(), /applied/i, 'the entry reports that the package was loaded at all')
  assert.doesNotMatch(
    log.text(),
    /tick-applied/,
    'without a timer the ticking half is deferred — "not loaded" and "dependency absent" must stay distinguishable',
  )
  await root.fiber.dispose()
})

test('with a timer it opens the workspace and ticks it with no session in existence', async (t) => {
  const hostRuntime = await host()
  if (hostRuntime === undefined) return t.skip('cordis is not in this checkout')
  const workspace = tempWorkspace()
  const root = new hostRuntime.Context()
  const log = collector()
  await root.plugin(hostRuntime.TimerService)
  await root.plugin(plugin, { ...BASE, workspace, interval_ms: 20, onLog: log.onLog })

  assert.equal(root.get('sessions'), undefined, 'the loop must not depend on a session existing')
  assert.match(log.text(), /tick-applied/, 'the ticking half applies once the timer is reachable')

  await wait(300)
  assert.ok(existsSync(join(workspace, 'workspace.db')), 'the fact plane lives in the workspace directory')

  const reader = Store.openReadOnly(workspace)
  try {
    const state = reader.getState(undefined, 'workspace')
    assert.ok(state?.started_at_ms > 0, 'a real tick ran: the workspace row is seeded on the first pass')
  } finally {
    reader.close()
  }
  assert.doesNotMatch(log.text(), /tick failed/, 'a healthy tick is silent')

  await root.fiber.dispose()
  assert.match(log.text(), /disposed/, 'disposal is reported, so the next cleanup is checkable')
})

test('a workspace that cannot be opened is a log line, never a boot failure', async (t) => {
  const hostRuntime = await host()
  if (hostRuntime === undefined) return t.skip('cordis is not in this checkout')
  const dir = mkdtempSync(join(tmpdir(), 'reprise-host-broken-'))
  const notADirectory = join(dir, 'file')
  writeFileSync(notADirectory, 'not a directory\n')

  const root = new hostRuntime.Context()
  const log = collector()
  await root.plugin(hostRuntime.TimerService)
  await root.plugin(plugin, { ...BASE, workspace: join(notADirectory, 'workspace'), interval_ms: 20, onLog: log.onLog })

  await wait(150)
  assert.match(log.text(), /workspace/i, 'the refusal says what could not be opened')
  assert.match(log.text(), new RegExp(notADirectory.split('/').pop()), 'and which path it was')
  assert.equal(root.get('timer') !== undefined, true, 'the host is still alive and its services intact')
  await root.fiber.dispose()
})

test('a configuration with no workspace is refused, and the host still boots', async (t) => {
  const hostRuntime = await host()
  if (hostRuntime === undefined) return t.skip('cordis is not in this checkout')
  const root = new hostRuntime.Context()
  const log = collector()
  await root.plugin(hostRuntime.TimerService)
  await root.plugin(plugin, { ...BASE, onLog: log.onLog })

  await wait(80)
  assert.match(log.text(), /applied/i)
  assert.match(log.text(), /workspace/i, 'the reason is on the record')
  assert.doesNotMatch(log.text(), /tick-applied/, 'nothing is scheduled against a workspace that does not exist')
  await root.fiber.dispose()
})

test('a real executor with no GPU-hours limit is announced at boot, not discovered on the bill', async (t) => {
  const hostRuntime = await host()
  if (hostRuntime === undefined) return t.skip('cordis is not in this checkout')
  const root = new hostRuntime.Context()
  const log = collector()
  await root.plugin(hostRuntime.TimerService)
  await root.plugin(plugin, {
    ...BASE,
    workspace: tempWorkspace(),
    interval_ms: 20,
    executor: { kind: 'ray', base_url: 'http://ray.invalid' },
    budget: { gpu_hours_limit: 0 },
    onLog: log.onLog,
  })
  await wait(120)
  await root.fiber.dispose()

  assert.match(log.text(), /no_gpu_hours_limit/, 'the operator hears about it before a job is submitted')
  assert.match(log.text(), /GPU-hours limit/i)
})