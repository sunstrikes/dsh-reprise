/**
 * The model port's command adapter: **one question, one answer, or one closed failure.**
 *
 * What this file guards, and why it is a seam rather than an implementation detail:
 *
 * 1. **A structured question goes in and a structured answer comes out.** The loop's judgement
 *    phases may not read prose, so the adapter is the only place prose is tolerated — a fence, a
 *    stream's final event, a paragraph around the JSON. Nothing downstream has to know which CLI
 *    answered, which is what makes "swap the engine, touch no kernel code" true.
 * 2. **A missing binary, a non-zero exit, a timeout and an unparseable answer are one condition.**
 *    They share `MODEL_UNAVAILABLE`; the differences survive as a `cause` for the operator, never as
 *    four classes for the phase machine to keep in step.
 * 3. **The call is recorded, and the record is content-addressed.** Asking the same question twice
 *    produces the same `question_id` and byte-identical record — no timestamp, no random id — so a
 *    repeat cannot look like a second judgement.
 *
 * The suite needs neither `dsh` nor `claude`: every case below is either an injected process runner
 * or a fake CLI started with `node`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CAUSES,
  MODEL_KINDS,
  MODEL_UNAVAILABLE,
  ModelUnavailable,
  QUESTION_PROTOCOL,
  buildQuestion,
  classifyAsk,
  createModelPort,
  isModelUnavailable,
  isNoAnswerClass,
  modelCallName,
  modelCallRecord,
  questionId,
  readAnswer,
} from '../lib/model.js'
import { HARNESS_UNAVAILABLE, REFUSAL, TIMEOUT } from '../lib/harness.js'

const FAKE_CLI = `
import { readFileSync, writeFileSync } from 'node:fs'

const mode = process.env.FAKE_MODE ?? 'answer'
const input = readFileSync(0, 'utf8')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')

if (mode === 'answer') {
  const question = JSON.parse(input)
  process.stdout.write(JSON.stringify({ verdict: 'accept', rationale: 'asked ' + question.call_site }) + '\\n')
}

if (mode === 'stream') {
  // What a real 'claude -p --output-format stream-json' / 'dsh --profile headless --json' prints:
  // events, and the model's words inside the last one.
  const seen = input.includes('"call_site"') ? 'json' : 'text'
  emit({ type: 'system', subtype: 'init', session_id: 'fake' })
  emit({
    type: 'result',
    subtype: 'success',
    result:
      'I read the diff.\\n\\n' +
      '\\u0060\\u0060\\u0060json\\n{"verdict": "reject", "rationale": "sees ' + seen + '"}\\n' +
      '\\u0060\\u0060\\u0060\\n',
  })
}

if (mode === 'garbage') process.stdout.write('this is not json\\nnor is this\\n')
if (mode === 'no-object') process.stdout.write('I would rather not answer in JSON today.\\n')
if (mode === 'exit') {
  process.stderr.write('line that matters\\n')
  process.exitCode = 7
}
if (mode === 'hang') {
  // Announce the pid before the hang: the fact the deadline test asserts is that this process was
  // *killed*, and a process that never named itself cannot be looked for afterwards.
  if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid))
  setTimeout(() => {}, 60000)
}
`

/** A fake engine, started with `node`, selected by `FAKE_MODE`; no network, no provider, no harness. */
function fakeCli() {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-model-'))
  const path = join(dir, 'fake-model.mjs')
  writeFileSync(path, `${FAKE_CLI}\n`, 'utf8')
  return path
}

const CLI = fakeCli()

/** A port over the fake engine, plus the records it filed. */
function port({ mode = 'answer', kind = 'command', timeoutMs = 5_000, ...overrides } = {}) {
  const records = []
  const ask = createModelPort({
    kind,
    command: kind === 'command' ? [process.execPath, CLI] : [process.execPath, CLI],
    env: { FAKE_MODE: mode },
    timeout_ms: timeoutMs,
    record: (call) => records.push(call),
    ...overrides,
  })
  return { ask, records }
}

const VERIFY_QUESTION = {
  call_site: 'verify',
  subject: 'r1-h2',
  ref: 'a1',
  prompt: 'VERIFY — adversarial review.\nAnswer with {"verdict": "accept" | "reject"}.',
  facts: { candidate_id: 'r1-h2', files: ['model/embedding.py'] },
  answer_schema: '{"verdict": "accept" | "reject"}',
}

// ------------------------------------------------------------ one round trip

test('one question goes in and one structured answer comes out, through a real process', async () => {
  const { ask, records } = port()
  const question = buildQuestion(VERIFY_QUESTION)

  const answer = await ask(VERIFY_QUESTION)

  assert.deepEqual(answer, { verdict: 'accept', rationale: 'asked verify' }, 'the answer is the object, not the text around it')
  assert.equal(records.length, 1, 'exactly one call, exactly one record')
  const record = records[0]
  assert.equal(record.status, 'answered')
  assert.equal(record.protocol, QUESTION_PROTOCOL)
  assert.equal(record.call_site, 'verify')
  assert.equal(record.subject, 'r1-h2')
  assert.equal(record.ref, 'a1')
  assert.equal(record.question_id, question.question_id, 'the record names the question by content')
  assert.equal(record.prompt, VERIFY_QUESTION.prompt, 'the audit page can render the exact prompt')
  assert.deepEqual(record.facts, VERIFY_QUESTION.facts)
  assert.deepEqual(record.answer, answer, 'and the answer it became')
  assert.equal(record.error_class, null)
})

test('the question the child receives is one JSON object carrying the prompt, the facts and the id', async () => {
  const seen = []
  const ask = createModelPort({
    command: [process.execPath, CLI],
    env: { FAKE_MODE: 'answer' },
    run: async (request) => {
      seen.push(request)
      return { code: 0, signal: null, stdout: '{"verdict":"accept"}\n', stderr: '', timedOut: false, overflowed: false, spawnError: null, duration_ms: 1 }
    },
  })

  await ask(VERIFY_QUESTION)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].command, process.execPath)
  assert.deepEqual(seen[0].args, [CLI])
  const delivered = JSON.parse(seen[0].input)
  assert.equal(delivered.protocol, QUESTION_PROTOCOL)
  assert.equal(delivered.call_site, 'verify')
  assert.equal(delivered.prompt, VERIFY_QUESTION.prompt)
  assert.deepEqual(delivered.facts, VERIFY_QUESTION.facts)
  assert.equal(delivered.answer_schema, VERIFY_QUESTION.answer_schema)
  assert.match(delivered.question_id, /^[0-9a-f]{64}$/)
  assert.ok(seen[0].timeoutMs > 0, 'a judgement always has a deadline')
})

test('a headless CLI is asked with its own argv and the prompt as its task, not with a JSON envelope', async () => {
  const seen = []
  const ask = createModelPort({
    kind: 'dsh',
    command: [process.execPath, CLI],
    env: { FAKE_MODE: 'stream' },
    run: async (request) => {
      seen.push(request)
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, overflowed: false, spawnError: null, duration_ms: 1 }
    },
  })

  await assert.rejects(() => ask(VERIFY_QUESTION), /did not.*|without a JSON object/i)

  assert.deepEqual(seen[0].args, [CLI, '--profile', 'headless', '--json', '-'], 'the headless profile is the shipped invocation')
  assert.equal(seen[0].input, VERIFY_QUESTION.prompt, 'a real CLI reads a task, so the prompt travels as text')
  assert.ok(MODEL_KINDS.includes('dsh') && MODEL_KINDS.includes('claude') && MODEL_KINDS.includes('command'))
})

test('an answer inside a stream event and a fenced block is read as the answer, and the record keeps the words', async () => {
  const { ask, records } = port({ kind: 'dsh', mode: 'stream' })

  const answer = await ask({ ...VERIFY_QUESTION, prompt: 'review this diff' })

  assert.deepEqual(answer, { verdict: 'reject', rationale: 'sees text' })
  assert.match(records[0].response, /I read the diff/, 'the model\'s own text is what an auditor reads')
  assert.match(records[0].response, /```json/, 'including the fence it wrapped the answer in')
})

test('the answer reader tolerates the three real shapes and refuses prose with no object', () => {
  assert.deepEqual(readAnswer('{"a":1}')?.answer, { a: 1 })
  assert.deepEqual(readAnswer('Here you go:\n```json\n{"a":1}\n```\n')?.answer, { a: 1 })
  assert.deepEqual(
    readAnswer('{"type":"result","result":"thinking… {\\"a\\":1}"}\n')?.answer,
    { a: 1 },
    'a one-event stream is a stream',
  )
  assert.equal(readAnswer('I decline to answer.'), undefined)
  assert.equal(readAnswer('[1,2,3]'), undefined, 'a list where an object was asked for is not an answer')
  assert.equal(readAnswer(''), undefined)
})

// --------------------------------------------------------- one closed failure

test('an unparseable answer is a closed failure, and the record says so instead of inventing an answer', async () => {
  const { ask, records } = port({ mode: 'no-object' })

  await assert.rejects(
    () => ask(VERIFY_QUESTION),
    (error) => {
      assert.ok(isModelUnavailable(error))
      assert.equal(error.error_class, MODEL_UNAVAILABLE)
      assert.equal(error.cause, CAUSES.unparseableAnswer)
      return true
    },
  )
  assert.equal(records[0].status, 'unavailable')
  assert.equal(records[0].answer, null, 'a failed parse must never become an empty answer')
  assert.equal(records[0].error_class, MODEL_UNAVAILABLE)
  assert.match(records[0].response, /would rather not answer/, 'the operator can see what the model said')
})

test('a binary that is not installed is the same closed failure, with its own cause', async () => {
  const records = []
  const ask = createModelPort({
    command: ['reprise-definitely-not-installed', '--json'],
    timeout_ms: 5_000,
    record: (call) => records.push(call),
  })

  await assert.rejects(
    () => ask(VERIFY_QUESTION),
    (error) => {
      assert.ok(isModelUnavailable(error), 'one class for every way of not answering')
      assert.equal(error.cause, CAUSES.binaryMissing)
      return true
    },
  )
  assert.equal(records[0].status, 'unavailable')
  assert.equal(records[0].cause, CAUSES.binaryMissing)
})

test('a non-zero exit is the same closed failure, and its message quotes the last thing the CLI said', async () => {
  const { ask, records } = port({ mode: 'exit' })

  await assert.rejects(
    () => ask(VERIFY_QUESTION),
    (error) => {
      assert.ok(isModelUnavailable(error))
      assert.equal(error.cause, CAUSES.exitNonZero)
      assert.match(error.message, /line that matters/)
      return true
    },
  )
  assert.equal(records[0].status, 'unavailable')
  assert.equal(records[0].cause, CAUSES.exitNonZero)
})

test('a model that never answers is killed at its deadline, not waited on', async () => {
  // The property under test is "we do not wait out the 60 s hang", so the assertions are the kill
  // (the child is gone afterwards) and a bound far below the hang. What this test must NOT assert is
  // "we answered in a few hundred milliseconds": a full suite on a loaded box once spent 25.1 s here
  // while the behaviour was exactly right, because the port's deadline is a timer racing a machine
  // that was busy running other tests. Alone this file takes 786 ms.
  const pidFile = join(mkdtempSync(join(tmpdir(), 'reprise-model-pid-')), 'pid')
  const { ask, records } = port({ mode: 'hang', timeoutMs: 5_000, env: { FAKE_MODE: 'hang', FAKE_PIDFILE: pidFile } })

  const started = Date.now()
  await assert.rejects(
    () => ask(VERIFY_QUESTION),
    (error) => {
      assert.ok(isModelUnavailable(error))
      assert.equal(error.cause, CAUSES.timeout)
      assert.match(error.message, /5000 ms/)
      return true
    },
  )
  const elapsed = Date.now() - started
  // Half the hang, and 6x the deadline: loose enough that load cannot fail it, tight enough that
  // waiting the child out (60 s) cannot pass it.
  assert.ok(elapsed < 30_000, `the deadline, not the 60 s hang, ended the judgement (took ${elapsed} ms)`)

  // The observable fact behind "killed": the process the fake announced is gone. A port that reports
  // `timeout` while leaving the child alive is a leaked harness, and a night of leaked harnesses is
  // an OOM at 3 a.m.
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `the fake engine announced its pid in ${pidFile}`)
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error !== null && error.code === 'ESRCH',
    `the hung child (pid ${pid}) was killed, not left running`,
  )

  assert.equal(records[0].cause, CAUSES.timeout, 'the record names the deadline, not an unreadable answer')
})

test('a port that throws is "no answer arrived", not an opinion — and one predicate says so', async () => {
  const ask = createModelPort({
    command: [process.execPath, CLI],
    run: async () => {
      throw new Error('upstream 503')
    },
  })

  await assert.rejects(
    () => ask(VERIFY_QUESTION),
    (error) => isModelUnavailable(error) === true && /upstream 503/.test(error.message),
  )
  assert.equal(isModelUnavailable(new Error('ordinary bug')), false)
})

test('a port with no deadline or no argv is refused at construction, not at tick 400', () => {
  assert.throws(() => createModelPort({ command: [process.execPath, CLI], timeout_ms: 0 }), /positive timeout_ms/)
  assert.throws(() => createModelPort({ command: [] }), /argv/)
  assert.throws(() => createModelPort({ kind: 'gpt5' }), /model.kind/)
})

test('the harness vocabulary maps into the same condition, so LAND can report it too', () => {
  assert.equal(isNoAnswerClass(HARNESS_UNAVAILABLE), true, 'the implementer binary is missing: no model answered')
  assert.equal(isNoAnswerClass(TIMEOUT), true)
  assert.equal(isNoAnswerClass(REFUSAL), false, 'a refusal is an answer: the model said no')
  assert.equal(isNoAnswerClass('cross_check_mismatch'), false, 'that is a disagreement between two facts')
})

// --------------------------------------------------------------- determinism

test('asking the same question twice is the same question: no clock, no random id, identical bytes', async () => {
  const records = []
  const ask = createModelPort({
    command: [process.execPath, CLI],
    env: { FAKE_MODE: 'answer' },
    record: (call) => records.push(call),
  })

  await ask(VERIFY_QUESTION)
  await ask(VERIFY_QUESTION)

  assert.equal(records.length, 2)
  assert.equal(records[0].question_id, records[1].question_id)
  assert.equal(
    JSON.stringify(records[0]),
    JSON.stringify(records[1]),
    'the second call files the same bytes: a repeat cannot read as a second judgement',
  )
  assert.equal(modelCallName(records[0]), modelCallName(records[1]))

  const changed = buildQuestion({ ...VERIFY_QUESTION, facts: { candidate_id: 'r1-h2', files: ['other.py'] } })
  assert.notEqual(changed.question_id, records[0].question_id, 'a different question is a different id')
})

test('a record is filed under the call site, the subject and the place in its sequence', () => {
  const question = buildQuestion(VERIFY_QUESTION)
  const record = modelCallRecord({ question, answer: { verdict: 'accept' }, response: '{"verdict":"accept"}' })

  assert.equal(modelCallName(record), 'model_call:verify:r1-h2:a1')
  assert.equal(record.status, 'answered')
  for (const forbidden of ['at_ms', 'timestamp', 'started_at', 'duration_ms']) {
    assert.equal(forbidden in record, false, `the record has no ${forbidden}: identity is the question, not the clock`)
  }

  const anonymous = modelCallName(buildQuestion({ call_site: 'round_plan', prompt: 'plan' }))
  assert.equal(anonymous, 'model_call:round_plan', 'a round-level question has no candidate to name')
})

test('classifyAsk names the cause without inventing a second class', () => {
  const cases = [
    [{ timedOut: true }, CAUSES.timeout],
    [{ overflowed: true }, CAUSES.streamOverflow],
    [{ spawnError: Object.assign(new Error('nope'), { code: 'ENOENT' }) }, CAUSES.binaryMissing],
    [{ spawnError: new Error('EACCES') }, CAUSES.crash],
    [{ signal: 'SIGKILL' }, CAUSES.crash],
    [{ code: 2, stderr: 'bad flags' }, CAUSES.exitNonZero],
  ]
  for (const [outcome, cause] of cases) {
    const verdict = classifyAsk({ ...outcome, stdout: '' })
    assert.equal(verdict.error_class, MODEL_UNAVAILABLE, `${cause}: one class`)
    assert.equal(verdict.cause, cause)
  }
  assert.equal(classifyAsk({ code: 0, stdout: '{"a":1}' }).error_class, 'ok')
})

test('a machine out of processes is an outage with its own cause, because retrying in a minute would be wrong', () => {
  const verdict = classifyAsk({ spawnError: Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }), stdout: '' })
  assert.equal(verdict.error_class, MODEL_UNAVAILABLE)
  assert.equal(verdict.cause, CAUSES.resourceExhausted)
})

test('every failure is a ModelUnavailable carrying the class, so a caller can branch on one name', async () => {
  const { ask } = port({ mode: 'garbage' })
  const error = await ask(VERIFY_QUESTION).then(
    () => null,
    (failure) => failure,
  )
  assert.ok(error instanceof ModelUnavailable)
  assert.equal(error.name, 'ModelUnavailable')
  assert.equal(error.error_class, MODEL_UNAVAILABLE)
  assert.equal(error.cause, CAUSES.unparseableAnswer)
  assert.equal(error.question.call_site, 'verify', 'the failure knows which question went unanswered')
  assert.ok(questionId(error.question) !== undefined)
})