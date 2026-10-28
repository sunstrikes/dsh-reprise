/**
 * The run configuration reader: the subset it reads, and the TOML it refuses by name.
 *
 * Contract guarded (ADR 0002, "Per-run configuration: `<run>/reprise.toml`"): a run carries its own
 * configuration file, a person edits it, and the reader may not *approximate* — "a config that reads as
 * something else than what was typed is the one failure this repository will not have". So every test
 * below is one of two things:
 *
 *   - **a document that must read exactly as typed** — nested tables, arrays with `{candidate}`
 *     placeholders, inline tables, comments in every gap, `_` separators, escapes — asserted on the
 *     object, not on a stringified echo of it;
 *   - **a construct that must come back as a problem naming the construct and the line**, because the
 *     alternative is a run configured differently from what its file says. The refusals asserted here
 *     are the ones ADR 0002 lists: datetimes/dates/times, `[[array of tables]]`, multiline `"""` and
 *     `'''` strings, duplicate keys (of every kind, including a header redefining a value and a key
 *     already owned by an earlier header), a key without `=`, an unterminated string/array/table, a
 *     table header after an inline value at the same path, and a document root that is not a table.
 *
 * The last tests are the ones that keep `config_file` honest. They assert that the reader is *not* a
 * vocabulary of its own: every JSON value for these types is a legal TOML value, so a `reprise.toml`
 * and a `run.json` can hold the same configuration and neither surface is the odd one out. Precisely:
 * `"…"`, `12`, `0.5`, `1e-7`, `true` and `[ … ]` are JSON's own bytes unchanged, and a JSON object is
 * TOML's inline table once its `:` are `=`. A whole JSON *document* is not TOML (its separators are
 * wrong and an object at the root is not a table), so the round trip writes headers and hands every
 * value through JSON — the bytes are then JSON's, and the reader has to give the object back.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseToml } from '../lib/toml.js'

/** The configuration a real run ships: every construct the subset has, in the order a person writes it. */
const RUN_TOML = `# reprise.toml — one exploration run, edited by a person rather than a script.
domain = "generative-recommenders"
rounds = 3
budget_gpu_hours = 4_000
seed = 0.5
runner = { kind = "local", root_dir = "jobs" }   # an inline table, one line

[executor]
kind = "ray"
base_url = "http://127.0.0.1:8265"
gpus_per_job = 0.5

[model]
kind = "dsh"
timeout_s = 900
note = 'no escapes here: C:\\models\\v4 is literal'

[candidate]
kind = "command"
# the argv the implementer runs inside the worktree, one flag per line
command = [
  "node", "implement.mjs",
  "--candidate", "{candidate}",   # placeholder, filled per candidate
  "--prompt", "{prompt}",
  "--worktree", "{worktree}",
]

[stop]
max_rounds = 12
max_wall_hours = 1.5
on_plateau = true
`

const RUN_CONFIG = {
  domain: 'generative-recommenders',
  rounds: 3,
  budget_gpu_hours: 4_000,
  seed: 0.5,
  runner: { kind: 'local', root_dir: 'jobs' },
  executor: { kind: 'ray', base_url: 'http://127.0.0.1:8265', gpus_per_job: 0.5 },
  model: { kind: 'dsh', timeout_s: 900, note: 'no escapes here: C:\\models\\v4 is literal' },
  candidate: {
    kind: 'command',
    command: [
      'node',
      'implement.mjs',
      '--candidate',
      '{candidate}',
      '--prompt',
      '{prompt}',
      '--worktree',
      '{worktree}',
    ],
  },
  stop: { max_rounds: 12, max_wall_hours: 1.5, on_plateau: true },
}

/**
 * Parse a document that must be refused, and assert the problem names the construct *and* the line.
 *
 * `expected` is a list of patterns all of which one problem must satisfy — a `RegExp` is tested, a
 * string is looked for verbatim (the escape refusals quote backslashes, and a regex for those reads as
 * line noise). An operator with a four-line file wants "what" and "where"; a refusal that says only
 * "unexpected input" makes them diff the file by hand.
 */
function refusedBy(text, ...expected) {
  const result = parseToml(text)
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result.value)}`)
  const matches = (pattern, problem) =>
    typeof pattern === 'string' ? problem.includes(pattern) : pattern.test(problem)
  assert.ok(
    result.problems.some((problem) => expected.every((pattern) => matches(pattern, problem))),
    `no problem matched ${expected.map(String).join(' and ')}; the reader said:\n  ${result.problems.join('\n  ')}`,
  )
  return result.problems
}

// ----------------------------------------------------------- the document it reads

test('a realistic run configuration reads as the object it describes', () => {
  const result = parseToml(RUN_TOML)

  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.deepEqual(result.value, RUN_CONFIG)
})

test('the values it answers are plain: own keys, no prototypes from the input, no arrays mistaken for tables', () => {
  const result = parseToml('a = 1\nb = [1, 2]\n[c]\nd = "x"\n')
  assert.equal(result.ok, true, result.problems?.join('; '))

  assert.deepEqual(Object.keys(result.value), ['a', 'b', 'c'], 'keys are the document order, and only them')
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.equal(Object.getPrototypeOf(result.value.c), Object.prototype)
  assert.ok(Array.isArray(result.value.b))
})

test('a key named __proto__ is stored as a key, not applied to the prototype', () => {
  const result = parseToml('__proto__ = "x"\n[t]\nconstructor = "y"\n')
  assert.equal(result.ok, true, result.problems?.join('; '))

  assert.equal(Object.hasOwn(result.value, '__proto__'), true, 'a file may not reach the prototype chain')
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.equal(Object.hasOwn(result.value.t, 'constructor'), true)
})

test('empty and comment-only input is an empty table, not a refusal', () => {
  for (const text of ['', '\n', '# nothing but this\n\n   # and this\n', '   \t\n']) {
    assert.deepEqual(parseToml(text), { ok: true, value: {} }, JSON.stringify(text))
  }
})

test('a basic string reads the five escapes the subset has', () => {
  const result = parseToml(String.raw`value = "q \"quoted\" b \\ t \t n \n r \r u \u00e9"`)

  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.equal(result.value.value, 'q "quoted" b \\ t \t n \n r \r u é')
})

test('a literal string takes backslashes literally, which is what a Windows path needs', () => {
  const result = parseToml(String.raw`path = 'C:\models\v4\best.pt'`)

  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.equal(result.value.path, 'C:\\models\\v4\\best.pt')
})

test('arrays take a trailing comma and a comment on any line, and inline tables stay on one', () => {
  const result = parseToml(`values = [
  1, # the first
  "two",
  [3, 4],   # nested
]
inline = { a = 1, b = { c = [true, false] } }
`)

  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.deepEqual(result.value, { values: [1, 'two', [3, 4]], inline: { a: 1, b: { c: [true, false] } } })
})

test('numbers: signs, underscores between digits, decimal fractions, exponents', () => {
  const result = parseToml('a = -5\nb = +5\nc = 1_000_000\nd = 1_000.25\ne = 1.5e-3\nf = 6.02e+23\ng = 0\n')

  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.deepEqual(result.value, { a: -5, b: 5, c: 1_000_000, d: 1_000.25, e: 0.0015, f: 6.02e23, g: 0 })
})

test('quoted and dotted keys, including a dot inside a quoted segment', () => {
  const result = parseToml('a."b c".d = 1\n"e.f" = 2\n\'g h\' = 3\n')

  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.deepEqual(result.value, { a: { 'b c': { d: 1 } }, 'e.f': 2, 'g h': 3 })
})

// --------------------------------------------------------------- refused by name

test('a datetime, a date and a time are each refused by name — this reader has no such type', () => {
  refusedBy('a = 1\nd = 1979-05-27T07:32:00Z\n', /^datetime "1979-05-27T07:32:00Z" \(line 2\)/, /as a string/)
  refusedBy('a = 1\nd = 1979-05-27\n', /^date "1979-05-27" \(line 2\)/, /as a string/)
  refusedBy('a = 1\nd = 07:32:00\n', /^time "07:32:00" \(line 2\)/, /as a string/)
})

test('[[array of tables]] is refused by name, with the one-array-per-key form to write instead', () => {
  const problems = refusedBy('[[job]]\nname = "a"\n[[job]]\nname = "b"\n', /^array of tables \[\[…\]\] \(line 1\)/, /key = \[\{ … \}, \{ … \}\]/)

  assert.equal(problems.length, 1, 'the read stops here: the keys that follow belong to a table this subset does not have')
})

test('multiline triple-quoted strings are refused by name, basic and literal', () => {
  refusedBy('s = """\nhello\n"""\n', /^multiline basic string """ \(line 1\)/, /one string per line/)
  refusedBy("s = '''\nhello\n'''\n", /^multiline literal string ''' \(line 1\)/, /one string per line/)
})

test('a duplicate key in one table names the key, both lines, and what to do', () => {
  const problems = refusedBy('[server]\nport = 8080\nport = 9090\n', /^duplicate key "server\.port" \(line 3\)/, /line 2/)

  assert.equal(problems.length, 1)
})

test('a key already owned by an earlier table header is a duplicate, not an overwrite', () => {
  // `[a.b]` already made `a.b` a table, so `b = 1` under `[a]` is the same path twice.
  refusedBy('[a.b]\nc = 1\n[a]\nb = 1\n', /^duplicate key "a\.b" \(line 4\)/, /table header \[a\.b\] at line 1/)
})

test('a table header that redefines a value is refused by name', () => {
  refusedBy('server = "box-1"\n[server]\nport = 1\n', /^table header \[server\] \(line 2\)/, /redefines the value "server"/)
})

test('a repeated table header is refused by name', () => {
  refusedBy('[server]\nport = 1\n[server]\nhost = "x"\n', /^duplicate table header \[server\] \(line 3\)/, /line 1/)
})

test('a key with no "=" says what an entry and what a header look like', () => {
  refusedBy('justakey\n', /^key "justakey" \(line 1\)/, /no "="/, /header/)
  refusedBy('a = 1\n\nb 2\n', /^key "b" \(line 3\)/, /no "="/)
})

test('an unterminated string, array, inline table and table header each name themselves and their line', () => {
  refusedBy('a = 1\nb = "oops\n', /^unterminated string \(line 2\)/, /"/)
  refusedBy('a = 1\nb = [1, 2\n', /^unterminated array \(line 2\)/, /\]/)
  refusedBy('a = 1\nb = { c = 1\n', /^unterminated inline table \(line 2\)/, /\{ key = value \}/)
  refusedBy('a = 1\n[server\nport = 1\n', /^unterminated table header \[server\] \(line 2\)/, /\[server\]/)
})

test('a table header after an inline value at the same path is refused by name', () => {
  refusedBy('runner = { kind = "local" }\n[runner]\nroot_dir = "jobs"\n', /^table header \[runner\] \(line 2\)/, /inline value at the same path was set at line 1/)
})

test('a document root that is not a table is refused by name', () => {
  refusedBy('{ kind = "local", root_dir = "jobs" }\n', /^document root \(line 1\)/, /inline table/)
})

test('a dotted key may not walk through a value, and the refusal names both paths', () => {
  refusedBy('a = { b = 1 }\na.c = 2\n', /^key "a\.c" \(line 2\)/, /walks through "a"/, /inline value \(line 1\)/)
  refusedBy('a = 1\na.b = 2\n', /^key "a\.b" \(line 2\)/, /walks through "a"/, /a value \(line 1\)/)
})

test('a dotted key creates its table, and a later header may not reopen it — but a super-table header may', () => {
  refusedBy('[a]\nb.c = 1\n[a.b]\nd = 2\n', /^duplicate table header \[a\.b\] \(line 3\)/, /dotted key at line 2/)

  // `[a.b]` first, `[a]` second: the super-table is defined after its child, the one order-free case.
  const result = parseToml('[a.b]\nc = 1\n[a]\nd = 2\n')
  assert.equal(result.ok, true, result.problems?.join('; '))
  assert.deepEqual(result.value, { a: { b: { c: 1 }, d: 2 } })
})

test('values outside the subset are refused rather than coerced to the nearest JS number or string', () => {
  refusedBy('a = 1_000\nb = 0x1F\n', /^integer "0x1F" \(line 2\)/, /decimal/)
  refusedBy('a = 0123\n', /^integer "0123" \(line 1\)/, /leading zero/)
  refusedBy('a = inf\n', /^float "inf" \(line 1\)/, /finite/)
  refusedBy('a = True\n', /^value "True" \(line 1\)/, /true or false/)
  refusedBy('a = yes\n', /^value "yes" \(line 1\)/, /quoted string/)
})

test('an escape or an inline-table comma outside the subset is refused by name', () => {
  // The message quotes the escape the way TOML writes it, so the assertion is the text an operator
  // reads back — no regex, and no chance of testing the backslashes instead of the refusal.
  const quoted = (escape) => JSON.stringify(escape)

  refusedBy('a = "x\\by"\n', `escape ${quoted(String.raw`\b`)} (line 1)`, 'uXXXX')
  refusedBy('a = "x\\u12y"\n', `${String.raw`\u`} escape (line 1)`, 'is not four hexadecimal digits')
  refusedBy('a = { b = 1, }\n', /^trailing comma \(line 1\)/, /inline table/)
})

test('a document with two independent mistakes reports both, because an operator fixes one at a time', () => {
  const problems = refusedBy('a = 1\nb = 1979-05-27\nc = 2.5.5\n', /\(line 2\)/)

  assert.equal(problems.length, 2, 'a scalar that ended at its line boundary does not stop the read')
  assert.match(problems[1], /\(line 3\)/)
})

// -------------------------------------- the two surfaces cannot drift: JSON is TOML here

/**
 * One value as TOML text. Scalars and arrays are JSON's bytes verbatim — that is the claim being
 * tested — while an object is an inline table, which differs from JSON only in `=` for `:`.
 */
function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)} = ${tomlValue(inner)}`)
    return `{ ${members.join(', ')} }`
  }
  return JSON.stringify(value)
}

/** A JSON-shaped document as TOML text: headers for tables, JSON's bytes for every value in them. */
function tomlSource(document, prefix = []) {
  const lines = []
  const tables = []
  for (const [key, value] of Object.entries(document)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) tables.push([key, value])
    else lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`)
  }
  for (const [key, table] of tables) {
    lines.push(`[${[...prefix, key].map((segment) => JSON.stringify(segment)).join('.')}]`)
    lines.push(...tomlSource(table, [...prefix, key]))
  }
  return lines
}

test('every JSON value for these types is a legal TOML value, escape for escape', () => {
  const values = [
    'plain',
    'a "quoted" name',
    'line\nbreak and a\ttab',
    'back\\slash',
    'ünïcode',
    'control\u0001character',
    '',
    0,
    -12,
    3.5,
    1e-7,
    4_000,
    true,
    false,
    ['a', 'b'],
    [],
    { kind: 'local', root_dir: 'jobs' },
    { nested: { deep: [1, { k: 'v' }] } },
  ]

  for (const value of values) {
    const text = `value = ${tomlValue(value)}`
    const result = parseToml(text)
    assert.equal(result.ok, true, `${text}: ${result.problems?.join('; ')}`)
    assert.deepEqual(result.value, { value }, text)
  }
})

test('a JSON.stringify document round-trips idempotently: read it, write it again, same bytes', () => {
  const source = tomlSource(RUN_CONFIG).join('\n')

  const parsed = parseToml(source)
  assert.equal(parsed.ok, true, parsed.problems?.join('; '))
  assert.deepEqual(parsed.value, RUN_CONFIG, 'the object JSON.stringify was handed came back')
  assert.equal(JSON.stringify(tomlSource(parsed.value)), JSON.stringify(tomlSource(RUN_CONFIG)), 'writing it again is the same document')

  const again = parseToml(tomlSource(parsed.value).join('\n'))
  assert.equal(again.ok, true, again.problems?.join('; '))
  assert.equal(JSON.stringify(again.value), JSON.stringify(RUN_CONFIG), 'and reading the rewrite is stable')
})