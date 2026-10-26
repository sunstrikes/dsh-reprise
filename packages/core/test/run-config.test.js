/**
 * Where a host run's configuration comes from: one plugin config, one JSON file, one environment,
 * and the order in which they win.
 *
 * Contract guarded (issue "host configuration", spec "宿主边界"): an operator must be able to point a
 * real run at a workspace, a repository and a model **without hand-editing the profile's
 * `cordis.patch.yml`** — one file or one environment variable per run — and must get a *named* refusal
 * when the file they named is missing, unreadable or not JSON. A silent fallback to defaults is a run
 * against somebody else's directory, which is worse than not starting.
 *
 * Four rules are pinned here:
 *
 *   - `workspace` comes from the plugin configuration, then from `DSH_REPRISE_WORKSPACE`. With
 *     neither, the refusal names both ways of supplying one.
 *   - `config_file` (or `DSH_REPRISE_CONFIG` when the key is absent) is the **base**, and the inline
 *     keys win **key by key** — a shallow merge, so a nested object in the inline config replaces the
 *     file's object wholesale rather than merging into it.
 *   - `workspace` inside that file resolves against **the file's own directory**: the one path rule
 *     that differs from inline config, because a file on disk must not depend on where the host was
 *     started. Every other path keeps the host-cwd rule.
 *   - `runner.keep` defaults to `true`: the default run removes nothing, so a finished run's trees are
 *     still on disk when someone asks where they went.
 *
 * The workspace precedence is pinned twice on purpose: through `resolveConfig` (the run) and directly
 * on `declaredWorkspace` (the same question asked by the read-only page about a run that was refused).
 * They are one function, and the last test here would go red if they ever became two.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { declaredWorkspace, resolveConfig } from '../lib/config.js'

const LOCAL = { kind: 'local', command: ['node', 'metric.mjs'] }

/** The same stand-in pack `config.test.js` uses: these tests are about paths and precedence. */
const PACK = Object.freeze({
  dir: '/packs/config-only-domain',
  name: 'config-only-domain',
  metricContract: { name: 'config-only-score', primary: 'score', direction: 'higher', objectives: { score: 'up' } },
  priors: { search_space: {}, priors: [], hypothesis_classes: [] },
  surface: { files: ['src/thing.json'], keys: ['width'], symbols: [] },
  promptsDir: '/packs/config-only-domain/prompts',
  prompts: new Map(),
  executor: { kind: 'local', command: ['node', 'score.mjs'] },
})

const resolve = (raw, options = {}) =>
  resolveConfig({ domain: 'a-domain-pack', ...raw }, { loadDomain: () => PACK, env: {}, ...options })

const tempDir = () => mkdtempSync(join(tmpdir(), 'reprise-run-config-'))

/** Write one run configuration file and answer its absolute path. */
function configFile(dir, document, name = 'run.json') {
  const path = join(dir, name)
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document, null, 2))
  return path
}

// --------------------------------------------------------------- the workspace

test('a workspace may come from the environment when the configuration names none', () => {
  const resolved = resolve({ executor: LOCAL }, { cwd: '/tmp/elsewhere', env: { DSH_REPRISE_WORKSPACE: '.reprise/run-7' } })

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.workspaceDir, join('/tmp/elsewhere', '.reprise/run-7'), 'a relative one still resolves against the host cwd')
  assert.equal(resolved.config.workspaceSource, 'env', 'the resolved config says which of the two it used')
})

test('an absolute workspace in the environment is used as is, not joined onto the host cwd', () => {
  const resolved = resolve({ executor: LOCAL }, { cwd: '/tmp/elsewhere', env: { DSH_REPRISE_WORKSPACE: '/srv/runs/task-3' } })

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.workspaceDir, '/srv/runs/task-3')
})

test('the plugin configuration outranks the environment', () => {
  const resolved = resolve(
    { executor: LOCAL, workspace: 'from-config' },
    { cwd: '/tmp/elsewhere', env: { DSH_REPRISE_WORKSPACE: '/srv/runs/from-env' } },
  )

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.workspaceDir, join('/tmp/elsewhere', 'from-config'))
  assert.equal(resolved.config.workspaceSource, 'config')
})

test('with neither a workspace nor DSH_REPRISE_WORKSPACE the refusal names both ways out', () => {
  const resolved = resolve({ executor: LOCAL })

  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /workspace/, 'the key is named')
  assert.match(resolved.problem, /DSH_REPRISE_WORKSPACE/, 'and so is the environment variable, not just the YAML key')
})

// ------------------------------------------- the workspace, asked of the one owner of the order

test('declaredWorkspace picks the same directory resolveConfig would, and says which source won', () => {
  const dir = tempDir()
  const file = configFile(dir, { workspace: 'from-file', executor: LOCAL })
  const cases = [
    {
      name: 'an inline workspace beats both the file and the environment',
      raw: { workspace: './from-inline', config_file: file },
      env: { DSH_REPRISE_WORKSPACE: '/srv/from-env' },
      expected: { dir: join('/tmp/elsewhere', 'from-inline'), source: 'config' },
    },
    {
      name: "the file's workspace beats the environment, resolved against the file's own directory",
      raw: { config_file: file },
      env: { DSH_REPRISE_WORKSPACE: '/srv/from-env' },
      expected: { dir: join(dir, 'from-file'), source: 'config_file' },
    },
    {
      name: 'the environment is last, and a relative value there resolves against the host cwd',
      raw: {},
      env: { DSH_REPRISE_WORKSPACE: 'from-env' },
      expected: { dir: join('/tmp/elsewhere', 'from-env'), source: 'env' },
    },
  ]

  for (const { name, raw, env, expected } of cases) {
    assert.deepEqual(declaredWorkspace(raw, { cwd: '/tmp/elsewhere', env }), expected, name)
    const resolved = resolveConfig(
      { domain: 'a-domain-pack', executor: LOCAL, ...raw },
      { cwd: '/tmp/elsewhere', env, loadDomain: () => PACK },
    )
    assert.equal(resolved.ok, true, `${name}: ${resolved.problems?.join('; ')}`)
    assert.equal(resolved.config.workspaceDir, expected.dir, `${name}: one answer, two readers`)
    assert.equal(resolved.config.workspaceSource, expected.source, `${name}: and the config records it`)
  }
})

test('declaredWorkspace names both ways to supply a workspace when there is none anywhere', () => {
  const declared = declaredWorkspace({}, { cwd: '/tmp/elsewhere', env: {} })

  assert.equal(declared.dir, undefined)
  assert.match(declared.problem, /workspace/, 'the key is named')
  assert.match(declared.problem, /DSH_REPRISE_WORKSPACE/, 'and the environment variable, not just the YAML key')
})

test('declaredWorkspace answers the config_file refusal when the file cannot be read', () => {
  const missing = join(tempDir(), 'nowhere.json')
  const declared = declaredWorkspace({ config_file: missing }, { cwd: '/tmp/elsewhere', env: {} })

  assert.equal(declared.dir, undefined, 'no directory can be named from a file nobody could read')
  assert.match(declared.problem, /nowhere\.json/, 'and the refusal quotes the path, exactly as the run does')
})

// ----------------------------------------------------------- the configuration file

test('a configuration file is the base and inline keys override it key by key', () => {
  const dir = tempDir()
  const file = configFile(dir, {
    workspace: 'ws',
    executor: LOCAL,
    interval_ms: 250,
    stop: { max_rounds: 2, max_wall_hours: 4 },
  })

  const resolved = resolveConfig(
    { config_file: file, domain: 'a-domain-pack', interval_ms: 1_000, stop: { max_rounds: 5 } },
    { cwd: '/tmp/elsewhere', env: {}, loadDomain: () => PACK },
  )

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.interval_ms, 1_000, 'the inline key wins')
  assert.equal(resolved.config.stop.max_rounds, 5)
  assert.equal(
    resolved.config.stop.max_wall_hours,
    undefined,
    'the merge is shallow: an inline object replaces the file\'s object, it does not merge into it',
  )
  assert.equal(resolved.config.config_file, file, 'the resolved configuration says which file it came from')
  assert.equal(resolved.config.workspaceSource, 'config_file')
})

test('a workspace inside the file resolves against the file\'s own directory, not the host\'s cwd', () => {
  const dir = tempDir()
  const file = configFile(dir, { workspace: 'my-run', executor: LOCAL })

  const resolved = resolveConfig(
    { config_file: file, domain: 'a-domain-pack' },
    { cwd: '/tmp/elsewhere', env: {}, loadDomain: () => PACK },
  )

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(
    resolved.config.workspaceDir,
    join(dir, 'my-run'),
    'an operator file describes a run on the machine that owns it; it must not depend on where the host was started',
  )
})

test('an inline workspace still resolves against the host cwd, even when the file also names one', () => {
  const dir = tempDir()
  const file = configFile(dir, { workspace: 'from-file', executor: LOCAL })

  const resolved = resolveConfig(
    { config_file: file, domain: 'a-domain-pack', workspace: './from-inline' },
    { cwd: '/tmp/elsewhere', env: {}, loadDomain: () => PACK },
  )

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.workspaceDir, join('/tmp/elsewhere', 'from-inline'))
  assert.equal(resolved.config.workspaceSource, 'config')
})

test('a config_file that does not exist is a named boot failure, never a fallback to defaults', () => {
  const missing = join(tempDir(), 'nowhere.json')
  const resolved = resolveConfig({ config_file: missing }, { cwd: '/tmp/elsewhere', env: {}, loadDomain: () => PACK })

  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /nowhere\.json/, 'the path is quoted, so the reader can fix the one thing that is wrong')
  assert.match(resolved.problem, /could not be read/, 'and the reason is named')
  assert.match(resolved.problem, /ENOENT/, 'with the operating system\'s own words, not a paraphrase of them')
})

test('a config_file that is not JSON is a named boot failure quoting the parse error', () => {
  const dir = tempDir()
  const file = configFile(dir, '{ "workspace": "ws", }', 'broken.json')
  const resolved = resolveConfig({ config_file: file }, { cwd: dir, env: {}, loadDomain: () => PACK })

  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /broken\.json/)
  assert.match(resolved.problem, /not valid JSON/)
})

test('a config_file that holds something other than an object is refused by name', () => {
  const dir = tempDir()
  const file = configFile(dir, '["workspace"]', 'array.json')
  const resolved = resolveConfig({ config_file: file }, { cwd: dir, env: {}, loadDomain: () => PACK })

  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /array\.json/)
  assert.match(resolved.problem, /JSON object/)
})

test('a relative config_file resolves against the host cwd, like every other inline path', () => {
  const dir = tempDir()
  configFile(dir, { workspace: 'ws', executor: LOCAL }, 'run.json')

  const resolved = resolveConfig({ config_file: 'run.json', domain: 'a-domain-pack' }, { cwd: dir, env: {}, loadDomain: () => PACK })

  assert.equal(resolved.ok, true, resolved.problems?.join('; '))
  assert.equal(resolved.config.config_file, join(dir, 'run.json'))
})

test('DSH_REPRISE_CONFIG names the file when the key is absent, and an explicit key wins over it', () => {
  const dir = tempDir()
  const fromEnv = configFile(dir, { workspace: 'env-ws', executor: LOCAL, interval_ms: 111 }, 'env.json')
  const fromKey = configFile(dir, { workspace: 'key-ws', executor: LOCAL, interval_ms: 222 }, 'key.json')

  const viaEnv = resolveConfig({ domain: 'a-domain-pack' }, { cwd: dir, env: { DSH_REPRISE_CONFIG: fromEnv }, loadDomain: () => PACK })
  assert.equal(viaEnv.ok, true, viaEnv.problems?.join('; '))
  assert.equal(viaEnv.config.interval_ms, 111, 'the file the environment named was read')
  assert.equal(viaEnv.config.workspaceDir, join(dir, 'env-ws'))

  const bothNamed = resolveConfig(
    { config_file: fromKey, domain: 'a-domain-pack' },
    { cwd: dir, env: { DSH_REPRISE_CONFIG: fromEnv }, loadDomain: () => PACK },
  )
  assert.equal(bothNamed.ok, true, bothNamed.problems?.join('; '))
  assert.equal(bothNamed.config.interval_ms, 222, 'the plugin configuration wins, exactly as workspace precedence does')
})

test('a config_file key that is not a path is refused rather than ignored', () => {
  const resolved = resolve({ config_file: { path: 'run.json' } })

  assert.equal(resolved.ok, false)
  assert.match(resolved.problem, /config_file/)
})

// ------------------------------------------------------------------ retention

test('runner.keep defaults to true, is kept when declared false, and anything else is refused', () => {
  const kept = resolve({ workspace: 'w', executor: LOCAL, candidate: { kind: 'command', command: ['node', 'x.mjs'] }, runner: { repo: 'repo', dir: 'worktrees' } })
  assert.equal(kept.ok, true, kept.problems?.join('; '))
  assert.equal(kept.config.runner.keep, true, 'the default run removes nothing, so nothing has to be re-created')

  const prunable = resolve({
    workspace: 'w',
    executor: LOCAL,
    candidate: { kind: 'command', command: ['node', 'x.mjs'] },
    runner: { repo: 'repo', dir: 'worktrees', keep: false },
  })
  assert.equal(prunable.ok, true, prunable.problems?.join('; '))
  assert.equal(prunable.config.runner.keep, false)

  const nonsense = resolve({
    workspace: 'w',
    executor: LOCAL,
    candidate: { kind: 'command', command: ['node', 'x.mjs'] },
    runner: { repo: 'repo', dir: 'worktrees', keep: 'sometimes' },
  })
  assert.equal(nonsense.ok, false)
  assert.match(nonsense.problem, /runner\.keep/)
})