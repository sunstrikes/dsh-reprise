/**
 * The candidate's tree as the job package: what to ship, what to leave behind, and the inventory
 * that proves the two accounts of "what changed" agree.
 *
 * Three facts shape this module, and none of them is a style choice:
 *
 *  1. **There is no shared filesystem between this machine and the node.** The only inbound channel
 *     is the Ray Job Submission API, so the candidate's worktree has to travel as the job's
 *     `runtime_env.working_dir` package. That makes the packer part of the execution path: if it
 *     ships the base commit, the run measures a model nobody edited.
 *  2. **The fact plane must not travel.** The workspace directory this plugin owns holds an SQLite
 *     fact plane, and a node would open it with a process that must never write it. The exclusion
 *     list is therefore *data* — `FACT_PLANE_EXCLUSIONS`, each entry carrying its reason — so that
 *     adding a fact-plane path is one line of data rather than one more `if` buried in a walker.
 *  3. **Git, not us, says what changed.** `git diff --name-only <baseRef>` plus `git ls-files
 *     --others --exclude-standard`, both run in the candidate worktree, neither touching the index.
 *     A candidate that only *adds* a module is the normal shape of a structural hypothesis, so
 *     untracked files are part of the answer — and every one of them is named in the receipt, either
 *     as shipped or as excluded with a reason.
 *
 * The two checks the ticket asks for bracket the archive: `collectInventory()` before packing and
 * `compareInventories()` on the archive read back (the archive is a zip we can itemise, and the node
 * runs the same comparison from the shipped manifest). A disagreement is a **`conflict`** — the fact
 * plane contradicting itself — and it stops the submission. It is never `invalid`: nothing about the
 * candidate's artifact is malformed, the two accounts of it simply do not match, and that is a
 * finding a human needs rather than a candidate to reject.
 *
 * Refusals are *conclusions*, not exceptions with a stack trace: `{ok: false, conclusion, message}`
 * names the limit that was hit or the paths that disagree, because the alternative — shipping an
 * oversized or divergent tree and letting the job fail three minutes into a GPU reservation — is
 * exactly the "hard run" the ticket forbids.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestOfArchive, readZip, writeZip } from './zip.js'

/** The path every package puts its own bookkeeping under. Reserved: a tree's copy is never shipped. */
export const PACKAGE_METADATA_PREFIX = '.reprise/'
/** The manifest the node-side verifier compares the unpacked tree against. */
export const PACKAGE_MANIFEST_PATH = `${PACKAGE_METADATA_PREFIX}archive.json`
/** The verifier the entrypoint runs first; it prints `REPRISE_INVENTORY {…}` and fails the job. */
export const PACKAGE_VERIFIER_PATH = `${PACKAGE_METADATA_PREFIX}verify_inventory.py`

/**
 * What a job package must never carry, with the reason attached.
 *
 * The first four are the workspace's fact plane (spec: 事实面 is a directory the plugin owns and
 * everything else treats as read-only). `.git` is a worktree *pointer* on the laptop and a broken
 * repository on a node, so it is metadata rather than code. `.reprise/` is this packer's own prefix,
 * reserved so a job can never be confused about where its manifest came from.
 *
 * Patterns: `name` matches a path segment anywhere, `*.ext` matches a file name suffix, `dir/`
 * matches a directory anywhere in the tree, and any other `*` matches inside one segment.
 */
export const FACT_PLANE_EXCLUSIONS = Object.freeze([
  { pattern: '*.db', why: 'the workspace SQLite fact plane — a node must read it through a fact, never open it' },
  { pattern: '*.db-wal', why: 'SQLite write-ahead log: part of the fact plane, meaningless without its database' },
  { pattern: '*.db-shm', why: 'SQLite shared-memory index: a per-process file that must not be copied anywhere' },
  { pattern: '.mnemon/', why: 'the workspace-scoped memory source: a second account of the run, and read-only outside the plugin' },
  { pattern: '.git', why: 'version control metadata: a worktree pointer resolved on a laptop points at nothing on a node' },
  { pattern: PACKAGE_METADATA_PREFIX, why: 'reserved for this packer, so a shipped manifest can never be a candidate file' },
])

/** Why a run stops instead of shipping something it cannot vouch for. */
export const PACKAGE_CONCLUSIONS = Object.freeze({
  ok: 'ok',
  archive_too_large: 'archive_too_large',
  inventory_conflict: 'inventory_conflict',
})

/** 64 MiB. Not a cluster limit (the package upload is its own request) — a "this is not a code change" limit. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * Does this relative path match one exclusion? Returns the entry that matched, so a caller can report
 * *which* rule dropped a file rather than only that something did.
 *
 * @param {string} path relative, `/`-separated
 * @param {{pattern: string, why: string}[]} [exclusions]
 */
export function isExcluded(path, exclusions = FACT_PLANE_EXCLUSIONS) {
  const normalised = path.replace(/^\.\//, '')
  const segments = normalised.split('/')
  const base = segments.at(-1) ?? ''
  for (const entry of exclusions) {
    const pattern = entry.pattern
    if (pattern.endsWith('/')) {
      const directory = pattern.slice(0, -1)
      if (segments.slice(0, -1).includes(directory)) return entry
      continue
    }
    if (pattern.startsWith('*.')) {
      if (base.endsWith(pattern.slice(1))) return entry
      continue
    }
    if (pattern.includes('*')) {
      const source = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')
      if (new RegExp(`^${source}$`).test(normalised) || new RegExp(`^${source}$`).test(base)) return entry
      continue
    }
    if (base === pattern || segments.includes(pattern)) return entry
  }
  return undefined
}

/** Default git runner: a read-only subprocess, pinned so a user's `diff.noprefix` cannot change the answer. */
function defaultGit(args, { cwd }) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

/**
 * `collectInventory` cannot be lazy about `core.quotepath`: git escapes non-ASCII names by default,
 * and a quote-escaped path is a path the archive would never contain.
 */
const GIT_CONFIG = ['-c', 'core.quotepath=false']

function gitLines(run, args, cwd, what) {
  const result = run([...GIT_CONFIG, ...args], { cwd })
  if (result?.error) throw new Error(`the packer could not run \`git ${args.join(' ')}\` in ${cwd}: ${result.error.message}`)
  if (result?.status !== 0) {
    throw new Error(
      `\`git ${args.join(' ')}\` failed in ${cwd} (exit ${result?.status}): ${String(result?.stderr ?? '').trim() || 'git said nothing'}`,
    )
  }
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * What the runner's git says changed, relative to the base ref it branched the worktree from.
 *
 * `deleted` is a separate answer on purpose: a path git lists as changed that is no longer in the
 * tree is a deletion, not a file the packer forgot. Without that split, deleting a module would read
 * as an inventory conflict on every candidate that tidies up.
 *
 * @param {{worktreeDir: string, baseRef: string, git?: Function}} options
 * @returns {{changed: string[], untracked: string[], deleted: string[]}}
 */
export function collectInventory({ worktreeDir, baseRef, git }) {
  if (typeof worktreeDir !== 'string' || worktreeDir === '') throw new TypeError('collectInventory needs a worktreeDir')
  if (typeof baseRef !== 'string' || baseRef === '') {
    throw new TypeError('collectInventory needs a baseRef: what changed is the runner\'s git diff against the ref it branched from, never our own guess')
  }
  const run = git ?? defaultGit
  const changedAll = gitLines(run, ['diff', '--name-only', baseRef], worktreeDir, 'diff')
  const untracked = gitLines(run, ['ls-files', '--others', '--exclude-standard'], worktreeDir, 'ls-files')
  const offline = (path) => {
    try {
      lstatSync(join(worktreeDir, path))
      return false
    } catch {
      return true
    }
  }
  const deleted = changedAll.filter(offline)
  const changed = changedAll.filter((path) => !deleted.includes(path))
  return { changed, untracked, deleted }
}

/** Every regular file in the tree, minus the exclusion list, in a stable order. */
function walk(worktreeDir, exclusions) {
  const files = []
  const excluded = []
  const skipped = []

  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: toPosix(relative(worktreeDir, directory)), why: `unreadable directory (${error?.code ?? error})` })
      return
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = join(directory, entry.name)
      const path = toPosix(relative(worktreeDir, absolute))
      const excludedBy = isExcluded(path, exclusions)
      if (excludedBy !== undefined) {
        // A directory exclusion covers its contents; reporting the directory is what makes the
        // receipt readable, and the per-file detail would be a second, longer list.
        if (entry.isDirectory()) excluded.push({ path: `${path}/`, pattern: excludedBy.pattern, why: excludedBy.why })
        else excluded.push({ path, pattern: excludedBy.pattern, why: excludedBy.why })
        continue
      }
      if (entry.isSymbolicLink()) {
        skipped.push({ path, why: 'symbolic link: a zip cannot promise it resolves to the same bytes on another machine' })
        continue
      }
      if (entry.isDirectory()) {
        visit(absolute)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ path, why: 'not a regular file' })
        continue
      }
      try {
        const stats = statSync(absolute)
        files.push({ path, absolute, bytes: stats.size, executable: (stats.mode & 0o111) !== 0 })
      } catch (error) {
        skipped.push({ path, why: `unreadable (${error?.code ?? error})` })
      }
    }
  }

  visit(worktreeDir)
  return { files, excluded, skipped }
}

const toPosix = (path) => path.split(sep).join('/')

/**
 * Compare what was packed with what came back — the archive read back on this machine, and (as the
 * shipped manifest) the tree the node unpacks. One function, both callers, because a check that
 * lives in two implementations is a check that can disagree with itself.
 *
 * `untracked_missing` is broken out from `missing` on purpose: a brand-new module that did not
 * arrive is the candidate's entire change going missing, and it deserves its own line in the
 * finding rather than a footnote in a list of paths.
 *
 * @param {{changed: string[], untracked: string[], entries: {path: string, sha256: string}[]}} pre
 * @param {{path: string, sha256: string}[]} post
 */
export function compareInventories(pre, post) {
  const after = new Map(post.map((entry) => [entry.path, entry.sha256]))
  const before = new Map(pre.entries.map((entry) => [entry.path, entry.sha256]))
  const missing = pre.entries.filter((entry) => !after.has(entry.path)).map((entry) => entry.path)
  const altered = pre.entries
    .filter((entry) => after.has(entry.path) && after.get(entry.path) !== entry.sha256)
    .map((entry) => entry.path)
  const extra = post.filter((entry) => !before.has(entry.path)).map((entry) => entry.path)
  const untrackedMissing = pre.untracked.filter((path) => missing.includes(path))
  const conflict = [...new Set([...missing, ...altered, ...extra])]
  return { ok: conflict.length === 0, conflict, missing, altered, extra, untracked_missing: untrackedMissing }
}

function manifestFor({ baseRef, inventory, entries }) {
  return {
    schema_version: 1,
    kind: 'reprise-job-package',
    base_ref: baseRef,
    // Every path git says changed, and every path git does not know yet, named in the document the
    // node reads. If the node's copy disagrees with this, the job stops instead of training on a
    // tree nobody described.
    changed: inventory.changed,
    untracked: inventory.untracked,
    deleted: inventory.deleted,
    excluded: inventory.excluded,
    entries: entries.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
  }
}

const VERIFIER_SOURCE = readFileSync(fileURLToPath(new URL('./verify-inventory.py', import.meta.url)), 'utf8')

/**
 * Pack one candidate worktree into the archive that will travel.
 *
 * @param {{
 *   worktreeDir: string,
 *   baseRef: string,
 *   git?: Function,
 *   exclusions?: {pattern: string, why: string}[],
 *   maxBytes?: number,
 *   verify?: {command: string[]} | false,
 * }} options `verify` ships the node-side checker and returns the argv that runs it; `false` ships a
 *   bare tree (a caller that does not control the entrypoint, e.g. a laptop executor)
 */
export function packCandidate({
  worktreeDir,
  baseRef,
  git,
  exclusions = FACT_PLANE_EXCLUSIONS,
  maxBytes = DEFAULT_MAX_ARCHIVE_BYTES,
  verify = { command: ['python3'] },
} = {}) {
  const inventory = collectInventory({ worktreeDir, baseRef, git })
  const { files, excluded, skipped } = walk(worktreeDir, exclusions)
  const withExclusions = { ...inventory, excluded, skipped }

  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  if (total > maxBytes) {
    const largest = [...files]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 5)
      .map((file) => ({ path: file.path, bytes: file.bytes }))
    return {
      ok: false,
      conclusion: PACKAGE_CONCLUSIONS.archive_too_large,
      inventory: withExclusions,
      largest,
      message:
        `the candidate tree is ${total} bytes, over the ${maxBytes}-byte job-package limit; ` +
        `the largest files are ${largest.map((file) => `${file.path} (${file.bytes})`).join(', ')}`,
    }
  }

  const entries = []
  const contents = new Map()
  for (const file of files) {
    let content
    try {
      content = readFileSync(file.absolute)
    } catch (error) {
      skipped.push({ path: file.path, why: `unreadable (${error?.code ?? error})` })
      continue
    }
    const entry = {
      path: file.path,
      bytes: content.length,
      sha256: sha256Of(content),
      executable: file.executable,
    }
    entries.push(entry)
    contents.set(entry.path, content)
  }

  const manifest = manifestFor({ baseRef, inventory: withExclusions, entries })
  const zipEntries = entries.map((entry) => ({
    path: entry.path,
    content: contents.get(entry.path),
    mode: entry.executable ? 0o755 : 0o644,
  }))
  if (verify !== false) {
    zipEntries.push({ path: PACKAGE_MANIFEST_PATH, content: `${JSON.stringify(manifest, null, 2)}\n`, mode: 0o644 })
    zipEntries.push({ path: PACKAGE_VERIFIER_PATH, content: VERIFIER_SOURCE, mode: 0o755 })
  }
  const archive = writeZip(zipEntries)

  // The check, in the only form available on this side of the boundary: the archive we are about to
  // upload is unpacked and compared with the tree that produced it. A zip that lost a path, mangled
  // a name or dropped a digest is caught here, before a GPU is reserved.
  const unpacked = readZip(archive)
    .filter((entry) => !entry.path.startsWith(PACKAGE_METADATA_PREFIX))
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
  const comparison = compareInventories({ ...withExclusions, entries }, unpacked)

  // The second half of the same question: is every changed-or-untracked path either in the archive
  // or explicitly left out? A file present in the tree, named by git, and absent from both lists is
  // the silent drop this ticket exists to prevent.
  const shipped = new Set(entries.map((entry) => entry.path))
  // Only a declared exclusion excuses a changed path. A path the walker *skipped* (a symlink, an
  // unreadable file) is exactly the case where the tree we send is not the tree git describes, so it
  // stays a conflict instead of quietly joining the exclusions.
  const leftOut = new Set(excluded.map((entry) => entry.path.replace(/\/$/, '')))
  const dropped = [...inventory.changed, ...inventory.untracked].filter((path) => !shipped.has(path) && !leftOut.has(path))
  const conflict = [...new Set([...comparison.conflict, ...dropped])]

  if (conflict.length > 0) {
    return {
      ok: false,
      conclusion: PACKAGE_CONCLUSIONS.inventory_conflict,
      inventory: withExclusions,
      conflict,
      comparison,
      message:
        `the archive and the runner's git diff disagree about ${conflict.length} path(s): ${conflict.join(', ')} — ` +
        'the two accounts of what changed must match before a job runs',
    }
  }

  return {
    ok: true,
    conclusion: PACKAGE_CONCLUSIONS.ok,
    archive,
    sha256: digestOfArchive(archive),
    bytes: archive.length,
    entries,
    inventory: withExclusions,
    manifest,
    comparison,
    verify: verify === false ? undefined : { command: [...verify.command, PACKAGE_VERIFIER_PATH], manifest: PACKAGE_MANIFEST_PATH },
  }
}

/**
 * The name the package is uploaded under: flat, `.zip`, and content-addressed.
 *
 * Flat because Ray's package route has no wildcard — `a/b.zip` matches nothing and answers 404.
 * Content-addressed because a name that ignores the content lets two candidates overwrite each
 * other's package, and one that changed on every pack leaves an object behind per submission.
 */
export function packageNameFor({ submissionId, sha256 }) {
  if (typeof submissionId !== 'string' || submissionId === '') throw new TypeError('packageNameFor needs a submissionId')
  if (typeof sha256 !== 'string' || sha256.length < 12) throw new TypeError('packageNameFor needs the archive digest')
  const slug = submissionId.replace(/[^A-Za-z0-9_.-]/g, '-')
  return `reprise-${slug}-${sha256.slice(0, 12)}.zip`
}
/**
 * Why a submission stopped before it started.
 *
 * A class rather than a plain `Error` because the caller has to tell two very different situations
 * apart: "the cluster is down" (retry later) and "this candidate's tree cannot be shipped as it
 * stands" (retrying changes nothing). `retryable` is the answer, and `conclusion` is the sentence an
 * operator reads — `archive_too_large` with the files that made it too large, or
 * `inventory_conflict` with the paths the two accounts disagree about.
 */
export class PackageRefusedError extends Error {
  /**
   * @param {{conclusion: string, message: string, inventory?: object, conflict?: string[],
   *   largest?: {path: string, bytes: number}[]}} detail
   */
  constructor({ conclusion, message, ...detail }) {
    super(message)
    this.name = 'PackageRefusedError'
    this.conclusion = conclusion
    /** Nothing about a refused package changes by waiting: the tree is what it is. */
    this.retryable = false
    Object.assign(this, detail)
  }
}
