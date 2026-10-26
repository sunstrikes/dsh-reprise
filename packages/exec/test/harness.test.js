/**
 * Guards ticket 07's two central decisions, for every adapter that claims to be a candidate
 * implementer:
 *
 * 1. **LAND happens inside the candidate's own git worktree.** `cwd` is the worktree — not the
 *    loop's directory with an `--add-dir` whitelist and a sentence in the prompt, which is what the
 *    predecessor did and what ticket 07 calls a bug.
 * 2. **"Which files changed" is git's answer, never the harness's.** The harness's self-report is a
 *    cross-check; when it disagrees with the diff the landing fails as a `conflict`, so no phase can
 *    be advanced on a claim nobody verified.
 *
 * A third decision is guarded implicitly: the runner owns worktrees and `refs/reprise/*`. Every
 * test below creates them itself and then asserts the adapter left them untouched, because an
 * adapter that can create git state is an adapter that can corrupt the tree it is supposed to be
 * isolated inside.
 *
 * The conformance contract is `assertLandResult` from `lib/harness.js`, not the assertions in this
 * file: a third engine is usable exactly when it satisfies that function.
 */

import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { assertLandResult, buildPrompt, runGit, validateLandResult } from '../lib/harness.js'
import { createClaudeHarness } from '../lib/harness-claude.js'
import { createDshHarness } from '../lib/harness-dsh.js'
import { fakeHarness, makeRunner, readTrace, writeFakeCli } from './support.js'

const HYPOTHESIS = 'widen the embedding table to cut rare-feature collisions'

/** Single-adapter shorthand: the shared body in `harness.js` is what most cases exercise. */
const CLAUDE = { create: createClaudeHarness }

const ADAPTERS = [
  {
    name: 'claude',
    create: createClaudeHarness,
    /** `-p --output-format stream-json` is the streaming harness; `--add-dir` would defeat cwd pinning. */
    assertArgv(argv) {
      assert.ok(argv.includes('-p'), 'claude must be invoked with -p: print mode is the only non-interactive shape')
      const index = argv.indexOf('--output-format')
      assert.notEqual(index, -1, 'stream-json is the only output format that reports per-run events and spend')
      assert.equal(argv[index + 1], 'stream-json', 'the adapter parses stream-json, so it must ask for stream-json')
      assert.ok(
        argv.includes('--verbose'),
        'the CLI refuses -p with stream-json unless --verbose is passed; without it every landing fails',
      )
      assert.ok(
        !argv.includes('--add-dir'),
        'the worktree must be the child cwd; an --add-dir whitelist would leave the process running in the loop\'s own checkout',
      )
      assert.ok(
        !argv.includes('--worktree'),
        'the runner owns worktree creation, so the harness must not be asked to make one',
      )
      assert.ok(
        argv.includes('--dangerously-skip-permissions'),
        'an unattended landing must never wait on a permission prompt nobody will answer',
      )
    },
  },
  {
    name: 'dsh',
    create: createDshHarness,
    assertArgv(argv) {
      const index = argv.indexOf('--profile')
      assert.notEqual(index, -1, 'the headless app is selected by an explicit profile')
      assert.equal(argv[index + 1], 'headless', 'the adapter must boot the headless app, not the interactive one')
      assert.ok(argv.includes('--json'), 'the adapter consumes run events, not the final rendered message')
      assert.equal(argv.at(-1), '-', 'the prompt travels on stdin, so the task argument must be "-"')
    },
  },
]

for (const adapter of ADAPTERS) {
  test(`${adapter.name}: the candidate process runs inside its worktree and git names the changed files`, async (t) => {
    const runner = makeRunner(t)
    const fakeCli = writeFakeCli(runner.root)
    const trace = runner.tracePath()
    const refsBefore = runner.refs()
    const worktreesBefore = runner.worktrees()

    // Every git call is recorded on its way to the real git: the adapter may read state, never write it.
    const gitCalls = []
    const recordingGit = (args, options) => {
      gitCalls.push(args[0])
      return runGit(args, options)
    }
    const observed = fakeHarness(adapter, { fakeCli, trace, git: recordingGit })

    const result = assertLandResult(
      await observed.land({
        candidateId: 'cand-1',
        hypothesis: HYPOTHESIS,
        round: 2,
        worktreeDir: runner.worktreeDir,
        baseRef: runner.base,
        parentId: 'baseline-0',
      }),
    )

    assert.equal(result.ok, true, 'a harness that exits cleanly and edited files has landed')
    assert.equal(result.error_class, 'ok', 'the success class is spelled "ok" so the kernel can log one field')
    assert.equal(result.engine, adapter.name, 'the result must name the engine that landed it')
    assert.equal(
      result.parent_id,
      'baseline-0',
      'the parent is whatever the kernel said it was; the adapter is not entitled to guess an identity',
    )
    assert.equal(
      result.parent_commit,
      runner.base,
      'parent_commit must be the commit the worktree branched from, resolved from git rather than trusted from a string',
    )
    assert.equal(result.base_ref, runner.base, 'the base ref the diff was taken against is part of the audit trail')
    assert.deepEqual(
      result.files,
      ['README.md', 'candidate.py'],
      'git decides which files changed, and a newly created file counts — a plain `git diff` against the base ref would have missed it',
    )
    assert.equal(result.files_changed, 2, 'the count is git\'s count, so it cannot disagree with the list')
    assert.equal(
      result.cross_check.status,
      'match',
      'a self-report that agrees with git is recorded as agreement, not promoted to a second source of truth',
    )
    assert.equal(result.usage.total_cost_usd, 0.0123, 'spend is read from the result event so the ledger can settle it')
    assert.equal(result.usage.input_tokens, 11, 'token accounting is recorded even though v1 does not stop on it')
    assert.equal(result.usage.output_tokens, 22)
    assert.equal(result.session_id, 'fake-session', 'the session id is kept so an operator can resume the run by hand')
    assert.ok(Number.isSafeInteger(result.duration_ms), 'duration is a diagnostic the event stream can carry')

    const recorded = readTrace(trace)
    assert.equal(
      recorded.cwd,
      realpathSync(runner.worktreeDir),
      'the child process must run with the candidate worktree as its cwd — the whole ticket is this line',
    )
    assert.match(recorded.stdin, /widen the embedding table/, 'the hypothesis reaches the harness through stdin')
    assert.match(recorded.stdin, /cand-1/, 'the harness is told which candidate it is landing')
    assert.ok(
      result.output.includes(realpathSync(runner.worktreeDir)),
      'the harness saw the worktree path, so its edits and the diff are about the same directory',
    )
    adapter.assertArgv(recorded.argv)

    assert.deepEqual(
      [...new Set(gitCalls)].sort(),
      ['diff', 'ls-files', 'rev-parse'],
      'the adapter only reads git state: worktrees and refs belong to the runner, and a mutation here would corrupt a tree it does not own',
    )
    assert.equal(runner.refs(), refsBefore, 'landing must not create, move or delete the runner\'s refs')
    assert.equal(runner.worktrees(), worktreesBefore, 'landing must not create or remove worktrees')
  })

  test(`${adapter.name}: a self-report that disagrees with git fails the landing instead of being believed`, async (t) => {
    const runner = makeRunner(t)
    const fakeCli = writeFakeCli(runner.root)
    const harness = fakeHarness(adapter, { mode: 'mismatch', fakeCli })

    const result = assertLandResult(
      await harness.land({
        candidateId: 'cand-1',
        hypothesis: HYPOTHESIS,
        worktreeDir: runner.worktreeDir,
        baseRef: runner.base,
      }),
    )

    assert.equal(result.ok, false, 'a harness whose report contradicts the diff has not landed')
    assert.equal(result.error_class, 'cross_check_mismatch', 'the mismatch is its own class, not a generic failure')
    assert.equal(
      result.conflict,
      true,
      'two facts that must agree do not: this is the contract\'s conflict state, and the kernel must not record it as "invalid"',
    )
    assert.deepEqual(result.files, ['README.md', 'candidate.py'], 'git still decides the diff; the claim never replaces it')
    assert.deepEqual(
      result.cross_check.missing,
      ['README.md'],
      'git changed a file the harness never reported — believing the report would silently drop it from the audit',
    )
    assert.deepEqual(
      result.cross_check.unexpected,
      ['ghost.py'],
      'the harness claimed a file git cannot see — believing the report would invent a change that never happened',
    )
    assert.match(result.message, /ghost\.py/, 'the failure must name the disagreement so an operator can act on it')
  })
}

test('a harness that says nothing about its diff still lands, with the cross-check marked not_reported', async (t) => {
  const runner = makeRunner(t)
  const fakeCli = writeFakeCli(runner.root)
  const harness = fakeHarness(CLAUDE, { mode: 'no-report', fakeCli })

  const result = assertLandResult(
    await harness.land({
      candidateId: 'cand-1',
      hypothesis: HYPOTHESIS,
      worktreeDir: runner.worktreeDir,
      baseRef: runner.base,
    }),
  )

  assert.equal(result.ok, true, 'silence is not a contradiction: the diff is the authority and it is available')
  assert.equal(result.cross_check.status, 'not_reported', 'an absent report is recorded as absent, not as agreement')
  assert.deepEqual(result.files, ['README.md', 'candidate.py'], 'git\'s list is complete without any self-report')
  assert.equal(result.parent_id, null, 'no parent was given, so the result says null rather than inventing one')
})

test('landing twice in the same worktree reports the diff, not an accumulation', async (t) => {
  const runner = makeRunner(t)
  const fakeCli = writeFakeCli(runner.root)
  const harness = fakeHarness(CLAUDE, { fakeCli })
  const input = {
    candidateId: 'cand-1',
    hypothesis: HYPOTHESIS,
    worktreeDir: runner.worktreeDir,
    baseRef: runner.base,
  }

  const first = await harness.land(input)
  const second = await harness.land(input)

  assert.deepEqual(first.files, ['README.md', 'candidate.py'], 'the first landing edited two files')
  assert.deepEqual(
    second.files,
    ['README.md', 'candidate.py'],
    'a resumed or retried landing re-derives the diff against the base ref instead of stacking a second delta',
  )
  assert.equal(second.files_changed, 2, 'the count stays stable across retries, so the audit line does not drift')
})

test('the runner can remove a candidate worktree and its ref, and the next candidate lands fresh', async (t) => {
  const runner = makeRunner(t)
  const fakeCli = writeFakeCli(runner.root)
  const harness = fakeHarness(CLAUDE, { fakeCli })
  const input = {
    candidateId: 'cand-1',
    hypothesis: HYPOTHESIS,
    worktreeDir: runner.worktreeDir,
    baseRef: runner.base,
  }

  const crashed = assertLandResult(
    await fakeHarness(CLAUDE, { mode: 'edit-then-crash', fakeCli }).land(input),
  )
  assert.equal(crashed.ok, false, 'the harness died mid-edit, so nothing landed')
  assert.equal(crashed.error_class, 'deterministic_fail', 'a non-zero exit is a decidable failure, not a stuck phase')
  assert.deepEqual(
    crashed.files,
    ['README.md', 'candidate.py'],
    'a failed landing still reports the dirty worktree it left behind, which is what tells the runner it must clean up',
  )

  // The runner's cleanup, exactly as ticket 07 requires: nothing about it goes through the adapter.
  runner.removeWorktree()
  runner.removeRef()
  assert.ok(
    !runner.worktrees().includes('worktree-cand-1'),
    'after the runner cleans up, the candidate worktree is gone — cleanup must not depend on the harness',
  )
  assert.ok(!runner.refs().includes('refs/reprise/'), 'the candidate ref is gone once the runner removes it')

  runner.addWorktree()
  const refsAfterRecreate = runner.refs()
  const second = assertLandResult(await harness.land(input))

  assert.equal(second.ok, true, 'a fresh worktree for the same candidate lands cleanly after a crash-and-cleanup cycle')
  assert.deepEqual(
    second.files,
    ['README.md', 'candidate.py'],
    'no residue from the crashed attempt is attributed to this one: the diff is against the base ref, not an accumulated delta log',
  )
  assert.equal(runner.refs(), refsAfterRecreate, 're-landing does not recreate or move any ref')
})

test('caller mistakes throw before a process starts, because they are the runner\'s bug and not a candidate to reject', async (t) => {
  const runner = makeRunner(t)
  const fakeCli = writeFakeCli(runner.root)
  const trace = runner.tracePath('never-written')
  const harness = fakeHarness(CLAUDE, { fakeCli, trace })

  await assert.rejects(
    () =>
      harness.land({
        candidateId: 'cand-1',
        hypothesis: HYPOTHESIS,
        worktreeDir: join(runner.root, 'no-such-worktree'),
        baseRef: runner.base,
      }),
    (error) => error instanceof TypeError && /does not exist/.test(error.message),
    'a missing worktree means the runner never created one; silently rejecting candidates would hide that for hours',
  )
  await assert.rejects(
    () =>
      harness.land({
        candidateId: 'cand-1',
        hypothesis: HYPOTHESIS,
        worktreeDir: runner.worktreeDir,
        baseRef: 'definitely-not-a-commit',
      }),
    (error) => error instanceof TypeError && /does not resolve/.test(error.message),
    'without a resolvable base ref there is no diff, and the diff is the only authority on what changed',
  )
  await assert.rejects(
    () => harness.land({ hypothesis: HYPOTHESIS, worktreeDir: runner.worktreeDir, baseRef: runner.base }),
    (error) => error instanceof TypeError && /candidateId/.test(error.message),
    'a landing with no candidate id cannot be recorded, so it must fail loudly instead of writing an anonymous fact',
  )
  await assert.rejects(
    () => harness.land({ candidateId: 'cand-1', hypothesis: '   ', worktreeDir: runner.worktreeDir, baseRef: runner.base }),
    (error) => error instanceof TypeError && /hypothesis/.test(error.message),
    'a landing with no hypothesis is a build step, and pretending otherwise would burn model budget for nothing',
  )

  assert.equal(existsSync(trace), false, 'no harness process may start when the caller\'s input is already wrong')
})

test('a diff git cannot read is a runner bug, not a landing with zero files', async (t) => {
  const runner = makeRunner(t)
  const fakeCli = writeFakeCli(runner.root)
  const brokenGit = (args, options) =>
    args[0] === 'diff' ? { ok: false, stdout: '', stderr: 'fatal: bad revision' } : runGit(args, options)
  const harness = fakeHarness(CLAUDE, { fakeCli, git: brokenGit })

  await assert.rejects(
    () =>
      harness.land({
        candidateId: 'cand-1',
        hypothesis: HYPOTHESIS,
        worktreeDir: runner.worktreeDir,
        baseRef: runner.base,
      }),
    (error) => /cannot read the candidate diff/.test(error.message),
    'reporting "landed, zero files changed" because git could not be read would be a silent lie about what the candidate did',
  )
})

test('the prompt states the isolation rules the port cannot enforce for the model', () => {
  const prompt = buildPrompt({
    candidateId: 'cand-7',
    hypothesis: HYPOTHESIS,
    round: 3,
    worktreeDir: '/tmp/worktree-cand-7',
  })

  assert.match(prompt, /\/tmp\/worktree-cand-7/, 'the candidate must be told where its world ends')
  assert.match(prompt, /cand-7/, 'the candidate must know which candidate it is')
  assert.match(prompt, /git commit/, 'forbidden git mutations are named, because the runner owns every ref')
  assert.match(prompt, /git worktree/, 'worktree creation is the runner\'s job, not the harness\'s')
  assert.match(prompt, /\{"files"/, 'the self-report shape is stated, so a mismatch is a real disagreement rather than a format guess')
  assert.match(prompt, /git decides what changed/, 'the prompt says outright that the report is only a cross-check')
})
test('the conformance contract rejects results the kernel must never receive', () => {
  const good = {
    ok: true,
    prompt: 'land candidate cand-1',
    error_class: 'ok',
    retryable: false,
    conflict: false,
    engine: 'claude',
    candidate_id: 'cand-1',
    parent_id: null,
    parent_commit: 'a'.repeat(40),
    base_ref: 'refs/reprise/cand-1',
    files: ['config.py'],
    files_changed: 1,
    cross_check: { status: 'match', reported: ['config.py'], changed: ['config.py'], missing: [], unexpected: [] },
    usage: { total_cost_usd: 0.01, input_tokens: 1, output_tokens: 2 },
    output: 'done',
    session_id: null,
    exit_code: 0,
    signal: null,
    timed_out: false,
    overflowed: false,
    stderr_excerpt: '',
    duration_ms: 12,
  }

  assert.equal(validateLandResult(good).status, 'ok', 'a well-formed success is accepted, or the contract checks nothing')

  const rejected = [
    [{ files: ['b.py', 'a.py'] }, 'an unsorted file list would make the same landing produce different event payloads'],
    [{ files: ['a.py', 'a.py'], files_changed: 2 }, 'a duplicated path would double-count the landing'],
    [{ files: ['a.py', 'b.py'], files_changed: 1 }, 'the count and the list must agree, because both go into the audit line'],
    [{ cross_check: { status: 'mismatch' } }, 'a mismatch may not ride along on a successful landing'],
    [{ parent_commit: 'not-a-sha' }, 'parent_commit must be a git object id, or the identity chain cannot be walked'],
    [{ error_class: 'made_up' }, 'an undeclared class would silently fall through the kernel\'s switch'],
    [{ prompt: '' }, 'a result with no prompt cannot be filed next to the answer it produced'],
    [{ ok: false, error_class: 'cross_check_mismatch', conflict: false, message: 'x' }, 'a mismatch is a conflict state, never an invalid artifact'],
  ]
  for (const [patch, why] of rejected) {
    assert.equal(validateLandResult({ ...good, ...patch }).status, 'invalid', why)
  }
  assert.equal(
    validateLandResult({ ...good, ok: false, error_class: 'cross_check_mismatch', conflict: true, message: 'x' }).status,
    'ok',
    'the mismatch failure is a legitimate result, as long as it is flagged as the conflict it is',
  )
  assert.throws(
    () => assertLandResult({ ...good, files_changed: 9 }),
    /violates the harness port contract/,
    'assertLandResult is what a new adapter runs; it must fail loudly rather than return a warning nobody reads',
  )
})
