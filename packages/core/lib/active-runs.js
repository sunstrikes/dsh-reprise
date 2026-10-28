/**
 * Which runs this host actually drives — the one piece of state that is not a run's own fact.
 *
 * A registry can list twenty runs; a machine may only be allowed to advance two. That decision belongs
 * to the host, not to any run: a run's fact plane records what happened *to it*, and "nobody has
 * started me yet" is not something that happened to it. So the set of active runs lives in one small
 * file beside the runs — `<runs_root>/.reprise-host.json` — and it is written the same way any other
 * decision of this system is written: as a file, atomically, with the previous content replaced rather
 * than edited in place.
 *
 * Three rules, and the third is the one that matters for money:
 *
 *   - **Absent file means "only the run the configuration ticks".** A deployment that never activates
 *     anything behaves exactly as it did before the registry existed — no run of theirs starts
 *     spending because a directory appeared next to it.
 *   - **A malformed file is reported, never defaulted.** Silently reading a corrupt activation set as
 *     "everything is active" would start jobs the operator did not start; reading it as "nothing is
 *     active" would stop a night shift. The reader answers `problems` and the caller decides.
 *   - **Writing is a full replace through a temporary file.** A crash mid-write leaves the old set
 *     intact; there is no state in which half the ids are gone.
 *
 * What is deliberately *not* here: starting, stopping or suspending a run that is already active. That
 * is a `pause`/`resume` **intent** under `<run>/pending/`, consumed by the kernel, because a paused run
 * is still watched — it just does not dispatch. This module only answers "should this host be ticking
 * this run at all?".
 *
 * @module
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the host keeps the set, relative to `runs_root`. Hidden, so a registry scan never lists it. */
export const HOST_STATE_FILENAME = '.reprise-host.json'

/** The version this reader writes. A future shape changes it rather than guessing at this one. */
const VERSION = 1

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * The active set, as recorded.
 *
 * @param {string | undefined} runsRoot the directory of runs, or `undefined` when this host has none
 * @param {{readFile?: (path: string) => string}} [options] the test seam
 * @returns {{status: 'absent', ids: undefined}
 *         | {status: 'ok', ids: string[], path: string}
 *         | {status: 'invalid', ids: undefined, path: string, problems: string[]}}
 *   `absent` is not an error: it is a host that has never activated anything.
 */
export function readHostState(runsRoot, { readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  if (!isText(runsRoot)) return { status: 'absent', ids: undefined }
  const path = join(runsRoot, HOST_STATE_FILENAME)
  if (!existsSync(path)) return { status: 'absent', ids: undefined }

  let text
  try {
    text = readFile(path)
  } catch (error) {
    return { status: 'invalid', ids: undefined, path, problems: [`${path} could not be read: ${error?.message ?? String(error)}`] }
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { status: 'invalid', ids: undefined, path, problems: [`${path} is not valid JSON: ${error?.message ?? String(error)}`] }
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { status: 'invalid', ids: undefined, path, problems: [`${path} must contain a JSON object, not ${Array.isArray(document) ? 'an array' : typeof document}`] }
  }
  if (document.v !== VERSION) {
    return {
      status: 'invalid',
      ids: undefined,
      path,
      problems: [`${path} has version ${JSON.stringify(document.v ?? null)}; this reader writes version ${VERSION}`],
    }
  }
  if (!Array.isArray(document.active) || !document.active.every(isText)) {
    return { status: 'invalid', ids: undefined, path, problems: [`${path}: "active" must be an array of run ids`] }
  }

  // The archive log rides in the same file: one record of what this host was told, in one place, so a
  // run that was moved aside is still nameable after its directory stopped being one.
  const trashed = document.trashed ?? []
  if (
    !Array.isArray(trashed) ||
    !trashed.every((entry) => typeof entry === 'object' && entry !== null && isText(entry.id) && isText(entry.dir))
  ) {
    return { status: 'invalid', ids: undefined, path, problems: [`${path}: "trashed" must be an array of {id, dir} records`] }
  }

  // Order is the operator's, duplicates are not: a set is a set, and writing the same id twice would
  // make "how many runs is this host driving?" answerable two ways.
  return { status: 'ok', ids: [...new Set(document.active)], trashed, path }
}

/**
 * Add or remove one id, and write the whole set back.
 *
 * Idempotent in both directions (`activate` of an active id returns the set unchanged rather than
 * failing), because the caller is a button: a double click must not be an error, and a page that
 * re-reads after a failed write must be able to retry the same request.
 *
 * @param {string} runsRoot
 * @param {string} id
 * @param {{activate: boolean, readFile?: Function, writeFile?: (path: string, text: string) => void}} options
 * @returns {{ids: string[], changed: boolean, path: string}}
 */
export function setRunActive(runsRoot, id, { activate, readFile, writeFile = (path, text) => writeFileSync(path, text) } = {}) {
  if (!isText(runsRoot)) throw new Error('activating a run needs runs_root: there is no directory to record it in')
  if (!isText(id)) throw new Error('activating a run needs its id')

  const current = readHostState(runsRoot, { readFile })
  // A corrupt file is refused rather than overwritten: it is the only record of what this host was
  // told to do, and replacing it silently would erase a decision somebody made.
  if (current.status === 'invalid') throw new Error(current.problems[0])

  const ids = current.ids ?? []
  const has = ids.includes(id)
  if (has === activate) return { ids, changed: false, path: join(runsRoot, HOST_STATE_FILENAME) }

  const next = activate ? [...ids, id] : ids.filter((entry) => entry !== id)
  const path = writeHostState(runsRoot, { active: next, trashed: current.trashed ?? [] }, { writeFile })
  return { ids: next, changed: true, path }
}

/**
 * One record of a run that was moved aside, appended to the same file.
 *
 * The archive is not a deletion: the directory still exists, one level away, and this entry is what
 * makes it findable a week later ("where did run 7 go?" → `.trash/7-2026-10-28T…`). Keeping it beside
 * the activation set is deliberate — both are this host's own memory, and a second file would be a
 * second thing to remember to back up.
 *
 * @param {string} runsRoot
 * @param {{id: string, dir: string, trashed_to: string, at_ms: number}} entry
 * @param {{readFile?: Function, writeFile?: (path: string, text: string) => void}} [options]
 * @returns {{trashed: object[], path: string}}
 */
export function recordTrash(runsRoot, entry, { readFile, writeFile = (path, text) => writeFileSync(path, text) } = {}) {
  if (!isText(runsRoot)) throw new Error('recording a removed run needs runs_root')
  const current = readHostState(runsRoot, readFile === undefined ? {} : { readFile })
  if (current.status === 'invalid') throw new Error(current.problems[0])
  const trashed = [...(current.trashed ?? []), entry]
  const path = writeHostState(runsRoot, { active: current.ids ?? [], trashed }, { writeFile })
  return { trashed, path }
}

/**
 * The one writer: replace the whole document through a temporary file, so a crash mid-write leaves the
 * previous decision intact.
 */
function writeHostState(runsRoot, { active, trashed }, { writeFile }) {
  const path = join(runsRoot, HOST_STATE_FILENAME)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFile(temporary, `${JSON.stringify({ v: VERSION, active, trashed }, null, 2)}\n`)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file is already gone; the write failure below is the one worth reporting.
    }
    throw error
  }
  return path
}

/**
 * Which runs a host with this registry should drive.
 *
 * The default is the run the configuration ticks and nothing else — that single case is what every
 * pre-registry deployment does, and it must stay the behaviour of an absent file. A run that is active
 * but whose configuration cannot be resolved is *not* silently dropped here; this function only answers
 * the activation question, and the caller reports the run it could not start.
 *
 * @param {{registry: object, runsRoot?: string, defaultRun?: string, readFile?: Function}} options
 * @returns {{ids: string[], status: 'absent'|'ok'|'invalid', problems: string[]}}
 */
export function activeRunIds({ registry, runsRoot, defaultRun, readFile }) {
  const state = readHostState(runsRoot, readFile === undefined ? {} : { readFile })
  const known = new Set(registry.list().map((entry) => entry.id))
  const fallback = defaultRun === undefined ? [] : [defaultRun]

  if (state.status === 'absent') return { ids: fallback.filter((id) => known.has(id)), status: 'absent', problems: [] }
  if (state.status === 'invalid') {
    return { ids: fallback.filter((id) => known.has(id)), status: 'invalid', problems: state.problems }
  }
  // An id that is no longer in the registry is dropped from the *answer* but kept in the file: the
  // directory may come back, and forgetting a decision because a mount went missing is how an
  // operator's night shift stops without anybody being told.
  return { ids: state.ids.filter((id) => known.has(id)), status: 'ok', problems: [] }
}