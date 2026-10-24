/**
 * The model port's command adapter: **one question in, one answer out**, and one closed failure
 * class when there is no answer.
 *
 * Every judgement the loop makes — VERIFY's adversarial review, CAND_ANALYZE, ROUND_PLAN,
 * ROUND_REFLECT, and LAND's briefing of the implementer — reaches a model the same way a candidate
 * reaches a worktree: as a **process**. Not an in-process function, because then the port would be a
 * closure only this repository can hold, and not an in-process subagent, because a subagent has no
 * `cwd` of its own. A process crosses the boundary with JSON, and JSON is the one wire format a
 * configuration file can name.
 *
 * Three decisions are load-bearing here:
 *
 * 1. **The question is structured.** The child receives (or the wrapper is handed) one object:
 *    `{ protocol, call_site, subject, prompt, facts, answer_schema }`, and a `question_id` derived
 *    from its own content. The id is a digest, not a clock, so the same question asked twice is the
 *    same question — which is what lets "asking again changed nothing but the artifact" be a
 *    statement about content rather than about ordering.
 *
 * 2. **The answer is structured, or there is no answer.** The model's reply is prose and may wrap
 *    its JSON in a fence; what comes out of here is either a plain object or `ModelUnavailable`.
 *    Nothing downstream parses prose, so a malformed answer cannot be read as an opinion.
 *
 * 3. **"The model is unavailable" is one name.** A missing binary, a non-zero exit, a timeout and an
 *    unparseable answer are four causes of one condition — no answer arrived — and the loop must
 *    react to the condition, not to four stories about it. The single name lives here, in
 *    `MODEL_UNAVAILABLE`; the cause is kept beside it for the operator, never in place of it.
 *
 * The persisted record (ticket 29 reads it) is built here too, because this is the only place that
 * has both halves of a call: `modelCallRecord`. A caller supplies a sink (`record`) and decides where
 * the record lands — in production, the workspace's artifact store under `model_call/…`.
 *
 * @module
 */

import { createHash } from 'node:crypto'

import {
  CRASH,
  CREDENTIAL,
  DEFAULT_TIMEOUT_MS,
  HARNESS_UNAVAILABLE,
  OK,
  RESULT_MISSING,
  STREAM_OVERFLOW,
  TIMEOUT,
  TRANSIENT,
  UNPARSEABLE_OUTPUT,
  parseStream,
  runProcess,
} from './harness.js'

/**
 * The one name. Every judgement point reports it, and `isModelUnavailable` is the only test anyone
 * downstream needs: a phase that sees this condition does not advance, does not reject a candidate,
 * and does not wait — it records one operation and backs off.
 */
export const MODEL_UNAVAILABLE = 'model_unavailable'

/** The wire format's version. A question carries it so a wrapper can refuse a shape it cannot read. */
export const QUESTION_PROTOCOL = 'dsh-reprise/model-question@1'

/** How one judgement is reached when the run says nothing more specific. Ten minutes, then a name. */
export const DEFAULT_MODEL_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

/**
 * Why no answer arrived. Diagnostic only: the class the loop acts on is always
 * `MODEL_UNAVAILABLE`, and turning these into classes would put the classification back in every
 * phase (which is exactly the thing this module exists to stop).
 */
export const CAUSES = Object.freeze({
  binaryMissing: 'binary_missing',
  exitNonZero: 'exit_non_zero',
  timeout: 'timeout',
  unparseableAnswer: 'unparseable_answer',
  crash: 'crash',
  streamOverflow: 'stream_overflow',
  // The port itself failed before a process existed: a wrapper that threw, a configuration with no
  // argv, an error a caller passed through. Same condition, different plumbing.
  portError: 'port_error',
})

/**
 * Harness error classes that mean "no answer arrived" rather than "the answer was no". LAND reaches a
 * model through the candidate-harness adapter, whose vocabulary is older and finer; this table is
 * where the two vocabularies meet, so a missing `claude` binary pauses the run in `loop.js` instead
 * of rejecting every candidate it was about to brief.
 *
 * `refusal` and `deterministic_fail` are deliberately absent: those are a model that answered.
 */
export const NO_ANSWER_CLASSES = Object.freeze([
  HARNESS_UNAVAILABLE,
  TIMEOUT,
  CRASH,
  STREAM_OVERFLOW,
  UNPARSEABLE_OUTPUT,
  RESULT_MISSING,
  CREDENTIAL,
  TRANSIENT,
])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const firstLine = (text) => (typeof text === 'string' ? (text.split('\n')[0] ?? '').trim() : '')

/** The last non-empty line of stderr, which is where a CLI usually says what went wrong. */
const lastLine = (text) => {
  if (typeof text !== 'string') return ''
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return (lines[lines.length - 1] ?? '').trim()
}

const digest = (text) => createHash('sha256').update(text).digest('hex')

/** The canonical ordering the question id is computed over: adding a field later is a protocol change. */
const QUESTION_FIELDS = Object.freeze(['protocol', 'call_site', 'subject', 'ref', 'prompt', 'facts', 'answer_schema'])

function requireText(name, value, why) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string — ${why}`)
  return value
}

// --------------------------------------------------------------- question

/**
 * The one shape a model is asked anything in.
 *
 * `subject` names what the answer is about (a candidate id, `round-<n>`) and `ref` names the place in
 * a sequence (`a2` for the second gate attempt). Both are the kernel's identifiers, never the
 * model's, and both are optional because an audit reader can live without them — but a record
 * without them cannot be filed next to the artifact it explains.
 *
 * @param {{call_site: string, prompt: string, facts?: object, answer_schema?: string,
 *          subject?: string|null, ref?: string|null}} request
 */
export function buildQuestion({ call_site: callSite, prompt, facts, answer_schema: answerSchema, subject = null, ref = null } = {}) {
  requireText('call_site', callSite, 'the audit trail keys a call by the judgement it belongs to')
  requireText('prompt', prompt, 'a question with no prompt asks a model nothing and still gets an answer')
  const question = {
    protocol: QUESTION_PROTOCOL,
    call_site: callSite,
    subject: typeof subject === 'string' && subject !== '' ? subject : null,
    ref: typeof ref === 'string' && ref !== '' ? ref : null,
    prompt,
    facts: isObject(facts) ? facts : {},
    answer_schema: typeof answerSchema === 'string' ? answerSchema : '',
  }
  // Serialised in a fixed field order so the digest depends on the content and nothing else.
  return frozenQuestion(question)
}

function frozenQuestion(question) {
  const body = {}
  for (const field of QUESTION_FIELDS) body[field] = question[field]
  return Object.freeze({ ...body, question_id: digest(JSON.stringify(body)) })
}

/** The content identity of a question: same question, same id, in any process, on any day. */
export const questionId = (question) => question.question_id

// ----------------------------------------------------------------- answer

/**
 * Read the model's answer out of whatever the CLI printed.
 *
 * Three shapes are real, and all three are accepted because the difference is the CLI's, not the
 * judgement's: a bare JSON object (a wrapper that prints only the answer), a newline-delimited event
 * stream whose final event carries the text (`claude -p --output-format stream-json`,
 * `dsh --profile headless --json`), and a final message that wraps its JSON in prose or a fenced
 * block. What is *not* accepted is prose with no object in it: that is not an answer, and returning
 * an empty one would let a phase advance on nothing.
 *
 * @returns {{answer: Record<string, unknown>, response: string} | undefined}
 */
export function readAnswer(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  const direct = parseObject(trimmed)
  // Event-shaped output is a stream of one, not a bare answer: the model's words are inside it and
  // an event object is not something any judgement's validator would accept.
  if (direct !== undefined && !looksLikeEvent(direct)) return { answer: direct, response: trimmed }

  // A stream: the model's own words are in the final event, and that is what a reader wants to see
  // in the audit record — not the twenty events that preceded it.
  const parsed = parseStream(text)
  const fromStream = typeof parsed.result?.text === 'string' ? parseObject(parsed.result.text) : undefined
  if (fromStream !== undefined) return { answer: fromStream, response: parsed.result.text }

  const fromProse = parseObject(text)
  if (fromProse !== undefined) return { answer: fromProse, response: trimmed }
  return undefined
}

/** One run event rather than an answer: `type` plus the field the event's payload lives under. */
function looksLikeEvent(value) {
  return (
    typeof value.type === 'string' &&
    ('result' in value || 'subtype' in value || 'final' in value || 'message' in value || 'text' in value)
  )
}

/** A plain JSON object, tolerating a fence or prose around it. `undefined` when there is none. */
function parseObject(text) {
  if (typeof text !== 'string') return undefined
  const candidates = [text.trim()]
  for (const match of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)) candidates.push(match[1].trim())
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1))

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (isObject(value)) return value
    } catch {
      // Next shape; a model that wrapped its JSON in prose is normal, not a failure.
    }
  }
  return undefined
}

// ----------------------------------------------------------- availability

/**
 * Classify one finished process into the single condition, or into `ok`.
 *
 * Precedence is fixed and documented because the signals overlap: we killed it (timeout, overflow)
 * means the exit code and the stream are both meaningless; a missing binary is nobody's answer; a
 * non-zero exit is the CLI saying it could not ask; and only then is "the output had no object in
 * it" the model's answer being unreadable.
 *
 * @returns {{error_class: string, cause: string|null, message: string}}
 */
export function classifyAsk({
  timedOut = false,
  overflowed = false,
  spawnError = null,
  code = 0,
  signal = null,
  stdout = '',
  stderr = '',
  timeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  parsed,
} = {}) {
  const unavailable = (cause, message) => ({ error_class: MODEL_UNAVAILABLE, cause, message })

  if (timedOut) {
    return unavailable(CAUSES.timeout, `the model did not answer within ${timeoutMs} ms and was killed`)
  }
  if (overflowed) {
    return unavailable(CAUSES.streamOverflow, 'the model wrote more than the stream cap allows and was killed')
  }
  if (spawnError !== null && spawnError !== undefined) {
    const reason = firstLine(spawnError.message) || String(spawnError)
    if (spawnError.code === 'ENOENT') {
      return unavailable(CAUSES.binaryMissing, `the model command is not installed: ${reason}`)
    }
    return unavailable(CAUSES.crash, `the model command could not be started: ${reason}`)
  }
  if (signal !== null && signal !== undefined) {
    return unavailable(CAUSES.crash, `the model command was killed by ${signal}`)
  }
  if (code !== 0) {
    return unavailable(CAUSES.exitNonZero, `the model command exited ${code}: ${lastLine(stderr) || 'it said nothing'}`)
  }

  const stream = parsed ?? parseStream(stdout)
  if (stream.unparsed.length > 0 && stream.events.length === 0) {
    // A CLI that printed only non-JSON noise never answered; the message quotes it so the operator
    // can tell a broken wrapper from a broken prompt.
    return unavailable(
      CAUSES.unparseableAnswer,
      `the model wrote ${stream.unparsed.length} line(s) and none was an answer: ${firstLine(stream.unparsed[0])}`,
    )
  }
  return { error_class: OK, cause: null, message: '' }
}

/** Thrown when no answer arrived. Carries the class, the cause and what the CLI actually said. */
export class ModelUnavailable extends Error {
  /**
   * @param {{cause: string, message: string, response?: string, question?: object, error_class?: string}} detail
   */
  constructor({ cause, message, response = '', question = undefined, error_class: errorClass = MODEL_UNAVAILABLE }) {
    super(message)
    this.name = 'ModelUnavailable'
    this.error_class = errorClass
    this.cause = cause
    this.response = response
    if (question !== undefined) this.question = question
  }
}

/** Is this "no answer arrived"? One predicate, so no phase invents its own reading of the class. */
export function isModelUnavailable(error) {
  return error instanceof Error && error.error_class === MODEL_UNAVAILABLE
}

/**
 * Wrap anything a port threw into the one closed class. A wrapper that crashed, an upstream 503, a
 * configuration with no argv: none of those answers the question, so none of them is an opinion.
 */
export function asModelUnavailable(error, { question } = {}) {
  if (isModelUnavailable(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ModelUnavailable({
    cause: CAUSES.portError,
    message: `the model port failed: ${message}`,
    question,
  })
}

/** Does this harness error class mean the model never answered? LAND asks through `harness.js`. */
export const isNoAnswerClass = (errorClass) => NO_ANSWER_CLASSES.includes(errorClass)

// ----------------------------------------------------------------- record

/** The artifact name one call is filed under; `artifactFileName` turns the colons into directories. */
export function modelCallName({ call_site: callSite, subject, ref }) {
  const parts = ['model_call', callSite]
  if (typeof subject === 'string' && subject !== '') parts.push(subject)
  if (typeof ref === 'string' && ref !== '') parts.push(ref)
  return parts.join(':')
}

/**
 * Everything one judgement call has to leave behind, and nothing that changes when the clock does.
 *
 * Ticket 29 renders this: the prompt a model was given, the answer text it returned, and the object
 * that answer became. There is deliberately no timestamp and no sequence number — the record's
 * identity is the question's content, so asking the same question twice rewrites the same bytes
 * instead of inventing a second history.
 *
 * @param {{question: object, answer?: object|null, response?: string, error_class?: string|null,
 *          cause?: string|null, message?: string|null}} call
 */
export function modelCallRecord({ question, answer = null, response = '', error_class: errorClass = null, cause = null, message = null }) {
  return {
    schema_version: 1,
    protocol: question.protocol,
    question_id: question.question_id,
    call_site: question.call_site,
    subject: question.subject,
    ref: question.ref,
    prompt: question.prompt,
    facts: question.facts,
    answer_schema: question.answer_schema,
    status: errorClass === null ? 'answered' : 'unavailable',
    answer,
    response: typeof response === 'string' ? response : '',
    error_class: errorClass,
    cause,
    message,
  }
}

// ------------------------------------------------------------------- port

/** How each kind of engine is invoked. `command` is a wrapper; the other two are the plain CLIs. */
const KINDS = Object.freeze({
  command: { argv: null, input: (question) => JSON.stringify(question) },
  dsh: { argv: ['--profile', 'headless', '--json', '-'], input: (question) => question.prompt },
  claude: { argv: ['-p', '--output-format', 'stream-json'], input: (question) => question.prompt },
})

export const MODEL_KINDS = Object.freeze(Object.keys(KINDS))

/**
 * The model port: an async function that answers one structured question, or throws `ModelUnavailable`.
 *
 * `record` is where the call is filed. It is awaited and its failure is *not* swallowed: the audit
 * trail is a requirement of the same ticket that requires the answer, and a run whose records cannot
 * be written has a broken workspace, not a broken model.
 *
 * @param {{
 *   kind?: 'command'|'dsh'|'claude',
 *   command?: string[],
 *   cwd?: string,
 *   env?: object,
 *   timeout_ms?: number,
 *   run?: Function,
 *   record?: (call: object) => unknown|Promise<unknown>,
 * }} [options]
 */
export function createModelPort({ kind = 'command', command, cwd = process.cwd(), env, timeout_ms: timeoutMs, run = runProcess, record } = {}) {
  if (!MODEL_KINDS.includes(kind)) {
    throw new TypeError(`model.kind must be one of ${MODEL_KINDS.join(', ')} — it says which CLI the answer comes from`)
  }
  const spec = KINDS[kind]
  const argv = kind === 'command' ? command : [...(command ?? [kind]), ...spec.argv]
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('the model port needs an argv: model.command for a wrapper, or a kind that names its own CLI')
  }
  const patience = timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS
  // A port with no patience is a phase that can wait for ever, which is the state this whole
  // ticket exists to make impossible. Zero is not "unlimited" here; it is a bug.
  if (!Number.isSafeInteger(patience) || patience <= 0) {
    throw new TypeError('the model port needs a positive timeout_ms — a judgement with no deadline can hang a night')
  }

  const [binary, ...args] = argv

  return async function ask(request) {
    const question = buildQuestion(request)
    let outcome
    try {
      outcome = await run({
        command: binary,
        args,
        cwd,
        input: spec.input(question),
        env: { ...process.env, ...(env ?? {}) },
        timeoutMs: patience,
      })
    } catch (error) {
      // A runner that throws never started a model. That is the same condition as a missing binary,
      // so it is filed and thrown as itself rather than escaping as an unbranded Error a phase
      // would have to guess about.
      const failure = asModelUnavailable(error, { question })
      if (typeof record === 'function') {
        await record(
          modelCallRecord({
            question,
            answer: null,
            response: '',
            error_class: failure.error_class,
            cause: failure.cause,
            message: failure.message,
          }),
        )
      }
      throw failure
    }

    const parsed = parseStream(outcome.stdout)
    const verdict = classifyAsk({ ...outcome, parsed, timeoutMs: patience })
    const read = readAnswer(outcome.stdout)
    const unavailable = verdict.error_class !== OK || read === undefined

    const failure = unavailable
      ? verdict.error_class !== OK
        ? verdict
        : {
            error_class: MODEL_UNAVAILABLE,
            cause: CAUSES.unparseableAnswer,
            message: 'the model answered without a JSON object — an answer shape the contract cannot read',
          }
      : null

    if (typeof record === 'function') {
      await record(
        modelCallRecord({
          question,
          answer: failure === null ? read.answer : null,
          response: read?.response ?? outcome.stdout ?? '',
          error_class: failure?.error_class ?? null,
          cause: failure?.cause ?? null,
          message: failure?.message ?? null,
        }),
      )
    }

    if (failure !== null) {
      throw new ModelUnavailable({ ...failure, response: read?.response ?? outcome.stdout ?? '', question })
    }
    return read.answer
  }
}