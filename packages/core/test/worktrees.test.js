/**
 * Where the candidate trees are — and the fact that they are kept.
 *
 * Contract guarded (issue "worktree retention"): a run that lands candidates creates
 * `<workspace>/worktrees/<candidateId>` for each of them, and **nothing in the kernel removes one**.
 * The trees are the evidence behind every landing — the diff a candidate was judged on is *the files
 * in that directory* — so a run that cleaned up after itself would be a run whose verdicts nobody can
 * re-read. Retention is therefore a declared contract (`runner.keep`, default `true`), not an accident
 * of nobody having written the removal code.
 *
 * Three claims are pinned here:
 *
 *   - **The view answers the question the run could not answer before.** `worktreeReport` gives one row
 *     per candidate — path, whether it is still on disk, the phase, how many files landed, whether it
 *     is the current code base anchor, and the commit it was sealed as — from facts plus one `stat`:
 *     no git calls, no writes, so a reader of a finished run cannot disturb it.
 *   - **A finished run leaves every tree on disk.** Proved by driving the phase machine to FINALIZE
 *     with a runner that really creates the directories, not a stub that claims it did.
 *   - **`dump --candidate` prints the path**, because that is where an operator looks first.
 *
 * Removal lives in `worktrees-cli.test.js`: `prune` is the only thing allowed to do it.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readRoundsState } from '../lib/rounds.js'
import { Store } from '../lib/store.js'
import { createWorktreeRunner } from '../lib/ports.js'
import { tick } from '../lib/loop.js'
import { renderDump } from '../lib/cli/dump.js'
import { pruneRefusal, worktreeReport } from '../lib/worktrees.js'
import { judgeFor } from './support/domain.js'
import { AT, FakeClock, openWorkspace } from './support/fake-ports.js'

const COMMIT = 'ab'.repeat(20)

/** A runner as `ports.js` builds one, recorded by the test so a call can be read as a step. */
function recordingGit(answers = () => undefined) {
  const calls = []
  const git = (args, options) => {
    calls.push({ args, cwd: options?.cwd })
    return answers(args, options) ?? { status: 0, stdout: '', stderr: '' }
  }
  return { git, calls, argv: () => calls.map((call) => call.args.join(' ')) }
}

/**
 * A workspace with three kinds of candidate in it: one that landed and whose tree is present, one
 * that landed and whose tree is gone, one that never landed.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-'))
  const store = Store.open(dir)
  const worktreesDir = join(dir, 'worktrees')

  const land = (candidateId, { round = 1, files = [], worktreeDir } = {}) =>
    store.appendEvent({
      candidate_id: candidateId,
      wall_clock_ms: AT,
      event_type: 'land_done',
      payload: { engine: 'fake', files, files_changed: files.length, round, worktree_dir: worktreeDir ?? null },
    })

  // r1-h1: landed, tree still on disk, and it is the code base the run moved to.
  mkdirSync(join(worktreesDir, 'r1-h1'), { recursive: true })
  store.setState('r1-h1', 'phase', { phase: 'DONE', round: 1 })
  land('r1-h1', { files: ['model/embedding.py', 'model/attention.py'], worktreeDir: join(worktreesDir, 'r1-h1') })

  // r1-h2: landed, and its tree was removed behind the run's back (a person, or a stray `git worktree
  // prune`). The row must say so rather than repeat the path as if the tree were there.
  store.setState('r1-h2', 'phase', { phase: 'REJECTED', round: 1 })
  land('r1-h2', { files: ['model/embedding.py'], worktreeDir: join(worktreesDir, 'r1-h2') })

  // r2-h1: landed by a harness that did not report where it worked (a real host run records null),
  // so the path has to come from the runner — the same `pathFor` the tree was created at.
  store.setState('r2-h1', 'phase', { phase: 'DONE', round: 2 })
  land('r2-h1', { round: 2, files: ['model/embedding.py'] })

  // r2-h2: still in flight. It has a row (the question "where is its tree?" applies already) and no
  // landing fact, so there is nothing to count yet.
  store.setState('r2-h2', 'phase', { phase: 'VERIFY', round: 2 })

  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', {
    ...workspace,
    code_base_anchor: { candidate_id: 'r1-h1', commit: COMMIT, source: 'automatic' },
    runner: { repo: 'model-repo', dir: 'worktrees', keep: true },
  })

  const runner = createWorktreeRunner(
    { repo: 'model-repo', dir: 'worktrees', base_ref: 'HEAD' },
    { workspaceDir: dir, git: recordingGit().git },
  )
  return { dir, store, worktreesDir, runner }
}

const rowOf = (report, candidateId) => report.rows.find((row) => row.candidate_id === candidateId)

test('one row per candidate: path, whether it is on disk, phase, files, anchor, sealed commit', () => {
  const { dir, store, worktreesDir, runner } = fixture()
  try {
    const report = worktreeReport({ store, workspaceDir: dir, runner })

    assert.equal(report.worktrees, worktreesDir, 'the answer to "where do they go" is on the report itself')
    assert.equal(report.repo, join(dir, 'model-repo'), 'and so is the repository they branch from')
    assert.equal(report.kept, true, 'with the shipped default, nothing is removed')
    assert.deepEqual(
      report.rows.map((row) => row.candidate_id),
      ['r1-h1', 'r1-h2', 'r2-h1', 'r2-h2'],
      'every candidate the run ever created gets a row, in a stable order',
    )
    assert.deepEqual(Object.keys(rowOf(report, 'r1-h1')).sort(), [
      'anchor',
      'candidate_id',
      'exists',
      'files',
      'landed',
      'path',
      'phase',
      'pruned_at_ms',
      'round',
      'sealed_commit',
      'source',
    ])

    const kept = rowOf(report, 'r1-h1')
    assert.equal(kept.path, join(worktreesDir, 'r1-h1'), 'the path the run recorded')
    assert.equal(kept.source, 'land_done', 'and the report says where it came from')
    assert.equal(kept.exists, true)
    assert.equal(kept.phase, 'DONE')
    assert.equal(kept.round, 1)
    assert.equal(kept.files, 2, 'the landing recorded two files')
    assert.equal(kept.anchor, true, 'it is the code base the run is on')
    assert.equal(kept.sealed_commit, COMMIT, 'and the commit it was sealed as')

    const gone = rowOf(report, 'r1-h2')
    assert.equal(gone.exists, false, 'a tree that is no longer on disk is reported as missing, not as present')
    assert.equal(gone.path, join(worktreesDir, 'r1-h2'), 'the path is still the one the run used')
    assert.equal(gone.phase, 'REJECTED')

    const fallback = rowOf(report, 'r2-h1')
    assert.equal(fallback.path, join(worktreesDir, 'r2-h1'), 'with no recorded tree, the runner\'s own derivation answers')
    assert.equal(fallback.source, 'runner')
    assert.equal(fallback.anchor, false)

    const inFlight = rowOf(report, 'r2-h2')
    assert.equal(inFlight.files, 0, 'nothing landed, so nothing to count')
    assert.equal(inFlight.phase, 'VERIFY')
    assert.equal(inFlight.exists, false, 'VERIFY has not created anything yet')
    assert.equal(inFlight.sealed_commit, null, 'and nothing sealed it')
  } finally {
    store.close()
  }
});

test('the report is a view: it writes no facts and asks git nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-pure-'))
  const store = Store.open(dir)
  try {
    store.setState('r1-h1', 'phase', { phase: 'DONE', round: 1 })
    const recorded = recordingGit()
    const runner = createWorktreeRunner(
      { repo: 'model-repo', dir: 'worktrees' },
      { workspaceDir: dir, git: recorded.git },
    )
    const before = store.maxSeq('r1-h1')

    worktreeReport({ store, workspaceDir: dir, runner })

    assert.equal(store.maxSeq('r1-h1'), before, 'a reader of a run cannot be the reason the run changed')
    assert.deepEqual(recorded.argv(), [], 'the report does not run git: the path is a fact, and stat is enough')
  } finally {
    store.close()
  }
})

test('dump --candidate prints the worktree path and whether it is still there', () => {
  const { dir, store } = fixture()
  try {
    const present = renderDump(store, 'r1-h1')
    assert.match(present, /worktree/, 'the section exists, so "where did its tree go" is answerable from the page')
    assert.match(present, new RegExp(join(dir, 'worktrees', 'r1-h1').replaceAll('.', '\\.')))
    assert.match(present, /present/)

    const missing = renderDump(store, 'r1-h2')
    assert.match(missing, /MISSING/, 'a tree that is gone is named as gone — that is the difference from "never created"')

    // A candidate that never landed has no tree and no path: saying so is the honest answer.
    const neverLanded = renderDump(store, 'r2-h2')
    assert.match(neverLanded, /worktree/)
    assert.match(neverLanded, /never landed/)
  } finally {
    store.close()
  }
})

test('dump can still name the path when the run recorded no tree, because the runner was recorded too', () => {
  const { dir, store } = fixture()
  try {
    const text = renderDump(store, 'r2-h1')
    assert.match(text, new RegExp(join(dir, 'worktrees', 'r2-h1').replaceAll('.', '\\.')))
  } finally {
    store.close()
  }
})

// ------------------------------------------------------------------- retention

const ROUND_CONFIG = {
  rounds: {
    metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
    baseline: { metric: 'auc', value: 0.7012 },
    max_rounds: 1,
    candidates_per_round: 2,
    retry: { base_ms: 1_000, max_ms: 8_000, max_attempts: 2 },
  },
}

const PLAN = {
  hypotheses: [
    { id: 'h1', statement: 'widen the embedding table to 2^22', expected_files: ['model/embedding.py'] },
    { id: 'h2', statement: 'share the projection across heads', expected_files: ['model/attention.py'] },
  ],
}

const REFLECT = {
  summary: 'capacity helped',
  lessons: [{ statement: 'capacity pays above a rare-feature rate', evidence: 'r1-h1' }],
  next_round_focus: ['measure the rare-feature rate first'],
}

/**
 * A runner that really creates the tree, and records what it created. Its git is a recording stub —
 * the directory is made here rather than by `git worktree add` — because this test is about what
 * survives a run, not about git's behaviour (that is `anchor-base-ref.test.js`'s subject).
 */
function treeCreatingRunner(workspaceDir) {
  const created = []
  const worktreesDir = join(workspaceDir, 'worktrees')
  return {
    worktreesDir,
    repoDir: join(workspaceDir, 'model-repo'),
    baseRef: 'HEAD',
    keep: true,
    created,
    pathFor(candidateId) {
      return join(worktreesDir, candidateId)
    },
    worktreeFor(candidateId) {
      const path = this.pathFor(candidateId)
      mkdirSync(path, { recursive: true })
      created.push({ candidateId, path })
      return path
    },
  }
}

/** Tick until the workspace finalises, finishing every running job as a platform would. */
async function driveUntilFinalized(ports, { maxTicks = 80 } = {}) {
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await tick(ports)
    if (result.paused !== null) throw new Error(`the workspace paused: ${result.paused.reason}`)
    for (const job of ports.platform.jobs.values()) {
      if (job.state === 'running') ports.platform.finish(job.job_id)
    }
    if (readRoundsState(ports.store)?.finalized_at_ms !== undefined) return { ticks: index + 1 }
    ports.clock.advance(10_000)
  }
  throw new Error(`the workspace did not finalise in ${maxTicks} ticks`)
}

test('a run driven to FINALIZE leaves every candidate worktree on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-kept-'))
  const workspace = openWorkspace({ dir, config: ROUND_CONFIG })
  const runner = treeCreatingRunner(dir)
  const answers = {
    round_plan: PLAN,
    round_reflect: REFLECT,
    verify: { verdict: 'accept', rationale: 'minimal diff, no evaluation changes' },
    cand_analyze: { root_cause: 'the wider table removed collisions on rare features' },
  }
  const model = async (request) => answers[request.call_site]
  const ports = {
    ...workspace,
    clock: new FakeClock(),
    runner,
    // The harness is the real contract: it asks the runner for the tree and works inside it.
    harness: {
      land({ candidateId }) {
        const worktreeDir = runner.worktreeFor(candidateId)
        return { engine: 'fake', parent_id: 'baseline-0', parent_commit: 'aaa1111', files: ['model/embedding.py'], files_changed: 1, worktreeDir, candidateId }
      },
    },
    judge: judgeFor({
      model,
      metric: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
      baseline: 0.7012,
    }),
  }

  try {
    await driveUntilFinalized(ports)

    assert.equal(readRoundsState(workspace.store).phase, 'FINALIZE')
    const candidateIds = workspace.store.candidateIds()
    assert.ok(candidateIds.length >= 2, 'the round really created candidates')
    assert.deepEqual(runner.created.map((entry) => entry.candidateId), candidateIds, 'every candidate was landed in its own tree')

    for (const candidateId of candidateIds) {
      const path = runner.pathFor(candidateId)
      assert.ok(existsSync(path), `${candidateId}: the run ended and left its worktree at ${path} — retention is the contract`)
    }

    // The view over the same facts agrees, and says the trees are present rather than merely recorded.
    const report = worktreeReport({ store: workspace.store, workspaceDir: dir, runner })
    assert.equal(report.kept, true)
    for (const row of report.rows) assert.equal(row.exists, true, `${row.candidate_id} is present on disk`)
  } finally {
    workspace.store.close()
  }
})

// ------------------------------------------------- removal, and its two refusals

test('the runner will not remove a tree while the run keeps its worktrees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-keep-'))
  const recorded = recordingGit()
  const runner = createWorktreeRunner({ repo: 'model-repo', dir: 'worktrees' }, { workspaceDir: dir, git: recorded.git })
  mkdirSync(runner.pathFor('r1-h1'), { recursive: true })

  assert.equal(runner.keep, true, 'the default is retention')
  assert.throws(() => runner.remove('r1-h1'), /runner\.keep/, 'nothing in the kernel may remove what the run declared it keeps')
  assert.deepEqual(recorded.argv(), [], 'and it does not even ask git')
  assert.ok(existsSync(runner.pathFor('r1-h1')), 'the tree is still there')
})

test('with keep: false the runner removes the tree with git, and prunes the registration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-prune-'))
  const recorded = recordingGit()
  const runner = createWorktreeRunner(
    { repo: 'model-repo', dir: 'worktrees', keep: false },
    { workspaceDir: dir, git: recorded.git },
  )
  const path = runner.pathFor('r1-h1')
  mkdirSync(path, { recursive: true })

  const removal = runner.remove('r1-h1')

  assert.equal(removal.path, path)
  assert.equal(removal.removed, true)
  assert.deepEqual(recorded.argv(), [`worktree remove --force ${path}`, 'worktree prune'], 'removal is git\'s, in the repository the tree was added to')
  assert.ok(recorded.calls.every((call) => call.cwd === join(dir, 'model-repo')), 'and it runs where `worktree add` ran')
})

test('a tree that is already gone is a no-op removal, not a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-gone-'))
  const recorded = recordingGit()
  const runner = createWorktreeRunner(
    { repo: 'model-repo', dir: 'worktrees', keep: false },
    { workspaceDir: dir, git: recorded.git },
  )

  const removal = runner.remove('r1-h1')

  assert.equal(removal.removed, false)
  assert.deepEqual(recorded.argv(), ['worktree prune'], 'the registration is still reconciled, because a crash can leave one behind')
})

test('a real git worktree is really removed, and the repository is left with none', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-worktrees-real-'))
  const repo = join(dir, 'model-repo')
  const run = (args, cwd = dir) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    return result
  }
  const made = run(['init', '-q', repo])
  if (made.status !== 0) return t.skip(`git is not usable here: ${made.stderr ?? made.error}`)
  run(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '--allow-empty', '-qm', 'base'], repo)

  const runner = createWorktreeRunner({ repo: 'model-repo', dir: 'worktrees', keep: false }, { workspaceDir: dir })
  const path = runner.worktreeFor('r1-h1')
  assert.ok(existsSync(path), 'the worktree the runner created is on disk')

  runner.remove('r1-h1')

  assert.equal(existsSync(path), false, 'and after an allowed prune it is not')
  const list = run(['worktree', 'list', '--porcelain'], repo)
  assert.equal(String(list.stdout).includes(path), false, 'git no longer believes it owns that tree')
})