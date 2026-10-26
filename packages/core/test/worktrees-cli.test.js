/**
 * `worktrees list` and `worktrees prune`: the inventory, and the only action that may remove a tree.
 *
 * Contract guarded (issue "worktree retention"): cleanup is an explicit act, the same rule the cluster
 * job reaper follows — a loop that decides a tree is finished deletes the evidence behind a verdict the
 * first time its idea of "finished" is wrong. So there are exactly three refusals and one action:
 *
 *   - a candidate that has not finished (its job may still be reading that directory);
 *   - an id this workspace never recorded (a typo must not be a silent no-op);
 *   - every candidate of a run whose `runner.keep` is `true`, which is the default;
 *   - and, when none of those apply, `git worktree remove` plus a `worktree_pruned` fact — so the
 *     workspace still explains the tree it used to hold, and `dump` can say when it went.
 *
 * `--config` is read as a **run configuration file**, which means the file-relative rule from
 * `run-config.js` applies: one JSON file per run, next to the workspace it describes, is the thing an
 * operator actually passes to every command about that run.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorktreeRunner } from '../lib/ports.js'
import { Store } from '../lib/store.js'
import { runWorktrees, worktreesCommand } from '../lib/cli/worktrees.js'
import { CONFIG_ONLY_PACK_DIR } from './support/domain.js'

const AT = 1_761_091_200_000
const NOW = AT + 60_000

/** A git that records what it was asked and really deletes the directory on `worktree remove`. */
function recordingGit() {
  const calls = []
  const git = (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'worktree' && args[1] === 'remove') rmSync(args[3], { recursive: true, force: true })
    return { status: 0, stdout: '', stderr: '' }
  }
  return { git, calls }
}

function fixture({ keep = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-cli-'))
  const store = Store.open(dir)
  const worktreesDir = join(dir, 'worktrees')

  // r1-h1 finished and its tree is on disk; r2-h1 is still running in its own tree.
  for (const [candidateId, phase] of [
    ['r1-h1', 'DONE'],
    ['r2-h1', 'VERIFY'],
  ]) {
    store.setState(candidateId, 'phase', { phase, round: 1 })
    store.appendEvent({
      candidate_id: candidateId,
      wall_clock_ms: AT,
      event_type: 'land_done',
      payload: { engine: 'fake', files: ['model/a.py'], files_changed: 1, round: 1, worktree_dir: join(worktreesDir, candidateId) },
    })
    mkdirSync(join(worktreesDir, candidateId), { recursive: true })
  }
  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', { ...workspace, runner: { repo: 'model-repo', dir: 'worktrees', keep } })

  const recorded = recordingGit()
  const runner = createWorktreeRunner({ repo: 'model-repo', dir: 'worktrees', keep }, { workspaceDir: dir, git: recorded.git })
  return {
    dir,
    store,
    worktreesDir,
    runner,
    recorded,
    config: { workspaceDir: dir, runner: { repo: 'model-repo', dir: 'worktrees', keep }, executor: { kind: 'local' } },
  }
}

/** Run one command, collecting the lines it printed. */
function run(argv, options) {
  const lines = []
  const result = worktreesCommand(argv, { out: (line) => lines.push(String(line)), now: () => NOW, ...options })
  return { ...result, text: lines.join('\n'), lines }
}

test('list prints where the trees are, which repository they branch from, and whether each is present', () => {
  const { store, runner, config, worktreesDir, dir } = fixture()
  try {
    const result = run(['list'], { config, runner })

    assert.equal(result.code, 0)
    assert.match(result.text, new RegExp(dir.replaceAll('.', '\\.')), 'the workspace it speaks about')
    assert.match(result.text, /model-repo/, 'the repository the trees branch from')
    assert.match(result.text, new RegExp(worktreesDir.replaceAll('.', '\\.')), 'where the trees go')
    assert.match(result.text, /kept/, 'and whether the run keeps them')
    assert.match(result.text, /r1-h1/)
    assert.match(result.text, /present/)
    assert.match(result.text, /r2-h1/)
    assert.ok(result.lines.some((line) => line.includes(join(worktreesDir, 'r1-h1'))), 'the path itself, not a summary of it')
  } finally {
    store.close()
  }
})

test('list --json answers the same question in a shape a script can read', () => {
  const { store, runner, config } = fixture()
  try {
    const result = run(['list', '--json'], { config, runner })
    const report = JSON.parse(result.text)

    assert.equal(result.code, 0)
    assert.equal(report.kept, true)
    assert.equal(report.rows.length, 2)
    assert.equal(report.rows.find((row) => row.candidate_id === 'r1-h1').exists, true)
  } finally {
    store.close()
  }
})

test('prune refuses a candidate that is still running, and says which phase it is in', () => {
  const { store, runner, config, worktreesDir } = fixture({ keep: false })
  try {
    const result = run(['prune', '--candidate', 'r2-h1'], { config, runner })

    assert.equal(result.code, 1, 'a refusal is not a success')
    assert.match(result.text, /refused/)
    assert.match(result.text, /VERIFY/, 'the reason names the phase, so the operator knows what to wait for')
    assert.ok(existsSync(join(worktreesDir, 'r2-h1')), 'the tree of a running candidate is untouched')
  } finally {
    store.close()
  }
})

test('prune refuses every candidate of a run that keeps its worktrees', () => {
  const { store, runner, config, worktreesDir, recorded } = fixture({ keep: true })
  try {
    const result = run(['prune', '--candidate', 'r1-h1'], { config, runner })

    assert.equal(result.code, 1)
    assert.match(result.text, /runner\.keep/, 'the refusal names the setting that would allow it')
    assert.deepEqual(recorded.calls, [], 'nothing reached git')
    assert.ok(existsSync(join(worktreesDir, 'r1-h1')))
  } finally {
    store.close()
  }
})

test('prune refuses an id this workspace never recorded', () => {
  const { store, runner, config } = fixture({ keep: false })
  try {
    const result = run(['prune', '--candidate', 'r9-h9'], { config, runner })

    assert.equal(result.code, 1)
    assert.match(result.text, /refused/)
    assert.match(result.text, /no candidate with that id/)
  } finally {
    store.close()
  }
})

test('prune removes a finished candidate\'s tree when the run allows it, and records the fact', () => {
  const { store, runner, config, worktreesDir, recorded, dir } = fixture({ keep: false })
  try {
    const result = run(['prune', '--candidate', 'r1-h1'], { config, runner })

    assert.equal(result.code, 0, result.text)
    assert.match(result.text, /pruned/)
    assert.equal(existsSync(join(worktreesDir, 'r1-h1')), false, 'the tree is gone from disk')
    assert.deepEqual(recorded.calls, [`worktree remove --force ${join(worktreesDir, 'r1-h1')}`, 'worktree prune'], 'removed by git, from the repository it was added to')

    const pruned = store.eventsFor('r1-h1').filter((event) => event.event_type === 'worktree_pruned')
    assert.equal(pruned.length, 1, 'the workspace still explains the tree it used to hold')
    assert.equal(pruned[0].payload.path, join(worktreesDir, 'r1-h1'))
    assert.equal(pruned[0].payload.existed, true)
    assert.equal(pruned[0].wall_clock_ms, NOW, 'and when it went, from the clock the command was given')

    // The other candidate's tree is not collateral: prune acts only on the ids it was named.
    assert.ok(existsSync(join(worktreesDir, 'r2-h1')))
    assert.equal(store.eventsFor('r2-h1').filter((event) => event.event_type === 'worktree_pruned').length, 0)
    assert.ok(dir.length > 0)
  } finally {
    store.close()
  }
})

test('prune with no --candidate is a usage error: it never removes what it was not named', () => {
  const { store, runner, config, worktreesDir } = fixture({ keep: false })
  try {
    const result = run(['prune'], { config, runner })

    assert.equal(result.code, 2)
    assert.match(result.text, /--candidate/)
    assert.ok(existsSync(join(worktreesDir, 'r1-h1')))
  } finally {
    store.close()
  }
})

test('the command reads a run configuration file, and the file\'s own directory decides the workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-config-'))
  const file = join(dir, 'run.json')
  writeFileSync(
    file,
    JSON.stringify({
      workspace: 'ws',
      domain: CONFIG_ONLY_PACK_DIR,
      executor: { kind: 'local', command: ['node', '-e', '0'] },
      runner: { repo: 'model-repo', dir: 'worktrees', keep: true },
    }),
  )

  const lines = []
  // The cwd is deliberately somewhere else: a file that names its workspace relative to itself must
  // not depend on where the command was typed.
  const result = runWorktrees(['list', '--config', file], { cwd: tmpdir(), out: (line) => lines.push(String(line)) })

  assert.equal(result.code, 0, lines.join('\n'))
  assert.ok(lines.join('\n').includes(join(dir, 'ws')), `the workspace the file names, resolved against the file: ${lines.join('\n')}`)
  assert.ok(lines.join('\n').includes(join(dir, 'ws', 'worktrees')), 'and the trees inside it')
})