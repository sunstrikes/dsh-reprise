/**
 * Which runs this host may show, and which one a request means.
 *
 * The plugin used to answer that question with one string: `config.workspace`, resolved once at
 * mount. One workspace is still one run — that rule does not move — but an operator runs several
 * exploration tasks, and the only way to reach the second one was to edit the profile patch and
 * recompose the host. This module is the replacement: a *directory* of runs plus a few named extras,
 * read fresh on every call so a directory dropped in by hand shows up without a restart.
 *
 * Three properties are load-bearing, and each one is a refusal rather than a repair:
 *
 *   - **A run's identity is its directory's name.** The name has to be a slug
 *     (`[A-Za-z0-9][A-Za-z0-9._-]*`), because it travels in a URL query and ends up as a path segment
 *     in a worktree. A directory named something else is *skipped and reported*, never renamed:
 *     renaming somebody's directory to fit a regular expression is a write nobody asked for.
 *   - **A resolved id may only name a directory the registry already listed.** The lookup is a map
 *     built from the listing, not `join(runsRoot, id)`, so a traversal (`../`, an absolute path, a
 *     name with a slash) is unknown rather than resolved. The registry is the allow-list.
 *   - **Duplicate directories collapse.** `workspace`, `runs[]` and `runsRoot/*` routinely name the
 *     same directory (the run a deployment already ticked is often the first one under its root), and
 *     two rows for one run would let the panel show one run twice with two different ids. Deduplication
 *     is by `realpath`, which is also what makes a symlinked run one run.
 *
 * What is deliberately *not* here: reading a run's facts or its projection (the dashboard's business,
 * `packages/ui/lib/`), and anything that writes. The one write this module owns is the scaffolding a
 * new run needs (`scaffoldRun`), because the file layout of a run — a directory, a repository, one
 * `reprise.toml` — is the same fact the reader depends on.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

import { parseToml } from './toml.js'

/**
 * The id a run is addressable by: the directory's own name, and nothing that could be a path.
 *
 * A leading dot is allowed — `.run` is a perfectly ordinary hidden workspace, and a rule that made
 * somebody's run vanish from the picker because of a dot would be a rule about our convenience rather
 * than about safety. What is refused is what could be a *path*: an empty name, `.`, `..`, a slash (the
 * basename has none by construction, but an id read from a query string might), a space, a NUL.
 */
export const RUN_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]+$/

/** The one configuration file a run carries. Read by this module, written once at creation. */
export const RUN_CONFIG_FILENAME = 'reprise.toml'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const realpathOf = (dir) => {
  try {
    return realpathSync(dir)
  } catch {
    return undefined
  }
}

const isDirectory = (dir) => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * The registry.
 *
 * `workspace` is the run this host ticks (the pre-registry configuration key); it is listed first so
 * a deployment that never sets `runsRoot` gets exactly the one run it always had, and a request that
 * names no run keeps meaning that one. `runs` are extra absolute paths — a run that already lives in
 * a checkout, which is the common case for the demo workspace and for a task directory somebody
 * created by hand. `runsRoot` contributes every subdirectory that is one.
 *
 * @param {{workspace?: string, runsRoot?: string, runs?: string[], cwd?: string}} [options] relative
 *   paths resolve against `cwd`, exactly as the rest of the configuration does.
 * @returns {{
 *   runsRoot: string | undefined,
 *   defaultRun: string | undefined,
 *   list: () => {id: string, dir: string, source: 'workspace'|'runs'|'runs_root'}[],
 *   skipped: () => {dir: string, reason: string}[],
 *   resolve: (id: string) => string | undefined,
 *   contains: (dir: string) => boolean,
 * }}
 */
export function createRunRegistry({ workspace, runsRoot, runs = [], cwd = process.cwd() } = {}) {
  const root = isText(runsRoot) ? resolve(cwd, runsRoot) : undefined
  const extra = (Array.isArray(runs) ? runs : []).filter(isText).map((dir) => resolve(cwd, dir))
  const single = isText(workspace) ? resolve(cwd, workspace) : undefined

  /** Registry order: the ticked run, then `runs[]` in the order declared, then the root's own order. */
  const entries = () => {
    const declared = []
    if (single !== undefined) declared.push({ dir: single, source: 'workspace' })
    for (const dir of extra) declared.push({ dir, source: 'runs' })
    if (root !== undefined) {
      let names = []
      try {
        names = readdirSync(root).sort()
      } catch {
        // A root that does not exist yet is not an error: the panel offers to create the first run
        // in it, and `skipped()` says nothing about a directory nobody made.
        names = []
      }
      for (const name of names) {
        // A dot-directory under the root is not a run list entry — `.git`, `.cache` and `.DS_Store`
        // live there — while a *declared* workspace may well be hidden (`workspace: .run`), which is
        // why this rule is about discovery and not about ids.
        if (name.startsWith('.')) continue
        const dir = join(root, name)
        if (isDirectory(dir)) declared.push({ dir, source: 'runs_root' })
      }
    }

    const seen = new Set()
    const kept = []
    const skipped = []
    for (const entry of declared) {
      const real = realpathOf(entry.dir) ?? entry.dir
      if (seen.has(real)) continue
      seen.add(real)
      const id = entry.dir.slice(entry.dir.lastIndexOf(sep) + 1)
      if (!RUN_ID_PATTERN.test(id)) {
        skipped.push({ dir: entry.dir, reason: `the directory name is not a run id (${JSON.stringify(id)}, wanted ${RUN_ID_PATTERN})` })
        continue
      }
      kept.push({ id, dir: entry.dir, source: entry.source })
    }
    return { kept, skipped }
  }

  const byId = () => {
    const map = new Map()
    for (const entry of entries().kept) if (!map.has(entry.id)) map.set(entry.id, entry.dir)
    return map
  }

  const rootReal = root === undefined ? undefined : realpathOf(root) ?? root

  return {
    runsRoot: root,

    get defaultRun() {
      return entries().kept[0]?.id
    },

    list: () => entries().kept,
    skipped: () => entries().skipped,
    resolve: (id) => (isText(id) ? byId().get(id) : undefined),

    /** Is this directory inside `runsRoot`? The guard every write goes through. */
    contains(dir) {
      if (rootReal === undefined || !isText(dir)) return false
      const real = realpathOf(dir) ?? resolve(dir)
      return real === rootReal || real.startsWith(`${rootReal}${sep}`)
    },
  }
}

/**
 * One run's configuration file, parsed.
 *
 * `status` is 'missing' for a directory that has no `reprise.toml` (a run created by hand, or one
 * whose configuration still lives in the profile patch), 'invalid' when the file is there and the
 * reader refused it, and 'ok' when it parsed to a table. The problems carry the reader's own words —
 * a line number and the construct — because "the run would not start" with no sentence is the state
 * this repository exists to avoid.
 *
 * @param {string} dir the run directory
 * @param {{readFile?: (path: string) => string}} [options] the test seam
 * @returns {{path: string, status: 'ok'|'missing'|'invalid', value?: object, problems?: string[]}}
 */
export function readRunConfig(dir, { readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const path = join(dir, RUN_CONFIG_FILENAME)
  if (!existsSync(path)) return { path, status: 'missing' }

  let text
  try {
    text = readFile(path)
  } catch (error) {
    return { path, status: 'invalid', problems: [`${path} could not be read: ${error?.message ?? String(error)}`] }
  }

  const parsed = parseToml(text)
  if (!parsed.ok) return { path, status: 'invalid', problems: parsed.problems }
  return { path, status: 'ok', value: parsed.value }
}

/**
 * The text of a created run's configuration file.
 *
 * It is deliberately a file a person will edit: comments say what each block is for, the values are
 * the ones the create form collected, and the two blocks a form cannot know (`candidate`, `model`) are
 * present as commented examples rather than as wrong guesses — a run whose implementer is a made-up
 * command would boot and then fail at the first LAND, which is a worse experience than a file saying
 * "fill this in". `workspace = "."` resolves against this file's own directory (the one path rule
 * `run-config.js` states), so the file stays portable with its run.
 *
 * @param {{domain: string, repo?: string, repoDir?: string, maxRounds?: number,
 *          candidatesPerRound?: number, candidateGpuHours?: number}} options
 * @returns {string}
 */
export function runConfigDocument({
  domain,
  repo = 'repo',
  repoDir = 'repo',
  maxRounds = 3,
  candidatesPerRound = 2,
  candidateGpuHours = 0.5,
} = {}) {
  const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return `# ${RUN_CONFIG_FILENAME} — written once, when this run was created. Edit it freely: the loop
# reads it, and never writes it back.

# The run owns this directory. "." resolves against this file's own directory.
workspace = "."
domain = ${quote(domain)}

[runner]
repo = ${quote(repoDir)}          # the repository candidates branch from, inside the run
dir = "worktrees"                 # candidate trees live in <run>/worktrees/<candidate>
base_ref = "HEAD"
keep = true                       # a landed candidate's tree is evidence: nothing removes it

[rounds]
max_rounds = ${Number(maxRounds)}
candidates_per_round = ${Number(candidatesPerRound)}

[budget]
candidate_gpu_hours = ${Number(candidateGpuHours)}
gpu_hours_limit = 0               # 0 = uncapped; a remote executor would be warned about

# Two blocks a form cannot know. Uncomment and fill them in before starting this run; the loop
# refuses to start rounds without them, by name, at boot.
#
# [candidate]
# kind = "command"
# command = ["node", "/absolute/path/to/apply-change.mjs", "{candidate}"]
#
# [model]
# kind = "command"
# command = ["node", "/absolute/path/to/your-model-port.mjs"]
${repo === repoDir ? '' : `\n# Source repository: ${repo}\n`}`
}

/**
 * Scaffold one run under `runsRoot`, and nothing else.
 *
 * Two modes, because the two situations are genuinely different: `clone` copies a repository in (a
 * local path is copied with `--shared` so a run does not duplicate another run's object store), and
 * `empty` only lays down the directory and its configuration, for a run whose repository arrives
 * later. Both refuse rather than repair: an existing directory, a clone that fails, a write that
 * cannot land — each is a thrown error the route turns into one sentence.
 *
 * The one thing this never does is delete. A half-built run stays on disk to be inspected, because
 * the alternative — tidying away the evidence of a failure — is how a bug becomes unreproducible.
 *
 * @param {{
 *   registry: ReturnType<typeof createRunRegistry>,
 *   id: string, mode: 'clone'|'empty', repo?: string, domain: string,
 *   repoDir?: string, maxRounds?: number, candidatesPerRound?: number, candidateGpuHours?: number,
 *   git?: (args: string[], options: {cwd: string}) => {status: number|null, stderr?: string|Buffer, error?: Error},
 * }} options
 * @returns {{dir: string, configPath: string, cloned: boolean}}
 */
export function scaffoldRun({
  registry,
  id,
  mode = 'empty',
  repo,
  domain,
  repoDir,
  maxRounds,
  candidatesPerRound,
  candidateGpuHours,
  git,
}) {
  const root = registry?.runsRoot
  if (root === undefined) throw new Error('creating a run needs runs_root: there is no directory to create it in')
  if (!isText(id) || !RUN_ID_PATTERN.test(id)) {
    throw new Error(`the run id must match ${RUN_ID_PATTERN} (got ${JSON.stringify(id ?? null)}) — it becomes the directory name and a URL parameter`)
  }
  if (!isText(domain) || !isAbsolute(domain)) {
    throw new Error(`domain must be the absolute path of a domain pack (got ${JSON.stringify(domain ?? null)}) — a relative path would resolve against the host, not the run`)
  }
  if (mode !== 'clone' && mode !== 'empty') throw new Error(`mode must be "clone" or "empty" (got ${JSON.stringify(mode)})`)
  if (mode === 'clone' && !isText(repo)) throw new Error('mode "clone" needs repo: the repository this run explores (an absolute path or a git URL)')

  const dir = join(root, id)
  if (existsSync(dir)) throw new Error(`a run directory already exists at ${dir}`)
  if (!registry.contains(root)) throw new Error(`runs_root ${root} could not be resolved, so nothing was created`)

  const target = join(dir, repoDir ?? 'repo')
  mkdirSync(dir, { recursive: true })

  let cloned = false
  if (mode === 'clone') {
    const gitRun = git ?? ((args, options) => spawnSync('git', args, { encoding: 'utf8', ...options }))
    const local = isAbsolute(repo)
    const args = local ? ['clone', '--shared', repo, target] : ['clone', repo, target]
    const result = gitRun(args, { cwd: dir })
    if (result?.error || result?.status !== 0) {
      const said = String(result?.stderr ?? result?.error?.message ?? '').trim() || 'git said nothing'
      throw new Error(`the repository ${repo} could not be cloned into ${target}: ${said}`)
    }
    cloned = true
  }

  const configPath = join(dir, RUN_CONFIG_FILENAME)
  writeFileSync(
    configPath,
    runConfigDocument({ domain, repo: repo ?? repoDir, repoDir, maxRounds, candidatesPerRound, candidateGpuHours }),
  )

  return { dir, configPath, cloned }
}