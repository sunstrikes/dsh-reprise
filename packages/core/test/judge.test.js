/**
 * The judge contract: what the model is asked, and what it is *not* allowed to decide.
 *
 * Two invariants live in this file and are the reason it exists as a seam:
 *
 * 1. **A model opinion is not a number.** The adversarial review answers `accept`/`reject`; every
 *    metric value, comparison and verdict is computed by the kernel from frozen evidence. A judge
 *    that added the model's `score` to the artifact would put a language-model number into the
 *    frontier and the stop rule — the one thing the whole architecture forbids.
 * 2. **A model opinion is not the verdict either.** The judge records the review and the L1 checks
 *    as two separate opinions and lets the contract decide. When they contradict each other (the
 *    review accepts, a static check failed) that is `conflict` — the fact plane disagreeing with
 *    itself — and the candidate stops. Collapsing the two here would erase exactly the
 *    disagreement a human needs to see.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateArtifact } from '@dsh-reprise/contract'

import { MODEL_UNAVAILABLE, isModelUnavailable } from '@dsh-reprise/exec/model'

import { memoryArtifacts } from '../lib/artifacts.js'
import { defaultStaticChecks } from '../lib/judge.js'
import { FEED_PROMPTS_DIR, judgeFor } from './support/domain.js'

const AT = 1_761_091_200_000

/** A model port that records every request and answers from a script keyed by call site. */
function scripted(answers) {
  const calls = []
  const model = async (request) => {
    calls.push(request)
    const answer = answers[request.call_site]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(request) : answer
  }
  return {
    model,
    calls,
    get count() {
      return calls.length
    },
    sites: () => calls.map((call) => call.call_site),
  }
}

const VERIFY_INPUT = {
  candidateId: 'c1',
  state: { phase: 'VERIFY', round: 1, hypothesis: 'widen the embedding table to 2^22' },
  parent: { parent_id: 'baseline-0', parent_commit: 'aaa1111' },
  now: AT,
}

test('an accepting adversarial review yields a contract-valid verdict, with the L1 checks from the kernel', async () => {
  const model = scripted({
    verify: { verdict: 'accept', rationale: 'minimal diff, no evaluation changes', concerns: [] },
  })
  const judge = judgeFor({ model: model.model })

  const artifact = await judge.verify(VERIFY_INPUT)

  assert.deepEqual(validateArtifact('verify_verdict', artifact), { status: 'ok', message: '' })
  assert.equal(artifact.candidate_id, 'c1')
  assert.equal(artifact.passed, true)
  assert.equal(artifact.decided_at_ms, AT)
  assert.equal(artifact.reviewer.verdict, 'accept')
  assert.match(artifact.reviewer.rationale, /minimal diff/)
  assert.ok(artifact.checks.length >= 2, 'a verdict with no checks is an opinion')
  assert.deepEqual(
    artifact.checks.map((check) => check.name),
    [...defaultStaticChecks(VERIFY_INPUT).map((check) => check.name), 'syntax', 'allowed_surface', 'conflict_markers'],
    'the checks are the kernel\'s — its own metadata facts plus gate two\'s static report — not the model\'s',
  )
  assert.deepEqual(model.sites(), ['verify'], 'one model call, at one call site')
  assert.match(model.calls[0].prompt, /VERIFY — adversarial review/, 'the prompt is the markdown skill')
  assert.equal(model.calls[0].facts.candidate_id, 'c1')
})

test('the report travels to the review as evidence, and the record keeps the bytes it checked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-judge-worktree-'))
  mkdirSync(join(dir, 'model'), { recursive: true })
  writeFileSync(join(dir, 'model/structure.json'), '{"hidden_units": 64}\n', 'utf8')

  const model = scripted({ verify: { verdict: 'accept', rationale: 'knob only' } })
  const judge = judgeFor({ model: model.model, surface: { files: ['model/structure.json'] } })
  const artifact = await judge.verify({
    ...VERIFY_INPUT,
    files: ['model/structure.json'],
    worktreeDir: dir,
    attempt: 2,
  })

  assert.equal(artifact.attempt, 2, 'the gate record carries its place in the attempt sequence')
  assert.deepEqual(
    model.calls[0].facts.static_report.checks.map((check) => `${check.name}:${check.result}`),
    ['syntax:pass', 'allowed_surface:pass', 'conflict_markers:pass'],
    'the adversarial review reasons from the kernel\'s report, it does not produce it',
  )
  assert.deepEqual(artifact.evidence.whitelist, ['model/structure.json'])
  assert.equal(artifact.evidence.files.length, 1)
  assert.match(artifact.evidence.files[0].digest, /^[0-9a-f]{64}$/, 'evidence that cannot be re-read cannot be recomputed')
  assert.deepEqual(validateArtifact('verify_verdict', artifact), { status: 'ok', message: '' })
})

test('a change outside the adjustable surface is a failed check, so the gate cannot pass it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-judge-surface-'))
  mkdirSync(join(dir, 'model'), { recursive: true })
  writeFileSync(join(dir, 'model/structure.json'), '{"hidden_units": 64}\n', 'utf8')
  writeFileSync(join(dir, 'model/evaluate.py'), 'print("moved the split")\n', 'utf8')

  const model = scripted({ verify: { verdict: 'accept', rationale: 'looks fine to me' } })
  const judge = judgeFor({ model: model.model, surface: { files: ['model/structure.json'] } })
  const artifact = await judge.verify({
    ...VERIFY_INPUT,
    files: ['model/evaluate.py', 'model/structure.json'],
    worktreeDir: dir,
  })

  assert.equal(artifact.checks.find((check) => check.name === 'allowed_surface').result, 'fail')
  assert.equal(artifact.passed, false)
  const verdict = validateArtifact('verify_verdict', artifact)
  assert.equal(verdict.status, 'conflict', 'the review accepted over a fact that failed — neither wins')
  assert.match(verdict.message, /accepted while 1 check\(s\) failed/)
})

test('attempt 2 is recorded under its own reference, so attempt 1 can still be recomputed', async () => {
  const artifacts = memoryArtifacts()
  const model = scripted({ verify: { verdict: 'accept', rationale: 'knob only' } })
  const judge = judgeFor({ model: model.model, artifacts })

  await judge.verify({ ...VERIFY_INPUT, attempt: 1 })
  await judge.verify({ ...VERIFY_INPUT, attempt: 2 })

  assert.equal(artifacts.read('verify_verdict:c1:a1').attempt, 1, 'the first attempt is not overwritten by the second')
  assert.equal(artifacts.read('verify_verdict:c1:a2').attempt, 2)
  assert.equal(artifacts.read('verify_verdict:c1').attempt, 2, 'and the plain reference still names the latest record')
})

test('the model cannot contribute the checks — only the review', async () => {
  const model = scripted({
    verify: {
      verdict: 'accept',
      rationale: 'looks fine',
      checks: [{ name: 'invented_by_the_model', result: 'pass' }],
    },
  })
  const artifact = await judgeFor({ model: model.model }).verify(VERIFY_INPUT)

  assert.ok(
    artifact.checks.every((check) => check.name !== 'invented_by_the_model'),
    'L1 static checks live in the kernel; a model-supplied check list is not evidence',
  )
})

test('an adversarial review that rejects stops the candidate without calling the artifact malformed', async () => {
  const model = scripted({
    verify: { verdict: 'reject', rationale: 'it also changes the evaluation split' },
  })
  const artifact = await judgeFor({ model: model.model }).verify(VERIFY_INPUT)

  assert.deepEqual(validateArtifact('verify_verdict', artifact), { status: 'ok', message: '' })
  assert.equal(artifact.passed, false, 'a rejected review is not a pass')
  assert.equal(artifact.reviewer.verdict, 'reject')
  assert.match(artifact.reviewer.rationale, /evaluation split/)
})

test('a review that accepts while a static check failed is a conflict, not a pass', async () => {
  const model = scripted({ verify: { verdict: 'accept', rationale: 'I see nothing wrong' } })
  const judge = judgeFor({
    model: model.model,
    staticChecks: () => [
      { name: 'worktree_clean', result: 'fail' },
      { name: 'parent_binding_matches', result: 'pass' },
    ],
  })

  const artifact = await judge.verify(VERIFY_INPUT)
  const verdict = validateArtifact('verify_verdict', artifact)

  assert.equal(verdict.status, 'conflict', 'the fact plane disagrees with itself: neither opinion wins')
  assert.match(verdict.message, /passed is true while 1 check\(s\) failed|adversarial review/)
})

test('a model answer full of numbers is not a verdict, and none of its numbers survive', async () => {
  const model = scripted({
    verify: { score: 0.987, rank: 1, confidence: 0.99, verdict: 'probably fine' },
  })
  const artifact = await judgeFor({ model: model.model }).verify(VERIFY_INPUT)

  assert.equal(artifact.passed, false, 'an unusable review is a rejection, not an abstention')
  assert.equal(artifact.reviewer.verdict, 'reject')
  assert.match(artifact.reviewer.rationale, /did not answer accept or reject/i)
  const serialised = JSON.stringify(artifact)
  for (const number of ['0.987', '0.99', '"rank":1']) {
    assert.equal(serialised.includes(number), false, `the model's ${number} must not reach the artifact`)
  }
})

test('a model port that throws is "no model answered", and no opinion is recorded', async () => {
  const artifacts = memoryArtifacts()
  const model = scripted({ verify: new Error('upstream 503') })

  await assert.rejects(
    () => judgeFor({ model: model.model, artifacts }).verify(VERIFY_INPUT),
    (error) => {
      assert.ok(isModelUnavailable(error), 'the whole point: an outage is not one call site\'s private problem')
      assert.equal(error.error_class, MODEL_UNAVAILABLE)
      assert.match(error.message, /upstream 503/, 'the reason travels with the class, for the operator')
      return true
    },
  )
  assert.equal(artifacts.read('verify_verdict:c1'), undefined, 'an outage must not become "the review rejected it"')
})

test('a port that hands back prose has not answered, and the failure is the same closed class', async () => {
  // Reading the answer out of a CLI's prose is the adapter's job (`@dsh-reprise/exec/model`,
  // `readAnswer`). By the time a judgement gets here it either has an object or it has nothing —
  // and "nothing" is one class, not a fifth way to fail.
  const model = scripted({ verify: 'Looking at this diff, I would accept it.' })

  await assert.rejects(
    () => judgeFor({ model: model.model }).verify(VERIFY_INPUT),
    (error) => isModelUnavailable(error) && error.cause === 'unparseable_answer',
  )
})

// ------------------------------------------------------------- CAND_ANALYZE

const ANALYZE_INPUT = {
  candidateId: 'c1',
  state: { phase: 'CAND_ANALYZE', round: 1, hypothesis: 'widen the embedding table to 2^22' },
  job: { job_id: 'job-1', state: 'succeeded' },
  collected: { metrics: { auc: 0.7123, loss: 2.01 }, artifacts: ['metrics.json'] },
  now: AT,
}

const judgeWithBaseline = (model, extra = {}) =>
  judgeFor({
    model: model.model,
    metric: { name: 'auc', direction: 'higher' },
    baseline: 0.7012,
    ...extra,
  })

test('an improvement is computed by code from the monitor metrics, and the report echoes them', async () => {
  const model = scripted({
    cand_analyze: { root_cause: 'the wider table removed collisions on rare features' },
  })
  const artifact = await judgeWithBaseline(model).analyze(ANALYZE_INPUT)

  assert.deepEqual(validateArtifact('analyze_report', artifact), { status: 'ok', message: '' })
  assert.equal(artifact.verdict, 'improved', 'the verdict is arithmetic on frozen metrics')
  assert.deepEqual(artifact.observed, { metric: 'auc', value: 0.7123 })
  assert.deepEqual(artifact.concluded, artifact.observed, 'concluded echoes observed — the contract enforces it')
  assert.match(artifact.root_cause, /collisions/)
  assert.equal(artifact.at_ms, AT)
})

test('a model that claims improvement over a regressed metric changes nothing', async () => {
  const model = scripted({
    cand_analyze: {
      root_cause: 'the wider table slowed convergence',
      verdict: 'improved',
      score: 99,
      confidence: 1,
    },
  })
  const artifact = await judgeWithBaseline(model).analyze({
    ...ANALYZE_INPUT,
    collected: { metrics: { auc: 0.6501 } },
  })

  assert.equal(artifact.verdict, 'regressed', 'a model-authored verdict is discarded')
  const serialised = JSON.stringify(artifact)
  assert.equal(serialised.includes('99'), false)
  assert.equal(serialised.includes('"confidence"'), false)
})

test('a report with no measured metric is missing evidence, so the phase cannot advance', async () => {
  const model = scripted({ cand_analyze: { root_cause: 'unknown' } })
  const artifact = await judgeWithBaseline(model).analyze({
    ...ANALYZE_INPUT,
    collected: { metrics: {} },
  })

  const verdict = validateArtifact('analyze_report', artifact)
  assert.equal(verdict.status, 'missing')
  assert.match(verdict.message, /observed/)
})

test('a model port that never answered the analysis reports the outage, not an empty finding', async () => {
  const artifacts = memoryArtifacts()
  const model = scripted({ cand_analyze: new Error('rate limited') })

  await assert.rejects(
    () => judgeWithBaseline(model, { artifacts }).analyze(ANALYZE_INPUT),
    (error) => isModelUnavailable(error) && /rate limited/.test(error.message),
  )
  assert.equal(artifacts.read('analyze_report:c1'), undefined, 'no root cause was produced, and nothing claims one')
})

test('an empty root cause is a malformed report rather than a finding', async () => {
  const model = scripted({ cand_analyze: { root_cause: '   ' } })
  const artifact = await judgeWithBaseline(model).analyze(ANALYZE_INPUT)

  const verdict = validateArtifact('analyze_report', artifact)
  assert.equal(verdict.status, 'invalid')
  assert.match(verdict.message, /root_cause/)
})

test('the metrics the monitor recorded on the phase state are the evidence when collect() returns nothing', async () => {
  const model = scripted({ cand_analyze: { root_cause: 'the wider table slowed convergence' } })
  const artifact = await judgeWithBaseline(model).analyze({
    ...ANALYZE_INPUT,
    collected: undefined,
    state: { ...ANALYZE_INPUT.state, metrics: { auc: 0.7001 } },
  })

  assert.deepEqual(artifact.observed, { metric: 'auc', value: 0.7001 }, 'MONITOR_POLL hands its metrics to CAND_ANALYZE through the state')
  assert.equal(artifact.verdict, 'regressed')
  assert.deepEqual(validateArtifact('analyze_report', artifact), { status: 'ok', message: '' })
})

test('the metric contract decides which reported number counts, not the model', async () => {
  const model = scripted({ cand_analyze: { root_cause: 'noise' } })
  const judge = judgeFor({
    model: model.model,
    metric: { name: 'ndcg@10', direction: 'higher' },
    baseline: 0.3,
  })
  const artifact = await judge.analyze({
    ...ANALYZE_INPUT,
    collected: { metrics: { auc: 0.7123, 'ndcg@10': 0.2811 } },
  })

  assert.deepEqual(artifact.observed, { metric: 'ndcg@10', value: 0.2811 })
  assert.equal(artifact.verdict, 'regressed')
})

test('a baseline that is not frozen yet yields inconclusive rather than a guess', async () => {
  const model = scripted({ cand_analyze: { root_cause: 'unclear' } })
  const artifact = await judgeFor({ model: model.model, metric: { name: 'auc' } }).analyze(ANALYZE_INPUT)

  assert.equal(artifact.verdict, 'inconclusive')
  assert.deepEqual(validateArtifact('analyze_report', artifact), { status: 'ok', message: '' })
})

test('editing a skill changes the next prompt from the same judge, with no rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-judge-skills-'))
  cpSync(FEED_PROMPTS_DIR, dir, { recursive: true })
  const model = scripted({ verify: { verdict: 'accept', rationale: 'ok' } })
  const judge = judgeFor({ model: model.model, skillsDir: dir })

  await judge.verify(VERIFY_INPUT)
  const path = join(dir, 'verify', 'SKILL.md')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n\nAlso reject PR-CHANGES.\n`)
  await judge.verify(VERIFY_INPUT)

  assert.equal(model.calls[0].prompt.includes('PR-CHANGES'), false)
  assert.match(model.calls[1].prompt, /Also reject PR-CHANGES/, 'the skill is re-read per call, not compiled in')
})
// ------------------------------------------------- ROUND_PLAN / ROUND_REFLECT

const PLAN_FACTS = {
  max_rounds: 3,
  candidates_per_round: 2,
  metric_contract: { name: 'auc', direction: 'higher', contract_ref: 'metric-contract.json' },
  baseline: { metric: 'auc', value: 0.7012 },
  candidates: [],
  previous_reflection: undefined,
}

test('a round plan is contract-valid, and its identity fields come from code rather than from the model', async () => {
  const model = scripted({
    round_plan: {
      round: 99,
      metric_contract_ref: 'whatever-the-model-prefers',
      hypotheses: [
        { id: 'h1', statement: 'widen the embedding table to 2^22', expected_files: ['model/embedding.py'] },
        { statement: 'share the projection across heads', expected_files: ['model/attention.py'] },
      ],
    },
  })
  const judge = judgeFor({ model: model.model, metric: { name: 'auc', contract_ref: 'metric-contract.json' } })
  const artifact = await judge.plan({ round: 2, facts: PLAN_FACTS })

  assert.deepEqual(validateArtifact('candidate_plan', artifact), { status: 'ok', message: '' })
  assert.equal(artifact.round, 2, 'the kernel owns the round number')
  assert.equal(artifact.metric_contract_ref, 'metric-contract.json', 'the kernel owns the metric contract reference')
  assert.deepEqual(artifact.hypotheses.map((hypothesis) => hypothesis.id), ['h1', 'h2'], 'a missing id is assigned by code')
  assert.match(artifact.hypotheses[0].statement, /widen the embedding table/)
  assert.deepEqual(artifact.hypotheses[1].expected_files, ['model/attention.py'])
  assert.equal(model.calls[0].facts.max_rounds, 3, 'the round budget is in the facts the model reads')
})

test('two hypotheses with the same id are a conflict, not a plan', async () => {
  const model = scripted({
    round_plan: {
      hypotheses: [
        { id: 'h1', statement: 'widen the embedding table', expected_files: ['a.py'] },
        { id: 'h1', statement: 'share the projection', expected_files: ['b.py'] },
      ],
    },
  })
  const artifact = await judgeFor({ model: model.model }).plan({ round: 1, facts: PLAN_FACTS })

  const verdict = validateArtifact('candidate_plan', artifact)
  assert.equal(verdict.status, 'conflict')
  assert.match(verdict.message, /share the id/)
})

test('a hypothesis with no statement is invalid, and the message names the field', async () => {
  const model = scripted({
    round_plan: { hypotheses: [{ id: 'h1', expected_files: ['a.py'] }] },
  })
  const artifact = await judgeFor({ model: model.model }).plan({ round: 1, facts: PLAN_FACTS })

  const verdict = validateArtifact('candidate_plan', artifact)
  assert.equal(verdict.status, 'invalid')
  assert.match(verdict.message, /hypotheses\[0\]\.statement/)
})

test('a plan that names no hypothesis is refused rather than silently becoming an empty round', async () => {
  const model = scripted({ round_plan: { hypotheses: [] } })
  const artifact = await judgeFor({ model: model.model }).plan({ round: 1, facts: PLAN_FACTS })

  const verdict = validateArtifact('candidate_plan', artifact)
  assert.equal(verdict.status, 'invalid')
  assert.match(verdict.message, /hypotheses/)
})

test('a reflection is structured, and a model-authored stop flag or score is discarded', async () => {
  const model = scripted({
    round_reflect: {
      summary: 'the wider table helped, the projection change did nothing measurable',
      lessons: [{ statement: 'capacity only pays above a rare-feature rate', evidence: 'candidate c1 vs baseline' }],
      next_round_focus: ['measure the rare-feature rate before adding capacity'],
      stop: true,
      score: 0.42,
      rank: 1,
    },
  })
  const artifact = await judgeFor({ model: model.model }).reflect({ round: 1, facts: PLAN_FACTS, now: AT })

  assert.deepEqual(validateArtifact('round_reflect', artifact), { status: 'ok', message: '' })
  assert.equal(artifact.round, 1)
  assert.equal(artifact.at_ms, AT)
  assert.deepEqual(Object.keys(artifact).sort(), ['at_ms', 'lessons', 'next_round_focus', 'round', 'summary'])
  const serialised = JSON.stringify(artifact)
  for (const forbidden of ['stop', '0.42', 'rank']) {
    assert.equal(serialised.includes(forbidden), false, `the model's ${forbidden} must not survive into the artifact`)
  }
})

test('a reflection with no summary does not advance anything', async () => {
  const model = scripted({ round_reflect: { lessons: [], next_round_focus: ['try something else'] } })
  const artifact = await judgeFor({ model: model.model }).reflect({ round: 1, facts: PLAN_FACTS, now: AT })

  const verdict = validateArtifact('round_reflect', artifact)
  assert.equal(verdict.status, 'missing')
  assert.match(verdict.message, /summary/)
})

test('a reflection whose lessons are all empty strings is malformed, not merely uninformative', async () => {
  const model = scripted({
    round_reflect: { summary: 'nothing learned', lessons: [{ statement: '' }], next_round_focus: ['try again'] },
  })
  const artifact = await judgeFor({ model: model.model }).reflect({ round: 1, facts: PLAN_FACTS, now: AT })

  const verdict = validateArtifact('round_reflect', artifact)
  assert.equal(verdict.status, 'invalid')
  assert.match(verdict.message, /lessons\[0\]\.statement/)
})

// -------------------------------------------------------------------- LAND

test('the LAND entry freezes the hypothesis it will implement and briefs the implementer from the skill', async () => {
  const model = scripted({})
  const judge = judgeFor({ model: model.model, metric: { name: 'auc', contract_ref: 'metric-contract.json' } })
  const { artifact, prompt } = await judge.land({
    candidateId: 'r1-h1',
    round: 1,
    hypothesis: { id: 'h1', statement: 'widen the embedding table to 2^22', expected_files: ['model/embedding.py'] },
    now: AT,
  })

  assert.deepEqual(validateArtifact('land_hypothesis', artifact), { status: 'ok', message: '' })
  assert.equal(artifact.candidate_id, 'r1-h1')
  assert.equal(artifact.round, 1)
  assert.equal(artifact.metric_contract_ref, 'metric-contract.json')
  assert.equal(artifact.frozen_at_ms, AT)
  assert.match(prompt, /LAND — implement exactly one hypothesis/, 'the implementer is briefed from the markdown skill')
  assert.match(prompt, /widen the embedding table to 2\^22/, 'and the hypothesis is in the brief')
  assert.equal(model.count, 0, 'freezing a hypothesis is code; the model is the implementer, not the judge')
})

test('a hypothesis that names no file never becomes a candidate', async () => {
  const model = scripted({})
  const { artifact } = await judgeFor({ model: model.model }).land({
    candidateId: 'r1-h1',
    round: 1,
    hypothesis: { id: 'h1', statement: 'make the model better', expected_files: [] },
    now: AT,
  })

  const verdict = validateArtifact('land_hypothesis', artifact)
  assert.equal(verdict.status, 'invalid')
  assert.match(verdict.message, /expected_files/)
})
