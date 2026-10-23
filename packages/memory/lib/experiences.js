/**
 * The promoted-experience corpus: read the files ticket 12 writes, and give each one exactly one
 * home in the packet.
 *
 * The writer is `core/lib/intents.js` (`applyExperience`). It writes one file per promotion —
 * `<workspace>/experiences/<experience_id>.json` — because an experience is a durable artefact, not
 * a row: it survives a wiped cache and an operator can read it. This module is the only reader, so
 * the meaning of that file lives here.
 *
 * Two rules, both about not losing things quietly:
 *
 *   **A section decides the home, and there is only one home.** `guardrails` and `singletons` are
 *   supplied verbatim by the hard quota; `recipes` and `candidate_experiences` go to the strategy
 *   that ranks them. One fact in two places would be counted twice in every turn, so the split is
 *   total and disjoint by construction.
 *
 *   **A file we cannot use is reported, not skipped.** A promotion that vanishes without a line is
 *   how a run silently loses the lesson somebody took the trouble to write down.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The four sections the writer accepts, and the only ones this reader honours. */
export const EXPERIENCE_SECTIONS = Object.freeze(['guardrails', 'singletons', 'recipes', 'candidate_experiences'])

const DEFAULT_SECTION = 'recipes'

/** Mirrors `MAX_TEXT` in `core/lib/intents.js`: the writer's limit is the reader's contract. */
export const MAX_TEXT = 4_000

const FIELDS = Object.freeze(['experience_id', 'section', 'text', 'intent_id', 'promoted_at_ms'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Read every promoted experience in a workspace.
 *
 * @param {string | undefined} workspaceDir
 * @returns {{
 *   items: object[],
 *   rejected: { name: string, path: string, reason: string }[],
 *   missing: boolean,
 *   dir: string | null,
 * }}
 */
export function readExperiences(workspaceDir) {
  if (typeof workspaceDir !== 'string' || workspaceDir === '') return { items: [], rejected: [], missing: true, dir: null }

  const dir = join(workspaceDir, 'experiences')
  let names
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch (error) {
    // No directory means no promotions yet: a fresh workspace is normal, not a failure.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { items: [], rejected: [], missing: true, dir }
    return { items: [], rejected: [{ name: '.', path: dir, reason: `unreadable: ${error?.message ?? String(error)}` }], missing: false, dir }
  }

  const items = []
  const rejected = []
  for (const name of names.sort()) {
    const path = join(dir, name)
    const stem = name.slice(0, -'.json'.length)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      rejected.push({ name, path, reason: `invalid_json: ${error?.message ?? String(error)}` })
      continue
    }
    const complaint = validateExperience(parsed, stem)
    if (complaint !== undefined) {
      rejected.push({ name, path, reason: complaint })
      continue
    }
    items.push({
      experience_id: parsed.experience_id,
      section: parsed.section ?? DEFAULT_SECTION,
      text: parsed.text,
      intent_id: parsed.intent_id,
      promoted_at_ms: parsed.promoted_at_ms,
      name,
      path,
    })
  }
  return { items, rejected, missing: false, dir }
}

/**
 * Shape validation. `expectedId` is the filename stem: a file may not claim an identity other than
 * the name it was planted under, because the id is how the packet dedupes a fact.
 */
export function validateExperience(value, expectedId) {
  if (!isObject(value)) return `not_an_object: expected a JSON object`
  if (typeof value.experience_id !== 'string' || value.experience_id.trim() === '') return 'invalid_experience_id: missing'
  if (expectedId !== undefined && value.experience_id !== expectedId) {
    return `experience_id_mismatch: file is ${JSON.stringify(expectedId)}, file says ${JSON.stringify(value.experience_id)}`
  }
  if (value.section !== undefined && !EXPERIENCE_SECTIONS.includes(value.section)) {
    return `unknown_section: ${JSON.stringify(value.section)} (expected one of ${EXPERIENCE_SECTIONS.join(', ')})`
  }
  if (typeof value.text !== 'string' || value.text.trim() === '') return 'invalid_text: expected a non-empty string'
  if (value.text.length > MAX_TEXT) return `invalid_text: ${value.text.length} characters, limit ${MAX_TEXT}`
  if (value.intent_id !== undefined && (typeof value.intent_id !== 'string' || value.intent_id.trim() === '')) {
    return `invalid_intent_id: ${JSON.stringify(value.intent_id)}`
  }
  if (value.promoted_at_ms !== undefined && !Number.isSafeInteger(value.promoted_at_ms)) {
    return `invalid_promoted_at_ms: ${JSON.stringify(value.promoted_at_ms)}`
  }
  for (const field of Object.keys(value)) {
    // A hand-edited extra field is a misunderstanding of the artefact, and the writer would never
    // produce one. Refusing beats guessing which extra field was meant to matter.
    if (!FIELDS.includes(field)) return `unknown_field: ${field}`
  }
  return undefined
}

/**
 * Split the corpus into the one home each experience has.
 *
 * @param {ReturnType<typeof readExperiences>} corpus
 * @param {{ problems?: object[] }} [options] `problems` collects the rejected files, so they reach
 *   the packet's own report instead of a log nobody reads.
 */
export function splitCorpus(corpus, { problems = [] } = {}) {
  const hard = { guardrails: [], singletons: [] }
  const soft = { recipes: [], candidate_experiences: [] }

  for (const rejected of corpus?.rejected ?? []) {
    problems.push({
      code: 'experience_rejected',
      message: `${rejected.path}: ${rejected.reason}`,
      file: rejected.path,
    })
  }

  for (const item of corpus?.items ?? []) {
    if (item.section === 'guardrails' || item.section === 'singletons') hard[item.section].push(item)
    else soft[item.section].push(item)
  }

  return { hard, soft, rejected: corpus?.rejected ?? [], missing: corpus?.missing === true }
}