/**
 * The skill pack contract: the judgement-facing half of all five model call sites is markdown on
 * disk, and editing that markdown changes what the model is asked without repackaging or touching
 * code (spec "写领域 skill 的人" / decision "模型输出必须先变成 validator 接受的 artifact").
 *
 * These tests are deliberately about *the file on disk*, not about a parsed object: the whole point
 * of a skill pack is that its authority is editable text, so a loader that caches a compiled copy
 * would quietly break the promise.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CALL_SITES,
  SkillMissingError,
  loadSkill,
  loadSkills,
  renderPrompt,
  skillPath,
} from '../lib/skills.js'
import { FEED_PROMPTS_DIR } from './support/domain.js'

/** A throwaway copy of the shipped pack, so a test may edit markdown without touching the repo. */
function copiedPack() {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-skills-'))
  cpSync(FEED_PROMPTS_DIR, dir, { recursive: true })
  return dir
}

test('every model call site has its own markdown skill, and none is empty', () => {
  const skills = loadSkills(FEED_PROMPTS_DIR)
  assert.deepEqual([...skills.keys()], [...CALL_SITES], 'one skill per call site, in a stable order')
  for (const callSite of CALL_SITES) {
    const skill = skills.get(callSite)
    assert.equal(skill.call_site, callSite)
    assert.ok(skill.body.length > 200, `${callSite}: a skill too short to instruct anything is a placeholder`)
    assert.ok(skill.description.length > 20, `${callSite}: the routing description must say when to use it`)
    assert.equal(skill.path, skillPath(FEED_PROMPTS_DIR, callSite), 'the record points at the file it came from')
  }
})

test('editing a skill file changes the prompt without touching code or repackaging', () => {
  const dir = copiedPack()
  const before = renderPrompt(loadSkill(dir, 'verify'), { facts: { candidate_id: 'c1' }, answer: '{}' })
  assert.doesNotMatch(before, /MUTATION-MARKER/)

  const path = skillPath(dir, 'verify')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n\nReject any change that touches MUTATION-MARKER files.\n`)

  const after = renderPrompt(loadSkill(dir, 'verify'), { facts: { candidate_id: 'c1' }, answer: '{}' })
  assert.match(after, /MUTATION-MARKER files/, 'the next prompt is built from the edited file, not from a compiled copy')
  assert.equal(loadSkill(dir, 'verify').path, path)
})

test('the prompt carries the skill, then the frozen facts, then the required answer shape', () => {
  const skill = loadSkill(FEED_PROMPTS_DIR, 'verify')
  const prompt = renderPrompt(skill, {
    facts: { candidate_id: 'c1', checks: [{ name: 'static_imports', result: 'pass' }] },
    answer: '{"verdict": "accept" | "reject"}',
  })

  // The skill's own headings are part of its text, so the prompt's markers are found from the end:
  // what matters is that the body comes first, unedited, and the two generated sections follow it.
  const contextAt = prompt.lastIndexOf('\n## Context')
  const factsAt = prompt.lastIndexOf('\n## Facts')
  const answerAt = prompt.lastIndexOf('\n## Answer')
  assert.ok(contextAt > 0 && factsAt > contextAt && answerAt > factsAt, 'context, then facts, then the answer shape')
  assert.ok(prompt.startsWith(skill.body), 'the editable text comes first and is used verbatim')
  assert.equal(
    prompt.slice(0, contextAt).trim(),
    skill.body,
    'nothing is inserted between the instruction and the context it is meant to be read against',
  )

  const facts = prompt.slice(factsAt, answerAt)
  assert.match(facts, /"candidate_id": "c1"/, 'facts are handed over as JSON, not paraphrased into prose')
  assert.match(facts, /static_imports/)

  const answer = prompt.slice(answerAt)
  assert.match(answer, /"verdict"/)
})

test('a missing skill fails loudly instead of prompting the model with nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'reprise-skills-empty-'))
  assert.throws(
    () => loadSkill(empty, 'round_plan'),
    (error) => {
      assert.ok(error instanceof SkillMissingError)
      assert.match(error.message, /round-plan/)
      assert.match(error.message, /SKILL\.md/)
      assert.equal(error.skillPath, skillPath(empty, 'round_plan'))
      return true
    },
  )
})

test('an unknown call site is refused rather than silently mapped to a file', () => {
  assert.throws(() => skillPath(FEED_PROMPTS_DIR, 'judge_everything'), /unknown call site/)
})
test('the injection packet reaches the prompt, and an empty one says so', () => {
  const skill = { body: 'Judge this.' }
  const withPacket = renderPrompt(skill, { facts: {}, answer: '{}', packet: ['[guardrail] never widen the table', '[frontier] r1-c1 auc=0.71'] })
  assert.match(withPacket, /## Context/, 'the packet is its own section, before the facts')
  assert.match(withPacket, /\[guardrail\] never widen the table/, 'a fixed-quota line is verbatim')
  assert.ok(withPacket.indexOf('## Context') < withPacket.indexOf('## Facts'), 'context is read before the record')

  const without = renderPrompt(skill, { facts: {}, answer: '{}' })
  assert.match(without, /no injection packet was provided/, 'absence is stated, not implied by a gap')
})
