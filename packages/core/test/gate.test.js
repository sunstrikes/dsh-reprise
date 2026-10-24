/**
 * Gate two's two pieces of evidence — the half the kernel computes.
 *
 * This file guards the static check report, and it exists as its own seam for three reasons:
 *
 * 1. **The report is the kernel's, not the model's.** Syntax, the adjustable-surface whitelist and
 *    residual conflict markers are facts read from the candidate's worktree by code. Nothing in this
 *    module takes a model port, and no model answer can add, drop or reword a check.
 * 2. **The report is recomputable.** Each check records the sha256 of the bytes it saw, so a second
 *    reader (a retry, a dump, a human with the worktree) can re-derive the conclusion instead of
 *    trusting it. Re-reading a *different* tree is `stale` — the tree moved on, which is not a
 *    contradiction. Re-deriving a *different conclusion* from identical bytes is `conflict` — a
 *    deterministic check disagreed with itself, and that is a finding for a human.
 * 3. **A check that could not run is never a silent pass.** A file whose language the kernel cannot
 *    parse, or a worktree it cannot read, is named in `unchecked`; the checks say what they did and
 *    did not look at. The alternative — a green report over an unread file — is the failure this
 *    repository's warning rule exists to prevent.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createHash } from 'node:crypto'

import { recheckReport, staticReport, surfaceAllows } from '../lib/gate.js'

const AT = 1_761_091_200_000

/** A worktree with the files a candidate claims to have changed. */
function worktree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-gate-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content, 'utf8')
  }
  return dir
}

const report = (dir, files, surface) =>
  staticReport({ candidateId: 'c1', files, worktreeDir: dir, surface })

const check = (result, name) => result.checks.find((entry) => entry.name === name)
const digestOf = (text) => createHash('sha256').update(text).digest('hex')

const SURFACE = { files: ['model/structure.json'] }

// ------------------------------------------------------------------ report

test('a clean change passes all three checks, and the report records the bytes it checked', () => {
  const content = JSON.stringify({ hidden_units: 64 })
  const dir = worktree({ 'model/structure.json': content })
  const result = report(dir, ['model/structure.json'], SURFACE)

  assert.equal(result.ready_to_submit, true)
  assert.deepEqual(result.checks.map((entry) => entry.name), ['syntax', 'allowed_surface', 'conflict_markers'])
  assert.ok(result.checks.every((entry) => entry.result === 'pass'))
  assert.deepEqual(result.files, [{ path: 'model/structure.json', digest: digestOf(content), bytes: content.length }])
  assert.deepEqual(result.unchecked, [])
  assert.deepEqual(result.whitelist, ['model/structure.json'])
  rmSync(dir, { recursive: true, force: true })
})

test('a file that does not parse is a failed syntax check that names the path', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64,' })
  const result = report(dir, ['model/structure.json'], SURFACE)

  assert.equal(check(result, 'syntax').result, 'fail')
  assert.match(check(result, 'syntax').detail, /model\/structure\.json/)
  assert.equal(result.ready_to_submit, false)
  rmSync(dir, { recursive: true, force: true })
})

test('a changed file outside the declared surface is out of bounds, not merely unlikely', () => {
  const dir = worktree({
    'model/structure.json': '{"hidden_units": 64}',
    'model/train.py': 'print("hello")\n',
  })
  const result = report(dir, ['model/structure.json', 'model/train.py'], SURFACE)

  assert.equal(check(result, 'allowed_surface').result, 'fail')
  assert.match(check(result, 'allowed_surface').detail, /model\/train\.py/)
  assert.equal(result.ready_to_submit, false)
  rmSync(dir, { recursive: true, force: true })
})

test('the whitelist understands a directory and a star, so a domain can declare an adjustable area', () => {
  assert.equal(surfaceAllows('model/structure.json', ['model/structure.json']), true)
  assert.equal(surfaceAllows('model/head.py', ['model/']), true)
  assert.equal(surfaceAllows('model/head.py', ['model/*']), true)
  assert.equal(surfaceAllows('model/deep/head.py', ['model/**']), true)
  assert.equal(surfaceAllows('model/deep/head.py', ['model/*']), false, 'one star is one path segment')
  assert.equal(surfaceAllows('eval/harness.py', ['model/*']), false)
  assert.equal(surfaceAllows('model/structure.json', []), false, 'an empty whitelist allows nothing')
})

test('residual conflict markers fail the gate, and a markdown underline does not', () => {
  const conflicted = worktree({ 'model/structure.json': '<<<<<<< HEAD\n{"a": 1}\n=======\n{"a": 2}\n>>>>>>> other\n' })
  const failed = report(conflicted, ['model/structure.json'], SURFACE)
  assert.equal(check(failed, 'conflict_markers').result, 'fail')
  assert.match(check(failed, 'conflict_markers').detail, /model\/structure\.json:1/)
  rmSync(conflicted, { recursive: true, force: true })

  const notes = worktree({ 'model/structure.json': '{"a": 1}\n' })
  writeFileSync(join(notes, 'NOTES.md'), 'title\n=======\nbody\n', 'utf8')
  const clean = report(notes, ['model/structure.json', 'NOTES.md'], { files: ['model/structure.json', 'NOTES.md'] })
  assert.equal(check(clean, 'conflict_markers').result, 'pass', 'a setext underline is not a merge conflict')
  rmSync(notes, { recursive: true, force: true })
})

test('a file the kernel cannot read or parse is named, never silently green', () => {
  const dir = worktree({ 'model/notes.txt': 'plain text\n' })
  const result = report(dir, ['model/notes.txt', 'model/vanished.json'], { files: ['model/notes.txt', 'model/vanished.json'] })

  assert.deepEqual(result.unchecked, ['model/notes.txt', 'model/vanished.json'])
  assert.match(check(result, 'syntax').detail, /not checked/)
  assert.equal(result.ready_to_submit, true, 'an unparseable language is not a syntax failure — the review still reads the diff')
  rmSync(dir, { recursive: true, force: true })
})

test('a path that escapes the worktree is never read', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}', 'secret.json': '{"secret": true}\n' })
  const nested = join(dir, 'model')

  const result = staticReport({
    candidateId: 'c1',
    files: ['../secret.json'],
    worktreeDir: nested,
    surface: SURFACE,
  })
  assert.deepEqual(result.unchecked, ['../secret.json'], 'the escape is named, not followed')
  assert.equal(check(result, 'allowed_surface').result, 'fail', 'and it is out of bounds anyway')
  rmSync(dir, { recursive: true, force: true })
})

test('a domain that declares no surface makes the whitelist vacuous, and the report says so', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}' })
  const result = report(dir, ['model/structure.json'], undefined)

  assert.equal(check(result, 'allowed_surface').result, 'pass')
  assert.match(check(result, 'allowed_surface').detail, /no adjustable surface/i)
  assert.deepEqual(result.whitelist, [])
  rmSync(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------- recompute

/** The artifact shape a record has: the same report, stored with the attempt that produced it. */
const recordOf = (result, { attempt = 1, passed = result.ready_to_submit } = {}) => ({
  candidate_id: 'c1',
  attempt,
  passed,
  checks: result.checks,
  reviewer: { verdict: passed ? 'accept' : 'reject', rationale: 'looked at the diff' },
  decided_at_ms: AT,
  evidence: { whitelist: result.whitelist, files: result.files, unchecked: result.unchecked },
})

test('a record rechecks to ok while the tree it recorded is unchanged', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}' })
  const stored = recordOf(report(dir, ['model/structure.json'], SURFACE))

  assert.deepEqual(recheckReport(stored, { worktreeDir: dir }), { status: 'ok', message: '' })
  rmSync(dir, { recursive: true, force: true })
})

test('a recheck of a tree that moved on is stale, not a contradiction', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}' })
  const stored = recordOf(report(dir, ['model/structure.json'], SURFACE))
  writeFileSync(join(dir, 'model/structure.json'), '{"hidden_units": 128}', 'utf8')

  const verdict = recheckReport(stored, { worktreeDir: dir })
  assert.equal(verdict.status, 'stale')
  assert.match(verdict.message, /model\/structure\.json/)
  rmSync(dir, { recursive: true, force: true })
})

test('a record whose files are gone cannot be recomputed, and that is reported as stale', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}' })
  const stored = recordOf(report(dir, ['model/structure.json'], SURFACE))
  rmSync(join(dir, 'model/structure.json'))

  assert.equal(recheckReport(stored, { worktreeDir: dir }).status, 'stale')
  rmSync(dir, { recursive: true, force: true })
})

test('identical bytes and a different conclusion is a conflict: a deterministic check disagreed with itself', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}' })
  const result = report(dir, ['model/structure.json'], SURFACE)
  const tampered = { ...recordOf(result), checks: result.checks.map((entry) => (entry.name === 'syntax' ? { ...entry, result: 'fail' } : entry)) }

  const verdict = recheckReport(tampered, { worktreeDir: dir })
  assert.equal(verdict.status, 'conflict')
  assert.match(verdict.message, /syntax/)
  rmSync(dir, { recursive: true, force: true })
})

test('a record with no evidence cannot be recomputed, and saying so is not the same as agreeing', () => {
  const dir = worktree({ 'model/structure.json': '{"hidden_units": 64}' })
  const stored = { candidate_id: 'c1', passed: true, checks: [{ name: 'syntax', result: 'pass' }], decided_at_ms: AT }

  assert.equal(recheckReport(stored, { worktreeDir: dir }).status, 'missing')
  rmSync(dir, { recursive: true, force: true })
})