/**
 * The dump-facing renderer for an injection packet.
 *
 * The packet is the one artefact where "the model saw this" has to be answerable afterwards, so the
 * renderer's job is narrow and fixed: one line per packet item, with the fact that produced it in a
 * column of its own, and an explicit marker for the items that were *not* projected (routed or over
 * budget). Both halves matter — a dump that silently omitted the staged items would make the ranked
 * corpus look empty, and one that printed them as if they had been injected would be a lie.
 *
 * Pure: no store, no clock, no host. `packetLines` is the data, `renderPacket` is the text, and the
 * CLI can use either.
 *
 * @module
 */

import { HARD_SECTIONS, RANKED_SECTIONS } from './packet.js'

const WIDTH = 72

/** Section titles carry the quota, because "why is this not trimmed?" is the first question. */
const TITLES = {
  guardrails: 'guardrails [hard — verbatim, no ranking, no truncation]',
  singletons: 'singletons [hard — verbatim, no ranking, no truncation]',
  frontier: 'frontier [hard — every candidate, not a top-N]',
}

const pad = (text) => (text.length >= WIDTH ? `${text}  ` : text.padEnd(WIDTH))

/**
 * Flatten a packet into lines. `in_packet` distinguishes what the model actually received from what
 * was staged for the on-demand route, so a reader can never mistake the second for the first.
 *
 * @returns {{ section: string, fact_id: string, text: string, in_packet: boolean, reason?: string, provenance: object }[]}
 */
export function packetLines(packet) {
  const lines = []

  for (const section of HARD_SECTIONS) {
    for (const item of packet?.sections?.[section]?.items ?? []) {
      lines.push({ section, fact_id: item.fact_id, text: item.text, in_packet: true, provenance: item.provenance })
    }
  }

  for (const section of RANKED_SECTIONS) {
    const ranked = packet?.ranked?.[section]
    if (ranked === undefined) continue
    for (const item of ranked.items) {
      lines.push({ section, fact_id: item.fact_id, text: item.text, in_packet: true, provenance: item.provenance })
    }
    for (const item of ranked.staged) {
      lines.push({
        section,
        fact_id: item.fact_id,
        text: item.text,
        in_packet: false,
        reason: item.reason,
        provenance: item.provenance,
      })
    }
  }

  return lines
}

/** `source:ref` — short enough to read in a column, precise enough to grep. */
function provenanceText(provenance) {
  const source = provenance?.source ?? 'unknown'
  const ref = typeof provenance?.ref === 'string' && provenance.ref !== '' ? provenance.ref : 'unknown'
  return `${source}:${ref}`
}

function rankedTitle(section, ranked) {
  if (ranked === undefined) return section
  if (ranked.delegated_to === null) return `${section} [not ranked — no strategy decided]`
  return `${section} [ranked by ${ranked.delegated_to} — ${ranked.mode}, ${ranked.maxCharacters} characters]`
}

/**
 * Render the whole packet. Every line keeps its provenance, and the header states the workspace and
 * the digest so two dumps of two runs cannot be confused with each other.
 *
 * @param {object} packet
 * @returns {string}
 */
export function renderPacket(packet) {
  const out = ['# injection packet', `workspace: ${packet?.workspace?.dir ?? 'unknown'}`, `digest: ${packet?.digest ?? 'unknown'}`]

  for (const section of HARD_SECTIONS) {
    out.push('', `## ${TITLES[section]}`)
    const items = packet?.sections?.[section]?.items ?? []
    if (items.length === 0) out.push('(empty)')
    for (const item of items) out.push(`${pad(item.text)}← ${provenanceText(item.provenance)}  (in packet)`)
  }

  for (const section of RANKED_SECTIONS) {
    const ranked = packet?.ranked?.[section]
    out.push('', `## ${rankedTitle(section, ranked)}`)
    if (ranked === undefined || (ranked.items.length === 0 && ranked.staged.length === 0)) out.push('(empty)')
    for (const item of ranked?.items ?? []) out.push(`${pad(item.text)}← ${provenanceText(item.provenance)}  (in packet)`)
    for (const item of ranked?.staged ?? []) {
      out.push(`${pad(item.text)}← ${provenanceText(item.provenance)}  (not in packet: ${item.reason})`)
    }
  }

  if ((packet?.degraded ?? []).length > 0) {
    out.push('', '## degraded')
    for (const entry of packet.degraded) out.push(`- ${entry.code}: ${entry.message}`)
  }

  if ((packet?.problems ?? []).length > 0) {
    out.push('', '## problems')
    for (const entry of packet.problems) out.push(`- ${entry.code}: ${entry.message}`)
  }

  if ((packet?.suppressed ?? []).length > 0) {
    out.push('', '## suppressed duplicates')
    for (const entry of packet.suppressed) out.push(`- ${entry.fact_id}: already emitted by ${entry.kept_in}`)
  }

  return `${out.join('\n')}\n`
}