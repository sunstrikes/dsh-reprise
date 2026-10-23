#!/usr/bin/env node
/**
 * Step 1 of the five-minute path: check the toolchain, then make `packages/*` importable — one
 * command, no network, no package manager.
 *
 * Why this exists. `packages/core/lib/*` imports its siblings by package name (`@dsh-reprise/exec`,
 * `@dsh-reprise/ui`, …), and a plain git clone has no `node_modules` at all. In a full pnpm workspace
 * `pnpm install` creates those links properly, and this script does nothing but confirm it; on a
 * machine without pnpm (or offline), it creates the same links itself. Both routes end at the same
 * check: **can the kernel actually be imported from the repository root?** If that import fails,
 * nothing further in the five-step path can work, so this is the one place worth failing loudly.
 *
 * What it does, in order:
 *
 *   1. checks the Node version — the fact plane uses `node:sqlite`, which needs Node 22.5+;
 *   2. links every workspace package into `<repo>/node_modules/@dsh-reprise/`, skipping whatever is
 *      already there (a development checkout may point `node_modules` at a host profile's module
 *      tree; that tree is left alone, because writing into a shared profile because a checkout was
 *      stale is the kind of side effect that is hard to undo);
 *   3. imports `packages/core/lib/loop.js` to prove the links are sufficient;
 *   4. reports whether the two host modules the *test suite* needs (`cordis` and its timer plugin) are
 *      reachable. They ship with the DeepSeek Harness profile; the laptop path never needs them.
 *
 * Idempotent: running it twice prints the same verdict and changes nothing.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const nodeModules = join(root, 'node_modules')

/** Needed by `npm test` (the host-lifecycle tests), not by the laptop path. */
const HOST_LINKS = Object.freeze(['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-timer'])

const say = (line = '') => process.stdout.write(`${line}\n`)

const major = (version) => Number.parseInt(String(version).replace(/^v/, '').split('.')[0], 10)

function linked(name) {
  const path = join(nodeModules, name)
  try {
    const stat = lstatSync(path)
    return { exists: true, target: stat.isSymbolicLink() ? readlinkSync(path) : path }
  } catch {
    return { exists: false }
  }
}

/** Every package the workspace declares, by its manifest name — never a hard-coded list. */
function workspacePackages() {
  const packagesDir = join(root, 'packages')
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(packagesDir, entry.name)
      try {
        return { name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, dir }
      } catch {
        return undefined
      }
    })
    .filter((entry) => entry !== undefined && typeof entry.name === 'string')
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function main() {
  say(`repo      ${root}`)
  say(`node      ${process.version}`)

  if (major(process.version) < 22) {
    say('')
    say(`FAILED: Node ${process.version} is too old. The fact plane uses node:sqlite (Node 22.5+).`)
    say('        Install Node 24 or newer and run this again.')
    return 1
  }
  if (major(process.version) === 22) {
    say('note      Node 22 works but warns that node:sqlite is experimental; Node 24 is the tested version')
  }

  const sharedTree = (() => {
    try {
      return lstatSync(nodeModules).isSymbolicLink() ? readlinkSync(nodeModules) : undefined
    } catch {
      return undefined
    }
  })()
  if (sharedTree !== undefined) {
    say(`node_modules  is a symlink to ${sharedTree} (development checkout) — leaving that tree alone`)
  } else {
    mkdirSync(nodeModules, { recursive: true })
  }

  say('')
  say('workspace packages')
  const missing = []
  for (const { name, dir } of workspacePackages()) {
    const existing = linked(name)
    if (existing.exists) {
      say(`  present        ${name}`)
      continue
    }
    if (sharedTree !== undefined) {
      // A shared module tree that lacks a workspace package: still linkable, but it means the
      // profile and this checkout disagree. Link into the profile only if the profile has no entry;
      // otherwise leave it and report, so a stranger sees the mismatch instead of a silent shadow.
      missing.push(name)
      say(`  missing        ${name}  (not in ${sharedTree})`)
      continue
    }
    mkdirSync(dirname(join(nodeModules, name)), { recursive: true })
    symlinkSync(dir, join(nodeModules, name), 'dir')
    say(`  linked         ${name} -> ${dir}`)
  }

  if (missing.length > 0) {
    say('')
    say(`note      ${missing.length} workspace package(s) are absent from the shared module tree.`)
    say('          `pnpm install` in this checkout creates them; the laptop path below needs none of')
    say('          the host modules, so it can still run.')
  }

  // The check that matters: can the kernel be imported with what is on disk right now?
  try {
    await import(pathToFileURL(join(root, 'packages', 'core', 'lib', 'loop.js')).href)
  } catch (error) {
    say('')
    say(`FAILED: packages/core/lib/loop.js cannot be imported (${error?.message ?? error}).`)
    say('        If you have pnpm, `pnpm install` then run this again.')
    return 1
  }
  say('  verified       packages/core/lib/loop.js imports cleanly')

  say('')
  say('host modules (only needed for `npm test`)')
  for (const name of HOST_LINKS) {
    if (linked(name).exists) {
      say(`  present        ${name}`)
      continue
    }
    const fromProfile = join(homedir(), '.dsh', 'profiles', 'node_modules', name)
    if (!existsSync(fromProfile)) {
      say(`  absent         ${name}  (ships with the DeepSeek Harness profile)`)
      continue
    }
    if (sharedTree === undefined) {
      mkdirSync(dirname(join(nodeModules, name)), { recursive: true })
      symlinkSync(fromProfile, join(nodeModules, name), 'dir')
      say(`  linked         ${name} -> ${fromProfile}`)
      continue
    }
    say(`  absent         ${name}  (not in ${sharedTree})`)
  }

  say('')
  say('ready. Next: node examples/feed-structure/init.mjs .workspace/feed')
  return 0
}

process.exitCode = await main()