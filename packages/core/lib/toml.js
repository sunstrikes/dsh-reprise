/**
 * The run configuration reader: a TOML subset, refused by name wherever it stops.
 *
 * Why this exists. ADR 0002 gives every run its own `<run>/reprise.toml`, because the person who
 * edits it is a person: comments, no mandatory quotes, and one audit list written over four lines
 * without a trailing-comma trap. `JSON.parse` cannot read that, so a JSON-only run configuration is a
 * configuration edited by a script — which is how a run's declaration drifts from what it runs.
 *
 * The subset is the shape a run's configuration actually has; the refusals are the rest of TOML, and
 * that asymmetry is the point. This reader may not *approximate*: a config that reads as something
 * else than what was typed — a datetime quietly becoming the string `"1979-05-27"`, `[[job]]` quietly
 * keeping only the last table — is the one failure this repository will not have. So every construct
 * outside the subset comes back as a problem naming the construct, the line, and what to write
 * instead. There is no "close enough" branch in this file.
 *
 * What it reads: comments; bare, quoted and dotted keys; `[table]` and `[a.b]` headers; basic strings
 * with `\" \\ \n \t \r \uXXXX`; literal strings; integers (with `_` separators) and floats; booleans;
 * arrays (multiline, trailing comma allowed, comments between elements); inline tables. Empty or
 * comment-only input is `{}`.
 *
 * Three deliberate deviations, stated rather than implied:
 *
 *   - **Inline tables nest, but stay on one line and take no trailing comma.** Nesting is kept because
 *     `JSON.stringify` of a real configuration is exactly that shape, so every JSON value a
 *     `config_file` may hold is also a legal value here (the round trip in `test/toml.test.js` is that
 *     claim). What is *not* kept is a header reopening one: `runner = { … }` and `[runner]` describe
 *     one table, and refusing the second is the duplicate rule rather than a matter of taste.
 *   - **A dotted key creates the tables it names, and a later header may not reopen one of them**
 *     (`a.b = 1` then `[a]` is refused) — TOML agrees. A header may still define a super-table that an
 *     earlier header created implicitly (`[a.b]` then `[a]`); that is the one order-free case.
 *   - **No `inf`/`nan`, no hex/octal/binary integers, no leading zeros, no `\b`/`\f`/`\/` escapes.**
 *     Each is refused by name rather than coerced to the nearest JS value: `0x10` read as `0` is a run
 *     configured differently from what its file says.
 *
 * Two properties the caller relies on. It is **pure** — text in, value out, no `node:fs` and nothing
 * remembered between calls, so reading the file stays the caller's decision (`run-config.js` may hand
 * this reader JSON text or TOML text and, for these value types, cannot tell which it got). And every
 * value it returns is a **plain JS value**: `Object`, `Array`, `string`, `number`, `boolean`, with keys
 * installed as own properties, so a file that says `__proto__ = "x"` gets a key of that name and not a
 * changed prototype.
 *
 * @module
 */

const BARE_KEY = /^[A-Za-z0-9_-]+/
const IS_BARE = /^[A-Za-z0-9_-]+$/
const DECIMAL = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/
const FLOAT_FRACTION = /^[+-]?(?:0|[1-9](?:_?[0-9])*)\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/
const FLOAT_EXPONENT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)[eE][+-]?[0-9](?:_?[0-9])*$/
const LEADING_ZERO = /^[+-]?0[0-9]/
const RADIX_INTEGER = /^[+-]?0[xob]/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d/
const TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const NON_FINITE = /^[+-]?(?:inf|nan)$/i

/** Where a bare word ends: a value at the start of a line stops at the end of it or at a delimiter. */
const SCALAR_END = new Set(['\n', '\r', '#', ',', ']', '}'])

/** How each recorded definition is named in a duplicate refusal. */
const DEFINITION = {
  value: 'the value',
  inline: 'the inline value',
  table: 'the table header',
  'implicit-header': 'a table header',
  'implicit-dotted': 'a dotted key',
}

/**
 * A refusal travels as an exception so every value parser stays a plain expression, and carries
 * `fatal`: whether the scan can still be trusted afterwards. A refusal inside a value can normally not
 * be trusted — the rest of a multiline array would be read as document entries — while a duplicate
 * key, or a bad scalar that ended at the end of its line, only costs that one line and is worth
 * reporting alongside the next mistake.
 */
class TomlRefusal extends Error {
  constructor(problem, fatal) {
    super(problem)
    this.name = 'TomlRefusal'
    this.problem = problem
    this.fatal = fatal
  }
}

/** A key installed as an own property, so `__proto__` in a file stays a key instead of a prototype. */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/** What a value is, for the duplicate registry: a plain object can only have come from `{ … }`. */
function kindOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? 'inline' : 'value'
}

/**
 * Read one TOML document into a plain object.
 *
 * Refusals come back as `problems`, one sentence each: the construct, the line, and what to write
 * instead. Reading stops after the first problem the scan cannot recover from, so a file with one
 * unterminated string reports one problem rather than every line that followed it; a file with two
 * independent mistakes usually reports both.
 *
 * @param {string} text the file's whole text — a `Buffer` is `toString('utf8')`'d by the caller, not here
 * @returns {{ok: true, value: object} | {ok: false, problems: string[]}}
 * @throws {TypeError} when `text` is not text at all (a caller bug, not a configuration problem)
 */
export function parseToml(text) {
  if (typeof text !== 'string') {
    throw new TypeError(
      `parseToml reads a document as text (got ${text === null ? 'null' : typeof text}) — read the file, then hand it over`,
    )
  }

  const source = text
  const problems = []
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }

  /** The 1-based line a character offset sits on. */
  function lineAt(offset) {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }

  let at = 0
  const root = {}
  /** The table `key = value` lines belong to — the last header read. */
  let path = []
  /** Every definition in the document, by absolute path: the one owner of "already written". */
  const assigned = new Map()
  /** How many value parses are in progress: a refusal is fatal while one is, recoverable otherwise. */
  let depth = 0

  const keyOf = (segments) => JSON.stringify(segments)
  const here = () => (at >= source.length ? 'the end of the file' : JSON.stringify(source[at]))

  /** `a.b` for messages: bare segments as typed, anything else quoted, so a refusal is greppable. */
  function display(segments) {
    return segments.map((segment) => (IS_BARE.test(segment) ? segment : JSON.stringify(segment))).join('.')
  }

  /**
   * A refusal is recoverable where the scan is still standing on something it can resume from, which is
   * exactly when no value parse is in progress; the constructs that swallow the lines below them (an
   * array of tables, a header nobody closed) say `fatal: true` for themselves.
   */
  function refuse(problem, { fatal = depth > 0 } = {}) {
    throw new TomlRefusal(problem, fatal)
  }

  function skipInlineSpace() {
    while (at < source.length && (source[at] === ' ' || source[at] === '\t')) at += 1
  }

  function skipToEndOfLine() {
    while (at < source.length && source[at] !== '\n') at += 1
  }

  /** Whitespace of every kind and comments: the gap between entries, and between array elements. */
  function skipBlanks() {
    for (;;) {
      const ch = source[at]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        at += 1
        continue
      }
      if (ch === '#') {
        skipToEndOfLine()
        continue
      }
      return
    }
  }

  // ------------------------------------------------------------------ keys

  function readKeySegment() {
    const ch = source[at]
    if (ch === '"') return readBasicString(lineAt(at))
    if (ch === "'") return readLiteralString(lineAt(at))
    const match = BARE_KEY.exec(source.slice(at))
    if (match === null) {
      refuse(
        `key (line ${lineAt(at)}): expected one and found ${here()} — a key is bare (letters, digits, ` +
          '"_" and "-"), "quoted", or dotted (a.b.c)',
      )
    }
    at += match[0].length
    return match[0]
  }

  function readKeyPath() {
    const segments = []
    for (;;) {
      skipInlineSpace()
      segments.push(readKeySegment())
      skipInlineSpace()
      if (source[at] !== '.') return segments
      at += 1
    }
  }

  // ------------------------------------------------------------- the registry

  /**
   * Walk `segments` from `container`, creating the tables a dotted key or a header names, and answer
   * the object the last one lands in. `base` is `container`'s absolute path, and `what` names the
   * construct in the message, so a refusal can point at the other definition instead of at a symptom.
   *
   * `implicit` says *who* creates a missing table, because that decides whether a later header may
   * claim it: a header's ancestors are open to a super-table header, a dotted key's are not (TOML
   * agrees — `a.b = 1` then `[a]` is a duplicate, `[a.b]` then `[a]` is not).
   */
  function descend(container, base, segments, line, what, implicit = 'implicit-dotted') {
    let node = container
    let walked = base
    for (const segment of segments) {
      walked = [...walked, segment]
      const existing = assigned.get(keyOf(walked))
      if (existing === undefined) {
        const child = {}
        setOwn(node, segment, child)
        assigned.set(keyOf(walked), { kind: implicit, line })
        node = child
        continue
      }
      if (existing.kind === 'value' || existing.kind === 'inline') {
        refuse(
          `${what}: it walks through "${display(walked)}", which is ` +
            `${existing.kind === 'inline' ? 'an inline value' : 'a value'} (line ${existing.line}) — a key is a value ` +
            'or a table, never both; rename one of the two',
        )
      }
      node = Object.getOwnPropertyDescriptor(node, segment).value
    }
    return node
  }

  /**
   * Where one entry lands: the object its last key segment is written into, with the path already
   * refused. The value is read *after* this call on purpose — a path that may not be defined has no
   * business being parsed, because the inline tables inside it would register definitions that are
   * then thrown away, and the next refusal would quote a line that never became a value.
   */
  function seat(container, base, relative, line, what) {
    const absolute = [...base, ...relative]
    const parent = descend(container, base, relative.slice(0, -1), line, what)
    const existing = assigned.get(keyOf(absolute))
    if (existing !== undefined) refuse(duplicateProblem(absolute, existing, line))
    return { parent, absolute, leaf: relative[relative.length - 1] }
  }

  function write(seated, value, line) {
    setOwn(seated.parent, seated.leaf, value)
    assigned.set(keyOf(seated.absolute), { kind: kindOf(value), line })
    return value
  }

  /** One key, one place: the whole duplicate rule, phrased so the reader can delete the right line. */
  function duplicateProblem(segments, existing, line) {
    const name = display(segments)
    const before =
      existing.kind === 'table' || existing.kind === 'implicit-header'
        ? `the table header [${name}] at line ${existing.line}`
        : `${DEFINITION[existing.kind]} at line ${existing.line}`
    return (
      `duplicate key "${name}" (line ${line}): already defined by ${before} — a key is written once; ` +
      'delete one of the two, or rename one'
    )
  }

  function claimTable(segments, line) {
    const what = `table header [${display(segments)}] (line ${line})`
    const parent = descend(root, [], segments.slice(0, -1), line, what, 'implicit-header')
    const existing = assigned.get(keyOf(segments))
    if (existing !== undefined) {
      // `[a.b]` then `[a]`: the super-table is being defined after its child, which is legal and the
      // only case where the order of two headers is free. The object is already in the tree; only its
      // record changes.
      if (existing.kind === 'implicit-header') {
        assigned.set(keyOf(segments), { kind: 'table', line })
        path = segments
        return
      }
      refuse(headerConflict(segments, line, existing))
    }
    setOwn(parent, segments[segments.length - 1], {})
    assigned.set(keyOf(segments), { kind: 'table', line })
    path = segments
  }

  /** A header that cannot have the table it asks for, in the three ways that happen. */
  function headerConflict(segments, line, existing) {
    const what = `table header [${display(segments)}] (line ${line})`
    if (existing.kind === 'table' || existing.kind === 'implicit-dotted') {
      const creator = existing.kind === 'table' ? 'a header' : 'a dotted key'
      return (
        `duplicate ${what}: the table was already defined by ${creator} at line ${existing.line} — one header per ` +
        `table; write every key of "${display(segments)}" under that one header, or delete this one`
      )
    }
    if (existing.kind === 'inline') {
      return (
        `${what}: an inline value at the same path was set at line ${existing.line} — write either ` +
        `"${display(segments)} = { … }" or "[${display(segments)}]" with its keys underneath, never both`
      )
    }
    return (
      `${what}: redefines the value "${display(segments)}" set at line ${existing.line} — a key is a value or a ` +
      'table, never both; rename the value or the table'
    )
  }

  // ---------------------------------------------------------------- values

  function readValue(base) {
    skipInlineSpace()
    const line = lineAt(at)
    const ch = source[at]
    depth += 1
    try {
      if (ch === undefined || ch === '\n' || ch === '\r' || ch === '#') {
        refuse(`value (line ${line}): "=" is followed by ${here()} — every entry is "key = value"`)
      }
      if (ch === '"') {
        if (source.startsWith('"""', at)) {
          refuse(
            `multiline basic string """ (line ${line}): refused by name — write a single-line "..." string with ` +
              '\\n inside it, or one string per line',
          )
        }
        return readBasicString(line)
      }
      if (ch === "'") {
        if (source.startsWith("'''", at)) {
          refuse(
            `multiline literal string ''' (line ${line}): refused by name — write a single-line '...' string, or ` +
              'one string per line',
          )
        }
        return readLiteralString(line)
      }
      if (ch === '[') return readArray(base, line)
      if (ch === '{') return readInlineTable(base, line)
      return readScalar(line)
    } finally {
      depth -= 1
    }
  }

  function readBasicString(line) {
    at += 1
    let out = ''
    for (;;) {
      if (at >= source.length || source[at] === '\n') {
        refuse(
          `unterminated string (line ${line}): the "..." opened here is still open at the end of the line — ` +
            'close it with " on the same line, or write one string per line',
        )
      }
      const ch = source[at]
      if (ch === '"') {
        at += 1
        return out
      }
      if (ch !== '\\') {
        out += ch
        at += 1
        continue
      }
      const escape = source[at + 1]
      const escapeAt = at
      at += 2
      if (escape === '"' || escape === '\\') {
        out += escape
        continue
      }
      if (escape === 'n' || escape === 't' || escape === 'r') {
        out += escape === 'n' ? '\n' : escape === 't' ? '\t' : '\r'
        continue
      }
      if (escape === 'u') {
        const hex = source.slice(at, at + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          const digits = source.slice(at).split(/[^0-9a-fA-F]/)[0]
          refuse(
            `\\u escape (line ${lineAt(escapeAt)}): ${JSON.stringify(`\\u${digits}`)} is not four hexadecimal ` +
              'digits — write \\uXXXX (four of them), or the character itself',
          )
        }
        out += String.fromCharCode(Number.parseInt(hex, 16))
        at += 4
        continue
      }
      refuse(
        `escape ${JSON.stringify(`\\${escape ?? ''}`)} (line ${lineAt(escapeAt)}): not one this reader accepts — ` +
          'it reads \\" \\\\ \\n \\t \\r and \\uXXXX; write the character itself for anything else',
      )
    }
  }

  function readLiteralString(line) {
    at += 1
    const start = at
    for (;;) {
      if (at >= source.length || source[at] === '\n') {
        refuse(
          `unterminated string (line ${line}): the '...' opened here is still open at the end of the line — ` +
            "close it with ' on the same line",
        )
      }
      if (source[at] === "'") {
        const out = source.slice(start, at)
        at += 1
        return out
      }
      at += 1
    }
  }

  function readArray(base, line) {
    // One sentence for every way this array ends without its "]", because it is one mistake.
    const unclosed =
      `unterminated array (line ${line}): "[" was opened here and is not closed — add "]" after the last element`
    at += 1
    const items = []
    for (;;) {
      skipBlanks()
      if (at >= source.length) refuse(unclosed)
      if (source[at] === ']') {
        at += 1
        return items
      }
      // `#0`, `#1`, …: a segment no key can produce, so an inline table inside an array cannot collide
      // with a key of the same name.
      items.push(readValue([...base, `#${items.length}`]))
      skipBlanks()
      if (source[at] === ',') {
        at += 1
        continue
      }
      if (source[at] === ']') {
        at += 1
        return items
      }
      refuse(
        at >= source.length
          ? unclosed
          : `unterminated array (line ${line}): ${here()} where "," or "]" was expected — the array opened here is ` +
              'not closed',
      )
    }
  }

  function readInlineTable(base, line) {
    // An inline table may not span lines, so every way it can end without its "}" is one mistake: the
    // line ended first.
    const unclosed =
      `unterminated inline table (line ${line}): "{" was opened here and is not closed on this line — write ` +
      '"{ key = value }" on one line, or give it a "[section]" header'
    at += 1
    const table = {}
    skipInlineSpace()
    if (source[at] === '}') {
      at += 1
      return table
    }
    for (;;) {
      skipInlineSpace()
      if (at >= source.length || source[at] === '\n' || source[at] === '\r') refuse(unclosed)
      const entryLine = lineAt(at)
      const segments = readKeyPath()
      skipInlineSpace()
      if (source[at] !== '=') {
        refuse(
          `key "${display(segments)}" (line ${entryLine}): no "=" after it inside the inline table opened at line ` +
            `${line} — every entry is "key = value"`,
        )
      }
      at += 1
      const seated = seat(
        table,
        base,
        segments,
        entryLine,
        `inline key "${display([...base, ...segments])}" (line ${entryLine})`,
      )
      write(seated, readValue([...base, ...segments]), entryLine)
      skipInlineSpace()
      if (source[at] === ',') {
        at += 1
        skipInlineSpace()
        if (source[at] === '}') {
          refuse(
            `trailing comma (line ${lineAt(at)}): the inline table opened at line ${line} ends with "," — TOML ` +
              'allows a trailing comma in an array, not in an inline table; delete it',
          )
        }
        continue
      }
      if (source[at] === '}') break
      refuse(
        at >= source.length || source[at] === '\n' || source[at] === '\r'
          ? unclosed
          : `unterminated inline table (line ${line}): ${here()} where "," or "}" was expected — the table opened ` +
              'here is not closed',
      )
    }
    at += 1
    return table
  }

  function readScalar(line) {
    const start = at
    while (at < source.length && !SCALAR_END.has(source[at])) at += 1
    const raw = source.slice(start, at).trim()
    // A bare word ends at the end of its line, an element delimiter, or the end of the file. Only the
    // first and last of those leave the scan standing somewhere it can resume, so only those keep
    // reading: a bad value inside `[ … ]` would otherwise have its array read as document entries.
    const endedLine = at >= source.length || source[at] === '\n' || source[at] === '\r' || source[at] === '#'
    const outsideSubset = (kind, suggestion) =>
      refuse(
        `${kind} "${raw}" (line ${line}): refused by name, because this reader has no such type — ${suggestion}`,
        { fatal: !endedLine },
      )

    if (raw === '') refuse(`value (line ${line}): expected one and found ${here()} — every entry is "key = value"`)
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (DATE_TIME.test(raw)) return outsideSubset('datetime', `write it as a string ("${raw}") and let the run parse it`)
    if (DATE.test(raw)) return outsideSubset('date', `write it as a string ("${raw}") and let the run parse it`)
    if (TIME.test(raw)) return outsideSubset('time', `write it as a string ("${raw}") and let the run parse it`)
    if (NON_FINITE.test(raw)) {
      return outsideSubset('float', `write a finite number, or the string "${raw}" if that is what it means`)
    }
    if (RADIX_INTEGER.test(raw)) return outsideSubset('integer', 'write it in decimal, with "_" separators if it is long')
    if (LEADING_ZERO.test(raw)) return outsideSubset('integer', 'drop the leading zero — "0123" is not a number, nor in TOML')
    if (DECIMAL.test(raw)) return Number(raw.replace(/_/g, ''))
    if (FLOAT_FRACTION.test(raw) || FLOAT_EXPONENT.test(raw)) return Number(raw.replace(/_/g, ''))
    return refuse(
      `value "${raw}" (line ${line}): not a value this reader accepts — write a number (12, 1_000, 0.5, 1e-3), ` +
        'true or false (lowercase), a "quoted string", an array, or an inline table',
      { fatal: !endedLine },
    )
  }

  // ------------------------------------------------------------- the document

  function readTableHeader() {
    const line = lineAt(at)
    if (source.startsWith('[[', at)) {
      // Fatal rather than recoverable: the keys that follow belong to a table this subset does not
      // have, so continuing would report them as duplicates of the previous `[[…]]` block — a problem
      // nobody wrote, on a line that is not the mistake.
      refuse(
        `array of tables [[…]] (line ${line}): refused by name, because this reader has one array per key and no ` +
          'repeated-table form — write "key = [{ … }, { … }]" instead',
        { fatal: true },
      )
    }
    at += 1
    skipInlineSpace()
    const segments = readKeyPath()
    skipInlineSpace()
    if (source[at] !== ']') {
      refuse(
        `unterminated table header [${display(segments)}] (line ${line}): "[" was opened here and is not closed — ` +
          `write "[${display(segments)}]" on one line`,
        { fatal: true },
      )
    }
    at += 1
    skipInlineSpace()
    if (source[at] === '#') skipToEndOfLine()
    if (at < source.length && source[at] !== '\n' && source[at] !== '\r') {
      refuse(
        `table header [${display(segments)}] (line ${line}): ${here()} follows the closing "]" — nothing but a ` +
          'comment may follow a header; put the table\'s keys on the following lines',
        { fatal: false },
      )
    }
    claimTable(segments, line)
  }

  function readKeyValue() {
    const line = lineAt(at)
    const segments = readKeyPath()
    skipInlineSpace()
    if (source[at] !== '=') {
      refuse(
        `key "${display(segments)}" (line ${line}): no "=" after it — every entry is "key = value"; a table is a ` +
          `"[${display(segments)}]" header on its own line`,
        { fatal: false },
      )
    }
    at += 1
    const absolute = [...path, ...segments]
    const seated = seat(root, [], absolute, line, `key "${display(absolute)}" (line ${line})`)
    write(seated, readValue(absolute), line)
    skipInlineSpace()
    if (source[at] === '#') skipToEndOfLine()
    if (at < source.length && source[at] !== '\n' && source[at] !== '\r') {
      refuse(
        `key "${display(absolute)}" (line ${lineAt(at)}): ${here()} follows the value — one entry per line; arrays ` +
          'and inline tables are what may span lines',
        { fatal: false },
      )
    }
  }

  for (;;) {
    skipBlanks()
    if (at >= source.length) break
    try {
      if (source[at] === '[') readTableHeader()
      else if (source[at] === '{') {
        refuse(
          `document root (line ${lineAt(at)}): the file opens with an inline table "{ … }", which is a value, not a ` +
            'document — write "key = value" lines and "[section]" headers',
          { fatal: false },
        )
      } else readKeyValue()
    } catch (error) {
      if (!(error instanceof TomlRefusal)) throw error
      problems.push(error.problem)
      if (!error.fatal) {
        skipToEndOfLine()
        continue
      }
      break
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, value: root }
}