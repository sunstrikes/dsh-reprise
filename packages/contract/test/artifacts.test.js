import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

import { artifactKinds, validateArtifact } from '../lib/index.js'

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url))

const casesFor = (kind) =>
  JSON.parse(readFileSync(join(FIXTURES, kind, 'cases.json'), 'utf8'))

test('every registered artifact kind has fixtures', () => {
  const onDisk = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(onDisk, artifactKinds().slice().sort(), 'a kind without fixtures has no contract')
})

for (const kind of artifactKinds()) {
  test(`${kind}: fixtures are the contract`, () => {
    const cases = casesFor(kind)
    assert.ok(cases.length >= 4, `${kind} needs at least one case per state`)

    const covered = new Set()
    for (const { note, expect, artifact } of cases) {
      const result = validateArtifact(kind, artifact)
      assert.equal(result.status, expect, `${kind}: ${note}\n  got: ${result.status} ${result.message}`)
      covered.add(expect)
      if (result.status !== 'ok') assert.ok(result.message.length > 0, `${kind}: "${note}" must explain itself`)
    }

    assert.deepEqual([...covered].sort(), ['conflict', 'invalid', 'missing', 'ok'], `${kind} must cover all four states`)
  })
}

test('an unknown kind is invalid, not silently ok', () => {
  const result = validateArtifact('no_such_artifact', {})
  assert.equal(result.status, 'invalid')
  assert.match(result.message, /unknown artifact kind/)
})

test('milliseconds are enforced: seconds and nanoseconds are rejected', () => {
  const base = casesFor('verify_verdict').find((entry) => entry.expect === 'ok').artifact

  for (const [label, value] of [
    ['seconds', 1761091200],
    ['nanoseconds', 1761091200000000000],
    ['a float', 1761091200000.5],
    ['a string', '1761091200000'],
  ]) {
    const result = validateArtifact('verify_verdict', { ...base, decided_at_ms: value })
    assert.equal(result.status, 'invalid', `${label} must not pass as milliseconds`)
  }
})

test('a vendor can add a kind without touching the kernel', () => {
  // Nothing below is exported from index.js; the point is that registration is enough.
  const before = artifactKinds().length
  assert.equal(before, 4, 'the four kinds this package defines: three phase artifacts and the windowed sample series')
})
test('artifact schema_version is per-kind and rejects a version this kernel cannot speak', () => {
  const base = casesFor('verify_verdict').find((entry) => entry.expect === 'ok').artifact
  assert.equal(validateArtifact('verify_verdict', { ...base, schema_version: 1 }).status, 'ok')
  assert.equal(validateArtifact('verify_verdict', { ...base, schema_version: 2 }).status, 'invalid')
  // Absent means "the version this kernel writes" — old artifacts must not need a rewrite.
  assert.equal(validateArtifact('verify_verdict', base).status, 'ok')
})
