/**
 * The candidate-harness port: one external CLI coding harness, pinned to one candidate worktree.
 *
 * Two decisions are guarded here, and nothing else:
 *
 * 1. **`cwd` is the candidate worktree.** The predecessor passed `--add-dir <worktree>` plus a
 *    sentence in the prompt asking the model to stay inside it. That is a whitelist and a
 *    convention, not isolation — the child process still ran in the repository the loop itself
 *    was started from. Here the child's `cwd` is the worktree, so an edit outside it is a
 *    filesystem fact the OS can refuse, not a request the model may ignore.
 *
 * 2. **"Which files changed" comes from git, never from the harness.** A harness can under-report
 *    (it forgot a file), over-report (it claims a file it never touched), or simply answer
 *    something else entirely. The diff against the base ref is the only source; the harness's own
 *    report is a cross-check, and a disagreement fails the landing as `cross_check_mismatch`
 *    because two facts that must agree do not — the contract calls that `conflict`, and the kernel
 *    must record it as such rather than as `invalid`.
 *
 * The adapter is a leaf: pure Node, no contract import, no host import, no dependencies. Every
 * engine (claude, dsh, a future one) speaks the same result shape, so swapping engines never
 * touches the kernel.
 *
 * The one thing the adapter does *not* do is create worktrees or refs. The outer runner owns all
 * git state; this module only reads it (see `READ_ONLY_GIT_SUBCOMMANDS`) and edits files through
 * the child process.
 *
 * @module
 */

import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

/** A landing that talks to a model is measured in minutes, not milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** Prior art: the observed verbose stream was ~4 MiB; 16 MiB leaves headroom and still bounds us. */
export const DEFAULT_STREAM_CAP_BYTES = 16 * 1024 * 1024

/** How much stderr we keep for classification and for the audit line. */
export const MAX_STDERR_BYTES = 64 * 1024

export const OK = 'ok'
export const REFUSAL = 'refusal'
export const TIMEOUT = 'timeout'
export const STREAM_OVERFLOW = 'stream_overflow'
export const CREDENTIAL = 'credential'
export const TRANSIENT = 'transient'
export const UNPARSEABLE_OUTPUT = 'unparseable_output'
export const RESULT_MISSING = 'result_missing'
export const CRASH = 'crash'
export const HARNESS_UNAVAILABLE = 'harness_unavailable'
export const DETERMINISTIC_FAIL = 'deterministic_fail'
export const CROSS_CHECK_MISMATCH = 'cross_check_mismatch'

/**
 * Every outcome a landing can have. `unparseable_output`, `timeout` and `crash` are separate on
 * purpose: they ask for different responses (fix the prompt / the stream format, give it more time,
 * look for an OOM kill), and merging them into "failed" would send the operator to the wrong place.
 */
export const ERROR_CLASSES = Object.freeze([
  OK,
  REFUSAL,
  TIMEOUT,
  STREAM_OVERFLOW,
  CREDENTIAL,
  TRANSIENT,
  UNPARSEABLE_OUTPUT,
  RESULT_MISSING,
  CRASH,
  HARNESS_UNAVAILABLE,
  DETERMINISTIC_FAIL,
  CROSS_CHECK_MISMATCH,
])

/** Only a transient upstream failure may be retried; a timeout is usually a stuck agent, not a blip. */
export const RETRYABLE_CLASSES = Object.freeze([TRANSIENT])

/**
 * Classes that mean "the fact plane disagrees with itself" rather than "the artifact is malformed".
 * The kernel must record these as the contract's `conflict` state.
 */
export const CONFLICT_CLASSES = Object.freeze([CROSS_CHECK_MISMATCH])

/** The only git subcommands this adapter may run. Anything else would mutate runner-owned state. */
export const READ_ONLY_GIT_SUBCOMMANDS = Object.freeze(['rev-parse', 'diff', 'ls-files'])

// ---------------------------------------------------------------- helpers

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const firstString = (...values) => values.find((value) => typeof value === 'string' && value !== '')
const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const integerOrNull = (value) => (Number.isSafeInteger(value) ? value : null)
const firstLine = (text) => (typeof text === 'string' ? (text.split('\n')[0] ?? '').trim() : '')
const normalizePath = (value) => value.replace(/^\.\//, '')
const splitZ = (text) => text.split('\0').filter((entry) => entry !== '')
const excerpt = (text, limit = 2048) => {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more bytes]`
}

function requireNonEmptyString(name, value, why) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string — ${why}`)
  }
  return value
}

/**
 * The prompt is part of the contract, not a string literal buried in an adapter: it is where the
 * candidate is told that the worktree is its whole world and that git, not its own answer, decides
 * what changed. Both engines get the same text.
 */
export function buildPrompt({ candidateId, hypothesis, round = 1, worktreeDir }) {
  requireNonEmptyString('candidateId', candidateId, 'the kernel owns candidate identity')
  requireNonEmptyString('hypothesis', hypothesis, 'a landing with no hypothesis is a build step, not a candidate')
  requireNonEmptyString('worktreeDir', worktreeDir, 'the adapter must know the worktree before it can pin cwd to it')
  return [
    'You are the candidate implementer inside an automated model-structure exploration loop.',
    `Candidate ${candidateId}, round ${round}.`,
    '',
    'Hypothesis to land:',
    hypothesis,
    '',
    `Your working directory is this candidate's own git worktree (${worktreeDir}) and it is the only`,
    'place you may write. The outer runner created that worktree and owns every git ref: do not run',
    '`git add`, `git commit`, `git checkout`, `git branch`, `git worktree`, or `git update-ref`, and do',
    'not create or delete refs. The runner derives "which files changed" from `git diff` against the',
    'base commit, and it discards any git state you create.',
    '',
    'Edit the repository so the hypothesis is genuinely implemented. Keep the change minimal, inside',
    'the worktree, and leave the tree buildable.',
    '',
    'Finish your answer with a single JSON object on its own line naming the files you changed, with',
    'paths relative to the worktree:',
    '{"files": ["path/one", "path/two"]}',
    '',
    'That self-report is only a cross-check: git decides what changed, and a report that disagrees',
    'with git fails this landing.',
  ].join('\n')
}

// ------------------------------------------------------------- process

/**
 * Run one CLI process to completion, never letting it outlive the workspace's patience.
 *
 * A hung child is worse than a crashed one: the phase machine has no way to tell a slow model from
 * a stuck one, so `timeoutMs` is enforced here, with a SIGTERM → SIGKILL escalation over the whole
 * process group (a coding harness spawns children of its own).
 *
 * @returns {Promise<{
 *   code: number|null, signal: string|null, stdout: string, stderr: string,
 *   timedOut: boolean, overflowed: boolean, spawnError: Error|null, duration_ms: number,
 * }>}
 */
export function runProcess({
  command,
  args = [],
  cwd,
  input = '',
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  streamCapBytes = DEFAULT_STREAM_CAP_BYTES,
  stderrKeepBytes = MAX_STDERR_BYTES,
  killGraceMs = 5_000,
  spawn = spawnChild,
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let overflowed = false
    let spawnError = null
    let settled = false
    let child = null
    let timeoutTimer = null
    let graceTimer = null

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      resolve({
        code: code === undefined ? null : code,
        signal: signal === undefined ? null : signal,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        overflowed,
        spawnError,
        duration_ms: Date.now() - startedAt,
      })
    }

    // Negative pid = the whole process group, so a harness's grandchildren die with it.
    const signalChild = (signal) => {
      if (child === null || child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // Already gone; 'close' will fire or has fired.
        }
      }
    }

    const abort = (why) => {
      if (settled) return
      if (why === 'timeout') timedOut = true
      if (why === 'overflow') overflowed = true
      signalChild('SIGTERM')
      graceTimer = setTimeout(() => signalChild('SIGKILL'), killGraceMs)
      graceTimer.unref?.()
    }

    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      spawnError = error
      finish(null, null)
      return
    }

    child.on('error', (error) => {
      spawnError = spawnError ?? error
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    child.stdout?.on('data', (chunk) => {
      if (settled || overflowed) return
      outBytes += chunk.length
      if (outBytes > streamCapBytes) {
        const keep = chunk.length - (outBytes - streamCapBytes)
        if (keep > 0) outChunks.push(chunk.subarray(0, keep))
        abort('overflow')
        return
      }
      outChunks.push(chunk)
    })

    // Drain stderr even after the keep-buffer is full: an unread pipe blocks a noisy child forever.
    child.stderr?.on('data', (chunk) => {
      if (errBytes >= stderrKeepBytes) return
      const room = stderrKeepBytes - errBytes
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
      errChunks.push(kept)
      errBytes += kept.length
    })

    child.stdin?.on('error', () => {
      // EPIPE when the child exits before reading its prompt is an outcome, not a crash.
    })
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => abort('timeout'), timeoutMs)
      timeoutTimer.unref?.()
    }
    try {
      child.stdin?.end(input)
    } catch {
      // Same as EPIPE above.
    }
  })
}

// ---------------------------------------------------------------- stream

/**
 * The two engines describe a run with different event vocabularies, but the port only needs three
 * things from the stream: the final text, the outcome subtype, and the spend. Normalising that into
 * one record here is what lets a new engine be a thin adapter instead of a new parser.
 */
function pickResult(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isObject(event)) continue
    if (event.type !== 'result' && event.final !== true) continue
    const text = firstString(event.result, event.text, event.message)
    if (text === undefined) continue
    const usage = isObject(event.usage) ? event.usage : {}
    return {
      event,
      text,
      subtype: typeof event.subtype === 'string' ? event.subtype : 'success',
      session_id: firstString(event.session_id, event.sessionId) ?? null,
      usage: {
        total_cost_usd: numberOrNull(event.total_cost_usd ?? event.totalCostUsd),
        input_tokens: integerOrNull(usage.input_tokens ?? usage.inputTokens),
        output_tokens: integerOrNull(usage.output_tokens ?? usage.outputTokens),
      },
    }
  }
  return null
}

/**
 * Newline-delimited JSON, the one wire format both engines share. Lines that do not parse are kept:
 * "the stream was garbage" and "the stream was fine but ended early" are different failures.
 */
export function parseStream(stdout) {
  const events = []
  const unparsed = []
  const text = typeof stdout === 'string' ? stdout : ''
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      unparsed.push(line)
      continue
    }
    if (isObject(value)) events.push(value)
    else unparsed.push(line)
  }
  return { events, unparsed, result: pickResult(events) }
}

// -------------------------------------------------------- classification

const CREDENTIAL_SIGNAL = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|authenticat/i
const TRANSIENT_SIGNAL = /\b(429|502|503|504)\b|rate.?limit|overloaded|too many requests|econnreset|etimedout|temporar/i
const FAILURE_SUBTYPES = new Set([
  'error',
  'error_max_turns',
  'error_during_execution',
  'error_tool_use',
  'error_budget_exceeded',
  'error_invalid_request',
])

/**
 * Turn one finished process into exactly one class. Precedence is fixed and documented because
 * these overlap: we killed it (timeout/overflow) means the exit code and the stream are both
 * meaningless; a missing binary is not a candidate's fault; a signal kill is a crash; a subtype the
 * engine reported beats our guess from stderr; a non-zero exit beats an empty-tail heuristic.
 *
 * @returns {{ error_class: string, message: string, retryable: boolean }}
 */
export function classify({
  timedOut = false,
  overflowed = false,
  spawnError = null,
  code = 0,
  signal = null,
  stdout = '',
  stderr = '',
  parsed = { events: [], unparsed: [], result: null },
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (timedOut) {
    return {
      error_class: TIMEOUT,
      message: `the harness did not finish within ${timeoutMs} ms and was killed`,
      retryable: false,
    }
  }
  if (overflowed) {
    return {
      error_class: STREAM_OVERFLOW,
      message: 'the harness stream exceeded its byte cap and was killed',
      retryable: false,
    }
  }
  if (spawnError !== null && spawnError !== undefined) {
    const reason = firstLine(spawnError.message) || String(spawnError)
    if (spawnError.code === 'ENOENT') {
      return {
        error_class: HARNESS_UNAVAILABLE,
        message: `the harness binary is not installed: ${reason}`,
        retryable: false,
      }
    }
    return { error_class: CRASH, message: `the harness could not be started: ${reason}`, retryable: false }
  }
  if (signal !== null && signal !== undefined) {
    return { error_class: CRASH, message: `the harness was killed by ${signal}`, retryable: false }
  }

  const subtype = parsed.result?.subtype
  const stderrText = typeof stderr === 'string' ? stderr : ''

  if (code !== 0) {
    if (CREDENTIAL_SIGNAL.test(stderrText)) {
      return {
        error_class: CREDENTIAL,
        message: `the harness could not authenticate (exit ${code}): ${firstLine(stderrText)}`,
        retryable: false,
      }
    }
    if (TRANSIENT_SIGNAL.test(stderrText)) {
      return {
        error_class: TRANSIENT,
        message: `the harness hit a transient upstream failure (exit ${code}): ${firstLine(stderrText)}`,
        retryable: true,
      }
    }
    if (subtype === 'refusal') {
      return { error_class: REFUSAL, message: 'the harness refused the task', retryable: false }
    }
    const named = typeof subtype === 'string' ? ` (subtype ${subtype})` : ''
    return {
      error_class: DETERMINISTIC_FAIL,
      message: `the harness exited ${code}${named}: ${firstLine(stderrText)}`.trim(),
      retryable: false,
    }
  }

  if (subtype === 'refusal') {
    return { error_class: REFUSAL, message: 'the harness refused the task', retryable: false }
  }
  if (FAILURE_SUBTYPES.has(subtype)) {
    return {
      error_class: DETERMINISTIC_FAIL,
      message: `the harness finished with subtype ${subtype}`,
      retryable: false,
    }
  }
  if (parsed.events.length === 0 && typeof stdout === 'string' && stdout.trim() !== '') {
    return {
      error_class: UNPARSEABLE_OUTPUT,
      message: `the harness wrote ${parsed.unparsed.length} line(s) but none was a JSON event: ${firstLine(parsed.unparsed[0])}`,
      retryable: false,
    }
  }
  if (parsed.result === null) {
    return {
      error_class: RESULT_MISSING,
      message: 'the harness exited cleanly without a result event',
      retryable: false,
    }
  }
  return { error_class: OK, message: '', retryable: false }
}

// ------------------------------------------------------------------ git

/** The default git runner. Read-only by construction: the subcommands are allow-listed below. */
export function runGit(args, { cwd, env = process.env } = {}) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) return { ok: false, stdout: '', stderr: String(result.error.message ?? result.error) }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function requireReadOnlyGit(args) {
  const subcommand = args[0]
  if (!READ_ONLY_GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`the harness adapter may only read git state (${READ_ONLY_GIT_SUBCOMMANDS.join(', ')}), not "${subcommand}"`)
  }
}

/**
 * The commit the candidate branched from. `parent_commit` in the identity chain is this commit, so
 * it is resolved from the worktree itself rather than trusted from the caller's string.
 */
export function resolveCommit({ worktreeDir, baseRef, git = runGit }) {
  const args = ['rev-parse', '--verify', `${baseRef}^{commit}`]
  requireReadOnlyGit(args)
  const result = git(args, { cwd: worktreeDir })
  if (result.ok !== true) {
    throw new TypeError(
      `baseRef ${JSON.stringify(baseRef)} does not resolve to a commit inside the candidate worktree: ${firstLine(result.stderr)}`,
    )
  }
  return result.stdout.trim()
}

/**
 * What actually changed, according to git and only git.
 *
 * `git diff <baseRef>` covers modified and deleted tracked files but says nothing about new ones,
 * and a candidate whose whole change is a new module would otherwise report zero files. Untracked
 * paths are therefore unioned in from `git ls-files --others` — still git's answer, still relative
 * to the runner's base ref, never the harness's claim. (The alternative, `git add -A` first, would
 * mutate the runner-owned index, which this adapter must not do.)
 *
 * Sorted and de-duplicated so the event payload is stable across runs.
 */
export function changedFiles({ worktreeDir, baseRef, git = runGit }) {
  const diffArgs = ['diff', '--name-only', '--no-renames', '-z', baseRef]
  requireReadOnlyGit(diffArgs)
  const diff = git(diffArgs, { cwd: worktreeDir })
  if (diff.ok !== true) {
    throw new Error(`cannot read the candidate diff against ${baseRef}: ${firstLine(diff.stderr)}`)
  }
  const untrackedArgs = ['ls-files', '--others', '--exclude-standard', '-z']
  requireReadOnlyGit(untrackedArgs)
  const untracked = git(untrackedArgs, { cwd: worktreeDir })
  if (untracked.ok !== true) {
    throw new Error(`cannot list untracked files in the candidate worktree: ${firstLine(untracked.stderr)}`)
  }
  return [...new Set([...splitZ(diff.stdout), ...splitZ(untracked.stdout)])].sort()
}

// ---------------------------------------------------------- cross-check

/**
 * Read the harness's own file list out of its final answer, if it produced one.
 *
 * Tolerant by design — fenced JSON block, last JSON line, or the whole text — because a model
 * writing prose around its answer is normal and must not be mistaken for a contradiction. A
 * paragraph full of prose parses as "no report", which is honest: the adapter is not entitled to
 * invent a report the harness never made.
 */
export function readSelfReport(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const bodies = []
  for (const match of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)) bodies.push(match[1])
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) bodies.push(lines[index])
  bodies.push(text.trim())

  for (const body of bodies) {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    if (!isObject(parsed) || !Array.isArray(parsed.files)) continue
    const files = parsed.files
      .filter((file) => typeof file === 'string' && file.trim() !== '')
      .map((file) => normalizePath(file.trim()))
    return { files: [...new Set(files)].sort() }
  }
  return null
}

/**
 * Compare the harness's claim with git's answer. Equal sets pass; different sets are a mismatch in
 * which **neither side wins**: the diff stays authoritative, and the disagreement itself is the
 * finding the kernel has to record.
 */
export function crossCheck({ reported, actual }) {
  const changed = [...actual]
  if (reported === null || reported === undefined) {
    return {
      status: 'not_reported',
      reported: null,
      changed,
      missing: [],
      unexpected: [],
      message: 'the harness reported no file list; git is the only source',
    }
  }
  const claimed = new Set(reported)
  const real = new Set(changed)
  const missing = changed.filter((file) => !claimed.has(file))
  const unexpected = reported.filter((file) => !real.has(file))
  if (missing.length === 0 && unexpected.length === 0) {
    return { status: 'match', reported: [...reported], changed, missing, unexpected, message: 'the harness report agrees with git' }
  }
  return {
    status: 'mismatch',
    reported: [...reported],
    changed,
    missing,
    unexpected,
    message: [
      'the harness report disagrees with git:',
      missing.length === 0 ? '' : `git changed ${missing.join(', ')} but the harness never reported it;`,
      unexpected.length === 0 ? '' : `the harness reported ${unexpected.join(', ')} but git sees no change;`,
      'git stays authoritative for the diff, and the disagreement fails the landing',
    ]
      .filter((part) => part !== '')
      .join(' '),
  }
}

// ---------------------------------------------------------------- land

function requireWorktree(worktreeDir) {
  requireNonEmptyString('worktreeDir', worktreeDir, 'the adapter pins the child cwd to it')
  let stat
  try {
    stat = statSync(worktreeDir)
  } catch {
    throw new TypeError(
      `worktreeDir ${JSON.stringify(worktreeDir)} does not exist — the outer runner creates worktrees and refs; the adapter must never create one`,
    )
  }
  if (!stat.isDirectory()) throw new TypeError(`worktreeDir ${JSON.stringify(worktreeDir)} is not a directory`)
}

/**
 * The shared body of every adapter: one process, one worktree, git as the judge of the diff.
 *
 * Caller errors (missing candidate, missing worktree, a base ref that does not resolve) throw a
 * `TypeError`: they are the runner's bug, and rejecting candidates one by one would hide it for
 * hours. Everything attributable to the outside world — a crash, a timeout, a refusal, garbage
 * output, a lying self-report — comes back as `ok: false` plus a class, so the phase machine can
 * reject the candidate instead of waiting forever.
 *
 * @param {{
 *   engine: string,
 *   command: string,
 *   args?: string[],
 *   worktreeDir: string,
 *   baseRef: string,
 *   candidateId: string,
 *   hypothesis: string,
 *   round?: number,
 *   parentId?: string|null,
 *   prompt?: string,
 *   timeoutMs?: number,
 *   streamCapBytes?: number,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: Function,
 *   git?: Function,
 * }} options
 */
export async function landWithCli(options) {
  const {
    engine,
    command,
    args = [],
    worktreeDir,
    baseRef,
    candidateId,
    hypothesis,
    round = 1,
    parentId = null,
    env,
    spawn,
    git = runGit,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    streamCapBytes = DEFAULT_STREAM_CAP_BYTES,
    killGraceMs,
  } = options

  requireNonEmptyString('engine', engine, 'the kernel records which harness landed the candidate')
  requireNonEmptyString('command', command, 'an adapter without a binary is a misconfiguration')
  requireNonEmptyString('candidateId', candidateId, 'the kernel owns candidate identity')
  requireNonEmptyString('hypothesis', hypothesis, 'a landing with no hypothesis is a build step, not a candidate')
  requireNonEmptyString('baseRef', baseRef, 'without a base ref there is no diff, and the diff is the authority')
  if (parentId !== null && parentId !== undefined) {
    requireNonEmptyString('parentId', parentId, 'a parent is an identity the kernel owns, not a guess')
  }
  requireWorktree(worktreeDir)

  const prompt = options.prompt ?? buildPrompt({ candidateId, hypothesis, round, worktreeDir })
  const parentCommit = resolveCommit({ worktreeDir, baseRef, git })

  const outcome = await runProcess({
    command,
    args,
    cwd: worktreeDir,
    input: prompt,
    env: env ?? process.env,
    timeoutMs,
    streamCapBytes,
    ...(killGraceMs === undefined ? {} : { killGraceMs }),
    ...(spawn === undefined ? {} : { spawn }),
  })

  const parsed = parseStream(outcome.stdout)
  const verdict = classify({ ...outcome, parsed, timeoutMs })

  // Even a failed landing reports what it left behind: the worktree may be dirty and the runner has
  // to know that before it reuses or removes it. Best-effort on the failure path — a broken worktree
  // must not mask the failure that came first. On the success path a broken diff is fatal (below):
  // reporting "landed, zero files changed" because git could not be read would be a silent lie.
  let files = []
  let gitFailure = null
  try {
    files = changedFiles({ worktreeDir, baseRef, git })
  } catch (error) {
    gitFailure = error
  }

  const base = {
    engine,
    candidate_id: candidateId,
    parent_id: parentId ?? null,
    parent_commit: parentCommit,
    base_ref: baseRef,
    files,
    files_changed: files.length,
    usage: parsed.result?.usage ?? {
      total_cost_usd: null,
      input_tokens: null,
      output_tokens: null,
    },
    output: parsed.result?.text ?? '',
    session_id: parsed.result?.session_id ?? null,
    duration_ms: outcome.duration_ms,
  }

  if (verdict.error_class !== OK) {
    return {
      ok: false,
      error_class: verdict.error_class,
      message: verdict.message,
      retryable: verdict.retryable,
      conflict: CONFLICT_CLASSES.includes(verdict.error_class),
      cross_check: null,
      exit_code: outcome.code,
      signal: outcome.signal,
      timed_out: outcome.timedOut,
      overflowed: outcome.overflowed,
      stderr_excerpt: excerpt(outcome.stderr),
      ...base,
    }
  }

  if (gitFailure !== null) throw gitFailure

  const report = readSelfReport(base.output)
  const cross = crossCheck({ reported: report === null ? null : report.files, actual: files })
  if (cross.status === 'mismatch') {
    return {
      ok: false,
      error_class: CROSS_CHECK_MISMATCH,
      message: cross.message,
      retryable: false,
      conflict: true,
      cross_check: cross,
      exit_code: outcome.code,
      signal: outcome.signal,
      timed_out: false,
      overflowed: false,
      stderr_excerpt: excerpt(outcome.stderr),
      ...base,
    }
  }

  return {
    ok: true,
    error_class: OK,
    retryable: false,
    conflict: false,
    cross_check: cross,
    exit_code: outcome.code,
    signal: outcome.signal,
    timed_out: false,
    overflowed: false,
    stderr_excerpt: excerpt(outcome.stderr),
    ...base,
  }
}

// -------------------------------------------------------- conformance

const RESULT_KEYS = Object.freeze([
  'ok',
  'error_class',
  'retryable',
  'conflict',
  'engine',
  'candidate_id',
  'parent_id',
  'parent_commit',
  'base_ref',
  'files',
  'files_changed',
  'cross_check',
  'usage',
  'output',
  'session_id',
  'exit_code',
  'signal',
  'timed_out',
  'overflowed',
  'stderr_excerpt',
  'duration_ms',
])

/**
 * The port's conformance contract, as code. Any adapter — the two here, or a third contributed
 * later — is usable by the kernel exactly when its result satisfies this. Keeping it in the port
 * (rather than in a test) is what makes "add an engine, don't touch the kernel" checkable.
 *
 * @returns {{ status: 'ok'|'invalid', message: string, problems: string[] }}
 */
export function validateLandResult(value) {
  const problems = []
  const note = (condition, message) => {
    if (!condition) problems.push(message)
  }

  note(isObject(value), 'the result must be an object')
  if (!isObject(value)) return { status: 'invalid', message: problems.join('; '), problems }

  for (const key of RESULT_KEYS) note(key in value, `missing required field "${key}"`)

  note(typeof value.ok === 'boolean', 'ok must be a strict boolean')
  note(typeof value.engine === 'string' && value.engine !== '', 'engine must be a non-empty string')
  note(
    typeof value.candidate_id === 'string' && value.candidate_id !== '',
    'candidate_id must be a non-empty string',
  )
  note(
    value.parent_id === null || (typeof value.parent_id === 'string' && value.parent_id !== ''),
    'parent_id must be a non-empty string or null — the harness never invents a parent',
  )
  note(
    typeof value.parent_commit === 'string' && /^[0-9a-f]{7,64}$/.test(value.parent_commit),
    'parent_commit must be the git commit object id the candidate branched from',
  )
  note(typeof value.base_ref === 'string' && value.base_ref !== '', 'base_ref must be a non-empty string')

  note(Array.isArray(value.files), 'files must be an array')
  if (Array.isArray(value.files)) {
    note(
      value.files.every((file) => typeof file === 'string' && file !== ''),
      'files must contain non-empty path strings',
    )
    note(
      JSON.stringify(value.files) === JSON.stringify([...value.files].sort()),
      'files must be sorted (deduplicated) so the same landing produces the same event payload',
    )
    note(
      new Set(value.files).size === value.files.length,
      'files must be deduplicated — a repeated path would double-count the landing',
    )
    note(value.files_changed === value.files.length, 'files_changed must equal files.length (git decides the count)')
  }

  note(Number.isSafeInteger(value.duration_ms) && value.duration_ms >= 0, 'duration_ms must be a non-negative integer')
  note(ERROR_CLASSES.includes(value.error_class), `error_class must be one of ${ERROR_CLASSES.join(', ')}`)
  note(typeof value.retryable === 'boolean', 'retryable must be a strict boolean')
  note(typeof value.conflict === 'boolean', 'conflict must be a strict boolean')
  note(isObject(value.usage), 'usage must be an object even when the engine reported nothing')
  note(typeof value.output === 'string', 'output must be a string (possibly empty)')

  if (value.ok === true) {
    note(value.error_class === OK, 'a successful landing must carry error_class "ok"')
    note(value.conflict === false, 'a successful landing is never a conflict')
    note(isObject(value.cross_check), 'a successful landing must carry a cross_check record')
    if (isObject(value.cross_check)) {
      note(
        value.cross_check.status === 'match' || value.cross_check.status === 'not_reported',
        'a successful landing cross-check is "match" or "not_reported" — a mismatch must fail the landing',
      )
    }
  } else {
    note(value.error_class !== OK, 'a failed landing must not claim error_class "ok"')
    note(typeof value.message === 'string' && value.message !== '', 'a failed landing must say what happened')
    note(
      value.error_class !== CROSS_CHECK_MISMATCH || value.conflict === true,
      'a cross-check mismatch is a conflict, not a malformed artifact',
    )
  }

  return { status: problems.length === 0 ? 'ok' : 'invalid', message: problems.join('; '), problems }
}

/**
 * Throwing form of {@link validateLandResult}, for tests and for anyone wiring a new adapter into a
 * conformance suite: a result that fails here must never reach the kernel.
 */
export function assertLandResult(value) {
  const verdict = validateLandResult(value)
  if (verdict.status !== 'ok') {
    throw new Error(`land() result violates the harness port contract: ${verdict.message}`)
  }
  return value
}