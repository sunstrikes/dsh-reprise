/**
 * Guards the audit panel: every judgement the run asked a model for leaves a record that a
 * read-only page can list and open (ticket 29 「大模型调用审计：每次判断的提示词与返回能点开看原文」).
 *
 * The panel exists because "the model said no" is not an explanation until you can read what it was
 * asked and what it answered. So the view has to do two things and neither may be approximated:
 *
 * 1. **List every call**, whatever its outcome. An outage is a call that happened — the prompt went
 *    out and nothing usable came back — and hiding it would turn "the provider was down" into "the
 *    run did nothing".
 * 2. **Return one call's prompt and response verbatim when it is asked for.** Not a summary, not a
 *    truncated copy: the same words, so a reader can judge the prompt itself.
 *
 * The records are the ones ticket 25 writes (`<workspace>/artifacts/model_call/<site>/<subject>…`),
 * produced here through the same `buildQuestion` / `modelCallRecord` / `modelCallName` functions the
 * port uses — the only thing skipped is the CLI process, which ticket 25 already tests.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildQuestion, modelCallName, modelCallRecord } from '@dsh-reprise/exec/model'

import { fileArtifacts } from '../lib/artifacts.js'
import { modelCall, modelCalls } from '../lib/projection.js'
import { Store } from '../lib/store.js'

const AT = 1_761_091_200_000

/** One recorded judgement, filed the way the port files it. */
function record(artifacts, { callSite, subject = null, ref = null, prompt, facts = {}, answer, response, errorClass = null }) {
  const question = buildQuestion({ call_site: callSite, subject, ref, prompt, facts, answer_schema: '{"x": 1}' })
  const name = modelCallName({ call_site: callSite, subject, ref })
  artifacts.write(
    name,
    modelCallRecord({ question, answer: answer ?? null, response: response ?? '', error_class: errorClass, cause: errorClass === null ? null : 'exit_non_zero', message: errorClass === null ? null : 'no credential in this checkout' }),
  )
  return name
}

/** A workspace directory with a store and an artifact directory beside it — where the port writes. */
function workspaceWith(records) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-audit-'))
  const store = Store.open(dir)
  const artifacts = fileArtifacts(join(dir, 'artifacts'))
  for (const entry of records) record(artifacts, entry)
  return { dir, store, artifacts }
}

test('the audit lists every judgement the run asked for, answered or not', () => {
  const prompt = 'You are reviewing a candidate diff.'
  const { store, artifacts } = workspaceWith([
    { callSite: 'verify', subject: 'r1-h1', ref: 'a1', prompt, facts: { attempt: 1 }, answer: { verdict: 'reject' }, response: '{"verdict":"reject"}' },
    { callSite: 'round_plan', subject: 'round-1', prompt: 'Plan round 1.', answer: { hypotheses: [] }, response: '{"hypotheses":[]}' },
    {
      callSite: 'cand_analyze',
      subject: 'r1-h2',
      prompt: 'Explain why it regressed.',
      errorClass: 'model_unavailable',
    },
  ])

  const page = modelCalls(store, { artifacts })

  assert.deepEqual(page.calls.map((call) => call.ref), [
    'model_call:cand_analyze:r1-h2',
    'model_call:round_plan:round-1',
    'model_call:verify:r1-h1:a1',
  ])
  assert.deepEqual(page.calls.map((call) => call.status), ['unavailable', 'answered', 'answered'])
  assert.equal(page.calls[2].call_site, 'verify')
  assert.equal(page.calls[2].subject, 'r1-h1')
  assert.equal(page.calls[2].ref_of_call, 'a1', 'the attempt is part of the name, so two attempts are two rows')
  assert.equal(page.calls[0].error_class, 'model_unavailable', 'a call that got no answer is listed too, with its class')
  assert.equal(page.count, 3)
  store.close()
})

test('one call opens into the prompt and the response it got, word for word', () => {
  const prompt = 'ROUND_PLAN — propose one structural hypothesis.\n\nFacts: {"max_rounds": 1}'
  const response = 'Sure. Here is my answer:\n```json\n{"hypotheses": [{"id": "h1"}]}\n```'
  const { store, artifacts } = workspaceWith([
    { callSite: 'round_plan', subject: 'round-1', prompt, facts: { max_rounds: 1, round: 1 }, answer: { hypotheses: [{ id: 'h1' }] }, response },
  ])

  const call = modelCall(store, 'model_call:round_plan:round-1', { artifacts })

  assert.equal(call.status, 'answered')
  assert.equal(call.prompt, prompt, 'the prompt exactly as the model read it — an audit that paraphrases answers nothing')
  assert.equal(call.response, response, 'and the raw return, including the prose the parser had to see through')
  assert.deepEqual(call.answer, { hypotheses: [{ id: 'h1' }] }, 'beside the object those words became')
  assert.deepEqual(call.facts, { max_rounds: 1, round: 1 })
  assert.equal(call.answer_schema, '{"x": 1}')
  assert.match(call.question_id, /^[0-9a-f]{64}$/, 'the content id, so a repeated question is recognisable as one')
  store.close()
})

test('a call that never answered still opens, with what the CLI said', () => {
  const { store, artifacts } = workspaceWith([
    { callSite: 'cand_analyze', subject: 'r1-h2', prompt: 'Explain why it regressed.', errorClass: 'model_unavailable' },
  ])

  const call = modelCall(store, 'model_call:cand_analyze:r1-h2', { artifacts })

  assert.equal(call.status, 'unavailable')
  assert.equal(call.error_class, 'model_unavailable')
  assert.match(call.message, /no credential/, 'the operator reads the CLI\'s own words, not a rewritten reason')
  assert.equal(call.answer, null, 'no answer is not an empty answer')
  assert.match(call.prompt, /Explain why it regressed/, 'and the prompt that failed is kept, which is what a post-mortem needs')
  store.close()
})

test('the audit refuses a reference that is not one of its records', () => {
  const { store, artifacts } = workspaceWith([
    { callSite: 'verify', subject: 'r1-h1', ref: 'a1', prompt: 'x', answer: {}, response: '{}' },
  ])

  for (const ref of ['model_call:../workspace', 'model_call:', 'verify_verdict:c1:a1', '../../etc/passwd', 'model_call:verify:r1-h1:a2']) {
    assert.equal(modelCall(store, ref, { artifacts }), undefined, `${ref} is not a record this view may open`)
  }
  store.close()
})

test('a workspace that never asked a model answers an empty audit, not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-audit-empty-'))
  const store = Store.open(dir)

  const page = modelCalls(store)

  assert.deepEqual(page.calls, [])
  assert.equal(page.count, 0)
  assert.equal(page.reason, null, 'nothing recorded is not the same as a directory that could not be read')
  store.close()
})