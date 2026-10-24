/**
 * Guards "the candidate's code travels with the job" (ticket 15, spec 执行面: the runner's git diff
 * is the only authority on what changed, and the archive is what the node actually gets).
 *
 * The seam is `packCandidate()` / `collectInventory()` in `lib/archive.js` — one tree in, one archive
 * plus one inventory out. Five things are asserted here, in the order they can go wrong:
 *
 *  1. **The archive is the tree, whole.** A tracked edit, a brand-new module (the common shape of a
 *     structural candidate) and untouched files all ship; the plugin's own fact plane
 *     (`*.db`, `*.db-wal`, `*.db-shm`, `.mnemon/`) never does, because a fact plane inside the
 *     package would be read by a process that must not write it. The exclusion list is data, and the
 *     test names every pattern rather than trusting "some filter ran".
 *  2. **Untracked files are accounted for, not blinded.** A candidate that only adds a module is the
 *     normal case, so `git ls-files --others --exclude-standard` is part of the inventory and every
 *     untracked path appears in the receipt *and* either in the archive or in the excluded list.
 *  3. **The unpacked directory is the candidate's tree.** Reading the archive back yields the
 *     candidate's `config.py`, not the base commit's — the whole point of shipping the tree is that
 *     the job trains on the edited configuration.
 *  4. **A mismatch is a named conclusion, not a forced run.** An archive over `maxBytes`, and a path
 *     git says is part of the change that the archive cannot carry, both come back as
 *     `{ok: false, conclusion: …}` with the offending paths named. Neither writes anything.
 *  5. **The packer is a reader.** Only `git diff --name-only` and `git ls-files --others
 *     --exclude-standard` are run, in the candidate worktree, and the index, the refs and the
 *     working tree are untouched afterwards.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FACT_PLANE_EXCLUSIONS,
  compareInventories,
  collectInventory,
  isExcluded,
  packCandidate,
  packageNameFor,
} from '../lib/archive.js'
import { readZip } from '../lib/zip.js'
import { git as gitInRepo, makeRunner } from './support.js'

/** One candidate worktree with the three shapes a change takes, plus a fact plane nobody ships. */
function candidateTree(t) {
  const runner = makeRunner(t)
  const worktree = runner.worktreeDir
  writeFileSync(join(worktree, 'config.py'), 'learning_rate = 2e-3\n') // tracked edit
  mkdirSync(join(worktree, 'model'))
  writeFileSync(join(worktree, 'model', 'head.py'), '# a brand new module\n') // untracked, the common case
  writeFileSync(join(worktree, 'model', '说明.md'), '# 说明\n') // untracked, not ASCII
  writeFileSync(join(worktree, 'reprise.db'), 'sqlite') // fact plane
  writeFileSync(join(worktree, 'reprise.db-wal'), 'wal')
  mkdirSync(join(worktree, '.mnemon'))
  writeFileSync(join(worktree, '.mnemon', 'source.json'), '{"scope":"workspace"}')
  return runner
}

test('the archive carries the whole candidate tree and leaves the fact plane behind', (t) => {
  const runner = candidateTree(t)
  const packed = packCandidate({ worktreeDir: runner.worktreeDir, baseRef: runner.base })

  assert.equal(packed.ok, true, packed.ok ? '' : packed.message)
  const paths = packed.entries.map((entry) => entry.path).sort()
  assert.deepEqual(paths, ['README.md', 'config.py', 'model/head.py', 'model/说明.md'])

  assert.deepEqual(packed.inventory.changed, ['config.py'], 'what changed is git\'s answer, taken against the runner\'s base ref')
  assert.deepEqual(
    packed.inventory.untracked.sort(),
    ['.mnemon/source.json', 'model/head.py', 'model/说明.md', 'reprise.db', 'reprise.db-wal'].sort(),
    'untracked means "git does not know this file yet" — it is the normal shape of a candidate that adds a module',
  )

  const excluded = packed.inventory.excluded.map((entry) => `${entry.path} ${entry.pattern}`)
  for (const expected of ['reprise.db *.db', 'reprise.db-wal *.db-wal', '.mnemon/source.json .mnemon/']) {
    assert.ok(excluded.includes(expected), `the fact plane must be excluded by name and reason, not silently: missing ${expected} from ${excluded.join(', ')}`)
  }

  // Every untracked path the runner knows about is accounted for, one way or the other. This is the
  // line the ticket draws: the run may not proceed "blind" past a file only the candidate knows about.
  const accounted = new Set([...paths, ...packed.inventory.excluded.map((entry) => entry.path)])
  for (const path of packed.inventory.untracked) {
    assert.ok(accounted.has(path), `${path} is untracked and appears in neither the archive nor the excluded list`)
  }
})

test('the archive excludes exactly the patterns it declares, and the list is data', () => {
  for (const { pattern, why } of FACT_PLANE_EXCLUSIONS) {
    assert.equal(typeof pattern, 'string')
    assert.ok(why.length > 10, `${pattern} must say why it is excluded — a bare list becomes an if-chain the next time someone adds a path`)
  }
  assert.ok(isExcluded('reprise.db'), 'the workspace database is the fact plane')
  assert.ok(isExcluded('nested/dir/reprise.db-shm'))
  assert.ok(isExcluded('.mnemon/sources/one.json'))
  assert.equal(isExcluded('model/head.py'), undefined)
  assert.equal(isExcluded('docs/database.md'), undefined, 'a substring match would eat a candidate\'s own file named like ours')
})

test('what the node unpacks is the candidate\'s configuration, not the base commit\'s', (t) => {
  const runner = candidateTree(t)
  const packed = packCandidate({ worktreeDir: runner.worktreeDir, baseRef: runner.base })

  const unpacked = mkdtempSync(join(tmpdir(), 'reprise-unpacked-'))
  for (const entry of readZip(packed.archive)) {
    const target = join(unpacked, entry.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, entry.content)
  }

  assert.equal(
    readFileSync(join(unpacked, 'config.py'), 'utf8'),
    'learning_rate = 2e-3\n',
    'the job must read the configuration the candidate changed; shipping the base commit silently would measure the wrong model',
  )
  assert.equal(readFileSync(join(unpacked, 'model', 'head.py'), 'utf8'), '# a brand new module\n')
  assert.equal(existsSync(join(unpacked, 'reprise.db')), false, 'the node must not receive a fact plane it is not allowed to write')
})

test('an archive over the limit is a named conclusion with the sizes that caused it', (t) => {
  const runner = candidateTree(t)
  const packed = packCandidate({ worktreeDir: runner.worktreeDir, baseRef: runner.base, maxBytes: 16 })

  assert.equal(packed.ok, false)
  assert.equal(packed.conclusion, 'archive_too_large')
  assert.match(packed.message, /16/, 'the conclusion must carry the limit it hit')
  assert.ok(packed.largest.length > 0, 'it must also name the files that made the tree too big, or nobody can shrink it')
  assert.equal(packed.archive, undefined, 'nothing is uploaded: the conclusion replaces the run, it does not precede a forced one')
})

test('a path git says changed but the archive cannot carry is a conflict, not a silent drop', (t) => {
  const runner = candidateTree(t)
  symlinkSync('config.py', join(runner.worktreeDir, 'config-link.py'))

  const packed = packCandidate({ worktreeDir: runner.worktreeDir, baseRef: runner.base })

  assert.equal(packed.ok, false)
  assert.equal(packed.conclusion, 'inventory_conflict')
  assert.deepEqual(packed.conflict, ['config-link.py'], 'the two accounts of the change disagree; naming the path is the whole finding')
  assert.match(packed.message, /config-link\.py/)
})

test('the post-unpack comparison disagrees the moment one untracked path is missing or altered', () => {
  const pre = {
    changed: ['config.py'],
    untracked: ['model/head.py'],
    excluded: [],
    entries: [
      { path: 'config.py', sha256: 'aa' },
      { path: 'model/head.py', sha256: 'bb' },
    ],
  }
  const same = [
    { path: 'config.py', sha256: 'aa' },
    { path: 'model/head.py', sha256: 'bb' },
  ]
  assert.deepEqual(compareInventories(pre, same), {
    ok: true,
    conflict: [],
    missing: [],
    altered: [],
    extra: [],
    untracked_missing: [],
  })

  const absent = compareInventories(pre, [{ path: 'config.py', sha256: 'aa' }])
  assert.equal(absent.ok, false)
  assert.deepEqual(absent.untracked_missing, ['model/head.py'], 'an untracked module that did not arrive is the dangerous one: it is the candidate\'s whole change')

  const altered = compareInventories(pre, [
    { path: 'config.py', sha256: 'aa' },
    { path: 'model/head.py', sha256: 'cc' },
  ])
  assert.equal(altered.ok, false)
  assert.deepEqual(altered.altered, ['model/head.py'])
})

test('the packer reads git and touches nothing: two read-only subcommands, index and refs unchanged', (t) => {
  const runner = candidateTree(t)
  const before = gitInRepo(runner.worktreeDir, 'status', '--porcelain')
  const refsBefore = runner.refs()

  const calls = []
  const git = (args, options) => {
    calls.push(args.join(' '))
    return { status: 0, stdout: '', stderr: '' }
  }
  collectInventory({ worktreeDir: runner.worktreeDir, baseRef: runner.base, git })

  assert.deepEqual(calls, [
    `-c core.quotepath=false diff --name-only ${runner.base}`,
    '-c core.quotepath=false ls-files --others --exclude-standard',
  ])

  packCandidate({ worktreeDir: runner.worktreeDir, baseRef: runner.base })
  assert.equal(gitInRepo(runner.worktreeDir, 'status', '--porcelain'), before)
  assert.equal(runner.refs(), refsBefore, 'the runner owns the refs; a packer that moves them can lie about the diff')
})

test('the package name is flat, ends in .zip and is derived from the content', () => {
  const name = packageNameFor({ submissionId: 'r1-h2', sha256: 'a'.repeat(64) })
  assert.match(name, /\.zip$/, 'Ray rejects a non-.zip remote URI')
  assert.equal(name.includes('/'), false, 'the package route matches no path with a slash in the name: it 404s')
  assert.notEqual(name, packageNameFor({ submissionId: 'r1-h3', sha256: 'a'.repeat(64) }), 'two candidates must not overwrite each other')
  assert.equal(name, packageNameFor({ submissionId: 'r1-h2', sha256: 'a'.repeat(64) }), 'the same tree must land on the same object')
})