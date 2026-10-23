/**
 * Guards the decision "mnemon's scope is the workspace, and isolation between two workspaces is
 * deliberate, not an accident" (spec: 注入包与记忆; issue 10).
 *
 * Sharing a memory between two experiments is not a feature that is missing — it would be a
 * defect: the second run would inherit the first run's lessons as if it had learned them, and its
 * numbers would be compared against a prior it never agreed to. The strong version of that claim is
 * not "we pass a workspace id"; it is "nothing in this workspace's packet can come from another
 * workspace's files", which is what these tests check line by line.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPacket } from '../lib/packet.js'
import { packetLines, renderPacket } from '../lib/render.js'
import { createInjectionPacketSource } from '../lib/source.js'
import { done, frontierView, injectionConfig, workspace } from './support/fixtures.js'

const port = (compose) => ({ strategy: 'test-strategy', compose })

const strategyDecision = () => ({
  strategy: 'test-strategy',
  sections: {
    recipes: { mode: 'eager', maxCharacters: 4_000 },
    candidate_experiences: { mode: 'eager', maxCharacters: 4_000 },
  },
})

function twoWorkspaces() {
  // Same ids on purpose: an id is only unique inside a workspace, so a leak would be invisible if
  // the two sides had different names.
  const left = workspace([
    { experience_id: 'same-id', section: 'guardrails', text: 'LEFT never widen the head' },
    { experience_id: 'shared', section: 'recipes', text: 'LEFT warm up for one epoch' },
  ])
  const right = workspace([
    { experience_id: 'same-id', section: 'guardrails', text: 'RIGHT never shrink the head' },
    { experience_id: 'shared', section: 'recipes', text: 'RIGHT freeze the embedding layer' },
  ])
  return { left, right }
}

const build = (workspaceDir) =>
  buildPacket({
    view: frontierView({ candidates: [done('c1', 0.7301)] }),
    config: injectionConfig(),
    workspaceDir,
    strategy: port(strategyDecision),
  })

test('two workspaces with the same experience ids assemble different packets', () => {
  const { left, right } = twoWorkspaces()

  const leftPacket = build(left)
  const rightPacket = build(right)

  const leftText = renderPacket(leftPacket)
  const rightText = renderPacket(rightPacket)

  assert.match(leftText, /LEFT never widen the head/u)
  assert.match(leftText, /LEFT warm up for one epoch/u)
  assert.doesNotMatch(leftText, /RIGHT/u, 'no line of one workspace may come from the other workspace\'s files')
  assert.match(rightText, /RIGHT never shrink the head/u)
  assert.doesNotMatch(rightText, /LEFT/u)
  assert.notEqual(leftPacket.digest, rightPacket.digest, 'two workspaces are two contexts, even when their ids and configuration match')
  assert.equal(build(left).digest, leftPacket.digest, 'the same workspace twice is the same packet — the difference above is scope, not noise')
})

test('every provenance ref points inside its own workspace', () => {
  const { left, right } = twoWorkspaces()

  for (const [packetValue, dir, other] of [
    [build(left), left, right],
    [build(right), right, left],
  ]) {
    for (const line of packetLines(packetValue)) {
      if (line.provenance.source !== 'experience-file') continue
      assert.ok(line.provenance.ref.startsWith(dir), `${line.provenance.ref} must be inside ${dir}`)
      assert.ok(!line.provenance.ref.startsWith(other), `${line.provenance.ref} must not be inside the other workspace`)
    }
  }
})

test('two sources, one per workspace, project disjoint text through the host contract', () => {
  const { left, right } = twoWorkspaces()
  const sources = [left, right].map((dir) => {
    const packetValue = build(dir)
    return createInjectionPacketSource({ build: () => packetValue }).create({
      sourceInstanceKey: 'source:injection-packet',
      provenance: { packageName: '@dsh-reprise/memory', entryId: 'test' },
    })
  })

  const projected = sources.map((runtime, index) => {
    const packetValue = build([left, right][index])
    const facts = runtime.facts({ scope: { storage: 'workspace' }, scenario: 'reprise.injection-packet', budget: {} })
    return runtime
      .project({
        scope: { storage: 'workspace' },
        sourceInstanceKey: 'source:injection-packet',
        expectedRevision: facts.revision,
        includeProjection: true,
        mode: 'eager',
        maxCharacters: 4_000,
      })
      .fragments.map((fragment) => fragment.text)
      .join('\n')
  })

  assert.match(projected[0], /LEFT/u)
  assert.doesNotMatch(projected[0], /RIGHT/u)
  assert.match(projected[1], /RIGHT/u)
  assert.doesNotMatch(projected[1], /LEFT/u)
})