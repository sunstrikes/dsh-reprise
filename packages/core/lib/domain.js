/**
 * The domain pack: one directory holding everything the kernel is not allowed to know.
 *
 * The kernel owns the phase machine, the four states and the identity chain. It knows no metric name,
 * no model repository, no source file and no prompt — those are differences between domains, and
 * "the difference is data, not an `if`" (spec 领域差异必须是数据) only holds if one place loads them
 * and everything else receives them.
 *
 * A pack is a directory with a manifest (`domain.json`) that names its five parts by relative path:
 *
 *   metric_contract   what "better" means: the primary metric, the guardrail, the ranked objectives,
 *                     how large a difference counts, and how a windowed series is read
 *   priors            the search space, the starting beliefs, the hypothesis classes a plan may use
 *   surface           the adjustable-surface whitelist: the files a candidate may edit, and the
 *                     knobs / symbols inside them
 *   prompts           the five call-site prompts (LAND, VERIFY, CAND_ANALYZE, ROUND_PLAN, ROUND_REFLECT)
 *   executor          how this domain is measured: the argv one job runs, in the candidate's worktree
 *
 * Three rules shape this file, and all three are about the failure mode rather than the happy path:
 *
 *   - **Nothing is inferred from filenames.** A manifest names each part, so the error can say which
 *     field pointed at which missing file. Convention-based discovery would produce "not found" with
 *     no way to tell a typo from a design change.
 *   - **Nothing is loaded half-empty.** A missing prompt, a missing prior list, a self-contradicting
 *     metric contract: each one is refused by name at boot. The dangerous alternative is the quiet
 *     one — a model prompted with no instructions, or a gate comparing against an empty search space,
 *     still answers, and its answer looks exactly like a real one.
 *   - **A pack is self-contained.** Every part must resolve inside the pack directory, so a pack can
 *     be copied into another repository (or shipped as an example) and mean the same thing there.
 *
 * @module
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { isPlainObject } from '@dsh-reprise/contract'

import { resolveMetricContract } from './metric-contract.js'
import { CALL_SITES, loadSkill, skillPath } from './skills.js'
import { EXECUTOR_KINDS } from './warnings.js'

/** The manifest a pack directory starts with. */
export const DOMAIN_MANIFEST = 'domain.json'

/** The manifest version this kernel reads. A newer pack is refused, not guessed at. */
export const DOMAIN_SCHEMA_VERSION = 1

/** The five parts every pack must name. Missing one is a refusal, never an empty default. */
export const PACK_PARTS = Object.freeze(['metric_contract', 'priors', 'surface', 'prompts', 'executor'])

/** What each part is, for the message that says a pack is missing it. */
const PART_LABELS = Object.freeze({
  metric_contract: 'metric contract',
  priors: 'priors',
  surface: 'adjustable-surface whitelist',
  prompts: 'prompt directory',
  executor: 'executor entry',
})

const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isTextList = (value) => Array.isArray(value) && value.length > 0 && value.every(isText)
const textList = (value) => (Array.isArray(value) ? value.every(isText) : false)

/**
 * A pack that cannot be used, with every problem found rather than only the first.
 *
 * `problems` exists so a broken pack is one boot line listing all of them: fixing four files one
 * restart at a time is a bad way to spend an evening.
 */
export class DomainPackError extends Error {
  /**
   * @param {string} dir
   * @param {string[]} problems
   * @param {{name?: string, manifestPath?: string}} [context]
   */
  constructor(dir, problems, { name, manifestPath } = {}) {
    const where = isText(name) ? `the domain pack ${JSON.stringify(name)} at ${dir}` : `the domain pack at ${dir}`
    const first = problems[0] ?? 'no reason was recorded'
    const rest = problems.length > 1 ? ` (and ${problems.length - 1} more problem(s); see .problems)` : ''
    super(`${where} cannot be used: ${first}${rest}`)
    this.name = 'DomainPackError'
    this.packDir = dir
    this.manifestPath = manifestPath
    this.problems = problems
  }
}

/**
 * What an executor entry must be, checked identically whether the pack or the run configuration
 * supplied it — two validators for one shape is how a pack-valid entry becomes run-invalid.
 *
 * @param {unknown} value
 * @param {{label?: string}} [options]
 * @returns {string[]}
 */
export function executorProblems(value, { label = 'executor' } = {}) {
  if (!isPlainObject(value)) return [`${label} must be an object with a kind`]
  const problems = []
  const kind = value.kind ?? 'local'
  if (!EXECUTOR_KINDS.includes(kind)) {
    problems.push(`${label}.kind must be one of ${EXECUTOR_KINDS.join(', ')} (got ${JSON.stringify(value.kind)})`)
  }
  if (kind === 'local' && !isTextList(value.command)) {
    problems.push(
      `${label}.command must be a non-empty argv array — the local executor runs one process per job, ` +
        'e.g. command: ["node", "train.mjs"]',
    )
  }
  if (kind === 'ray' && !isText(value.base_url)) {
    problems.push(`${label}.base_url must be the Ray dashboard URL when ${label}.kind is ray`)
  }
  return problems
}

// ------------------------------------------------------------------ part checks
// Each returns the problems it found, phrased for the file it came from; the caller prefixes the
// path. They check *shape and internal agreement only* — which built-in metric a domain optimises is
// the domain's decision, and a validator that ranked them would be a second contract.

function metricContractProblems(value) {
  if (!isPlainObject(value)) return ['the metric contract must be a JSON object']

  const problems = []
  if (!isText(value.name)) {
    problems.push('name is required — it is the ref every frozen artifact quotes')
  }

  // Everything else is read by the one resolver the ranking, the stop rules and the gate also call. The
  // loader used to carry its own copy of those rules — same intent, different sentences — which is how a
  // pack passes boot and then gets interpreted differently by three readers. So it delegates: the
  // findings below are the resolver's, and the only rule kept here is the one about a *pack* (a manifest
  // part must carry the name frozen artifacts quote, which a run-level restatement need not).
  problems.push(...resolveMetricContract(value).problems.map((problem) => problem.message))
  return problems
}

function priorsProblems(value) {
  if (!isPlainObject(value)) return ['the priors must be a JSON object']
  const problems = []
  if (!isPlainObject(value.search_space)) {
    problems.push('search_space must be an object of named groups — the space a hypothesis may move within')
  }
  if (!Array.isArray(value.priors)) {
    problems.push('priors must be an array of starting beliefs (it may be empty, but it must be declared)')
  }
  if (!Array.isArray(value.hypothesis_classes)) {
    problems.push('hypothesis_classes must be an array — a plan whose class nobody declared cannot be reviewed')
  } else {
    for (const [index, entry] of value.hypothesis_classes.entries()) {
      if (!isPlainObject(entry) || !isText(entry.id)) {
        problems.push(`hypothesis_classes[${index}].id must be a non-empty string`)
      }
    }
  }
  return problems
}

function surfaceProblems(value) {
  if (!isPlainObject(value)) return ['the adjustable-surface whitelist must be a JSON object']
  const problems = []
  if (!isTextList(value.files)) {
    problems.push('files must be a non-empty array of paths — the whitelist a candidate\'s diff is checked against')
  }
  for (const field of ['keys', 'symbols']) {
    if (value[field] !== undefined && !textList(value[field])) {
      problems.push(`${field} must be an array of names when present`)
    }
  }
  return problems
}

// ------------------------------------------------------------------- the loader

/**
 * Read one domain pack from disk, or refuse it by name.
 *
 * @param {string} dir the pack directory (relative paths resolve against the process, so a caller
 *   that has a different base — the run config's `cwd` — resolves first)
 * @returns {Readonly<{
 *   dir: string,
 *   name: string,
 *   schemaVersion: number,
 *   manifest: object,
 *   metricContract: object,
 *   priors: object,
 *   surface: object,
 *   executor: object,
 *   prompts: Map<string, object>,
 *   promptsDir: string,
 *   files: {metricContract: string, priors: string, surface: string, executor: string},
 * }>}
 * @throws {DomainPackError} when a part is missing, unreadable, or does not satisfy its shape
 */
export function loadDomainPack(dir) {
  const packDir = resolve(dir)

  if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
    throw new DomainPackError(packDir, [
      `${packDir} is not a directory — a domain pack is a directory with a ${DOMAIN_MANIFEST} inside it`,
    ])
  }

  const manifestPath = join(packDir, DOMAIN_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new DomainPackError(packDir, [
      `${manifestPath} is missing — a pack declares its metric contract, priors, adjustable surface, ` +
        'prompts and executor entry there; nothing is inferred from filenames',
    ])
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new DomainPackError(packDir, [`${manifestPath} is not valid JSON: ${error?.message ?? error}`], {
      manifestPath,
    })
  }
  if (!isPlainObject(manifest)) {
    throw new DomainPackError(packDir, [`${manifestPath} must contain a JSON object`], { manifestPath })
  }

  const problems = []

  if (manifest.schema_version !== undefined && manifest.schema_version !== DOMAIN_SCHEMA_VERSION) {
    problems.push(
      `${manifestPath}: schema_version ${JSON.stringify(manifest.schema_version)} is not the version this kernel ` +
        `reads (${DOMAIN_SCHEMA_VERSION}) — refusing rather than guessing`,
    )
  }
  if (!isText(manifest.name)) {
    problems.push(`${manifestPath}: name is required — every error about this pack quotes it`)
  }

  // A pack moves as one directory, so every part must live inside it. A `../` part would make the
  // pack a view onto files elsewhere, and copying a pack would silently stop copying its content.
  const partPath = (part) => {
    const declared = manifest[part]
    if (!isText(declared)) {
      problems.push(`${manifestPath}: ${part} is required — the relative path of the pack's ${PART_LABELS[part]}`)
      return undefined
    }
    const resolved = resolve(packDir, declared)
    const inside = relative(packDir, resolved)
    if (isAbsolute(declared) || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      problems.push(
        `${manifestPath}: ${part} must be a path inside the pack (got ${JSON.stringify(declared)}) — ` +
          'a pack has to mean the same thing after it is copied elsewhere',
      )
      return undefined
    }
    return resolved
  }

  const paths = {}
  for (const part of PACK_PARTS) paths[part] = partPath(part)

  /** Parse one JSON part; missing and malformed are both reported against the manifest field. */
  const readJsonPart = (part, check) => {
    const path = paths[part]
    if (path === undefined) return undefined
    if (!existsSync(path)) {
      problems.push(
        `${manifestPath}: ${part} names ${JSON.stringify(manifest[part])}, but ${path} does not exist`,
      )
      return undefined
    }
    let value
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      problems.push(`${path} is not valid JSON: ${error?.message ?? error}`)
      return undefined
    }
    for (const problem of check(value)) problems.push(`${path}: ${problem}`)
    return value
  }

  const metricContract = readJsonPart('metric_contract', metricContractProblems)
  const priors = readJsonPart('priors', priorsProblems)
  const surface = readJsonPart('surface', surfaceProblems)
  const executor = readJsonPart('executor', (value) => executorProblems(value, { label: 'the executor entry' }))

  // The prompts: five markdown files, so a domain expert changes a phase's strategy by editing
  // prose. A missing one is a refusal — a model told nothing still answers, and its answer looks
  // like a real review.
  const promptsDir = paths.prompts
  const prompts = new Map()
  if (promptsDir !== undefined) {
    if (!existsSync(promptsDir) || !statSync(promptsDir).isDirectory()) {
      problems.push(
        `${manifestPath}: prompts names ${JSON.stringify(manifest.prompts)}, but ${promptsDir} is not a directory`,
      )
    } else {
      for (const callSite of CALL_SITES) {
        try {
          prompts.set(callSite, loadSkill(promptsDir, callSite))
        } catch {
          problems.push(
            `${promptsDir}: the ${callSite} prompt is missing or empty — expected a markdown file at ` +
              `${skillPath(promptsDir, callSite)}`,
          )
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new DomainPackError(packDir, problems, { name: manifest.name, manifestPath })
  }

  return Object.freeze({
    dir: packDir,
    name: manifest.name,
    schemaVersion: manifest.schema_version ?? DOMAIN_SCHEMA_VERSION,
    manifest: Object.freeze({ ...manifest }),
    metricContract,
    priors,
    surface,
    executor,
    prompts,
    promptsDir,
    files: Object.freeze({
      metricContract: paths.metric_contract,
      priors: paths.priors,
      surface: paths.surface,
      executor: paths.executor,
      manifest: manifestPath,
    }),
  })
}