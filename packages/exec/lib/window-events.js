/**
 * Reading a tensorboard event file: TFRecord framing and the handful of protobuf fields a scalar
 * summary lives in.
 *
 * This lives beside the executor adapters rather than in the kernel because it is *a way of reading a
 * medium*, not a rule about runs: the kernel is handed windowed samples and never learns what a
 * tensorboard file is. The same split as `platform.js` — the shape is the contract, the parse is the
 * adapter.
 *
 * Two mechanical reasons it is written by hand rather than with a library:
 *
 *  - this repository has zero runtime dependencies, and a tensorboard reader is 150 lines once the
 *    format is stated;
 *  - the *failures* are the interesting part. A clipped log, a byte changed in transit and a file
 *    that holds only its `file_version` record must each be reported, by byte offset, instead of
 *    yielding a short series that reads like a complete run.
 *
 * The format, in full, because everything below is a consequence of it:
 *
 * ```
 * file    := record*
 * record  := length:uint64le, length_crc:uint32le, payload:bytes[length], payload_crc:uint32le
 * ```
 *
 * with both CRCs the masked CRC32C of the bytes they protect. `payload` is a protobuf `Event`:
 * field 1 `wall_time` (double), field 2 `step` (varint), field 5 `summary` (Summary), field 10
 * `source_metadata`. `Summary` holds repeated field 1 `Value`; a `Value` holds field 1 `tag`
 * (string), field 2 `simple_value` (float) and field 3 `step` (varint).
 *
 * Only `simple_value` scalars are read. A tensor-valued scalar (`Value.tensor`, field 8) is a
 * different measurement shape and is skipped rather than guessed at — see `readScalarPoints`.
 *
 * @module
 */

/** Reflected Castagnoli polynomial (CRC-32C), the one TFRecord uses. */
const CRC32C_POLY = 0x82f63b78

/** Built once, deterministically: a table generated at load is a constant, not a clock. */
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (CRC32C_POLY ^ (value >>> 1)) >>> 0 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32C of a byte range, as an unsigned 32-bit integer. */
export function crc32c(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ bytes[index]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** TFRecord stores `crc32c` rotated and offset, so that 0 is not a plausible checksum. */
const masked = (crc) => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) % 2 ** 32

/** A parse refusal. `error_class: 'data'` is the platform port's word for "the world gave us garbage". */
function refused(reason) {
  return { ok: false, error_class: 'data', reason }
}

/**
 * Split a buffer into TFRecord payloads, checking both checksums.
 *
 * A shortened file is the case this exists for: the driver log holds a base64 of the event file, and
 * a clipped line decodes to a buffer that ends mid-record. Framing catches it at a byte offset, and
 * the payload checksum catches the other shape — a record whose bytes changed but whose framing
 * survived.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {{ ok: true, records: Buffer[] } | { ok: false, error_class: 'data', reason: string }}
 */
export function readEventRecords(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)
  const records = []
  let offset = 0

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      return refused(
        `the event file ends mid-record: a record starting at byte ${offset} has no complete length header (the file holds ${buffer.length - offset} more byte(s)) — a truncated payload is a data failure, not a short result`,
      )
    }

    const length = Number(buffer.readBigUInt64LE(offset))
    if (!Number.isSafeInteger(length)) {
      return refused(`the record at byte ${offset} claims an unreadable length (${length}) — the file is not a TFRecord stream`)
    }
    const lengthCrc = buffer.readUInt32LE(offset + 8)
    if (masked(crc32c(buffer.subarray(offset, offset + 8))) !== lengthCrc) {
      return refused(`the record at byte ${offset} failed its length checksum — the bytes changed between the job and here`)
    }

    const payloadStart = offset + 12
    const payloadEnd = payloadStart + length
    if (payloadEnd + 4 > buffer.length) {
      return refused(
        `the event file ends mid-record: the record at byte ${offset} claims ${length} payload byte(s) but only ${Math.max(0, buffer.length - payloadStart)} are here — a truncated payload is a data failure, not a short result`,
      )
    }

    const payload = buffer.subarray(payloadStart, payloadEnd)
    const payloadCrc = buffer.readUInt32LE(payloadEnd)
    if (masked(crc32c(payload)) !== payloadCrc) {
      return refused(`the record at byte ${offset} failed its payload checksum — the bytes changed between the job and here`)
    }

    records.push(payload)
    offset = payloadEnd + 4
  }

  return { ok: true, records }
}

/**
 * Decode one protobuf message into its fields, without knowing its schema.
 *
 * Unknown fields are skipped by wire type, which is what keeps this reader working when a newer
 * tensorboard writes a field it has never heard of.
 */
function decodeFields(bytes) {
  const fields = []
  let offset = 0
  while (offset < bytes.length) {
    let key
    ;[key, offset] = readVarint(bytes, offset)
    if (key === undefined) return refused(`a protobuf field header at byte ${offset} is not readable`)
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) {
      let value
      ;[value, offset] = readVarint(bytes, offset)
      if (value === undefined) return refused(`a varint field at byte ${offset} is not readable`)
      fields.push({ field, wire, value })
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) return refused(`a fixed64 field at byte ${offset} runs past the record`)
      fields.push({ field, wire, double: bytes.readDoubleLE(offset) })
      offset += 8
    } else if (wire === 2) {
      let length
      ;[length, offset] = readVarint(bytes, offset)
      if (length === undefined) return refused(`a length-delimited field at byte ${offset} is not readable`)
      if (offset + length > bytes.length) return refused(`a length-delimited field at byte ${offset} claims ${length} bytes and runs past the record`)
      fields.push({ field, wire, bytes: bytes.subarray(offset, offset + length) })
      offset += length
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) return refused(`a fixed32 field at byte ${offset} runs past the record`)
      fields.push({ field, wire, float: bytes.readFloatLE(offset) })
      offset += 4
    } else {
      // Groups (3/4) were removed from protobuf and never appear in an event record; anything else
      // means the framing and the payload disagree, which is worth saying out loud.
      return refused(`a protobuf field at byte ${offset} uses wire type ${wire}, which an event record cannot contain`)
    }
  }
  return { ok: true, fields }
}

function readVarint(bytes, offset) {
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < bytes.length) {
    const byte = bytes[cursor]
    value += (byte & 0x7f) * 2 ** shift
    cursor += 1
    if ((byte & 0x80) === 0) return [value, cursor]
    shift += 7
    if (shift > 63) return [undefined, offset]
  }
  return [undefined, offset]
}

/** The first field with this number, or `undefined`. */
const fieldOf = (fields, number) => fields.find((entry) => entry.field === number)

/**
 * Every scalar summary point in the records, in file order.
 *
 * A point is `{ tag, step, value }`. `step` is the summary value's own step when it carries one and
 * the event's step otherwise — torch and tensorflow differ about where they put it, and a reader
 * that picked one would silently report every point of one of them at step 0.
 *
 * A tag-less value is skipped: it names no metric, so there is nothing to report it under.
 *
 * @param {Buffer[]} records
 */
export function readScalarPoints(records) {
  /** @type {Array<{ tag: string, step: number, value: number }>} */
  const points = []
  let summaries = 0

  for (const [position, record] of records.entries()) {
    const event = decodeFields(record)
    if (!event.ok) return refused(`event record ${position}: ${event.reason}`)

    const summaryField = fieldOf(event.fields, 5)
    if (summaryField?.bytes === undefined) continue

    const eventStep = fieldOf(event.fields, 2)?.value ?? 0
    const summary = decodeFields(summaryField.bytes)
    if (!summary.ok) return refused(`event record ${position}: ${summary.reason}`)

    for (const valueField of summary.fields.filter((entry) => entry.field === 1 && entry.wire === 2)) {
      summaries += 1
      const value = decodeFields(valueField.bytes)
      if (!value.ok) return refused(`event record ${position}: ${value.reason}`)
      const tag = fieldOf(value.fields, 1)?.bytes?.toString('utf8')
      if (typeof tag !== 'string' || tag.trim() === '') continue
      const simple = fieldOf(value.fields, 2)
      // A tensor-valued scalar is a different measurement shape; skipping it is honest, inventing a
      // number for it is not.
      if (simple?.wire !== 5) continue
      const ownStep = fieldOf(value.fields, 3)?.value
      const step = Number.isSafeInteger(ownStep) ? ownStep : eventStep
      points.push({ tag, step, value: simple.float })
    }
  }

  return { ok: true, points, summaries }
}