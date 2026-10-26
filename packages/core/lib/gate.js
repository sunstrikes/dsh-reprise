/**
 * Gate two, kernel half: the static check report, and the ability to recompute it.
 *
 * The ticket this file exists for says the report is **the kernel's, not the model's**. So everything
 * here is a fact read from the candidate's worktree by code:
 *
 *   syntax            every changed file the kernel has a parser for parses
 *   allowed_surface   every changed file is inside the domain pack's adjustable surface
 *   conflict_markers  no residual merge-conflict markers were committed
 *
 * Three decisions shape it, and each one is about a failure mode rather than the happy path:
 *
 * **The report records the bytes it checked.** Each file carries the sha256 of its content. A reader
 * with the same worktree can re-derive the conclusion instead of trusting this module — which is what
 * `recheckReport` does for a retry, a dump, or a human. A gate record nobody can recompute is a
 * verdict about nothing.
 *
 * **A check that could not run is never a green check.** A file whose language the kernel has no
 * parser for, a file that vanished, a path that escapes the worktree: each is named in `unchecked`.
 * The report still passes — a Python file is not a syntax error — but it never pretends to have
 * looked. `detail` says how many files were parsed and how many were not.
 *
 * **Domain differences are data.** The parser for a file type and the adjustable surface both come
 * from outside this module: the surface from the domain pack, the parsers from an optional map. The
 * kernel ships JSON and JavaScript because it is a JavaScript kernel, and a domain with another
 * language supplies its own parser without an `if` appearing here.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

/** The three checks gate two runs. Named, so a report is comparable across attempts. */
export const GATE_CHECKS = Object.freeze(['syntax', 'allowed_surface', 'conflict_markers'])

/**
 * A recheck's state vocabulary: the contract's four states, and **only** those (CONTEXT §7).
 *
 * The four answer "is this record present and trustworthy", a question about the artifact. A recheck
 * also learns things about the *tree*, and those are not states: "the tree moved on" says nothing
 * about the record — the record was true of the tree it recorded, and that tree is gone — so it is
 * `reproducible: false` with a `reason`, beside a state that stays `ok`.
 */
export const RECHECK_STATES = Object.freeze(['ok', 'missing', 'invalid', 'conflict'])

/**
 * Why a recheck could not reproduce the record. A closed list, because a caller must be able to
 * branch on the reason: a `tree_moved` record may be replaced by a retry, a `checks_disagree` one is
 * a contradiction that a retry cannot fix.
 */
export const RECHECK_REASONS = Object.freeze(['tree_moved', 'no_evidence', 'no_recorded_checks', 'checks_disagree'])

/**
 * How many attempts the gate gets, and how long it waits between them.
 *
 * `max_attempts: 1` restores the single-shot gate a careful operator may want; the default is three
 * because one refusal is not evidence that a candidate is bad — the same "one hiccup, then a person"
 * shape `rounds.retry` already uses for workspace artifacts.
 */
export const DEFAULT_GATE = Object.freeze({ max_attempts: 3, base_ms: 1_000, max_ms: 60_000 })

/**
 * Normalise `config.gate`, refusing to make a bad number look configured.
 *
 * A zero or fractional `max_attempts` would reject every candidate on its first try and look for all
 * the world like a policy, so it is replaced by the default rather than honoured.
 */
export function gateSettings(config) {
  const raw = config?.gate ?? {}
  const positive = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback)
  const base = positive(raw.base_ms, DEFAULT_GATE.base_ms)
  return {
    max_attempts: positive(raw.max_attempts, DEFAULT_GATE.max_attempts),
    base_ms: base,
    max_ms: Math.max(base, positive(raw.max_ms, DEFAULT_GATE.max_ms)),
  }
}

const isText = (value) => typeof value === 'string' && value.trim() !== ''
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const normalise = (path) => path.replace(/\\/g, '/').replace(/^\.\//, '')

// ------------------------------------------------------------ surface match

/**
 * Does a changed path fall inside the declared adjustable surface?
 *
 * Four forms, all of them things a pack author actually writes: an exact path, a directory
 * (`model/`), one path segment (`model/*`), and any depth (`model/**`). An empty whitelist allows
 * nothing — that is what "declared no adjustable surface" means once the caller has decided to check;
 * `staticReport` is where "the domain declared none" is distinguished from "declared none of these".
 */
export function surfaceAllows(path, whitelist) {
  const candidate = normalise(path)
  for (const entry of Array.isArray(whitelist) ? whitelist : []) {
    if (!isText(entry)) continue
    const rule = normalise(entry.trim())
    if (rule === candidate) return true
    if (rule.endsWith('/**')) {
      if (candidate.startsWith(rule.slice(0, -2))) return true
      continue
    }
    if (rule.endsWith('/')) {
      if (candidate.startsWith(rule)) return true
      continue
    }
    if (rule.includes('*')) {
      const pattern = rule
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')
      if (new RegExp(`^${pattern}$`).test(candidate)) return true
    }
  }
  return false
}

// -------------------------------------------------------- conflict markers

const OPEN_MARKER = /^<{7}(\s|$)/
const SEPARATOR = /^={7}$/
const CLOSE_MARKER = /^>{7}(\s|$)/

/**
 * Residual merge-conflict markers, by line.
 *
 * Deliberately strict: an opener (`<<<<<<<`), a separator (`=======`) *while an opener is open*, and a
 * closer. A bare `=======` is a setext heading underline in every markdown file ever written, and
 * failing a candidate for its own documentation would teach people to switch the check off.
 */
export function findConflictMarkers(text) {
  if (typeof text !== 'string') return []
  const found = []
  let open = null
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trimEnd()
    if (OPEN_MARKER.test(trimmed)) {
      open = index + 1
      found.push({ line: index + 1, marker: '<<<<<<<' })
      continue
    }
    if (open !== null && SEPARATOR.test(trimmed)) {
      found.push({ line: index + 1, marker: '=======' })
      continue
    }
    if (CLOSE_MARKER.test(trimmed)) {
      found.push({ line: index + 1, marker: '>>>>>>>' })
      open = null
    }
  }
  return found
}

// ---------------------------------------------------------------- syntax

/**
 * A syntax check per file extension. JSON parses in-process; JavaScript and its module flavours are
 * handed to `node --check`, which is the same answer `scripts/check.mjs` uses for this repository's
 * own sources, so the gate cannot disagree with the build about what parses.
 */
export const DEFAULT_PARSERS = Object.freeze({
  '.json': (content) => {
    JSON.parse(content)
  },
  '.js': (content, { path }) => checkWithNode(content, path),
  '.mjs': (content, { path }) => checkWithNode(content, path),
  '.cjs': (content, { path }) => checkWithNode(content, path),
})

/** `node --check` reads from disk, so the path matters: the caller passes the file it just read. */
function checkWithNode(content, path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.error) throw new Error(result.error.message ?? String(result.error))
  if (result.status !== 0) {
    const reason = String(result.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(-1)[0]
    throw new Error(reason === undefined || reason === '' ? `node --check exited ${result.status}` : reason)
  }
}

const parserFor = (path, parsers) => {
  const lower = path.toLowerCase()
  const extension = lower.slice(lower.lastIndexOf('.'))
  return parsers[extension]
}

/**
 * Read the changed files, staying inside the worktree.
 *
 * A git path is relative to the worktree root and cannot climb out of it, but a symlink or a
 * hand-written event payload could try. `unchecked` names what was refused; nothing outside the
 * worktree is ever opened.
 */
function readChanged({ files, worktreeDir, readFile }) {
  const root = resolve(worktreeDir)
  const contents = new Map()
  const unchecked = []
  for (const path of [...new Set(files.map(normalise))].sort()) {
    const absolute = resolve(root, path)
    const inside = relative(root, absolute)
    if (isAbsolute(path) || inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.startsWith(`..${sep}`)) {
      unchecked.push(path)
      continue
    }
    try {
      contents.set(path, { absolute, content: readFile(absolute) })
    } catch {
      unchecked.push(path)
    }
  }
  return { contents, unchecked }
}

// ---------------------------------------------------------------- report

/**
 * The static check report for one candidate's diff.
 *
 * A pure function of (files, their content, the surface): no clock, no model, no randomness, so two
 * calls over the same tree produce equal objects. That is what makes `recheckReport` meaningful.
 *
 * @param {{
 *   candidateId?: string | null,
 *   files?: string[],
 *   worktreeDir?: string,
 *   surface?: { files?: string[] },
 *   readFile?: (path: string) => string,
 *   parsers?: Record<string, (content: string, context: { path: string }) => void>,
 * }} input
 * @returns {{
 *   candidate_id: string | null,
 *   files: { path: string, digest: string, bytes: number }[],
 *   checks: { name: string, result: 'pass' | 'fail', detail: string }[],
 *   whitelist: string[],
 *   unchecked: string[],
 *   ready_to_submit: boolean,
 * }}
 */
export function staticReport({
  candidateId = null,
  files = [],
  worktreeDir,
  surface,
  readFile = (path) => readFileSync(path, 'utf8'),
  parsers = DEFAULT_PARSERS,
} = {}) {
  const listed = (Array.isArray(files) ? files : []).filter(isText)
  const whitelist = Array.isArray(surface?.files) ? surface.files.filter(isText) : []
  const declared = Array.isArray(surface?.files)

  const { contents, unchecked } = isText(worktreeDir)
    ? readChanged({ files: listed, worktreeDir, readFile })
    : { contents: new Map(), unchecked: [...listed].sort() }

  const evidence = [...contents.entries()]
    .map(([path, { content }]) => ({ path, digest: sha256(content), bytes: Buffer.byteLength(content, 'utf8') }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))

  // syntax: every readable file with a parser must parse. Files the kernel cannot parse are reported
  // as not checked rather than failed — a Python file is not a syntax error just because the kernel
  // is written in JavaScript.
  const syntaxProblems = []
  let parsed = 0
  const unparsed = []
  for (const [path, { absolute, content }] of contents.entries()) {
    const parser = parserFor(path, parsers)
    if (parser === undefined) {
      unparsed.push(path)
      continue
    }
    parsed += 1
    try {
      parser(content, { path: absolute })
    } catch (error) {
      syntaxProblems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const notChecked = [...new Set([...unchecked, ...unparsed])].sort()
  const syntaxDetail =
    syntaxProblems.length > 0
      ? syntaxProblems.join('; ')
      : `${parsed} file(s) parsed` + (notChecked.length > 0 ? `, ${notChecked.length} not checked (${notChecked.join(', ')})` : '')

  // allowed_surface: every changed file — parsed or not — inside the whitelist. A file the kernel
  // could not read is still a file the candidate changed, so the whitelist is checked against the
  // diff, not against what happened to be readable.
  const outOfBounds = listed.map(normalise).filter((path) => !surfaceAllows(path, whitelist))
  const surfaceDetail = !declared
    ? 'the domain declared no adjustable surface, so no changed path can be out of bounds'
    : outOfBounds.length > 0
      ? `${outOfBounds.length} changed file(s) outside the surface: ${outOfBounds.join(', ')} (allowed: ${whitelist.join(', ') || 'nothing'})`
      : `${listed.length} changed file(s), all inside the surface`

  // conflict_markers: only over what was actually read.
  const conflicted = []
  for (const [path, { content }] of contents.entries()) {
    const found = findConflictMarkers(content)
    if (found.length > 0) conflicted.push(`${path}:${found.map((entry) => entry.line).join(',')}`)
  }
  const markerDetail = conflicted.length > 0 ? `residual markers at ${conflicted.join('; ')}` : 'no residual conflict markers'

  const checks = [
    { name: 'syntax', result: syntaxProblems.length > 0 ? 'fail' : 'pass', detail: syntaxDetail },
    { name: 'allowed_surface', result: declared && outOfBounds.length > 0 ? 'fail' : 'pass', detail: surfaceDetail },
    { name: 'conflict_markers', result: conflicted.length > 0 ? 'fail' : 'pass', detail: markerDetail },
  ]

  return {
    candidate_id: candidateId,
    files: evidence,
    checks,
    whitelist,
    unchecked: notChecked,
    ready_to_submit: checks.every((check) => check.result === 'pass'),
  }
}

// ------------------------------------------------------------- recompute

const evidenceOf = (record) => {
  const evidence = record?.evidence
  return evidence !== undefined && evidence !== null && typeof evidence === 'object' && Array.isArray(evidence.files)
    ? evidence
    : undefined
}

/**
 * Recompute a stored gate record from its own evidence.
 *
 * Two questions, answered separately because they are separate questions:
 *
 *   `state`         is the record present and trustworthy — one of the four (CONTEXT §7):
 *                     `ok`        the record is there and recomputes to the same conclusion
 *                     `missing`   it carries no evidence, or names none of the gate's own checks, so
 *                                 nothing can be recomputed — and saying so is not the same as agreeing
 *                     `conflict`  identical bytes produced a *different* conclusion. A deterministic
 *                                 check disagreed with itself, which no retry can fix and a human
 *                                 needs to see
 *
 *   `reproducible`  could the record be reproduced *from the tree as it stands now*, with `reason`
 *                   naming why not. `tree_moved` — a file changed, vanished, or the worktree is gone
 *                   — is **the tree's** answer, not the record's: the record was true of the tree it
 *                   recorded, and that tree is gone, so `state` stays `ok` and this boolean carries
 *                   the news. It is also why a retry can legitimately pass: re-deriving over a moved
 *                   tree is a new measurement, not a contradiction.
 *
 * `invalid` is part of the vocabulary and is never produced here, on purpose: this function is only
 * ever handed a record a `verify_verdict` validator already accepted, so nothing it can find is a
 * schema fault. A malformed record never reaches it. (If that ever stops being true, the answer is an
 * `invalid` with a reason — not a new name beside the four.)
 *
 * @param {any} record a `verify_verdict` artifact
 * @param {{ worktreeDir?: string, readFile?: (path: string) => string, parsers?: Record<string, Function> }} [options]
 * @returns {{ state: 'ok' | 'missing' | 'invalid' | 'conflict', reproducible: boolean, reason: string | null, message: string }}
 */
export function recheckReport(record, { worktreeDir, readFile, parsers } = {}) {
  const evidence = evidenceOf(record)
  if (evidence === undefined) {
    return {
      state: 'missing',
      reproducible: false,
      reason: 'no_evidence',
      message: 'the record carries no evidence, so there is nothing to recompute',
    }
  }

  const recorded = new Map(
    (Array.isArray(record.checks) ? record.checks : [])
      .filter((check) => GATE_CHECKS.includes(check?.name))
      .map((check) => [check.name, check.result]),
  )
  if (recorded.size === 0) {
    return {
      state: 'missing',
      reproducible: false,
      reason: 'no_recorded_checks',
      message: 'the record names none of the gate\'s own checks, so there is nothing to recompute',
    }
  }

  const fresh = staticReport({
    candidateId: record.candidate_id ?? null,
    files: evidence.files.map((file) => file.path),
    worktreeDir,
    surface: evidence.whitelist === undefined || evidence.whitelist === null ? undefined : { files: evidence.whitelist },
    readFile,
    parsers,
  })

  const digests = new Map(fresh.files.map((file) => [file.path, file.digest]))
  const moved = []
  for (const file of evidence.files) {
    const now = digests.get(normalise(file.path))
    if (now === undefined) moved.push(`${file.path} is no longer there`)
    else if (now !== file.digest) moved.push(`${file.path} changed since the record was written`)
  }
  if (moved.length > 0) {
    return {
      state: 'ok',
      reproducible: false,
      reason: 'tree_moved',
      message: `the tree moved since this record was written: ${moved.join('; ')}`,
    }
  }

  const disagreed = []
  for (const [name, result] of recorded) {
    const check = fresh.checks.find((entry) => entry.name === name)
    if (check === undefined) continue
    if (check.result !== result) {
      disagreed.push(`${name} was recorded as ${result} and recomputes as ${check.result}`)
    }
  }
  if (disagreed.length > 0) {
    return {
      state: 'conflict',
      reproducible: false,
      reason: 'checks_disagree',
      message: `the gate record cannot be reproduced from its own evidence: ${disagreed.join('; ')}`,
    }
  }
  return { state: 'ok', reproducible: true, reason: null, message: '' }
}