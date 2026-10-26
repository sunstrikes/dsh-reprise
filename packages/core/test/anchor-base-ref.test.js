/**
 * Guards the wiring "the code base anchor is read, and the base ref is where it arrives" (issue 23).
 *
 * The `anchor` intent has written `workspace.code_base_anchor` since ticket 12 and nothing read it.
 * What "read" has to mean is precise: `runner.baseRef` is the single source of
 * `git worktree add --detach <path> <base_ref>` (`ports.js`), and the same string is handed to a
 * cluster job as the tree to ship and to LAND as the commit the harness diffs against. Threading the
 * anchor through that one property is what makes *the tree a candidate edits* and *the diff it is
 * judged on* the same tree — two readers with two answers would let a candidate be judged against a
 * base it never branched from.
 *
 * The negative case is here too: with no anchor, nothing changes, because a run that never rolled
 * must branch from exactly the ref its configuration named.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readAnchor } from '../lib/anchor.js'
import { createCandidate, tick } from '../lib/loop.js'
import { consumePending, placeIntent } from '../lib/intents.js'
import { createWorktreeRunner, planForConfig, portsFromConfig } from '../lib/ports.js'
import { Store } from '../lib/store.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

const COMMIT = 'cd'.repeat(20)
const CONFIGURED = 'HEAD'

/** A git that records argv and answers from a table, so the test reads the command and not git. */
function recordingGit(answers = () => undefined) {
  const calls = []
  const git = (args, options) => {
    calls.push({ args, cwd: options?.cwd })
    return answers(args, options) ?? { status: 0, stdout: '', stderr: '' }
  }
  return {
    git,
    calls,
    argv: () => calls.map((call) => call.args.join(' ')),
  }
}

function runnerIn(tmp, { anchor, git = recordingGit().git } = {}) {
  return createWorktreeRunner(
    { repo: 'repo', dir: 'worktrees', base_ref: CONFIGURED },
    { workspaceDir: tmp, git, anchor },
  )
}

test('a new candidate worktree branches from the anchor commit, not the configured ref', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'reprise-anchor-ref-'))
  const recorded = recordingGit()
  const runner = runnerIn(tmp, { anchor: () => ({ candidate_id: 'r1-h3', commit: COMMIT }), git: recorded.git })

  const path = runner.worktreeFor('r2-h1')

  assert.equal(runner.baseRef, COMMIT, 'the one property every reader shares')
  assert.deepEqual(recorded.calls[0].args, ['worktree', 'add', '--detach', path, COMMIT])
  assert.equal(recorded.calls[0].args.includes(CONFIGURED), false, 'the configured ref is not what the tree came from')
})

test('with no anchor the tree comes from the configured base ref: a run that never rolled is unchanged', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'reprise-anchor-ref-'))
  const recorded = recordingGit()
  const runner = runnerIn(tmp, { anchor: () => undefined, git: recorded.git })

  const path = runner.worktreeFor('r1-h1')

  assert.equal(runner.baseRef, CONFIGURED)
  assert.deepEqual(recorded.calls[0].args, ['worktree', 'add', '--detach', path, CONFIGURED])
})

test('the plan a cluster job ships carries the same base ref the worktree was created from', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'reprise-anchor-ref-'))
  const runner = runnerIn(tmp, { anchor: () => ({ candidate_id: 'r1-h3', commit: COMMIT }) })
  const plan = planForConfig(
    { executor: { kind: 'ray', command: 'python train.py', base_url: 'http://dashboard.invalid' } },
    { workspaceDir: tmp, runner },
  )

  const planned = plan({ candidateId: 'r2-h1', round: 2 })

  assert.equal(planned.baseRef, COMMIT, 'the shipped package is the tree the worktree is on')
})

test('LAND hands the harness the anchor commit: the diff is taken against the tree it edited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-anchor-land-'))
  const ports = openWorkspace({ dir })
  const requests = []
  ports.harness = {
    land(request) {
      requests.push(request)
      return { engine: 'fake', parent_id: request.parentId ?? null, parent_commit: COMMIT, files_changed: 1 }
    },
  }

  // A finished candidate, then the human's `anchor` intent naming its commit: the reader under test
  // is the one the intent feeds, not a state field a test wrote directly.
  await runCandidate(ports, { candidateId: 'r1-h1' })
  placeIntent(
    dir,
    { kind: 'anchor', intent_id: 'anchor-r1', candidate_id: 'r1-h1', commit: COMMIT },
    { now: ports.clock.now() },
  )
  consumePending({ store: ports.store, clock: ports.clock, now: ports.clock.now() })
  assert.equal(readAnchor(ports.store).commit, COMMIT)

  createCandidate(ports, { candidateId: 'r2-h1', round: 2, hypothesis: 'widen the table' })
  await tick(ports)

  const landed = requests.filter((request) => request.candidateId === 'r2-h1')
  assert.equal(landed.length, 1, 'the candidate reached LAND and was landed once')
  assert.equal(landed[0].baseRef, COMMIT, 'the harness diffs against the code base the run is on')
  assert.equal(
    requests.find((request) => request.candidateId === 'r1-h1').baseRef,
    undefined,
    'the candidate that became the anchor landed before there was one: no anchor, no base ref of ours',
  )
  ports.store.close()
})

test('the runner can name a candidate tree as a commit, once — that is what an anchor commit is', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'reprise-anchor-seal-'))
  const SEALED = 'ab'.repeat(20)
  let sealed = false
  const recorded = recordingGit((args) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (args[2] === 'HEAD^{commit}') return { status: 0, stdout: `${SEALED}\n`, stderr: '' }
      return sealed
        ? { status: 0, stdout: `${SEALED}\n`, stderr: '' }
        : { status: 128, stdout: '', stderr: 'fatal: not a valid ref' }
    }
    if (args.includes('update-ref')) sealed = true
    return { status: 0, stdout: '', stderr: '' }
  })
  const runner = runnerIn(tmp, { git: recorded.git })
  const worktree = runner.pathFor('r1-h1')
  mkdirSync(worktree, { recursive: true })

  assert.equal(runner.seal('r1-h1'), SEALED)
  const argv = recorded.argv()
  assert.ok(argv.some((call) => call === 'add -A'), 'the candidate tree is staged in its own worktree')
  assert.ok(
    argv.some((call) => call.includes('commit') && call.includes('--no-verify')),
    'committed by the runner, because the runner is the only role allowed to write git',
  )
  assert.ok(
    argv.some((call) => call === `update-ref refs/reprise/anchor/r1-h1 ${SEALED}`),
    'kept behind a ref, or the commit would be garbage collected and the anchor would name nothing',
  )

  const before = recorded.calls.length
  assert.equal(runner.seal('r1-h1'), SEALED, 'sealing twice is the same commit')
  assert.equal(recorded.calls.length, before + 1, 'only the ref is consulted the second time')
})

test('a seal that cannot name the tree is loud, and the roll does not happen', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'reprise-anchor-seal-'))
  const recorded = recordingGit((args) =>
    args[0] === 'rev-parse' ? { status: 128, stdout: '', stderr: 'fatal: not a valid ref' } : undefined,
  )
  const runner = runnerIn(tmp, { git: recorded.git })
  mkdirSync(runner.pathFor('r1-h1'), { recursive: true })

  assert.throws(() => runner.seal('r1-h1'), /could not seal/)
})

test('the ports a host builds carry the anchor, so a roll reaches the runner without a special case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-anchor-'))
  const store = Store.open(dir)
  const withRunner = portsFromConfig({
    config: { runner: { repo: 'repo', dir: 'worktrees' }, executor: { kind: 'local' } },
    workspaceDir: dir,
    store,
  })

  assert.equal(withRunner.anchor.read(), undefined, 'no anchor yet')
  assert.equal(withRunner.runner.baseRef, CONFIGURED)

  const workspace = store.getState(undefined, 'workspace', {}) ?? {}
  store.setState(undefined, 'workspace', {
    ...workspace,
    code_base_anchor: { candidate_id: 'r1-h3', commit: COMMIT, source: 'automatic', at_ms: 1 },
  })

  assert.equal(withRunner.anchor.read().candidate_id, 'r1-h3')
  assert.equal(withRunner.runner.baseRef, COMMIT, 'the runner the platform and the harness share follows the fact')
  assert.equal(typeof withRunner.anchor.seal, 'function', 'and the roll can name a tree')

  const withoutRunner = portsFromConfig({ config: { executor: { kind: 'local' } }, workspaceDir: dir, store })
  assert.equal(withoutRunner.anchor, undefined, 'no runner means no tree to branch from, so no anchor port either')
  store.close()
})
