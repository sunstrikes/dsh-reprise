/**
 * The settings an operator may change from the page, and where they are remembered.
 *
 * Everything else in this plugin is configured in the host's `cordis.patch.yml`, and that is right for
 * what describes the *run this host was mounted for*: a workspace, a domain pack, a model port. Two
 * keys are different in kind — `runs_root` and `max_active_runs` — because they answer questions an
 * operator answers while looking at the page: *where do new runs go?* and *how many may advance at
 * once?* Sending somebody to a console to edit YAML for that is the friction this file removes.
 *
 * Four rules, and the first two are what keep "the page" from becoming a second, undocumented config:
 *
 *   - **One file, one meaning.** `<DSH_HOME>/reprise/settings.json`, written atomically through a
 *     temporary file. It holds *only* the keys the page owns; every other key is refused by name
 *     rather than carried along, so this file can never grow into a shadow of the plugin config.
 *   - **What the page wrote wins, and says so.** A value here outranks the same key in the plugin
 *     configuration — otherwise writing it from the panel would change nothing — and every reader
 *     reports `from: 'settings' | 'config'`, so the boot log and the page can both answer "who set
 *     this?" instead of leaving it to be inferred. Clearing a key (`null` in the request) hands the
 *     question back to the configuration.
 *   - **A malformed file is reported, never defaulted.** Reading a corrupt settings file as "no
 *     settings" would silently move new runs to a different directory; every reader answers
 *     `problems` and the callers log them and fall back to the configuration's value.
 *   - **Nothing here touches a run.** No fact plane, no activation set, no `pending/` file: this is the
 *     plugin's own memory about itself, which is why it is a third write path and not an intent.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** The document's version. A future shape changes it rather than guessing at this one. */
const VERSION = 1

/** The one directory this module writes, relative to the Harness home. */
export const SETTINGS_DIRNAME = 'reprise'

/** The file's name, inside that directory. */
export const SETTINGS_FILENAME = 'settings.json'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/** The keys the page may set, in the order the panel shows them. */
export const SETTINGS_KEYS = Object.freeze(['runs_root', 'max_active_runs'])

/**
 * Where the settings live, or `undefined` on a host that has no home directory to put them in.
 *
 * `DSH_HOME` is the Harness's own answer to "where does this deployment keep its state"; borrowing it
 * rather than inventing a second convention is what makes the file findable by a person who already
 * knows where the host keeps its profile.
 *
 * @param {{env?: Record<string, string | undefined>}} [options]
 * @returns {string | undefined}
 */
export function settingsPath({ env = process.env } = {}) {
  const home = env?.DSH_HOME
  if (!isText(home)) return undefined
  return join(home, SETTINGS_DIRNAME, SETTINGS_FILENAME)
}

/**
 * What the page has decided, or the reason it could not be read.
 *
 * @param {{env?: Record<string, string | undefined>, readFile?: (path: string) => string}} [options]
 * @returns {{status: 'absent', path: string | undefined, value: {}}
 *         | {status: 'ok', path: string, value: object}
 *         | {status: 'invalid', path: string, value: {}, problems: string[]}}
 */
export function readSettings({ env = process.env, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const path = settingsPath({ env })
  if (path === undefined) return { status: 'absent', path: undefined, value: {} }
  if (!existsSync(path)) return { status: 'absent', path, value: {} }

  let text
  try {
    text = readFile(path)
  } catch (error) {
    return { status: 'invalid', path, value: {}, problems: [`${path} could not be read: ${error?.message ?? String(error)}`] }
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { status: 'invalid', path, value: {}, problems: [`${path} is not valid JSON: ${error?.message ?? String(error)}`] }
  }

  const problems = settingsProblems(document, path)
  if (problems.length > 0) return { status: 'invalid', path, value: {}, problems }
  const value = {}
  for (const key of SETTINGS_KEYS) if (document[key] !== undefined) value[key] = document[key]
  return { status: 'ok', path, value }
}

/** Refusals for one settings document, each naming the key and what would be acceptable. */
function settingsProblems(document, path) {
  const problems = []
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return [`${path} must contain a JSON object, not ${Array.isArray(document) ? 'an array' : typeof document}`]
  }
  if (document.v !== VERSION) {
    problems.push(`${path} has version ${JSON.stringify(document.v ?? null)}; this reader writes version ${VERSION}`)
    return problems
  }
  for (const key of Object.keys(document)) {
    if (key === 'v') continue
    if (!SETTINGS_KEYS.includes(key)) {
      problems.push(`${path}: ${JSON.stringify(key)} is not a setting this page owns (it owns ${SETTINGS_KEYS.join(', ')})`)
    }
  }
  if (document.runs_root !== undefined && (!isText(document.runs_root) || !isAbsolute(document.runs_root))) {
    problems.push(`${path}: runs_root must be an absolute directory (got ${JSON.stringify(document.runs_root ?? null)})`)
  }
  if (
    document.max_active_runs !== undefined &&
    (!Number.isSafeInteger(document.max_active_runs) || document.max_active_runs <= 0)
  ) {
    problems.push(`${path}: max_active_runs must be a positive whole number (got ${JSON.stringify(document.max_active_runs ?? null)})`)
  }
  return problems
}

/**
 * Write the settings the page sent, merged over what is already there.
 *
 * `undefined` leaves a key alone and `null` removes it — that is how the page says "go back to what the
 * plugin configuration says" without knowing what that value is. The whole document is replaced
 * through a temporary file, so a crash mid-write leaves the previous decision intact.
 *
 * @param {object} patch `{runs_root?: string | null, max_active_runs?: number | null}`
 * @param {{env?: Record<string, string | undefined>, readFile?: Function,
 *          writeFile?: (path: string, text: string) => void}} [options]
 * @returns {{path: string, value: object, changed: boolean}}
 */
export function writeSettings(patch, { env = process.env, readFile, writeFile = (path, text) => writeFileSync(path, text) } = {}) {
  const path = settingsPath({ env })
  if (path === undefined) {
    throw new Error('there is nowhere to keep settings: DSH_HOME is not set, so this host has no home directory to write into')
  }

  const current = readSettings(readFile === undefined ? { env } : { env, readFile })
  // A corrupt file is refused rather than overwritten: it is the only record of what somebody chose.
  if (current.status === 'invalid') throw new Error(current.problems[0])

  // A key this file does not own is refused rather than dropped: a caller that thinks it saved
  // something must not be told "ok" by a writer that silently ignored it.
  for (const key of Object.keys(patch ?? {})) {
    if (!SETTINGS_KEYS.includes(key)) {
      throw new Error(`${JSON.stringify(key)} is not a setting this page owns (it owns ${SETTINGS_KEYS.join(', ')})`)
    }
  }

  const value = { ...current.value }
  let changed = false
  for (const key of SETTINGS_KEYS) {
    if (!(key in patch)) continue
    const next = patch[key]
    if (next === null) {
      if (key in value) {
        delete value[key]
        changed = true
      }
      continue
    }
    if (value[key] !== next) {
      value[key] = next
      changed = true
    }
  }

  const problems = settingsProblems({ v: VERSION, ...value }, path)
  if (problems.length > 0) throw new Error(problems.join('; '))
  if (!changed) return { path, value, changed: false }

  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFile(temporary, `${JSON.stringify({ v: VERSION, ...value }, null, 2)}\n`)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file is already gone; the write failure is the one worth reporting.
    }
    throw error
  }
  return { path, value, changed: true }
}

/**
 * The two keys as they will actually be used: the page's value where it has one, the plugin
 * configuration's otherwise, and which of the two answered.
 *
 * This is the one function every reader calls — `config.js` at boot, the ticking half on every beat,
 * the settings route when the page asks "what is in force?" — because two derivations of "where do new
 * runs go?" is how the log, the page and the loop start disagreeing.
 *
 * @param {{config: object, env?: Record<string, string | undefined>, readFile?: Function}} options
 *   `config` is a resolved configuration (its own values are the fallbacks).
 * @returns {{runsRoot: string | undefined, runsRootFrom: 'settings' | 'config' | null,
 *            maxActiveRuns: number, maxActiveRunsFrom: 'settings' | 'config',
 *            status: 'absent' | 'ok' | 'invalid', path: string | undefined, problems: string[]}}
 */
export function effectiveSettings({ config = {}, env = process.env, readFile } = {}) {
  const read = readSettings(readFile === undefined ? { env } : { env, readFile })
  const settings = read.value ?? {}

  const configuredRoot = isText(config.runs_root) ? config.runs_root : undefined
  const settingsRoot = isText(settings.runs_root) ? settings.runs_root : undefined
  const runsRoot = settingsRoot ?? configuredRoot

  const configuredMax = config.max_active_runs
  const maxActiveRuns = settings.max_active_runs ?? configuredMax

  return {
    runsRoot,
    runsRootFrom: runsRoot === undefined ? null : settingsRoot === undefined ? 'config' : 'settings',
    maxActiveRuns,
    maxActiveRunsFrom: settings.max_active_runs === undefined ? 'config' : 'settings',
    status: read.status,
    path: read.path,
    problems: read.problems ?? [],
  }
}