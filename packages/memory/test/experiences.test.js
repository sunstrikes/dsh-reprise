/**
 * Guards the decision "promoted experiences are files, read as the candidate-experience corpus, and
 * one experience has exactly one home in the packet" (spec: 注入包与记忆; issue 10, issue 12).
 *
 * The writer is `core/lib/intents.js`: a human promotes an experience and it lands in
 * `<workspace>/experiences/<id>.json` with a `section`. This module is the reader. The rule it must
 * not break is the one that would be invisible if it did: an experience promoted into `guardrails`
 * is supplied verbatim by the hard quota, so it must never *also* be offered to the strategy that
 * ranks recipes — that is the same fact twice in every future turn.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { readExperiences, splitCorpus } from '../lib/experiences.js'
import { workspace, writeExperience, writeRawExperience } from './support/fixtures.js'

test('the promoted files are the corpus, in filename order, with their section intact', () => {
  const dir = workspace([
    { experience_id: 'b-warmup', section: 'recipes', text: 'warm up for one epoch', intent_id: 'i-2', promoted_at_ms: 1 },
    { experience_id: 'a-guardrail', section: 'guardrails', text: 'never widen the head', intent_id: 'i-1', promoted_at_ms: 1 },
    { experience_id: 'c-experience', section: 'candidate_experiences', text: 'depth 8 beat depth 6', intent_id: 'i-3', promoted_at_ms: 1 },
  ])

  const corpus = readExperiences(dir)

  assert.deepEqual(
    corpus.items.map((item) => [item.experience_id, item.section]),
    [
      ['a-guardrail', 'guardrails'],
      ['b-warmup', 'recipes'],
      ['c-experience', 'candidate_experiences'],
    ],
    'filename order, so two readers of one workspace assemble the same packet',
  )
  assert.equal(corpus.items[1].text, 'warm up for one epoch')
  assert.equal(corpus.items[1].intent_id, 'i-2', 'the receipt of the promotion travels with the fact')
  assert.deepEqual(corpus.rejected, [])
})

test('a workspace with no experience directory yet is empty, not broken', () => {
  const corpus = readExperiences('/tmp/reprise-memory-no-such-workspace-dir')

  assert.deepEqual(corpus.items, [], 'nobody has promoted anything yet — that is not an error')
  assert.deepEqual(corpus.rejected, [])
  assert.equal(corpus.missing, true, 'and the reader says so, so a caller can tell "none" from "unreadable"')
})

test('a malformed or unrecognisable promotion is reported, never silently kept out of the packet', () => {
  const dir = workspace([{ experience_id: 'ok', section: 'recipes', text: 'a real recipe', intent_id: 'i-1' }])
  writeRawExperience(dir, 'broken-json', '{ "experience_id": "broken-json", "text": ')
  writeRawExperience(dir, 'wrong-id', JSON.stringify({ experience_id: 'some-other-id', section: 'recipes', text: 'mismatched name' }))
  writeExperience(dir, { experience_id: 'bad-section', section: 'hunches', text: 'a section nobody declared' })
  writeExperience(dir, { experience_id: 'empty-text', section: 'recipes', text: '   ' })
  writeExperience(dir, { experience_id: 'extra-field', section: 'recipes', text: 'a recipe', note: 'hand edited' })

  const corpus = readExperiences(dir)

  assert.deepEqual(
    corpus.items.map((item) => item.experience_id),
    ['ok'],
    'only the well-formed promotion is a fact the packet may carry',
  )
  assert.deepEqual(
    corpus.rejected.map((entry) => entry.name).sort(),
    ['bad-section.json', 'broken-json.json', 'empty-text.json', 'extra-field.json', 'wrong-id.json'],
    'every other file is named — a promotion that vanished without a line is how a run loses a lesson',
  )
  assert.match(
    corpus.rejected.find((entry) => entry.name === 'bad-section.json').reason,
    /section/u,
    'the reason points at what is wrong, so the operator can fix the file',
  )
})

test('each experience has exactly one home: sections split the corpus, none is copied twice', () => {
  const dir = workspace([
    { experience_id: 'g', section: 'guardrails', text: 'never widen the head' },
    { experience_id: 's', section: 'singletons', text: 'the global best is frozen at birth' },
    { experience_id: 'r', section: 'recipes', text: 'warm up for one epoch' },
    { experience_id: 'e', section: 'candidate_experiences', text: 'depth 8 beat depth 6' },
  ])

  const problems = []
  const corpus = splitCorpus(readExperiences(dir), { problems })

  assert.deepEqual(corpus.hard.guardrails.map((item) => item.experience_id), ['g'])
  assert.deepEqual(corpus.hard.singletons.map((item) => item.experience_id), ['s'])
  assert.deepEqual(corpus.soft.recipes.map((item) => item.experience_id), ['r'])
  assert.deepEqual(corpus.soft.candidate_experiences.map((item) => item.experience_id), ['e'])
  assert.deepEqual(problems, [], 'a well-formed corpus needs no excuses')

  const everyHome = [
    ...corpus.hard.guardrails,
    ...corpus.hard.singletons,
    ...corpus.soft.recipes,
    ...corpus.soft.candidate_experiences,
  ].map((item) => item.experience_id)
  assert.deepEqual(everyHome.sort(), ['e', 'g', 'r', 's'], 'four promotions, four homes, no duplicates')
})

test('a promotion with no section is a recipe, the same default the writer applies', () => {
  const dir = workspace([])
  writeRawExperience(dir, 'no-section', JSON.stringify({ experience_id: 'no-section', text: 'a recipe by default' }))

  const corpus = splitCorpus(readExperiences(dir), { problems: [] })

  assert.deepEqual(corpus.soft.recipes.map((item) => item.experience_id), ['no-section'])
})