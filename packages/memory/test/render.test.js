/**
 * Guards the decision "a dump can list every item of a packet with the fact that produced it"
 * (spec: 注入包与记忆 / 审计与恢复; issue 10).
 *
 * This is the acceptance line for the packet, the same one `dump --candidate` carries for a
 * candidate: a reader who has never opened this code must be able to answer "what did the model
 * see, and why was it there?" from the output alone. The renderer exists so that question has one
 * answer, rendered once, instead of three print statements in three places.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPacket } from '../lib/packet.js'
import { packetLines, renderPacket } from '../lib/render.js'
import { done, frontierView, injectionConfig, workspace } from './support/fixtures.js'

const port = (decide) => ({ strategy: 'test-strategy', compose: () => decide })

function packetFor() {
  const workspaceDir = workspace([
    { experience_id: 'r', section: 'recipes', text: 'warm up for one epoch' },
    { experience_id: 'g', section: 'guardrails', text: 'never widen the head' },
  ])
  return buildPacket({
    view: frontierView({ candidates: [done('c1', 0.7301)] }),
    config: injectionConfig({ forbidden: ['add a second attention block'] }),
    workspaceDir,
    strategy: port({
      sections: {
        recipes: { mode: 'eager', maxCharacters: 29 },
        candidate_experiences: { mode: 'routed', maxCharacters: 0 },
      },
    }),
  })
}

test('every packet line is listed with the fact that produced it', () => {
  const packet = packetFor()
  const lines = packetLines(packet)

  assert.equal(
    lines.length,
    packet.sections.guardrails.items.length +
      packet.sections.singletons.items.length +
      packet.sections.frontier.items.length +
      packet.ranked.recipes.items.length +
      packet.ranked.recipes.staged.length +
      packet.ranked.candidate_experiences.staged.length,
    'nothing in the packet is invisible to the renderer, and nothing staged is invisible either',
  )
  assert.deepEqual(
    lines.filter((line) => line.in_packet).map((line) => line.fact_id),
    [
      ...packet.sections.guardrails.items,
      ...packet.sections.singletons.items,
      ...packet.sections.frontier.items,
      ...packet.ranked.recipes.items,
    ].map((item) => item.fact_id),
    'the lines that are in the packet come first, in packet order',
  )
  for (const line of lines) {
    assert.ok(line.provenance?.source, `${line.fact_id} names the source fact it came from`)
    assert.ok(typeof line.provenance.ref === 'string' && line.provenance.ref !== '', `${line.fact_id} names the ref`)
  }
})

test('the rendered packet prints each provenance beside its line, and marks what was left out', () => {
  const packet = packetFor()
  const text = renderPacket(packet)
  const line = (needle) => text.split('\n').find((entry) => entry.includes(needle)) ?? ''

  assert.match(text, /^# injection packet$/mu, 'a dump section announces itself')
  assert.match(line('digest:'), new RegExp(`digest: ${packet.digest}`, 'u'), 'the digest is printed, so two dumps can be compared')
  assert.match(
    line('forbidden_direction: add a second attention block'),
    /← config:injection\.guardrails\.forbidden_directions\[0\] +\(in packet\)$/u,
    'the guardrail points at the config path it came from',
  )
  assert.match(
    line('guardrail: never widen the head'),
    /← experience-file:.*experiences\/g\.json +\(in packet\)$/u,
    'a promoted guardrail points at the file a human wrote',
  )
  assert.match(line('recipe: warm up for one epoch'), /← experience-file:.*experiences\/r\.json +\(in packet\)$/u)
  assert.match(
    line('recipe: warm up for one epoch'),
    /\(in packet\)$/u,
    'and says whether the line was actually projected or only staged',
  )
})

test('a degraded packet says so in the render, so a thin context is never mistaken for a rich one', () => {
  const packet = buildPacket({
    view: frontierView({ candidates: [] }),
    config: injectionConfig(),
    workspaceDir: workspace([]),
  })

  const text = renderPacket(packet)

  assert.match(text, /^## degraded$/mu)
  assert.match(text, /no_ranked_strategy/u, 'the reason the ranked half is empty is printed, not implied')
  assert.match(text, /^## guardrails \[hard/mu, 'the hard sections still render, complete')
})

test('a routed recipe is rendered as reachable but not projected', () => {
  const packet = buildPacket({
    view: frontierView({ candidates: [] }),
    config: injectionConfig(),
    workspaceDir: workspace([{ experience_id: 'r', section: 'recipes', text: 'warm up for one epoch' }]),
    strategy: port({
      sections: {
        recipes: { mode: 'routed', maxCharacters: 4_000 },
        candidate_experiences: { mode: 'routed', maxCharacters: 0 },
      },
    }),
  })

  const line = renderPacket(packet)
    .split('\n')
    .find((entry) => entry.includes('recipe: warm up for one epoch'))

  assert.match(line, /\(not in packet: routed\)$/u)
})