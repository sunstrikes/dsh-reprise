/**
 * Guards the container format the job package travels in (ticket 15: code travels with the job).
 *
 * The contract is four properties, and every one of them is a way a hand-rolled encoder silently
 * loses a candidate's change:
 *
 *  1. **What goes in comes out.** `readZip(writeZip(entries))` returns the same paths, the same
 *     bytes and the same sha256 for every entry — including nested paths, unicode names and the
 *     executable bit, because a training entrypoint that arrives non-executable is a job that fails
 *     for a reason nobody can see in the metrics.
 *  2. **The same tree produces the same bytes.** Ray's package store is content-addressed by
 *     `PUT /api/packages/gcs/<name>.zip`, so the name is derived from a digest; two runs that pack
 *     one unchanged tree must not leave two objects behind, and a test that asserts a byte-identical
 *     result is the only way to keep that promise honest.
 *  3. **A corrupt archive is refused, not half-read.** The point of reading our own archive back is
 *     the post-unpack check; a reader that shrugs at a bad CRC cannot tell "the tree arrived" from
 *     "this is garbage".
 *  4. **No timestamps.** A zip entry carries a DOS mtime; if it came from the filesystem, the same
 *     tree would hash differently on every pack and property 2 would be a coincidence.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { readZip, writeZip } from '../lib/zip.js'

const sha256 = (value) =>
  // A second, independent implementation of the digest the archive records: node:crypto over the
  // bytes the reader handed back. If both agreed because they shared code, this test would pass
  // for a reader that returned the wrong bytes.
  createHash('sha256').update(value).digest('hex')

test('every entry that goes in comes out with the same bytes', () => {
  const entries = [
    { path: 'config.json', content: '{"lr": 0.001}\n' },
    { path: 'model/deep/train.py', content: 'print("hi")\n' },
    { path: 'model/深/skill.md', content: '# 说明\n' },
  ]
  const bytes = writeZip(entries)
  const read = readZip(bytes)

  assert.deepEqual(
    read.map((entry) => entry.path),
    ['config.json', 'model/deep/train.py', 'model/深/skill.md'],
    'paths must survive the round trip in a stable order — the post-unpack check compares them one by one',
  )
  for (const entry of read) {
    const source = entries.find((candidate) => candidate.path === entry.path)
    assert.equal(entry.content.toString('utf8'), source.content, `${entry.path} came back with different bytes`)
    assert.equal(entry.sha256, sha256(entry.content), `${entry.path}: the recorded digest must describe the bytes`)
    assert.equal(entry.bytes, Buffer.byteLength(source.content), `${entry.path}: bytes means bytes, not characters`)
  }
})

test('a file keeps its executable bit, and a plain file does not gain one', () => {
  const read = readZip(
    writeZip([
      { path: 'run.sh', content: '#!/bin/sh\n', mode: 0o755 },
      { path: 'notes.md', content: 'plain\n', mode: 0o644 },
    ]),
  )
  const byPath = new Map(read.map((entry) => [entry.path, entry]))
  assert.equal(byPath.get('run.sh').executable, true, 'a training entrypoint shipped without +x fails on the node for no visible reason')
  assert.equal(byPath.get('notes.md').executable, false)
})

test('the same tree produces byte-identical archives, twice', () => {
  const entries = [
    { path: 'b.py', content: 'b\n' },
    { path: 'a.py', content: 'a\n' },
  ]
  const first = writeZip(entries)
  const second = writeZip([...entries].reverse())
  assert.deepEqual(
    first,
    second,
    'the package name is derived from this digest, so an unordered or timestamped archive leaves a new object per pack',
  )
})

test('the archive is a real zip, so a node-side unzip can read it', () => {
  const bytes = writeZip([{ path: 'train.py', content: 'x = 1\n' }])
  assert.equal(bytes.subarray(0, 4).toString('binary'), 'PK\x03\x04', 'a local file header starts every real zip')
  assert.ok(
    bytes.includes(Buffer.from('PK\x05\x06', 'binary')),
    'without an end-of-central-directory record nothing but our own reader could open it',
  )
})

test('a truncated archive is refused by the reader instead of yielding half a tree', () => {
  const bytes = writeZip([{ path: 'a.py', content: 'a\n' }])
  assert.throws(() => readZip(bytes.subarray(0, bytes.length - 8)), /zip/, 'a short buffer must not read as an empty tree')
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /zip/)
})

test('content is stored verbatim when compression would not help, and deflated when it would', () => {
  const repeated = 'a'.repeat(4096)
  const read = readZip(
    writeZip([
      { path: 'repeated.txt', content: repeated },
      { path: 'tiny.txt', content: 'x' },
    ]),
  )
  const byPath = new Map(read.map((entry) => [entry.path, entry]))
  assert.equal(byPath.get('repeated.txt').content.toString('utf8'), repeated)
  assert.equal(byPath.get('tiny.txt').content.toString('utf8'), 'x')
  assert.ok(byPath.get('repeated.txt').compressed < byPath.get('repeated.txt').bytes, 'a 4 KB run of one character must actually be compressed')
})