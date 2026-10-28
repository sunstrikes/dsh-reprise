/**
 * The run registry behind the dashboard's URLs, and the two writes the page may make.
 *
 * ADR 0002 replaced "one workspace, resolved once at mount" with "a directory of runs": a request says
 * which run it means with `?run=<id>`, and an absent parameter means the registry's **default run** —
 * the one the host ticks — so every URL, bookmark and test that predates the registry keeps meaning
 * what it meant. This module owns that resolution and nothing else about the host: the registry itself
 * is `core/lib/runs.js`, and the projection is `core/lib/projection.js`.
 *
 * Four properties are load-bearing, and each one is a refusal rather than a repair:
 *
 *   - **One resolution rule.** `resolveRun` is the only place an id becomes a directory. An id the
 *     registry does not list is a `ViewError(404)` naming it and pointing at the list — never a silent
 *     fall back to the default, because a page that quietly shows another run is worse than one that
 *     says it cannot find the one you asked for. The registry is the allow-list, so an id is never
 *     joined onto a root: `../`, an absolute path and a name with a slash are unknown, not resolved.
 *   - **The cluster listing belongs to the default run.** `platform` is what the host built from the
 *     configuration of the run it ticks, so any other run's page must say the cluster was not read
 *     instead of printing another run's numbers (ADR 0002's consequences section; T2 moves the listing
 *     per run). The host's `notice` — why *the* run is not ticking — is the same sentence about the
 *     same run, so it travels with `platform` rather than landing on a run it is not about.
 *   - **Reading a run's facts stays read-only.** `withStore` opens one `readOnly` handle per request
 *     and closes it, and the list derives each row from the very projection the overview page draws —
 *     one derivation, so the registry list and the page cannot disagree about a run's phase, its
 *     start time or its best result.
 *   - **The write surface is two paths.** `POST /runs` scaffolds a directory under `runs_root`
 *     (`scaffoldRun`), and `POST /intent` writes one of two things, depending on the kind: a
 *     pause/resume/grant file under `<run>/pending/` that the kernel already consumes (`placeIntent`),
 *     or — for `activate`/`deactivate` — the host-level set of runs this host drives, recorded once
 *     beside the runs (`core/lib/active-runs.js`). Neither writes a fact: a run's own state is only
 *     ever changed by the kernel that read the intent, which is what keeps "who decided this"
 *     answerable from the run directory alone.
 *
 * A run with no `workspace.db` is a legitimate row, not an error: a directory created a second ago has
 * no facts yet, and answering 500 there would make a fresh run look broken on the one page an operator
 * opens right after creating it.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { activeRunIds, setRunActive } from '../../core/lib/active-runs.js'
import { resolveConfig } from '../../core/lib/config.js'
import { IntentRefused, placeIntent } from '../../core/lib/intents.js'
import { overview } from '../../core/lib/projection.js'
import { RUN_CONFIG_FILENAME, readRunConfig, scaffoldRun } from '../../core/lib/runs.js'
import { DB_FILENAME, Store } from '../../core/lib/store.js'
import { ViewError, configFrom } from './views.js'

/**
 * Run one read against a run's own fact plane.
 *
 * A missing database is not an error: a run with no facts yet is exactly what the dashboard shows
 * before the first tick, and answering 500 there would make an empty run look broken. It lives here,
 * beside the registry routes that read many runs, rather than in `routes.js`: a registry route may
 * touch any run in the listing, so this is the helper those routes share — `routes.js` re-exports it
 * for the callers that already import it from there.
 *
 * @param {string} workspace a run's directory
 * @param {(store: Store) => object} read
 * @returns {object | undefined} `undefined` when the run has no facts yet
 */
export function withStore(workspace, read) {
  if (typeof workspace !== 'string' || workspace === '') throw new ViewError(500, 'no workspace configured')
  if (!existsSync(join(workspace, DB_FILENAME))) return undefined
  const store = Store.openReadOnly(workspace)
  try {
    return read(store)
  } finally {
    store.close()
  }
}

/**
 * The sentence an unknown id is refused with. One builder, two readers (`?run=` and `POST /intent`),
 * because the two refusals are the same fact and must not drift into two explanations.
 */
const runsHint = 'GET /api/reprise/runs lists the runs this host knows'

function unknownRun(id) {
  return `no run ${JSON.stringify(id ?? null)} is registered on this host — ${runsHint}`
}

/**
 * Which run a request means.
 *
 * Absent `?run=` is the default run, which is the run every pre-registry URL meant. An id the registry
 * does not list is a 404 that names it; an empty `?run=` is such an id (`""` is not a run), never a
 * quiet default.
 *
 * `dir` is the registry's own answer rather than the raw string the host configured, so a request can
 * only ever read a directory the registry listed. The one exception is a mount with no run at all — a
 * registry with neither `workspace` nor `runs_root`, or both empty — where the pre-registry answer (the
 * configured workspace, or "no workspace configured" from `withStore`) is preserved untouched.
 *
 * @param {ReturnType<typeof import('../../core/lib/runs.js').createRunRegistry>} registry
 * @param {{run?: string}} [query] the parsed query string
 * @param {{workspace?: string}} [fallback] the `workspace` this mount was configured with
 * @returns {{id: string | undefined, dir: string | undefined, isDefault: boolean}}
 */
export function resolveRun(registry, query = {}, { workspace } = {}) {
  const defaultId = registry.defaultRun
  if (query.run === undefined) {
    const dir = defaultId === undefined ? undefined : registry.resolve(defaultId)
    return { id: defaultId, dir: dir ?? workspace, isDefault: true }
  }
  const dir = registry.resolve(query.run)
  if (dir === undefined) throw new ViewError(404, unknownRun(query.run))
  // Naming the default run explicitly means the default run: the page is the same page, and it may
  // still read the cluster listing the host built for it.
  return { id: query.run, dir, isDefault: query.run === defaultId }
}

/**
 * `GET /api/reprise/runs`: every run this host may show, and which one a bare request means.
 *
 * One row per registry entry. The four fact columns come from the overview projection — the same
 * function the overview page draws — so a row and a page cannot disagree about a run. A run with no
 * database answers `has_facts: false` and nulls; a directory whose name is not a run id is not a row at
 * all, it is an entry of `skipped` with the registry's reason, and `runs_root` is `null` when the host
 * configures no root (a deployment that predates the registry).
 *
 * @param {object} registry the run registry
 * @param {{clock?: {now: () => number}}} [options] the instant the rows are read at
 * @returns {{ok: true, runs_root: string | null, default_run: string | null, active: string[],
 *            activation: {status: string, problems: string[]}, runs: object[], skipped: object[]}}
 */
export function runsHandler(registry, { clock = { now: () => Date.now() } } = {}) {
  const now = clock.now()
  // Which runs this host is allowed to drive is the one piece of state that is not a run's own fact
  // (`core/lib/active-runs.js`), so the list answers it beside the facts rather than making the panel
  // ask twice. A host with no `runs_root` has no activation file and, by the same rule, exactly one
  // active run — the one it ticks.
  const activation = activeRunIds({ registry, runsRoot: registry.runsRoot, defaultRun: registry.defaultRun })
  const active = new Set(activation.ids)
  return {
    ok: true,
    runs_root: registry.runsRoot ?? null,
    default_run: registry.defaultRun ?? null,
    active: activation.ids,
    activation: { status: activation.status, problems: activation.problems },
    runs: registry.list().map((entry) => ({ ...runRow(entry, now, active.has(entry.id)) })),
    skipped: registry.skipped(),
  }
}

/** One registry row. The keys are the ADR's, spelled the same way on the wire and in the panel. */
function runRow({ id, dir, source }, now, isActive) {
  const config = readRunConfig(dir)
  const facts = withStore(dir, (store) => overview(store, { config: configFrom(store), now }))
  // One resolution per row, read twice: `resolveConfig` loads the domain pack, and a list read that
  // asked it once per column would multiply that by the number of columns the day one is added.
  const runnable = runnableOf(config, dir)
  return {
    id,
    dir,
    source,
    has_facts: facts !== undefined,
    phase: facts?.workspace?.phase ?? null,
    stopped: facts?.stop?.stopped ?? null,
    started_at_ms: facts?.workspace?.startedAtMs ?? null,
    best: facts?.best ?? null,
    config: { path: config.path, status: config.status, problems: config.problems ?? [] },
    runnable,
    // `active` is the operator's decision; `ticking` is the conjunction that actually costs GPU hours,
    // and keeping them separate is what lets a page say "started, but its configuration is incomplete"
    // instead of showing a switch that is on over a run that cannot move.
    active: isActive,
    ticking: isActive && runnable.ok === true,
  }
}

/**
 * Would this run's configuration boot?
 *
 * A run whose `reprise.toml` parses is asked the same question the host asks at boot — `resolveConfig`,
 * with the run's own directory as the cwd, so a relative `workspace` or `config_file` inside the file
 * resolves against the run and not against the process. A run with no file, or one the reader refused,
 * does not boot by definition; its `problem` is the reader's own words, because a row that says only
 * "not runnable" sends the reader hunting for a fault nobody named.
 */
function runnableOf(config, dir) {
  if (config.status === 'ok') {
    const resolved = resolveConfig(config.value, { cwd: dir })
    return resolved.ok === true ? { ok: true } : { ok: false, problem: resolved.problem }
  }
  if (config.status === 'missing') {
    return { ok: false, problem: `${RUN_CONFIG_FILENAME} is missing from ${dir}, so this run has no configuration to check` }
  }
  const problems = config.problems ?? []
  return { ok: false, problem: problems.length > 0 ? problems.join('; ') : `${config.path} was refused without a reason` }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A number field the create form sends flat on the wire (`max_rounds`, …). Absent or null means "the
 * default", and any other non-number is refused by name: coercing `"4"` to 4 would write a
 * configuration the caller did not send.
 */
function positiveNumber(body, key, { integer }) {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  const whole = Number.isSafeInteger(value) && value > 0
  const any = typeof value === 'number' && Number.isFinite(value) && value > 0
  if (integer ? !whole : !any) {
    throw new ViewError(400, `${key} must be a positive ${integer ? 'whole number' : 'number'} (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * `repo_dir`: a subdirectory *of the run*, which is the one place a create may write.
 *
 * `scaffoldRun` joins this onto the new run's directory, so an absolute path or a `..` would put a
 * clone outside `runs_root` — the thing the ADR forbids outright ("nothing outside it is created or
 * touched"). It is refused here, before a directory exists, rather than after a clone landed.
 */
function runSubdirectory(body, key) {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ViewError(400, `${key} must be a relative directory name (got ${JSON.stringify(value)})`)
  }
  const runDir = resolve('/', '__run__')
  const probe = resolve(runDir, value)
  if (isAbsolute(value) || (probe !== runDir && !probe.startsWith(`${runDir}${sep}`))) {
    throw new ViewError(
      400,
      `${key} must stay inside the run directory (got ${JSON.stringify(value)}) — a run's repository is one of its own subdirectories`,
    )
  }
  return value
}

/**
 * `POST /api/reprise/runs`: create one run under `runs_root`, and answer with what was written.
 *
 * The body is flat — `{id, mode, repo?, domain, repo_dir?, max_rounds?, candidates_per_round?,
 * candidate_gpu_hours?}` — and each field is handed to `scaffoldRun` field for field. There is no
 * nested `rounds`/`budget` shape on purpose: translating between two spellings of one setting is how
 * they start disagreeing. `config` in the answer is the freshly parsed file, read back through the same
 * reader the list uses, so the caller sees what landed rather than what it asked for.
 *
 * Every refusal is one sentence in a 400: `scaffoldRun` only throws refusals, so a thrown sentence is
 * the caller's to read. Nothing here writes outside `runs_root`.
 *
 * @param {object} registry the run registry
 * @param {any} body the parsed JSON body
 * @returns {{ok: true, run: {id: string, dir: string, config: object}}}
 */
export function createRunHandler(registry, body) {
  if (!isPlainObject(body)) throw new ViewError(400, 'the request body must be a JSON object: {id, mode, domain, …}')

  let scaffolded
  try {
    scaffolded = scaffoldRun({
      registry,
      id: body.id,
      mode: body.mode ?? 'empty',
      repo: body.repo ?? undefined,
      domain: body.domain,
      repoDir: runSubdirectory(body, 'repo_dir'),
      maxRounds: positiveNumber(body, 'max_rounds', { integer: true }),
      candidatesPerRound: positiveNumber(body, 'candidates_per_round', { integer: true }),
      candidateGpuHours: positiveNumber(body, 'candidate_gpu_hours', { integer: false }),
    })
  } catch (error) {
    throw new ViewError(400, error?.message ?? String(error))
  }

  return { ok: true, run: { id: body.id, dir: scaffolded.dir, config: readRunConfig(scaffolded.dir) } }
}

/**
 * `POST /api/reprise/intent`: place one intent file for one run.
 *
 * It is not a new protocol — it is the same `pending/<id>.json` the CLI writes and the kernel consumes,
 * produced by the same `placeIntent`, so a button and a command line cannot disagree about what
 * "pause" means. The answer says which of the two things happened (`placed` for a new file, `exists`
 * for an id already on disk: the first writer wins) and where.
 *
 * `activate` and `deactivate` take the same path and the same body but answer `scope: 'host'`: they are
 * not facts of a run, they are the host's decision about which runs it advances at all (T2, ADR 0002).
 *
 * @param {object} registry the run registry
 * @param {any} body the parsed JSON body, `{run, intent}`
 * @returns {{ok: true, status: 'placed'|'exists', path: string}}
 */
export function intentHandler(registry, body) {
  if (!isPlainObject(body)) throw new ViewError(400, 'the request body must be a JSON object: {run, intent}')

  // The same rule the reads use: an id the registry does not list is a 404 naming it. The panel can
  // only ever write into a run it was already allowed to show.
  const dir = registry.resolve(body.run)
  if (dir === undefined) throw new ViewError(404, unknownRun(body.run))

  // Two kinds of intent arrive on one path, because they are one decision made by one person: is this
  // run *watched* (an activation, a host-level record beside the runs) or *dispatched* (a pause or a
  // resume, a file under `<run>/pending/` the kernel consumes)? The kinds differ, so the destination
  // differs, and the answer says which happened.
  const kind = body.intent?.kind
  if (kind === 'activate' || kind === 'deactivate') return activation(registry, body.run, kind === 'activate')

  let placed
  try {
    placed = placeIntent(dir, body.intent)
  } catch (error) {
    // A refusal from the writer has a reason with a name in it (`nothing_to_grant`,
    // `invalid_deadline_ms`, …), and that reason is the answer: an intent file that quietly did
    // nothing would be the one failure this repository refuses to have.
    if (error instanceof IntentRefused) throw new ViewError(400, error.reason)
    throw error
  }
  return { ok: true, scope: 'run', status: placed.status, path: placed.path }
}

/**
 * The host-level half of `POST /intent`: put one run into, or take it out of, the set this host drives.
 *
 * It needs somewhere to record the set — `runs_root` — and it refuses without one rather than starting
 * a run nobody can then find the switch for. Nothing about the run's own facts changes: a run taken out
 * of the set stops being *advanced*, and its fact plane keeps every fact it already had, which is what
 * lets the same run be put back a week later.
 */
function activation(registry, id, activate) {
  if (registry.runsRoot === undefined || registry.runsRoot === null) {
    throw new ViewError(
      400,
      'activating a run needs runs_root: the set of runs this host drives is recorded beside them, and this host has no directory of runs',
    )
  }
  let outcome
  try {
    outcome = setRunActive(registry.runsRoot, id, { activate })
  } catch (error) {
    throw new ViewError(400, error?.message ?? String(error))
  }
  return {
    ok: true,
    scope: 'host',
    status: activate ? 'active' : 'inactive',
    changed: outcome.changed,
    active: outcome.ids,
    path: outcome.path,
  }
}