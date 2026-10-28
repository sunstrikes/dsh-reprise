/**
 * The registry is the answer to "which runs may this page show?" (ADR 0002), so the tests are about
 * the three refusals it makes rather than about convenient behaviour:
 *
 *   - one directory is one run, whatever three keys named it (dedup by `realpath`);
 *   - a directory whose name is not a slug is skipped **and reported**, never renamed;
 *   - `resolve()` is a lookup in the listing, so `../x` is unknown rather than a path.
 *
 * Plus the one write this module owns: scaffolding a new run writes a directory, a repository and a
 * `reprise.toml` a person will edit — and refuses an existing directory instead of merging into it.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HOST_STATE_FILENAME } from '../lib/active-runs.js'
import {
  RUN_CONFIG_FILENAME,
  RunArchiveRefused,
  archiveRun,
  createRunRegistry,
  readRunConfig,
  runConfigDocument,
  scaffoldRun,
} from '../lib/runs.js'

const workdir = () => mkdtempSync(join(tmpdir(), 'reprise-runs-'))

/**
 * A directory that *is* a domain pack, which is what a create now requires: the shape check is the
 * presence of `domain.json`, so a test that scaffolds a run has to hand over a real one rather than a
 * path that merely looks like a pack.
 */
const packDir = () => {
  const dir = join(workdir(), 'pack')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'domain.json'), JSON.stringify({ name: 'test-pack' }))
  return dir
}
const mkdir = (dir) => {
  mkdirSync(dir, { recursive: true })
  return dir
}

test('one directory is one run: workspace, runs[] and runs_root/* collapse by realpath', () => {
  const root = workdir()
  const a = mkdir(join(root, 'a'))
  const b = mkdir(join(root, 'b'))

  // The same directory named three ways: as the ticked workspace, as an extra path, and as a
  // subdirectory of the root. A page that listed it three times would offer three ids for one run.
  const registry = createRunRegistry({ workspace: a, runs: [a], runsRoot: root })
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    ['a', 'b'],
  )
  assert.deepEqual(registry.skipped(), [])
  assert.equal(registry.defaultRun, 'a')
  assert.equal(registry.resolve('b'), b)
})

test('a directory name that is not a slug is skipped and reported, not renamed', () => {
  const root = workdir()
  mkdir(join(root, 'good-1'))
  mkdir(join(root, 'has space'))
  mkdir(join(root, '.hidden'))

  const registry = createRunRegistry({ runsRoot: root })
  // `.hidden` is not *skipped*, it is not discovered at all: a dot-directory under the root is the
  // root's own bookkeeping (`.git`, `.cache`), and listing it as a run would be noise.
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    ['good-1'],
  )
  const skipped = registry.skipped()
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].reason, /not a run id/)
  assert.ok(existsSync(join(root, 'has space')), 'the directory is left exactly as it was found')
})

test('a declared workspace may be hidden: the id rule is about paths, not about dots', () => {
  const work = workdir()
  const hidden = mkdir(join(work, '.run'))

  // `.run` is an ordinary name for a run directory people create by hand, and a rule that made the run
  // they tick disappear from their own picker would be a rule about our convenience, not about safety.
  const registry = createRunRegistry({ workspace: hidden })
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    ['.run'],
  )
  assert.equal(registry.resolve('.run'), hidden)
  assert.equal(registry.skipped().length, 0)
})

test('resolve() is a lookup, so a traversal is unknown rather than resolved', () => {
  const root = workdir()
  mkdir(join(root, 'run-1'))
  const outside = mkdir(join(root, '..', `outside-${Date.now()}`))

  const registry = createRunRegistry({ runsRoot: root })
  assert.equal(registry.resolve('run-1'), join(root, 'run-1'))
  assert.equal(registry.resolve('../outside'), undefined)
  assert.equal(registry.resolve('run-1/../run-1'), undefined)
  assert.equal(registry.resolve(outside), undefined, 'an absolute path is not an id')
  assert.equal(registry.resolve(''), undefined)
  assert.equal(registry.resolve(undefined), undefined)
  assert.equal(registry.resolve('missing'), undefined)
})

test('a symlinked run is the same run', () => {
  const root = workdir()
  const real = mkdir(join(root, 'real-run'))
  const links = mkdir(join(root, 'links'))
  symlinkSync(real, join(links, 'alias'))

  const registry = createRunRegistry({ runs: [real], runsRoot: links })
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    ['real-run'],
  )
  assert.equal(registry.resolve('alias'), undefined, 'the alias is not a second identity for one directory')
})

test('a runs_root that does not exist yet is an empty registry, not an error', () => {
  const root = workdir()
  const registry = createRunRegistry({ runsRoot: join(root, 'not-created') })
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(registry.skipped(), [])
  assert.equal(registry.defaultRun, undefined)
})

test('contains() is how every write decides it may touch a directory', () => {
  const root = workdir()
  const inside = mkdir(join(root, 'run'))
  const registry = createRunRegistry({ runsRoot: root })

  assert.equal(registry.contains(inside), true)
  assert.equal(registry.contains(root), true)
  assert.equal(registry.contains(join(root, '..')), false)
  assert.equal(registry.contains('/'), false)
  // No root at all: nothing is inside it, which is why creating a run needs runs_root.
  assert.equal(createRunRegistry({}).contains(inside), false)
})

test('the created configuration file is a person-editable TOML document', () => {
  const text = runConfigDocument({
    domain: '/abs/domain/pack',
    maxRounds: 5,
    candidatesPerRound: 3,
    candidateGpuHours: 1.5,
  })
  assert.match(text, /^# reprise\.toml/m)
  assert.match(text, /^workspace = "\."$/m, 'the workspace resolves against the file itself')
  assert.match(text, /^domain = "\/abs\/domain\/pack"$/m)
  assert.match(text, /^\[runner\]$/m)
  assert.match(text, /^\[rounds\]$/m)
  assert.match(text, /^max_rounds = 5$/m)
  assert.match(text, /^candidates_per_round = 3$/m)
  assert.match(text, /^\[budget\]$/m)
  assert.match(text, /^candidate_gpu_hours = 1\.5$/m)
  // The two blocks a form cannot know are present as examples, so the file says what is missing.
  assert.match(text, /^# \[candidate\]$/m)
  assert.match(text, /^# \[model\]$/m)
})

test('scaffoldRun("empty") lays down the directory and its configuration', () => {
  const root = mkdir(join(workdir(), 'runs'))
  const registry = createRunRegistry({ runsRoot: root })

  const made = scaffoldRun({ registry, id: 'run-1', mode: 'empty', domain: packDir() })
  assert.equal(made.dir, join(root, 'run-1'))
  assert.equal(made.cloned, false)
  const config = readRunConfig(made.dir)
  assert.equal(config.status, 'ok', JSON.stringify(config.problems))
  assert.equal(config.value.workspace, '.')
  assert.match(config.value.domain, /pack$/)
  assert.equal(config.value.runner.repo, 'repo')
  assert.equal(config.value.rounds.max_rounds, 3)
  // The id is now visible to the page without a restart: the registry re-reads the directory.
  assert.deepEqual(registry.list().map((entry) => entry.id), ['run-1'])
})

test('scaffoldRun("clone") runs git once, into the run, and says whether it cloned', () => {
  const root = mkdir(join(workdir(), 'runs'))
  const registry = createRunRegistry({ runsRoot: root })
  const calls = []
  const git = (args, options) => {
    calls.push({ args, cwd: options.cwd })
    mkdir(args.at(-1))
    return { status: 0 }
  }

  const made = scaffoldRun({
    registry,
    id: 'cloned',
    mode: 'clone',
    repo: '/abs/source-repo',
    domain: packDir(),
    repoDir: 'model-repo',
    git,
  })

  assert.equal(made.cloned, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(0, 2), ['clone', '--shared'], 'a local repository is shared, not duplicated')
  assert.equal(calls[0].cwd, join(root, 'cloned'))
  assert.ok(existsSync(join(root, 'cloned', 'model-repo')))
})

test('scaffoldRun refuses what it cannot do, by name', () => {
  const root = mkdir(join(workdir(), 'runs'))
  const registry = createRunRegistry({ runsRoot: root })

  assert.throws(
    () => scaffoldRun({ registry, id: 'has space', mode: 'empty', domain: '/abs/pack' }),
    /must match/,
  )
  assert.throws(
    () => scaffoldRun({ registry, id: 'run-1', mode: 'empty', domain: 'relative/pack' }),
    /absolute path of a domain pack/,
  )
  const pack = packDir()
  assert.throws(() => scaffoldRun({ registry, id: 'run-2', mode: 'sideways', domain: pack }), /"clone" or "empty"/)
  assert.throws(() => scaffoldRun({ registry, id: 'run-3', mode: 'clone', domain: pack }), /needs repo/)

  // A directory that looks like a pack but is not one: the mistake the form invites is a parent
  // directory typed instead of the pack inside it, and a run created against it could never boot.
  assert.throws(
    () => scaffoldRun({ registry, id: 'run-2b', mode: 'empty', domain: root }),
    /is not a domain pack: there is no domain\.json/,
  )

  // An existing directory is refused rather than merged into: it may be somebody's run.
  mkdir(join(root, 'run-4'))
  assert.throws(() => scaffoldRun({ registry, id: 'run-4', mode: 'empty', domain: pack }), /already exists/)

  // No root at all: there is nowhere to create it.
  assert.throws(
    () => scaffoldRun({ registry: createRunRegistry({}), id: 'run-5', mode: 'empty', domain: pack }),
    /needs runs_root/,
  )
})

test('a clone that fails keeps the directory and quotes git', () => {
  const root = mkdir(join(workdir(), 'runs'))
  const registry = createRunRegistry({ runsRoot: root })
  const git = () => ({ status: 128, stderr: 'fatal: repository not found' })

  assert.throws(
    () => scaffoldRun({ registry, id: 'broken', mode: 'clone', repo: 'https://example.invalid/x.git', domain: packDir(), git }),
    /repository not found/,
  )
  // Never tidy away the evidence of a failure: the half-built run is left to be inspected.
  assert.ok(existsSync(join(root, 'broken')))
})

test('readRunConfig distinguishes missing, invalid and ok', () => {
  const dir = mkdir(join(workdir(), 'run'))
  assert.equal(readRunConfig(dir).status, 'missing')

  writeFileSync(join(dir, RUN_CONFIG_FILENAME), 'domain = "/abs/pack"\n[runner\n')
  const invalid = readRunConfig(dir)
  assert.equal(invalid.status, 'invalid')
  assert.ok(invalid.problems.length > 0)

  writeFileSync(join(dir, RUN_CONFIG_FILENAME), 'domain = "/abs/pack"\n')
  const ok = readRunConfig(dir)
  assert.equal(ok.status, 'ok')
  assert.deepEqual(ok.value, { domain: '/abs/pack' })
})
// ------------------------------------------------------------- removing a run (archive, not destroy)

const statusOf = (thrown) => (thrown instanceof RunArchiveRefused ? thrown.status : undefined)

test('a removed run is moved into .trash and named in the host record — never destroyed', () => {
  const root = mkdir(join(workdir(), 'runs'))
  scaffoldRun({ registry: createRunRegistry({ runsRoot: root }), id: 'old', mode: 'empty', domain: packDir() })
  const registry = createRunRegistry({ runsRoot: root })
  assert.deepEqual(registry.list().map((entry) => entry.id), ['old'])

  const made = archiveRun({ registry, id: 'old', activeIds: [], now: 1_700_000_000_000 })
  assert.match(made.trashed_to, /[.]trash[/\\]old-/)
  assert.ok(existsSync(join(made.trashed_to, RUN_CONFIG_FILENAME)), 'every file the run had came along')
  assert.equal(existsSync(join(root, 'old')), false, 'and it is no longer a run')

  // The registry does not list the archive: `.trash` is a dot-directory, skipped by the scan.
  assert.deepEqual(createRunRegistry({ runsRoot: root }).list(), [])

  const record = JSON.parse(readFileSync(join(root, HOST_STATE_FILENAME), 'utf8'))
  assert.equal(record.trashed.length, 1)
  assert.equal(record.trashed[0].id, 'old')
  assert.equal(record.trashed[0].trashed_to, made.trashed_to, 'where it went is answerable a week later')
})

test('a run is refused when it is the one being ticked, when it is active, or when it is not ours', () => {
  const root = mkdir(join(workdir(), 'runs'))
  const registry = createRunRegistry({ runsRoot: root })
  for (const id of ['ticked', 'busy']) scaffoldRun({ registry, id, mode: 'empty', domain: packDir() })

  const ticked = createRunRegistry({ runsRoot: root, workspace: join(root, 'ticked') })
  assert.throws(
    () => archiveRun({ registry: ticked, id: 'ticked' }),
    (error) => statusOf(error) === 409 && /point workspace at another directory first/.test(error.message),
  )

  // `keepIds` defaults to the registry's default run, so this case says "nothing is protected" to reach
  // the activation guard on a registry whose first entry happens to be `busy`.
  assert.throws(
    () => archiveRun({ registry, id: 'busy', keepIds: [], activeIds: ['busy'] }),
    (error) => statusOf(error) === 409 && /stop it first/.test(error.message),
  )

  assert.throws(
    () => archiveRun({ registry, id: 'nobody' }),
    (error) => statusOf(error) === 404,
  )

  // A run declared through `runs: [...]` lives outside the root: this host only reorganises its own.
  const outside = mkdir(join(workdir(), 'elsewhere'))
  const wired = createRunRegistry({ runsRoot: root, runs: [outside] })
  assert.throws(
    () => archiveRun({ registry: wired, id: 'elsewhere', keepIds: [] }),
    (error) => statusOf(error) === 400 && /not inside runs_root/.test(error.message),
  )

  // A host with no root at all cannot hold an archive either.
  assert.throws(
    () => archiveRun({ registry: createRunRegistry({}), id: 'ticked' }),
    (error) => statusOf(error) === 400 && /needs runs_root/.test(error.message),
  )

  // Nothing moved in any of the refusals above.
  for (const id of ['ticked', 'busy']) assert.ok(existsSync(join(root, id)))
  assert.ok(existsSync(outside))
})
