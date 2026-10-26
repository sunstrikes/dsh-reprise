#!/usr/bin/env node
/**
 * Build `dsh-reprise-<version>.tgz` — the one artifact a stranger can install with one command.
 *
 * Why this exists. `dsh plugin add github:sunstrikes/dsh-reprise#path:/packages/core` cannot work,
 * and neither reason is fixable from inside this repository:
 *
 *  1. `packages/core` depends on its siblings as `workspace:*`, a spec only the monorepo can
 *     resolve. A profile is not that workspace, so pnpm stops at
 *     `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.
 *  2. Replacing those specs with git specs that point at the sibling directories is worse: pnpm 11
 *     refuses *every* git or tarball dependency below the root (`block-exotic-subdeps`, on by
 *     default) with `ERR_PNPM_EXOTIC_SUBDEP`. On pnpm 10, which resolves them, the installed tree is
 *     still broken — `packages/ui/lib` reaches into `packages/core/lib` by relative path, which no
 *     package manager's layout preserves. A plugin whose siblings are not on npm therefore cannot be
 *     resolved from a git URL at all.
 *
 * So the release carries its dependencies instead of asking for them. The sibling packages are copied
 * to `vendor/packages/` **at their monorepo paths**, which is what keeps those `../../core/lib/*.js`
 * imports working untouched, and every `@dsh-reprise/*` specifier in the copied JavaScript is
 * rewritten to a relative path — resolved through the owning package's own `exports` map, so a
 * subpath export lands on the file it names rather than on a guess. The built manifest has no
 * `dependencies` at all: nothing to resolve, no build approval to grant, and the install is a copy.
 *
 * What it does not do: bump the version, publish, or create a release. It writes the tarball; a
 * maintainer attaches it to a GitHub Release, and the listing points at it with `tarball:`.
 *
 * Usage: `node scripts/build-release.mjs [--out <dir>]` (default `dist/`, already gitignored).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = join(ROOT, 'packages')
/** The package that carries `dsh.bundle` — the directory a stranger would have named in the URL. */
const ENTRY = 'core'
/** Where a vendored sibling sits. `packages/<dir>` → `<stage>/vendor/packages/<dir>`. */
const VENDOR = 'vendor'

const say = (line = '') => process.stdout.write(`${line}\n`)
const fail = (message) => {
  process.stderr.write(`\n✖ ${message}\n\n`)
  process.exit(1)
}
const slash = (path) => path.split(sep).join('/')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Every `packages/*` directory with a manifest, keyed by directory name and by package name. */
function survey() {
  const byDir = new Map()
  const byName = new Map()
  for (const dirent of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const dir = join(PACKAGES, dirent.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    const entry = { dir: dirent.name, base: dir, manifest }
    byDir.set(dirent.name, entry)
    byName.set(manifest.name, entry)
  }
  return { byDir, byName }
}

/**
 * The paths one package publishes: its `files` list, with the one wildcard form the manifests use
 * (`locale/*.json`) expanded. An entry that is absent is skipped rather than fatal — npm's own packer
 * ignores those too, and several manifests list a `README.md` their directory does not have; the only
 * hard failure is a package that would publish nothing at all.
 */
function publishablePaths(pkg) {
  const out = []
  for (const entry of pkg.manifest.files ?? ['lib']) {
    const star = entry.indexOf('*')
    if (star === -1) {
      if (existsSync(join(pkg.base, entry))) out.push(entry)
      continue
    }
    const prefix = entry.slice(0, star).replace(/\/$/, '')
    const suffix = entry.slice(star + 1)
    const dir = join(pkg.base, prefix)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!suffix || name.endsWith(suffix)) out.push(join(prefix, name))
    }
  }
  if (out.length === 0) fail(`packages/${pkg.dir}: nothing to publish — every path in "files" is missing`)
  return out
}

/** Resolve a bare subpath through a package's `exports` map, exactly as Node would. */
function exportTarget(pkg, subpath, where) {
  const exports = pkg.manifest.exports
  if (exports === undefined) {
    if (subpath === '.') return pkg.manifest.main ?? 'index.js'
    fail(`${where}: "${pkg.manifest.name}${subpath.slice(1)}" has no "exports" map to resolve through`)
  }
  if (typeof exports === 'string') {
    if (subpath !== '.') fail(`${where}: "${pkg.manifest.name}" exports only its root`)
    return exports
  }
  if (typeof exports[subpath] === 'string') return exports[subpath]
  // A pattern key (`./fixtures/*`) is the only other form the manifests use.
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value !== 'string' || !key.includes('*')) continue
    const [head, tail] = key.split('*')
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue
    const middle = subpath.slice(head.length, subpath.length - tail.length)
    return value.replace('*', middle)
  }
  fail(`${where}: "${pkg.manifest.name}" does not export ${subpath} — the release cannot rewrite it`)
}

const SPECIFIER = /(\bfrom\b|\bimport\b|\brequire\b)(\s*\(?\s*)(['"])([^'"\n]+)\3/g

/**
 * Rewrite one file's specifiers. Two cases reach across a package boundary and need the staged copy:
 * a bare `@dsh-reprise/*` (resolved through the target package's exports map) and a relative path
 * that leaves its own package (resolved against the source tree, then mapped to where that package
 * was staged). Everything else — `node:*`, registry packages, same-package relatives — is left
 * exactly as it is, because the staged layout inside a package is byte-for-byte the source layout.
 */
function rewrite(source, sourcePath, stagePath, own, world) {
  let changed = 0
  const body = source.replace(SPECIFIER, (match, keyword, gap, quote, specifier) => {
    const emit = (absolute) => {
      changed += 1
      return `${keyword}${gap}${quote}${relativeSpecifier(dirname(stagePath), world.stagePathFor(absolute, sourcePath))}${quote}`
    }
    if (specifier.startsWith('@dsh-reprise/')) {
      const [scope, name, ...rest] = specifier.split('/')
      if (name === undefined) fail(`${relative(ROOT, sourcePath)}: cannot read the package name in "${specifier}"`)
      const target = world.byName.get(`${scope}/${name}`)
      if (target === undefined) {
        fail(`${relative(ROOT, sourcePath)}: "${specifier}" names a package the release does not carry — add it to packages/ or drop the import`)
      }
      const subpath = rest.length > 0 ? `./${rest.join('/')}` : '.'
      return emit(join(target.base, exportTarget(target, subpath, relative(ROOT, sourcePath))))
    }
    if (!specifier.startsWith('.')) return match
    const absolute = resolve(dirname(sourcePath), specifier)
    const inside = !relative(own.base, absolute).startsWith('..')
    if (inside) return match
    if (!existsSync(absolute)) fail(`${relative(ROOT, sourcePath)}: "${specifier}" points at a file that does not exist`)
    return emit(absolute)
  })
  return { body, changed }
}

function relativeSpecifier(fromDir, to) {
  const rel = slash(relative(fromDir, to))
  return rel.startsWith('.') ? rel : `./${rel}`
}

async function main() {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const outDir = resolve(outIndex === -1 ? join(ROOT, 'dist') : argv[outIndex + 1])

  const world = survey()
  const entry = world.byDir.get(ENTRY)
  if (entry === undefined) fail(`packages/${ENTRY} is missing, so there is no bundle to build`)

  // The siblings to carry: the entry's declared @dsh-reprise/* dependencies, transitively — the same
  // edges `scripts/check.mjs` holds the manifests to, read here rather than hard-coded.
  const carry = new Set([ENTRY])
  const queue = [ENTRY]
  while (queue.length > 0) {
    const pkg = world.byDir.get(queue.shift())
    for (const name of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (!name.startsWith('@dsh-reprise/')) continue
      const sibling = world.byName.get(name)
      if (sibling === undefined) fail(`packages/${pkg.dir} depends on "${name}", which is not a package in this repository`)
      if (carry.has(sibling.dir)) continue
      carry.add(sibling.dir)
      queue.push(sibling.dir)
    }
  }

  const stageRoot = mkdtempSync(join(tmpdir(), 'dsh-reprise-release-'))
  const stage = join(stageRoot, 'package')
  mkdirSync(stage, { recursive: true })

  /** `packages/core` → the staged root; every carried sibling → `<stage>/vendor/packages/<dir>`. */
  const stageBaseOf = (dir) => (dir === ENTRY ? stage : join(stage, VENDOR, 'packages', dir))
  world.stagePathFor = (absolute, where) => {
    for (const pkg of world.byDir.values()) {
      const rel = relative(pkg.base, absolute)
      if (rel.startsWith('..') || resolve(pkg.base, rel) !== absolute) continue
      if (!carry.has(pkg.dir)) {
        fail(`${where}: reaches into packages/${pkg.dir}, which the release does not carry`)
      }
      return join(stageBaseOf(pkg.dir), rel)
    }
    fail(`${where}: ${absolute.replace(ROOT, '.')} is outside packages/*, so the release cannot carry it`)
  }
  world.ownerOf = new Map() // staged .js path → the package directory it came from

  // 1. Copy every carried package's publishable paths, then index the staged JavaScript by owner.
  //    The example patch rides along for the entry: `files` does not list it (only a publisher needs
  //    those, not an installer), but the README's "worked example" points at it and an installed
  //    tarball is where a stranger looks for it first.
  const extraPaths = (dir) =>
    dir === ENTRY ? ['cordis.example.yml'].filter((path) => existsSync(join(entry.base, path))) : []
  const stageFileList = (dir) => [...publishablePaths(world.byDir.get(dir)), ...extraPaths(dir)]
  const stagedJs = []
  for (const dir of carry) {
    const pkg = world.byDir.get(dir)
    const base = stageBaseOf(dir)
    mkdirSync(base, { recursive: true })
    for (const rel of stageFileList(dir)) {
      cpSync(join(pkg.base, rel), join(base, rel), { recursive: true })
    }
    writeFileSync(join(base, 'package.json'), `${JSON.stringify(pkg.manifest, void 0, 2)}\n`)
    for (const walk of walkJs(base)) {
      world.ownerOf.set(walk, dir)
      stagedJs.push(walk)
    }
  }

  // 2. Rewrite, in the staged tree, using the source path of the same file for resolution.
  let rewrites = 0
  for (const stagePath of stagedJs) {
    const dir = world.ownerOf.get(stagePath)
    const pkg = world.byDir.get(dir)
    const sourcePath = join(pkg.base, relative(stageBaseOf(dir), stagePath))
    const { body, changed } = rewrite(readFileSync(sourcePath, 'utf8'), sourcePath, stagePath, pkg, world)
    if (changed === 0) continue
    writeFileSync(stagePath, body)
    rewrites += changed
  }

  // 3. Prove the rewrite rather than assert it: nothing still names a package to resolve, everything
  //    parses, and every rewritten specifier resolves from where it now sits.
  for (const stagePath of stagedJs) {
    const text = readFileSync(stagePath, 'utf8')
    for (const [, , , , specifier] of text.matchAll(SPECIFIER)) {
      if (specifier.startsWith('@dsh-reprise/')) {
        fail(`${slash(relative(stage, stagePath))} still imports "${specifier}" — the release would need that package resolved`)
      }
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(stagePath), specifier)
      if (!existsSync(target) || !target.startsWith(stage + sep)) {
        fail(`${slash(relative(stage, stagePath))} imports "${specifier}", which does not exist in the tarball`)
      }
    }
    try {
      execFileSync(process.execPath, ['--check', stagePath], { stdio: 'pipe' })
    } catch (error) {
      fail(`${slash(relative(stage, stagePath))} does not parse after rewriting — ${String(error.stderr ?? error.message).split('\n')[0]}`)
    }
  }

  // 4. The manifest the tarball ships: the entry's own, minus the monorepo, plus what it now carries.
  const root = readJson(join(ROOT, 'package.json'))
  const files = [...stageFileList(ENTRY), VENDOR]
  const manifest = {
    name: entry.manifest.name,
    version: entry.manifest.version,
    type: entry.manifest.type ?? 'module',
    description: entry.manifest.description,
    license: entry.manifest.license ?? root.license,
    ...entry.manifest.engines === undefined && root.engines === undefined ? {} : { engines: entry.manifest.engines ?? root.engines },
    main: entry.manifest.main,
    exports: entry.manifest.exports,
    files,
    dsh: entry.manifest.dsh,
    ...entry.manifest.private === true ? { private: true } : {}
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, void 0, 2)}\n`)
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    fail(`${manifest.name}: the built manifest still declares dependencies — the tarball must need none`)
  }
  if (manifest.dsh?.bundle === undefined) fail(`${manifest.name}: the built manifest lost "dsh.bundle", so it would not be installable`)

  // 5. Pack with npm — it is Node's own tarball writer, so a maintainer needs nothing extra.
  mkdirSync(outDir, { recursive: true })
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--pack-destination', outDir, '--json', '--ignore-scripts'], { cwd: stage, encoding: 'utf8' }),
  )
  const tarball = join(outDir, packed.filename)
  // npm reports these relative to the package root, without the tarball's `package/` prefix.
  for (const required of ['cordis.patch.yml', 'lib/index.js', 'package.json']) {
    if (!packed.files.some((file) => file.path === required)) fail(`${packed.filename} is missing ${required}`)
  }
  if (!packed.files.some((file) => file.path.startsWith(`${VENDOR}/packages/`))) {
    fail(`${packed.filename} carries no vendored sibling — the rewrite would have nothing to resolve`)
  }

  rmSync(stageRoot, { recursive: true, force: true })

  say('')
  say(`release   ${slash(relative(ROOT, tarball))}  (${(packed.size / 1024).toFixed(0)} KB, ${packed.entryCount} files)`)
  say(`carries   ${[...carry].filter((dir) => dir !== ENTRY).map((dir) => `/packages/${dir}`).join(', ') || '(no siblings)'} under ${VENDOR}/packages/`)
  say(`rewrote   ${rewrites} specifier(s) in ${stagedJs.length} module(s); every one resolves inside the tarball`)
  say(`install   dsh plugin --profile web add ${slash(relative(process.cwd(), tarball))}`)
  say('')
  say('attach    the tarball to a GitHub Release. Keep the asset name version-free if you want the')
  say('          `latest/download/` form: that path resolves "latest" at request time but reads the')
  say('          filename literally, so a versioned name 404s on the next release.')
  say('')
}

/** Every `.js` file under a directory, recursively. */
function walkJs(dir) {
  const out = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name)
    if (dirent.isDirectory()) out.push(...walkJs(path))
    else if (dirent.name.endsWith('.js')) out.push(path)
  }
  return out
}

await main()