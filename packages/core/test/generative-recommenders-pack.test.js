/**
 * The generative-recommenders pack: a second domain, pointed at a real upstream repository
 * (https://github.com/meta-recsys/generative-recommenders), held to the same contract the feed
 * example is — and to the four things a *real* domain adds.
 *
 * Contract guarded (spec "领域差异必须是数据，不是 if"; ticket 18): a model-structure loop on a
 * repository nobody in this project wrote can only propose sensible hypotheses if the domain ships
 * them as data. This file holds the four properties that make that claim checkable:
 *
 *   1. **the pack loads through the real loader** and its parts agree with each other — one primary
 *      metric inside `objectives`, a guardrail that is a *second* ranked metric, a tolerance for
 *      every ranked metric, and a tolerance smaller than the published structural gap it was derived
 *      from (a floor larger than the biggest known lever would call a real gain "noise");
 *   2. **every whitelisted gin key and source symbol is traceable** to a file and an evidence string
 *      in the domain repository, so gate two compares a diff against something that exists. When the
 *      repository is not on this machine the same entries are still required — a name nobody checked
 *      is recorded with the file that would prove it, never silently trusted;
 *   3. **the metric contract's window is executable**: the shipped reader reports the last *full*
 *      eval epoch and ignores a truncated one, because `train.py` truncates an epoch's eval unless
 *      `full_eval_every_n` divides it and a truncated number is a different measurement;
 *   4. **all five prompts are non-empty** and each states the diff exit convention — the change has
 *      to land as a diff, so a candidate that cannot be expressed as one is rejected, not discussed.
 *
 * The tests may name domain content (`hr@10`, `hstu_encoder.num_blocks`); the kernel may not, and
 * `domain.test.js` holds that line.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CALL_SITES } from '../lib/skills.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PACK = join(ROOT, 'examples', 'generative-recommenders')
const LOG_FIXTURE = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'generative-recommenders', 'train-log.txt')

/** Where the domain repository is expected; a checkout elsewhere is pointed at with the env var. */
const DOMAIN_REPO = process.env.REPRISE_DOMAIN_REPO ?? join(homedir(), '.reprise-lab', 'generative-recommenders')

/**
 * Whitelist entries this pack may ship *without* checking them against the repository. Empty on
 * purpose: the list is here so that adding one is a reviewable line in a test rather than a silent
 * `"status": "unverified"` in JSON nobody reads. Each entry is `[name, why]`.
 */
const UNVERIFIED_ALLOWED = Object.freeze([])

/** The gap between the two structural variants the README publishes for ML-1M — the calibration unit. */
const PUBLISHED_ML1M_GAP = Object.freeze({ 'hr@10': 0.3294 - 0.3097, 'ndcg@10': 0.1893 - 0.172 })

const repoPresent = existsSync(DOMAIN_REPO)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** The loader, imported lazily so a missing module is one clear failure instead of a load error. */
async function domain() {
  return import('../lib/domain.js')
}

// ------------------------------------------------------------------- the pack

test('the generative-recommenders pack loads: contract, priors, surface, five prompts and an executor entry', async () => {
  const { loadDomainPack } = await domain()
  const pack = loadDomainPack(PACK)

  assert.equal(pack.name, 'generative-recommenders', 'the manifest names the pack, and every error about it quotes that name')
  assert.equal(pack.dir, PACK)

  // What "better" means here: a hit in the top ten, counted on a fixed eval set.
  assert.equal(pack.metricContract.name, 'generative-recommenders-hr10')
  assert.equal(pack.metricContract.primary, 'hr@10')
  assert.equal(pack.metricContract.direction, 'higher')
  assert.deepEqual(Object.keys(pack.metricContract.objectives).sort(), ['hr@10', 'ndcg@10'])

  // Where a hypothesis may move: a real gin config plus the model source, named by the pack.
  assert.ok(
    pack.surface.files.includes('configs/ml-1m/hstu-sampled-softmax-n128-final.gin'),
    'the whitelist has to include the config the executor runs, or no candidate can move a knob at all',
  )
  assert.ok(pack.surface.symbols.includes('SequentialTransductionUnitJagged'), 'the HSTU layer is the thing under study')
  assert.ok(pack.surface.keys.includes('hstu_encoder.num_blocks'))

  // How it is measured: the upstream entry point, from the candidate's own worktree.
  assert.equal(pack.executor.kind, 'local')
  assert.equal(pack.executor.command[0], 'python3')
  assert.ok(
    pack.executor.command.some((argument) => argument.includes('run-metrics.py')),
    'the executor has to name the pack\'s metric reader; main.py writes no metrics file of its own',
  )
  assert.equal(pack.executor.metrics_required, true)

  // All five prompts, read from the pack — never from a path in the kernel.
  assert.deepEqual([...pack.prompts.keys()], [...CALL_SITES], 'one prompt per call site, in call-site order')
  assert.equal(pack.promptsDir, join(PACK, 'prompts'))
  assert.equal(
    pack.prompts.get('round_plan').path,
    join(PACK, 'prompts', 'round-plan', 'SKILL.md'),
    'each prompt knows the file it was read from',
  )
})

test('the metric contract names one primary, a guardrail the frontier can rank, and a tolerance for each ranked metric', () => {
  const contract = readJson(join(PACK, 'metric-contract.json'))
  const objectives = Object.keys(contract.objectives)

  // One primary, and the objectives are the ranked set the frontier folds — no third metric here.
  assert.equal(typeof contract.primary, 'string')
  assert.ok(objectives.includes(contract.primary), 'the gate compares the primary, so the frontier must rank it')
  assert.equal(contract.objectives[contract.primary], 'up')
  assert.equal(contract.direction, 'higher')

  // The guardrail is a *second* metric that must not degrade while the primary improves.
  assert.notEqual(contract.guardrail.metric, contract.primary, 'a guardrail equal to the primary is the objective restated')
  assert.ok(objectives.includes(contract.guardrail.metric), 'a guardrail nobody ranks is a comment')
  assert.equal(contract.objectives[contract.guardrail.metric], 'up')
  assert.match(contract.guardrail.rule, /re-ranking/i, 'the guardrail has to say what a bad outcome looks like')

  // The tolerance: positive, declared for every ranked metric, and smaller than the biggest known
  // structural gain — a floor above it would report the published lever as noise.
  for (const metric of objectives) {
    const delta = contract.minimum_effective_delta[metric]
    assert.equal(typeof delta, 'number', `${metric} has no minimum effective magnitude`)
    assert.ok(Number.isFinite(delta) && delta > 0, `${metric}'s magnitude must be a positive number (got ${delta})`)
    assert.ok(
      delta < PUBLISHED_ML1M_GAP[metric],
      `${metric}'s floor ${delta} is at least the published structural gap ${PUBLISHED_ML1M_GAP[metric].toFixed(4)} — ` +
        'it would call the largest known structural gain a non-result',
    )
  }

  // The window: a number that is only comparable between candidates when it comes from a full eval.
  assert.equal(contract.window.mode, 'last-full-eval-epoch')
  assert.equal(contract.window.reader, 'run-metrics.py', 'the window names the code that implements it')
})

test('every whitelisted gin key is traceable to the domain repository, or recorded with the file that would prove it', (t) => {
  const surface = readJson(join(PACK, 'surface.json'))
  assert.ok(surface.keys.length > 0, 'a whitelist of gin keys that is empty lets a candidate edit nothing')

  const allowed = new Map(UNVERIFIED_ALLOWED)
  const recordedOnly = []

  for (const key of surface.keys) {
    const entry = surface.verified?.keys?.[key]
    assert.ok(entry !== undefined, `${key} has no verified entry — a whitelist nobody checked refuses the wrong diffs`)

    if (entry.status === 'unverified') {
      assert.ok(
        allowed.has(key),
        `${key} is marked unverified but is not in UNVERIFIED_ALLOWED — either verify it or record the reason in the test`,
      )
      assert.ok(typeof entry.why === 'string' && entry.why !== '', `${key} is unverified with no reason`)
      recordedOnly.push(key)
      continue
    }

    assert.equal(typeof entry.file, 'string')
    assert.equal(typeof entry.evidence, 'string')
    if (!repoPresent) {
      recordedOnly.push(key)
      continue
    }
    const file = join(DOMAIN_REPO, entry.file)
    assert.ok(existsSync(file), `${key} is verified against ${entry.file}, which is not in ${DOMAIN_REPO}`)
    assert.ok(
      readFileSync(file, 'utf8').includes(entry.evidence),
      `${key}: ${entry.file} does not contain ${JSON.stringify(entry.evidence)} — the evidence string is the proof`,
    )
  }

  if (!repoPresent) {
    t.diagnostic(
      `the domain repository is not at ${DOMAIN_REPO}: ${recordedOnly.length} key(s) checked for a recorded ` +
        'file and evidence only. Point REPRISE_DOMAIN_REPO at a checkout to verify them against the source.',
    )
  }
})

test('every whitelisted source symbol is traceable to the domain repository, or recorded the same way', (t) => {
  const surface = readJson(join(PACK, 'surface.json'))
  const allowed = new Map(UNVERIFIED_ALLOWED)
  const recordedOnly = []

  for (const symbol of surface.symbols) {
    const entry = surface.verified?.symbols?.[symbol]
    assert.ok(entry !== undefined, `${symbol} has no verified entry`)

    if (entry.status === 'unverified') {
      assert.ok(allowed.has(symbol), `${symbol} is marked unverified but is not in UNVERIFIED_ALLOWED`)
      assert.ok(typeof entry.why === 'string' && entry.why !== '', `${symbol} is unverified with no reason`)
      recordedOnly.push(symbol)
      continue
    }

    assert.equal(typeof entry.file, 'string')
    assert.equal(typeof entry.evidence, 'string')
    assert.match(entry.file, /\.py$/, `${symbol} must be verified against a Python source file`)
    if (!repoPresent) {
      recordedOnly.push(symbol)
      continue
    }
    const file = join(DOMAIN_REPO, entry.file)
    assert.ok(existsSync(file), `${symbol} is verified against ${entry.file}, which is not in ${DOMAIN_REPO}`)
    assert.ok(
      readFileSync(file, 'utf8').includes(entry.evidence),
      `${symbol}: ${entry.file} does not contain ${JSON.stringify(entry.evidence)}`,
    )
  }

  if (!repoPresent) {
    t.diagnostic(`the domain repository is not at ${DOMAIN_REPO}: ${recordedOnly.length} symbol(s) checked for a record only.`)
  }
})

test('the surface, the forbidden list and the priors agree, and every path either names exists or is out of bounds on purpose', (t) => {
  const surface = readJson(join(PACK, 'surface.json'))
  const priors = readJson(join(PACK, 'priors.json'))

  assert.deepEqual([...new Set(surface.files)], surface.files, 'a duplicated whitelist entry hides which path was meant')

  for (const file of surface.files) {
    assert.ok(!(file in surface.forbidden.files), `${file} is whitelisted and forbidden at once`)
  }
  for (const key of Object.keys(surface.forbidden.keys)) {
    assert.ok(!surface.keys.includes(key), `${key} is whitelisted and forbidden at once`)
    assert.ok(surface.forbidden.keys[key].length > 20, `${key} is forbidden with no reason — the next reader will re-open it`)
  }

  if (repoPresent) {
    for (const file of surface.files) {
      assert.ok(existsSync(join(DOMAIN_REPO, file)), `${file} is whitelisted but does not exist in the domain repository`)
    }
    for (const file of Object.keys(surface.forbidden.files)) {
      assert.ok(
        existsSync(join(DOMAIN_REPO, file)),
        `${file} is forbidden but does not exist — a typo here protects nothing and says it protects something`,
      )
    }
  } else {
    t.diagnostic(`the domain repository is not at ${DOMAIN_REPO}: paths checked for shape only.`)
  }

  // The search space is a subset of the whitelist: a plan may only move knobs a diff is allowed to move.
  for (const key of Object.keys(priors.search_space)) {
    assert.ok(surface.keys.includes(key), `priors.search_space.${key} is not a whitelisted gin key`)
    assert.ok(Array.isArray(priors.search_space[key].values), `priors.search_space.${key}.values must be a list`)
  }

  // Every hypothesis class says which whitelisted knobs it may move, and every class is distinct.
  const ids = priors.hypothesis_classes.map((entry) => entry.id)
  assert.deepEqual([...new Set(ids)], ids, 'two hypothesis classes with one id cannot be told apart in a review')
  for (const entry of priors.hypothesis_classes) {
    assert.ok(entry.description.length > 10, `${entry.id} has no description a planner could use`)
    assert.ok(Array.isArray(entry.moves) && entry.moves.length > 0, `${entry.id} names no knob it may move`)
    for (const key of entry.moves) {
      assert.ok(surface.keys.includes(key), `${entry.id} moves ${key}, which is not on the adjustable surface`)
    }
  }

  // Every prior carries where it came from: ticket 27 compares against the published numbers, and a
  // claim whose source nobody can open is a rumour.
  assert.ok(priors.priors.length > 0)
  for (const prior of priors.priors) {
    assert.equal(typeof prior.statement, 'string')
    assert.ok(prior.source !== undefined, `${JSON.stringify(prior.statement)} carries no source`)
    assert.match(prior.source.file, /README\.md|configs\/|generative_recommenders\//, `${prior.statement} cites an unexpected file`)
    assert.equal(typeof prior.source.section, 'string')
  }
})

// ----------------------------------------------------------------- prompts

test('each of the five prompts is non-empty and states the diff exit convention', async () => {
  const { loadDomainPack } = await domain()
  const pack = loadDomainPack(PACK)

  for (const site of CALL_SITES) {
    const body = pack.prompts.get(site).body
    assert.ok(body.trim().length > 600, `${site} is too short to be a strategy (${body.trim().length} characters)`)
    assert.match(body, /diff exit/i, `${site} does not name the diff exit convention`)
    assert.match(body, /\bdiff\b/i, `${site} never mentions the diff it reasons about`)
    assert.match(
      body,
      /Do not invent fields/,
      `${site} does not tell the model that the answer shape belongs to the kernel`,
    )
  }
})

// ------------------------------------------------- the seam: a tolerance is data

test('a tolerance that names a metric the frontier cannot rank is refused at boot, naming the file and the key', async () => {
  const { DomainPackError, loadDomainPack } = await domain()
  const copied = copyPack(PACK)
  try {
    const contractPath = join(copied, 'metric-contract.json')
    const contract = readJson(contractPath)
    contract.minimum_effective_delta['ndcg@200'] = 0.01
    writeFileSync(contractPath, JSON.stringify(contract))

    assert.throws(
      () => loadDomainPack(copied),
      (error) => {
        assert.ok(error instanceof DomainPackError)
        assert.match(error.message, /metric-contract\.json/, 'the broken file is named')
        assert.match(error.message, /ndcg@200/, 'the metric that is not ranked is named')
        assert.match(error.message, /objectives/, 'and the list it is missing from')
        return true
      },
    )
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('a contract whose tolerance is zero, or whose guardrail is the primary, is refused: two ways of saying "nothing counts"', async () => {
  const { loadDomainPack } = await domain()

  const zero = copyPack(PACK)
  try {
    const contractPath = join(zero, 'metric-contract.json')
    const contract = readJson(contractPath)
    contract.minimum_effective_delta[contract.primary] = 0
    writeFileSync(contractPath, JSON.stringify(contract))
    assert.throws(
      () => loadDomainPack(zero),
      (error) => {
        assert.match(error.message, /minimum_effective_delta/)
        assert.match(error.message, /positive/)
        return true
      },
    )
  } finally {
    rmSync(zero, { recursive: true, force: true })
  }

  const restated = copyPack(PACK)
  try {
    const contractPath = join(restated, 'metric-contract.json')
    const contract = readJson(contractPath)
    contract.guardrail.metric = contract.primary
    writeFileSync(contractPath, JSON.stringify(contract))
    assert.throws(
      () => loadDomainPack(restated),
      (error) => {
        assert.match(error.message, /guardrail/)
        assert.match(error.message, /primary/)
        return true
      },
    )
  } finally {
    rmSync(restated, { recursive: true, force: true })
  }
})

// ------------------------------------------------- the window: full evals only

test('the shipped metric reader reports the last full eval epoch and ignores a truncated one', (t) => {
  const script = join(PACK, 'run-metrics.py')
  assert.ok(existsSync(script), 'the pack has to ship the reader its executor entry names')

  const dir = mkdtempSync(join(tmpdir(), 'reprise-gr-metrics-'))
  const out = join(dir, 'metrics.json')
  try {
    try {
      execFileSync('python3', [script, '--from-log', LOG_FIXTURE, '--out', out], { stdio: 'pipe' })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        t.diagnostic('python3 is not installed here; the reader is exercised on machines that have it')
        return
      }
      throw new Error(`the metric reader failed: ${error.stderr?.toString() ?? error.message}`)
    }

    const document = readJson(out)
    // The fixture's epochs: 0 truncated, 1 full, 2 truncated. The answer is epoch 1, not the last line.
    assert.deepEqual(document.metrics, {
      'hr@10': 0.3,
      'ndcg@10': 0.16,
      'hr@50': 0.56,
      'ndcg@50': 0.2,
      mrr: 0.17,
      epoch: 1,
      full_eval_epochs: 1,
      truncated_eval_epochs: 2,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------- helpers

/** A throwaway copy of the pack, so a test may break one part without touching the repository. */
function copyPack(source) {
  const target = mkdtempSync(join(tmpdir(), 'reprise-gr-pack-'))
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  return target
}