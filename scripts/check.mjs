#!/usr/bin/env node
/**
 * The three checks `npm test` cannot make, because they are about files the tests never import:
 *
 *  1. every `main` / `exports` target exists, and no export points at TypeScript (the host imports
 *     JavaScript, so a `.ts` target resolves for nobody);
 *  2. a declared `@dsh-reprise/*` dependency is imported somewhere in that package, and every
 *     `@dsh-reprise/*` import is declared;
 *  3. every module under `lib/` parses, including the ones no test happens to import.
 *
 * They are checks rather than rules because each is mechanical: a rule would be forgotten, a check
 * goes red. Each was a real defect in this repository before the check existed — the exports one
 * survived five separate tickets.
 *
 * Usage: `node scripts/check.mjs` (runs automatically before `npm test`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PACKAGES = join(ROOT, 'packages')
const problems = []

const fail = (where, what) => problems.push(`${where}: ${what}`)

const packageDirs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

/** Every .js file under a directory, recursively. */
const jsFiles = (dir) => {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...jsFiles(path))
    else if (entry.name.endsWith('.js')) out.push(path)
  }
  return out
}

const importsOf = (files) =>
  files
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
    .matchAll(/(?:from|import)\s*\(?\s*['"](@dsh-reprise\/[^'"]+)['"]/g)

for (const name of packageDirs) {
  const dir = join(PACKAGES, name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const where = `packages/${name}`

  // 1. export targets exist and are JavaScript
  const targets = [manifest.main, ...Object.values(manifest.exports ?? {})].flat().filter((v) => typeof v === 'string')
  const hasCode = jsFiles(join(dir, 'lib')).length > 0
  if (targets.length === 0 && hasCode) fail(where, 'has code but declares no main or exports, so nothing can import it')
  for (const target of targets) {
    if (target.endsWith('.ts')) {
      fail(where, `exports "${target}", and the host only imports JavaScript — point it at the built file`)
      continue
    }
    if (target.includes('*')) continue // a wildcard is only meaningful with files behind it
    if (!existsSync(join(dir, target))) fail(where, `exports "${target}", which does not exist`)
  }

  // 2. declared dependencies and real imports agree, in both directions
  const declared = Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.startsWith('@dsh-reprise/'))
  const used = new Set([...importsOf(jsFiles(join(dir, 'lib')))].map((match) => match[1]))
  const usedPackages = new Set(
    [...used].map((specifier) => {
      const parts = specifier.split('/')
      return `${parts[0]}/${parts[1]}`
    }),
  )

  for (const dep of declared) {
    if (!usedPackages.has(dep)) {
      fail(where, `declares "${dep}" but never imports it — a manifest edge nobody uses is a lie about the graph`)
    }
  }
  for (const dep of usedPackages) {
    if (!declared.includes(dep)) {
      fail(where, `imports "${dep}" without declaring it — the dependency graph is then unreadable`)
    }
    if (dep === `@dsh-reprise/${name}`) fail(where, 'imports itself by package name')
  }

  // 3. everything parses, including modules no test imports
  for (const file of jsFiles(join(dir, 'lib'))) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      const message = String(error.stderr ?? error.message).split('\n')[0]
      fail(file.slice(ROOT.length), `does not parse — ${message}`)
    }
  }
}

// 4. no package may point exports at a file that only exists in another package
for (const name of packageDirs) {
  const manifestPath = join(PACKAGES, name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const target of Object.values(manifest.exports ?? {}).flat()) {
    if (typeof target === 'string' && target.startsWith('..')) {
      fail(`packages/${name}`, `exports "${target}", which reaches outside the package`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem(s) the test suite cannot see:\n\n`)
  for (const problem of problems) process.stderr.write(`  ✖ ${problem}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

process.stdout.write(`check: ${packageDirs.length} packages agree with their manifests and parse\n`)