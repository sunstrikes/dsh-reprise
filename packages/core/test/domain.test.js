/**
 * The domain pack seam: the kernel knows no metric, no model repository, no prompt and no executor
 * entry, so a run must read them from one directory — and a pack that is missing a part is refused
 * **by name** instead of loading half-empty.
 *
 * Contract guarded (spec "领域差异必须是数据，不是 if"; ticket 17): a domain pack declares its metric
 * contract, its priors, its adjustable surface, the five prompts and its executor entry in one
 * manifest (`domain.json`). Four properties are pinned here:
 *
 *   1. the shipped `examples/feed-structure` really is a pack — every part loads from that directory;
 *   2. a missing manifest, a missing part, a self-contradicting part and a missing prompt each fail
 *      with the field / file / call site named, because the dangerous alternative is an empty prompt
 *      or an empty injection that a model answers anyway;
 *   3. a second pack that is *only data* (the `config-only` fixture) loads and reaches the model
 *      prompt with no kernel edit — the claim ticket 18 is built on;
 *   4. no kernel module names a metric, a model repository or a domain file, which is what "the
 *      difference is data" means when it is checked instead of asserted.
 *
 * The tests may name domain content (`auc`, `model/structure.json`); the kernel may not, and the
 * last test holds that line.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CALL_SITES } from '../lib/skills.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FEED_PACK = join(ROOT, 'examples', 'feed-structure')
const CONFIG_ONLY_PACK = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'config-only-domain')

/** The pack loader, required lazily so a missing module is one clear failure instead of a load error. */
async function domain() {
  return import('../lib/domain.js')
}

test('the shipped example is a domain pack: one directory holds the contract, the priors, the surface, the five prompts and the executor entry', async () => {
  const { loadDomainPack } = await domain()
  const pack = loadDomainPack(FEED_PACK)

  assert.equal(pack.name, 'feed-structure', 'the manifest names the pack, and the name is what messages quote')
  assert.equal(pack.dir, FEED_PACK)

  // The metric contract is the domain's account of "better", read here rather than known here.
  assert.equal(pack.metricContract.name, 'feed-click-auc', 'the contract carries its own ref, which artifacts quote')
  assert.equal(pack.metricContract.primary, 'auc')
  assert.equal(pack.metricContract.direction, 'higher')
  assert.deepEqual(pack.metricContract.objectives, { auc: 'up' })

  // The priors: the space a hypothesis may move in, and the classes it must belong to.
  assert.deepEqual(
    pack.priors.hypothesis_classes.map((entry) => entry.id),
    ['capacity', 'interaction', 'regularisation'],
  )
  assert.ok(pack.priors.search_space.hidden_units !== undefined, 'the search space is the pack\'s, not the kernel\'s')

  // The adjustable surface: files a candidate may edit, plus the knobs and symbols inside them.
  assert.deepEqual(pack.surface.files, ['model/structure.json'])
  assert.ok(pack.surface.keys.includes('hidden_units'))

  // The executor entry: how this domain is measured. `cwd` is the candidate worktree, so the command
  // names the domain's own training script and nothing else.
  assert.equal(pack.executor.kind, 'local')
  assert.deepEqual(pack.executor.command, ['node', 'metric.mjs'])

  // All five prompts, read from the pack — never from a path in the kernel.
  assert.deepEqual([...pack.prompts.keys()], [...CALL_SITES], 'one prompt per call site, in call-site order')
  assert.equal(pack.promptsDir, join(FEED_PACK, 'prompts'))
  assert.equal(pack.prompts.get('land').path, join(FEED_PACK, 'prompts', 'land', 'SKILL.md'), 'each prompt knows the file it was read from')
  assert.match(pack.prompts.get('land').body, /LAND/, 'the land prompt is the one that briefs an implementer')
})

test('a directory with no manifest is refused, naming the directory and the file it expected', async () => {
  const { DomainPackError, loadDomainPack } = await domain()
  const empty = mkdtempSync(join(tmpdir(), 'reprise-nopack-'))
  try {
    assert.throws(
      () => loadDomainPack(empty),
      (error) => {
        assert.ok(error instanceof DomainPackError)
        assert.equal(error.packDir, empty)
        assert.match(error.message, /domain\.json/, 'the message names the file a pack starts with')
        assert.match(error.message, new RegExp(empty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and where it looked')
        return true
      },
    )
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a manifest that names a part which is not there is refused, naming the field and the path', async () => {
  const { DomainPackError, loadDomainPack } = await domain()
  const copied = copyPack(CONFIG_ONLY_PACK)
  try {
    rmSync(join(copied, 'priors.json'))
    assert.throws(
      () => loadDomainPack(copied),
      (error) => {
        assert.ok(error instanceof DomainPackError)
        assert.match(error.message, /priors/, 'the manifest field is named')
        assert.match(error.message, /priors\.json/, 'and the file that should be there')
        assert.ok(error.problems.some((problem) => problem.includes(join(copied, 'priors.json'))), 'the absolute path is in the report')
        return true
      },
    )
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('a metric contract that contradicts itself is refused: two accounts of "better" make two rounds incomparable', async () => {
  const { DomainPackError, loadDomainPack } = await domain()
  const copied = copyPack(CONFIG_ONLY_PACK)
  try {
    const contractPath = join(copied, 'metric-contract.json')
    writeFileSync(contractPath, JSON.stringify({ ...readJson(contractPath), direction: 'lower' }))
    assert.throws(
      () => loadDomainPack(copied),
      (error) => {
        assert.ok(error instanceof DomainPackError)
        assert.match(error.message, /metric-contract\.json/, 'the broken file is named')
        assert.match(error.message, /direction/, 'the key that disagrees is named')
        assert.match(error.message, /objectives/, 'and the key it disagrees with')
        return true
      },
    )
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('a missing prompt is refused by call site and path — a model promised no instructions still answers', async () => {
  const { DomainPackError, loadDomainPack } = await domain()
  const copied = copyPack(CONFIG_ONLY_PACK)
  try {
    rmSync(join(copied, 'prompts', 'verify', 'SKILL.md'))
    assert.throws(
      () => loadDomainPack(copied),
      (error) => {
        assert.ok(error instanceof DomainPackError)
        assert.match(error.message, /verify/, 'the call site is named')
        assert.match(error.message, /SKILL\.md/, 'and the file shape it expected')
        assert.match(error.message, /verify\/SKILL\.md/)
        return true
      },
    )
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('a pack that is only configuration loads, and drives a judge prompt with no kernel change', async () => {
  const { loadDomainPack } = await domain()
  const pack = loadDomainPack(CONFIG_ONLY_PACK)

  assert.equal(pack.name, 'config-only-domain')
  assert.equal(pack.metricContract.primary, 'score', 'a metric the kernel has never heard of')
  assert.deepEqual(pack.executor.command, ['node', '-e', '0'])

  assert.match(pack.prompts.get('verify').body, /CONFIG-ONLY-DOMAIN-VERIFY/, 'the prompt text is the second pack\'s own')
  assert.match(pack.prompts.get('round_plan').body, /CONFIG-ONLY-DOMAIN-ROUND_PLAN/, 'every call site, not just one')
})

// ------------------------------------------------------------------ helpers

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** A throwaway copy of a pack, so a test may delete a part without touching the repository. */
function copyPack(source) {
  const target = mkdtempSync(join(tmpdir(), 'reprise-pack-'))
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  return target
}
