/**
 * Every judgement leaves its prompt and its return on disk, where a read-only page can render them.
 *
 * Ticket 29 draws the audit panel; this file holds the record it will read. Three properties make it
 * readable and worth reading:
 *
 * 1. **It is a file, not a row and not a log line.** `<workspace>/artifacts/model_call/<call site>/
 *    <subject>[/<ref>].json` — a reader with the workspace directory and no database can open it,
 *    which is the same access the dashboard has.
 * 2. **It carries both halves of the call.** The prompt the model was given, the facts it was given
 *    with it, the words it returned, and the object those words became. An audit that kept only the
 *    parsed answer could not tell a terse model from a prompt that never asked the question.
 * 3. **It is content-addressed.** No timestamp, no counter: asking the same question twice rewrites
 *    the same bytes, so a repeat cannot masquerade as a second judgement and a diff of two runs
 *    shows what actually differed.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MODEL_UNAVAILABLE, isModelUnavailable } from '@dsh-reprise/exec/model'

import { fileArtifacts } from '../lib/artifacts.js'
import { createModelFromConfig, recordLandCall } from '../lib/ports.js'
import { judgeFor } from './support/domain.js'

const AT = 1_761_091_200_000

/** A fake engine: one JSON question on stdin, one JSON answer on stdout. No provider anywhere. */
const FAKE_MODEL = `
import { readFileSync } from 'node:fs'
const mode = process.env.FAKE_MODE ?? 'answer'
const question = JSON.parse(readFileSync(0, 'utf8'))
if (mode === 'fail') {
  process.stderr.write('no credential in this checkout\\n')
  process.exitCode = 1
}
if (question.call_site === 'round_plan') {
  process.stdout.write(JSON.stringify({ hypotheses: [{ id: 'h1', statement: 'widen the embedding table', expected_files: ['model/embedding.py'] }] }) + '\\n')
} else {
  process.stdout.write(JSON.stringify({ verdict: 'accept', rationale: 'the diff is minimal' }) + '\\n')
}
`

function rig({ mode = 'answer' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-model-call-'))
  const cli = join(dir, 'fake-model.mjs')
  writeFileSync(cli, `${FAKE_MODEL}\n`, 'utf8')
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  const model = createModelFromConfig({
    model: { command: [process.execPath, cli], env: { FAKE_MODE: mode }, timeout_ms: 30_000 },
    artifacts,
    cwd: dir,
  })
  const judge = judgeFor({ model, artifacts })
  const recordPath = (name) => join(artifacts.dir, `${String(name).replaceAll(':', '/')}.json`)
  return { dir, artifacts, model, judge, recordPath }
}

const PLAN_FACTS = { max_rounds: 1, candidates_per_round: 1 }

test('a judgement leaves the prompt, the facts, the answer text and the answer object on disk', async () => {
  const { judge, recordPath } = rig()

  const artifact = await judge.plan({ round: 1, facts: PLAN_FACTS })

  const stored = JSON.parse(readFileSync(recordPath('model_call:round_plan:round-1'), 'utf8'))
  assert.equal(stored.call_site, 'round_plan')
  assert.equal(stored.subject, 'round-1')
  assert.equal(stored.status, 'answered')
  assert.match(stored.prompt, /ROUND_PLAN/, 'the prompt is the markdown skill the model actually read')
  assert.deepEqual(stored.facts, { ...PLAN_FACTS, round: 1 }, 'and the facts it read with it')
  assert.equal(stored.answer_schema, '{"hypotheses": [{"id": "h1", "statement": "<one structural claim>", "expected_files": ["path/one"]}]}', 'the answer shape it was asked for')
  assert.deepEqual(stored.answer, { hypotheses: [{ id: 'h1', statement: 'widen the embedding table', expected_files: ['model/embedding.py'] }] })
  assert.match(stored.response, /widen the embedding table/, 'the raw return is kept, not only the object it became')
  assert.equal(stored.error_class, null)
  assert.match(stored.question_id, /^[0-9a-f]{64}$/)
  assert.deepEqual(artifact.hypotheses.map((hypothesis) => hypothesis.id), ['h1'], 'the record sits beside the artifact it explains')
})

test('a VERIFY judgement is filed under its attempt, so attempt 1 is not erased by attempt 2', async () => {
  const { judge, recordPath } = rig()
  const input = {
    candidateId: 'r1-h1',
    state: { phase: 'VERIFY', round: 1, hypothesis: 'widen the embedding table' },
    parent: { parent_id: 'baseline-0', parent_commit: 'aaa1111' },
    now: AT,
  }

  await judge.verify({ ...input, attempt: 1 })
  await judge.verify({ ...input, attempt: 2 })

  const first = JSON.parse(readFileSync(recordPath('model_call:verify:r1-h1:a1'), 'utf8'))
  const second = JSON.parse(readFileSync(recordPath('model_call:verify:r1-h1:a2'), 'utf8'))
  assert.equal(first.facts.attempt, 1)
  assert.equal(second.facts.attempt, 2)
  assert.notEqual(first.question_id, second.question_id, 'a different question (the attempt) has a different id')
})

test('asking the same question twice rewrites the same bytes: the record has no clock in it', async () => {
  const { judge, recordPath } = rig()
  const path = recordPath('model_call:round_plan:round-1')

  await judge.plan({ round: 1, facts: PLAN_FACTS })
  const once = readFileSync(path, 'utf8')
  await judge.plan({ round: 1, facts: PLAN_FACTS })
  const twice = readFileSync(path, 'utf8')

  assert.equal(once, twice, 'same question, same record — a repeat cannot read as a second judgement')
  const stored = JSON.parse(once)
  for (const forbidden of ['at_ms', 'recorded_at', 'timestamp', 'duration_ms']) {
    assert.equal(forbidden in stored, false, `the record must not carry ${forbidden}: identity is the question`)
  }
})

test('an outage is filed too — with what the CLI said — so the audit shows why nothing happened', async () => {
  const { judge, recordPath } = rig({ mode: 'fail' })

  await assert.rejects(() => judge.plan({ round: 1, facts: PLAN_FACTS }), (error) => isModelUnavailable(error))

  const stored = JSON.parse(readFileSync(recordPath('model_call:round_plan:round-1'), 'utf8'))
  assert.equal(stored.status, 'unavailable')
  assert.equal(stored.answer, null, 'no answer is not an empty answer')
  assert.equal(stored.error_class, MODEL_UNAVAILABLE)
  assert.equal(stored.cause, 'exit_non_zero')
  assert.match(stored.message, /no credential in this checkout/, 'the operator reads the CLI\'s own words')
  assert.match(stored.prompt, /ROUND_PLAN/, 'and the prompt that failed is kept, which is what a post-mortem needs')
})

// -------------------------------------------------------------------- LAND

const LANDING_RESULT = (overrides = {}) => ({
  ok: true,
  error_class: 'ok',
  prompt: 'You are the candidate implementer inside an automated model-structure exploration loop.\nCandidate r1-h1, round 1.',
  engine: 'command',
  candidate_id: 'r1-h1',
  parent_id: 'baseline-0',
  parent_commit: 'aaa1111',
  base_ref: 'HEAD',
  files: ['model/embedding.py'],
  files_changed: 1,
  cross_check: { status: 'not_reported' },
  output: 'I widened the table.\n\n```json\n{"files": ["model/embedding.py"]}\n```\n',
  ...overrides,
})

test('LAND is the fifth call site: the briefing and what the implementer did are filed the same way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-model-call-land-'))
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  const request = { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table', parentId: 'baseline-0', worktreeDir: '/tmp/wt' }

  const stored = recordLandCall(artifacts, request, LANDING_RESULT())

  const record = JSON.parse(readFileSync(stored.path, 'utf8'))
  assert.equal(record.call_site, 'land')
  assert.equal(record.subject, 'r1-h1')
  assert.equal(record.status, 'answered')
  assert.match(record.prompt, /candidate implementer/, 'the text the implementer actually received')
  assert.equal(record.facts.hypothesis, 'widen the embedding table', 'and the hypothesis it was landed for')
  assert.deepEqual(record.answer.files, ['model/embedding.py'])
  assert.equal(record.answer.cross_check, 'not_reported')
  assert.match(record.response, /I widened the table/, 'git decides the diff, but the model\'s words are kept')
  assert.ok(stored.path.endsWith(join('model_call', 'land', 'r1-h1.json')))
})

test('LAND: an implementer that never answered is filed as the same closed class', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-model-call-land-down-'))
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  const request = { candidateId: 'r1-h1', round: 1, hypothesis: 'widen the embedding table', worktreeDir: '/tmp/wt' }

  recordLandCall(
    artifacts,
    request,
    LANDING_RESULT({ ok: false, error_class: 'harness_unavailable', message: 'claude: command not found', files: [], files_changed: 0 }),
  )

  const record = JSON.parse(readFileSync(join(artifacts.dir, 'model_call', 'land', 'r1-h1.json'), 'utf8'))
  assert.equal(record.status, 'unavailable')
  assert.equal(record.error_class, MODEL_UNAVAILABLE, 'one class across all five call sites, LAND included')
  assert.equal(record.cause, 'harness_unavailable', 'with the finer cause kept for the operator')
  assert.match(record.message, /command not found/)
  assert.equal(record.answer.files.length, 0)
})
