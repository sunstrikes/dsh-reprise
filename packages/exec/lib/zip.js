/**
 * The container the candidate's tree travels in: a real, deterministic `.zip`.
 *
 * Why hand-written instead of `zip -r` or a dependency: the repo has zero runtime dependencies and
 * must run on a laptop with no `zip` binary, and shelling out would put a process between the packer
 * and the bytes it must hash. The format is small enough to own: stored or deflated entries, no
 * encryption, no zip64 (the packer refuses an archive over `maxBytes` long before 4 GiB).
 *
 * Three properties this module is held to, each guarded by `test/zip.test.js`:
 *
 *  - **Lossless.** Paths, bytes, the executable bit and the digest survive `readZip(writeZip(x))`.
 *    The node-side check and the pre-submit check both read the archive back and compare it with
 *    the tree they packed, so the reader is not a convenience — it is half the verification.
 *  - **Deterministic.** Entries are sorted by path and every timestamp field is a constant, so one
 *    unchanged tree always produces the same bytes. Ray's package store is content-addressed
 *    (`PUT /api/packages/gcs/<name>.zip`), and a name derived from a digest that moved on every
 *    pack would leave a new object per submission.
 *  - **Loud.** A truncated or corrupt archive throws; it never reads back as a smaller tree. A
 *    reader that answered "no entries" for garbage would turn a broken upload into "the candidate
 *    changed nothing".
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** 1980-01-01 00:00, the earliest DOS timestamp. Constant on purpose: see "deterministic" above. */
const DOS_DATE = 0x0021
const DOS_TIME = 0x0000
const UTF8_FLAG = 0x0800
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_END = 0x06054b50
/** Fixed fields of a local file header, before the variable-length name and extra field. */
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const END_RECORD_BYTES = 22

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const digestOf = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** The bytes of one entry's content, whichever way the caller wrote it. */
function contentOf(entry) {
  const value = entry?.content ?? ''
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(String(value), 'utf8')
}

/**
 * Build the archive.
 *
 * @param {{path: string, content?: string|Buffer, mode?: number}[]} entries path is relative to the
 *   package root and uses `/` separators; `mode` defaults to 0o644 and only the executable bit is
 *   preserved (the cluster's umask decides the rest)
 * @returns {Buffer}
 */
export function writeZip(entries = []) {
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const seen = new Set()
  const records = []
  const local = []

  for (const entry of sorted) {
    const path = String(entry?.path ?? '')
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`zip: refusing entry path ${JSON.stringify(path)} — a package path must stay inside its root`)
    }
    if (seen.has(path)) throw new Error(`zip: duplicate entry ${path}`)
    seen.add(path)

    const content = contentOf(entry)
    const name = Buffer.from(path, 'utf8')
    const deflated = deflateRawSync(content, { level: 9 })
    // A tiny or already-compressed file grows under deflate; storing it is smaller and just as valid.
    const method = deflated.length < content.length ? METHOD_DEFLATE : METHOD_STORED
    const body = method === METHOD_DEFLATE ? deflated : content
    const crc = crc32(content)

    const header = Buffer.alloc(LOCAL_HEADER_BYTES)
    header.writeUInt32LE(SIGNATURE_LOCAL, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(UTF8_FLAG, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)

    records.push({ name, method, crc, compressed: body.length, bytes: content.length, mode: entry?.mode ?? 0o644 })
    local.push(header, name, body)
  }

  const localBytes = Buffer.concat(local)
  const central = []
  let offset = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const header = Buffer.alloc(CENTRAL_HEADER_BYTES)
    header.writeUInt32LE(SIGNATURE_CENTRAL, 0)
    header.writeUInt16LE(0x031e, 4) // made by: unix, zip 3.0 — `unzip` keeps the mode bits because of this
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(UTF8_FLAG, 8)
    header.writeUInt16LE(record.method, 10)
    header.writeUInt16LE(DOS_TIME, 12)
    header.writeUInt16LE(DOS_DATE, 14)
    header.writeUInt32LE(record.crc, 16)
    header.writeUInt32LE(record.compressed, 20)
    header.writeUInt32LE(record.bytes, 24)
    header.writeUInt16LE(record.name.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attributes
    const executable = (record.mode & 0o111) !== 0
    header.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, record.name)
    offset += LOCAL_HEADER_BYTES + record.name.length + record.compressed
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(END_RECORD_BYTES)
  end.writeUInt32LE(SIGNATURE_END, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(records.length, 8)
  end.writeUInt16LE(records.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localBytes.length, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([localBytes, centralBytes, end])
}

function findEndRecord(buffer) {
  // The record is the last 22 bytes unless an archive comment follows it. Our writer emits none, and
  // tolerating a comment here would mean trusting a length we never checked.
  const start = buffer.length - END_RECORD_BYTES
  if (start < 0 || buffer.readUInt32LE(start) !== SIGNATURE_END) {
    throw new Error('zip: not a zip archive (no end-of-central-directory record at the end of the buffer)')
  }
  return start
}

/**
 * Read an archive back. This is what turns "we uploaded something" into "we can say what the node
 * received": every entry comes back with its digest, so a comparison with the tree that was packed
 * is a comparison of facts rather than of file sizes.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{path: string, content: Buffer, bytes: number, compressed: number, sha256: string, mode: number,
 *   executable: boolean}[]} entries in central-directory order
 */
export function readZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const end = findEndRecord(buffer)
  const count = buffer.readUInt16LE(end + 10)
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralOffset = buffer.readUInt32LE(end + 16)
  if (centralOffset + centralSize > end) {
    throw new Error('zip: the central directory points past the end of the buffer — the archive is truncated')
  }

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > end || buffer.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) {
      throw new Error(`zip: central directory entry ${index} is missing or corrupt`)
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const bytes = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const external = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const path = buffer.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength).toString('utf8')

    if (localOffset + LOCAL_HEADER_BYTES > buffer.length || buffer.readUInt32LE(localOffset) !== SIGNATURE_LOCAL) {
      throw new Error(`zip: ${path} has no local header`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength
    const dataEnd = dataStart + compressed
    if (dataEnd > buffer.length) throw new Error(`zip: ${path} extends past the end of the buffer`)

    const raw = buffer.subarray(dataStart, dataEnd)
    let content
    if (method === METHOD_STORED) content = Buffer.from(raw)
    else if (method === METHOD_DEFLATE) {
      try {
        content = inflateRawSync(raw)
      } catch (error) {
        throw new Error(`zip: ${path} does not inflate (${error?.message ?? error})`)
      }
    } else throw new Error(`zip: ${path} uses unsupported compression method ${method}`)

    if (content.length !== bytes) throw new Error(`zip: ${path} inflated to ${content.length} bytes, expected ${bytes}`)
    if (crc32(content) !== crc) throw new Error(`zip: ${path} failed its CRC check`)

    const mode = external >>> 16
    entries.push({
      path,
      content,
      bytes,
      compressed,
      sha256: digestOf(content),
      mode: mode === 0 ? 0o644 : mode & 0o777,
      executable: mode !== 0 && (mode & 0o111) !== 0,
    })
    cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength
  }
  return entries
}

/** The digest a package name is built from: the archive bytes themselves. */
export function digestOfArchive(bytes) {
  return digestOf(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
}