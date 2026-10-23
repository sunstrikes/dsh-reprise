/**
 * Guards ticket 07's failure line: "a harness crash, a timeout and unparseable output are each
 * classified into a decidable error, so the phase machine never hangs on some phase".
 *
 * The three are kept apart because they point at different repairs — a timeout is a stuck or
 * too-slow agent, a crash is a dead process (often an OOM kill), unparseable output is a broken
 * stream contract — and a single "failed" would send the operator to the wrong place. The pure
 * `classify` table is checked first so every branch is pinned in one place, then a real child
 * process is made to fail each of the three ways: a classification that only exists in a unit test
 * would not prove the phase machine can get an answer.
 *
 * Both adapters are exercised for the three named failures; the remaining upstream outcomes go
 * through one adapter because the shared body in `harness.js` is the only implementation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CRASH,
  ERROR_CLASSES,
  OK,
  RESULT_MISSING,
  TIMEOUT,
  UNPARSEABLE_OUTPUT,
  CROSS_CHECK_MISMATCH,
  assertLandResult,
  classify,
  crossCheck,
  parseStream,
  readSelfReport,
} from '../lib/harness.js'
import { createClaudeHarness } from '../lib/harness-claude.js'
import { createDshHarness } from '../lib/harness-dsh.js'
import { fakeHarness, makeRunner, writeFakeCli } from './support.js'

const HYPOTHESIS = 'widen the embedding table to cut rare-feature collisions'

const ADAPTERS = [
  { name: 'claude', create: createClaudeHarness },
  { name: 'dsh', create: createDshHarness },
]

const landInput = (runner) => ({
  candidateId: 'cand-1',
  hypothesis: HYPOTHESIS,
  worktreeDir: runner.worktreeDir,
  baseRef: runner.base,
})

const streamOf = (...events) => parseStream(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
const spawnError = (code, message) => Object.assign(new Error(message), { code })

test('every outcome has exactly one class, with a fixed precedence', () => {
  const cases = [
    {
      name: 'timeout',
      input: { timedOut: true, code: null, signal: 'SIGTERM', timeoutMs: 250 },
      expected: TIMEOUT,
    },
    {
      name: 'stream overflow',
      input: { overflowed: true, code: null, signal: 'SIGTERM' },
      expected: 'stream_overflow',
    },
    {
      name: 'binary missing',
      input: { spawnError: spawnError('ENOENT', 'spawn claude ENOENT') },
      expected: 'harness_unavailable',
    },
    {
      name: 'spawn failure',
      input: { spawnError: spawnError('EACCES', 'spawn claude EACCES') },
      expected: CRASH,
    },
    {
      name: 'killed by a signal',
      input: { code: null, signal: 'SIGKILL' },
      expected: CRASH,
    },
    {
      name: 'credential failure',
      input: { code: 1, stderr: 'HTTP 401 unauthorized' },
      expected: 'credential',
    },
    {
      name: 'transient upstream failure',
      input: { code: 1, stderr: '429 too many requests' },
      expected: 'transient',
      retryable: true,
    },
    {
      name: 'non-zero exit with nothing better to go on',
      input: { code: 7, stderr: 'Traceback (most recent call last): KeyError' },
      expected: 'deterministic_fail',
    },
    {
      name: 'refusal',
      input: { code: 0, parsed: streamOf({ type: 'result', subtype: 'refusal', result: 'no' }) },
      expected: 'refusal',
    },
    {
      name: 'error subtype',
      input: { code: 0, parsed: streamOf({ type: 'result', subtype: 'error_max_turns', result: 'x' }) },
      expected: 'deterministic_fail',
    },
    {
      name: 'unparseable output',
      input: { code: 0, stdout: 'not json\nnor this\n', parsed: parseStream('not json\nnor this\n') },
      expected: UNPARSEABLE_OUTPUT,
    },
    {
      name: 'clean exit without a result event',
      input: { code: 0, stdout: '{"type":"system"}\n', parsed: parseStream('{"type":"system"}\n') },
      expected: RESULT_MISSING,
    },
    {
      name: 'success',
      input: {
        code: 0,
        parsed: streamOf({ type: 'result', subtype: 'success', result: 'done' }),
      },
      expected: OK,
    },
  ]

  for (const item of cases) {
    const verdict = classify(item.input)
    assert.equal(verdict.error_class, item.expected, `${item.name} must classify as "${item.expected}"`)
    assert.equal(verdict.retryable, item.retryable === true, `${item.name}: only a transient failure is retryable`)
    assert.ok(
      ERROR_CLASSES.includes(verdict.error_class),
      `${item.name}: every class must be declared in ERROR_CLASSES, or the kernel cannot switch on it`,
    )
  }

  assert.equal(
    new Set([TIMEOUT, CRASH, UNPARSEABLE_OUTPUT]).size,
    3,
    'a timeout, a crash and unparseable output must stay three classes: each one asks for a different repair',
  )
  assert.equal(
    new Set(ERROR_CLASSES).size,
    ERROR_CLASSES.length,
    'the class list must not repeat — a duplicate would make the taxonomy look fuller than it is',
  )
})

for (const adapter of ADAPTERS) {
  const failures = [
    {
      mode: 'killed',
      expected: CRASH,
      boundMs: 10_000,
      check(result) {
        assert.equal(result.signal, 'SIGKILL', 'a process killed from outside is a crash, and the signal is kept as evidence')
      },
    },
    {
      mode: 'timeout',
      expected: TIMEOUT,
      options: { timeoutMs: 250 },
      boundMs: 15_000,
      check(result) {
        assert.equal(result.timed_out, true, 'the adapter killed it, so the timeout flag says so')
      },
    },
    {
      mode: 'garbage',
      expected: UNPARSEABLE_OUTPUT,
      boundMs: 10_000,
      check(result) {
        assert.match(result.message, /none was a JSON event/, 'the message must say the stream itself was broken')
      },
    },
  ]

  for (const failure of failures) {
    test(`${adapter.name}: a ${failure.mode} harness comes back as "${failure.expected}", not as a hang`, async (t) => {
      const runner = makeRunner(t)
      const fakeCli = writeFakeCli(runner.root)
      const harness = fakeHarness(adapter, { mode: failure.mode, fakeCli, ...(failure.options ?? {}) })

      const startedAt = Date.now()
      const result = assertLandResult(await harness.land(landInput(runner)))
      const elapsed = Date.now() - startedAt

      assert.equal(result.ok, false, 'the landing did not happen, and the result says so instead of reporting a build')
      assert.equal(result.error_class, failure.expected, `${failure.mode} must not be flattened into a generic failure`)
      assert.equal(result.retryable, false, 'a crash or a broken stream is not something a retry will fix')
      assert.equal(result.conflict, false, 'this is not the fact plane disagreeing with itself, so it is not a conflict')
      assert.ok(result.message.length > 0, 'the kernel needs a sentence to put in the rejection event')
      assert.ok(Number.isSafeInteger(result.duration_ms), 'the failure carries how long it took, which is the timeout evidence')
      assert.ok(
        elapsed < failure.boundMs,
        `${failure.mode} must return in bounded time (${elapsed} ms); a phase that never gets an answer is the one outcome this system forbids`,
      )
      failure.check(result)
    })
  }
}

test('the remaining upstream outcomes come back as their own classes', async (t) => {
  const runner = makeRunner(t)
  const fakeCli = writeFakeCli(runner.root)

  const expectations = [
    { mode: 'exit-nonzero', expected: 'deterministic_fail', retryable: false },
    { mode: 'no-result', expected: RESULT_MISSING, retryable: false },
    { mode: 'refusal', expected: 'refusal', retryable: false },
    { mode: 'subtype-error', expected: 'deterministic_fail', retryable: false },
    { mode: 'credential', expected: 'credential', retryable: false },
    { mode: 'transient', expected: 'transient', retryable: true },
    { mode: 'flood', expected: 'stream_overflow', retryable: false, options: { streamCapBytes: 4096 } },
  ]

  for (const item of expectations) {
    const harness = fakeHarness({ create: createClaudeHarness }, {
      mode: item.mode,
      fakeCli,
      ...(item.options ?? {}),
    })
    const result = assertLandResult(await harness.land(landInput(runner)))
    assert.equal(result.ok, false, `${item.mode}: the landing must not be reported as a success`)
    assert.equal(result.error_class, item.expected, `${item.mode} must classify as "${item.expected}"`)
    assert.equal(
      result.retryable,
      item.retryable,
      item.retryable
        ? `${item.mode} is a blip upstream, so the kernel is allowed to retry it`
        : `${item.mode} will fail the same way again; retrying would burn budget without changing the outcome`,
    )
    assert.deepEqual(result.files, [], `${item.mode}: the fake edited nothing, and git — not the failure class — says so`)
  }
})

test('a missing harness binary is classified instead of surfacing as an unhandled spawn error', async (t) => {
  const runner = makeRunner(t)
  const harness = createClaudeHarness({
    command: 'reprise-no-such-harness-binary',
    env: process.env,
  })

  const result = assertLandResult(await harness.land(landInput(runner)))

  assert.equal(result.ok, false, 'an absent binary is a configuration outcome the phase machine can record')
  assert.equal(
    result.error_class,
    'harness_unavailable',
    'the class separates "this machine has no claude" from "claude ran and failed", which need different answers',
  )
})

test('a self-report is read out of prose, and prose alone is not a report', () => {
  assert.deepEqual(
    readSelfReport('I edited things.\n\n```json\n{"files": ["b.py", "a.py"]}\n```\n')?.files,
    ['a.py', 'b.py'],
    'the documented fenced block is found in prose and sorted, so the recorded list is stable',
  )
  assert.deepEqual(
    readSelfReport('done\n{"files": ["x.py"]}')?.files,
    ['x.py'],
    'the documented shape is one JSON line; the adapter parses the answer rather than a rigid transcript',
  )
  assert.equal(
    readSelfReport('done: {"files": ["x.py"]}'),
    null,
    'text wrapped around the JSON is not the agreed shape, and guessing at it would let a sentence about files become a claim',
  )
  assert.deepEqual(
    readSelfReport('{"files": ["./src/a.py", "src/a.py"]}')?.files,
    ['src/a.py'],
    'the same file written two ways is one path, or the cross-check would report a phantom disagreement',
  )
  assert.equal(
    readSelfReport('I edited three files but forgot which.'),
    null,
    'prose with no JSON is "no report"; inventing an empty one would manufacture a mismatch',
  )
  assert.equal(readSelfReport(''), null, 'an empty answer is no report')
})

test('the cross-check names which side disagrees and never merges the diff with the claim', () => {
  const match = crossCheck({ reported: ['a.py', 'b.py'], actual: ['b.py', 'a.py'] })
  assert.equal(match.status, 'match', 'ordering is not a disagreement; only membership is')

  const missing = crossCheck({ reported: ['a.py'], actual: ['a.py', 'b.py'] })
  assert.deepEqual(missing.missing, ['b.py'], 'a changed file the harness never mentioned is the dangerous direction')
  assert.deepEqual(missing.unexpected, [], 'nothing was claimed that git cannot see')

  const unexpected = crossCheck({ reported: ['a.py', 'c.py'], actual: ['a.py'] })
  assert.deepEqual(unexpected.unexpected, ['c.py'], 'a claimed file git cannot see is an invented change')
  assert.deepEqual(unexpected.missing, [], 'every changed file was reported')

  const silent = crossCheck({ reported: null, actual: ['a.py'] })
  assert.equal(silent.status, 'not_reported', 'silence is recorded as silence, not as agreement')
  assert.deepEqual(silent.missing, [], 'no report means no contradiction; the missing list stays empty')

  const contradiction = crossCheck({ reported: ['ghost.py'], actual: ['a.py'] })
  assert.equal(
    contradiction.status,
    'mismatch',
    'the class the kernel turns into a conflict is produced here, from the two sets alone',
  )
  assert.equal(
    CROSS_CHECK_MISMATCH,
    'cross_check_mismatch',
    'the failure class name is part of the contract the kernel switches on',
  )
})