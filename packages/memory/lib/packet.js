/**
 * The injection packet: the exact context a model turn receives, assembled from facts.
 *
 * Two halves, and the boundary between them is the whole design.
 *
 *   **Hard quota — supplied verbatim.** Guardrails (forbidden directions and anti-patterns),
 *   singletons (the global best and the search space), and the current frontier. These are the
 *   parts where a wrong answer is silent: a dropped guardrail reads as permission, a rounded metric
 *   reads as a different result, a frontier shown as top-N hides the candidate that was compared.
 *   So they are never ranked, never deduped, never truncated, and never summarised by this module.
 *
 *   **Ranked — delegated.** Recipes and candidate experiences do not fit in any context window as a
 *   whole, so *something* has to choose. That something is not this file: it is a strategy port
 *   (see `strategy.js`), which owns admission and budget, and which in production is a dsh-mnemon
 *   strategy. This module only fills what the port admitted, and records who decided.
 *
 * Every line carries provenance. A packet is the one artefact where "why did the model see this?"
 * has to be answerable after the fact, so each item names the fact that produced it, and the
 * renderer (`render.js`) prints that name next to the line.
 *
 * This module is read-only and holds no state. It is not on the write path of anything: there is no
 * function here that stores, remembers, or accepts an item chosen by a model.
 *
 * @module
 */

import { createHash } from 'node:crypto'

import { readExperiences, splitCorpus } from './experiences.js'

/** Supplied whole. The order here is the priority order used when two sections would emit one fact. */
export const HARD_SECTIONS = Object.freeze(['guardrails', 'singletons', 'frontier'])

/** Delegated to a strategy port: admission and budget belong to it, not to this module. */
export const RANKED_SECTIONS = Object.freeze(['recipes', 'candidate_experiences'])

/**
 * The budget the packet asks a strategy for when the workspace config does not say. It is a request,
 * not a limit: the strategy answers with whatever it grants, and mnemon's host budget can cap it
 * further. Every ranked item that does not fit is kept in `staged`, reachable through the source
 * route — nothing is deleted.
 */
const DEFAULT_RANKED_BUDGET = 6_000

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Key-order-independent JSON, so the same facts always produce the same digest. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const digestOf = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex')

/**
 * A guardrail list is either a list of strings or a declaration error. It is never "the strings we
 * could parse": a guardrail silently dropped because one entry was malformed is the exact failure
 * this section exists to prevent.
 */
function stringList(value) {
  if (value === undefined || value === null) return { ok: true, items: [] }
  if (!Array.isArray(value)) return { ok: false, items: [], error: `expected an array of strings, got ${jsonType(value)}` }
  const items = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, items: [], error: `entry ${index} is not a non-empty string` }
    }
    items.push(entry)
  }
  return { ok: true, items }
}

const jsonType = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)

/**
 * Guardrails: forbidden directions and anti-patterns, exactly as declared.
 *
 * An empty list produces an explicit "none declared" line rather than nothing at all, because an
 * absent line and an empty list look identical to a reader — one of them means "no rule", and the
 * other means "nobody wrote one yet", and the model is entitled to know which.
 */
function guardrailsSection({ config, corpus, problems }) {
  const items = []
  const declared = config?.injection?.guardrails

  if (declared !== undefined && !isObject(declared)) {
    problems.push({
      code: 'guardrails_invalid',
      message: `config.injection.guardrails must be an object with "forbidden_directions" and "anti_patterns", got ${jsonType(declared)}`,
    })
    items.push({
      fact_id: 'guardrail:invalid',
      text: 'guardrails: invalid — config.injection.guardrails must be an object with "forbidden_directions" and "anti_patterns"',
      provenance: { kind: 'declaration_error', source: 'config', ref: 'injection.guardrails' },
    })
    return items
  }

  for (const [kind, field] of [
    ['forbidden_direction', 'forbidden_directions'],
    ['anti_pattern', 'anti_patterns'],
  ]) {
    const list = stringList(declared?.[field])
    if (!list.ok) {
      problems.push({ code: `${field}_invalid`, message: `config.injection.guardrails.${field}: ${list.error}` })
      items.push({
        fact_id: `guardrail:${field}:invalid`,
        text: `${field}: invalid — ${list.error}`,
        provenance: { kind: 'declaration_error', source: 'config', ref: `injection.guardrails.${field}` },
      })
      continue
    }
    if (list.items.length === 0) {
      items.push({
        fact_id: `guardrail:${field}:none`,
        text: `guardrails: no ${field.replace(/_/gu, ' ')} declared for this workspace`,
        provenance: { kind: 'absence', source: 'config', ref: `injection.guardrails.${field}` },
      })
      continue
    }
    for (const [index, entry] of list.items.entries()) {
      items.push({
        fact_id: `guardrail:${kind}:${index}`,
        text: `${kind}: ${entry}`,
        provenance: { kind, source: 'config', ref: `injection.guardrails.${field}[${index}]`, index },
      })
    }
  }

  for (const experience of corpus.hard.guardrails) {
    items.push({
      fact_id: `guardrail:experience:${experience.experience_id}`,
      text: `guardrail: ${experience.text}`,
      provenance: {
        kind: 'guardrail',
        source: 'experience-file',
        ref: experience.path,
        experience_id: experience.experience_id,
      },
    })
  }

  return items
}

/** `name:value,name:value` — the declared objectives only, in contract order. A metric no objective names is not a score. */
function vectorText(vector) {
  const entries = Object.entries(vector ?? {})
  return entries.length === 0 ? 'none' : entries.map(([name, value]) => `${name}:${value}`).join(',')
}

/**
 * The singletons: the global best and the search space. Both are statements the whole run agrees
 * on, which is why they are supplied rather than chosen — a strategy that dropped them would leave
 * the model free to re-open a question the loop had already settled.
 */
function singletonsSection({ view, config, corpus, problems }) {
  const items = []
  const best = view?.best

  items.push(
    best === undefined
      ? {
          fact_id: 'singleton:global_best',
          text: 'global_best: none — no candidate has a complete objective vector yet',
          provenance: { kind: 'absence', source: 'frontier', ref: 'best' },
        }
      : {
          fact_id: 'singleton:global_best',
          text: `global_best: candidate=${best.candidate_id} metric=${best.metric} value=${best.value} round=${best.round}`,
          provenance: {
            kind: 'global_best',
            source: 'frontier',
            ref: 'best',
            candidate_id: best.candidate_id,
            metric: best.metric,
            value: best.value,
            round: best.round,
          },
        },
  )

  const searchSpace = config?.injection?.search_space
  if (searchSpace === undefined || searchSpace === null) {
    items.push({
      fact_id: 'singleton:search_space',
      text: 'search_space: not declared for this workspace',
      provenance: { kind: 'absence', source: 'config', ref: 'injection.search_space' },
    })
  } else if (!isObject(searchSpace)) {
    problems.push({
      code: 'search_space_invalid',
      message: `config.injection.search_space must be an object of named groups, got ${jsonType(searchSpace)}`,
    })
    items.push({
      fact_id: 'singleton:search_space:invalid',
      text: `search_space: invalid — expected an object of named groups, got ${jsonType(searchSpace)}`,
      provenance: { kind: 'declaration_error', source: 'config', ref: 'injection.search_space' },
    })
  } else {
    for (const [group, value] of Object.entries(searchSpace)) {
      items.push({
        fact_id: `singleton:search_space:${group}`,
        text: `search_space.${group}: ${JSON.stringify(value)}`,
        provenance: { kind: 'search_space', source: 'config', ref: `injection.search_space.${group}`, group },
      })
    }
    if (Object.keys(searchSpace).length === 0) {
      items.push({
        fact_id: 'singleton:search_space:empty',
        text: 'search_space: declared, but empty — no group is open for exploration',
        provenance: { kind: 'search_space', source: 'config', ref: 'injection.search_space' },
      })
    }
  }

  for (const experience of corpus.hard.singletons) {
    items.push({
      fact_id: `singleton:experience:${experience.experience_id}`,
      text: `singleton: ${experience.text}`,
      provenance: {
        kind: 'singleton',
        source: 'experience-file',
        ref: experience.path,
        experience_id: experience.experience_id,
      },
    })
  }

  return items
}

/** One line per candidate: the vector the contract declared and where the candidate sits. */
function frontierSection({ view, problems }) {
  const items = []
  const contract = view?.contract

  if (view === undefined || view === null) {
    problems.push({ code: 'no_frontier_view', message: 'no frontier view was supplied, so the packet carries no current frontier' })
    items.push({
      fact_id: 'frontier:unavailable',
      text: 'frontier: unavailable — no frontier view was supplied for this packet',
      provenance: { kind: 'absence', source: 'frontier', ref: 'view' },
    })
    return items
  }

  items.push(
    contract?.ok === true
      ? {
          fact_id: 'frontier:objectives',
          text: `objectives: ${contract.objectives.map((objective) => `${objective.name}=${objective.direction}`).join(', ')}`,
          provenance: { kind: 'frontier_objectives', source: 'frontier', ref: 'contract.objectives' },
        }
      : {
          fact_id: 'frontier:objectives',
          text: `objectives: none — ${contract?.error ?? 'no metric contract was supplied'}`,
          provenance: { kind: 'absence', source: 'frontier', ref: 'contract', error: contract?.error },
        },
  )

  const candidates = view.candidates ?? []
  if (candidates.length === 0) {
    items.push({
      fact_id: 'frontier:empty',
      text: 'frontier: no candidates yet',
      provenance: { kind: 'absence', source: 'frontier', ref: 'candidates' },
    })
    return items
  }

  for (const candidate of candidates) {
    const position =
      candidate.complete !== true
        ? 'unranked'
        : candidate.onFrontier === true
          ? 'frontier'
          : `dominated_by:${candidate.dominatedBy ?? 'unknown'}`
    const missing = candidate.complete === true ? '' : ` missing=${(candidate.missing ?? []).join(',') || 'unknown'}`
    items.push({
      fact_id: `frontier:${candidate.candidate_id}`,
      text: `candidate=${candidate.candidate_id} round=${candidate.round} status=${candidate.status} vector=${vectorText(candidate.vector)} position=${position}${missing}`,
      provenance: {
        kind: 'frontier_candidate',
        source: 'frontier',
        ref: `candidates.${candidate.candidate_id}`,
        candidate_id: candidate.candidate_id,
        seq: candidate.stamped_seq,
      },
    })
  }

  return items
}

/**
 * Enforce "one fact, one place" across the whole packet.
 *
 * The duplicate this exists for is a concrete one: a promoted experience carries a `section`, so
 * the same file could be rendered by the guardrail section *and* handed to the strategy as a
 * candidate experience. That is a double count in every future turn. Fixing it by construction (the
 * corpus is split into exactly one home per experience) is the first line of defence; this index is
 * the assertion that no later section reaches for something already emitted.
 */
function dedupe(sections) {
  const seen = new Map()
  const suppressed = []
  for (const name of HARD_SECTIONS) {
    const kept = []
    for (const item of sections[name].items) {
      const existing = seen.get(item.fact_id)
      if (existing !== undefined) {
        suppressed.push({ fact_id: item.fact_id, section: name, kept_in: existing })
        continue
      }
      seen.set(item.fact_id, name)
      kept.push(item)
    }
    sections[name].items = kept
  }
  return { seen, suppressed }
}

/**
 * Assemble one packet. Pure with respect to the facts: no clock, no randomness, no store writes.
 *
 * @param {{
 *   view?: object,
 *   config?: object,
 *   workspaceDir?: string,
 *   strategy?: object,
 * }} input `view` is the frontier view a caller computed; `strategy` is the port that owns the
 *   ranked half (see `strategy.js`); `workspaceDir` is the memory scope and the location of the
 *   promoted experience files.
 * @returns {object} the packet
 */
export function buildPacket({ view, config, workspaceDir, strategy } = {}) {
  const problems = []
  const degraded = []

  const corpus = splitCorpus(readExperiences(workspaceDir), { problems })

  const sections = {
    guardrails: { quota: 'hard', items: guardrailsSection({ config, corpus, problems }) },
    singletons: { quota: 'hard', items: singletonsSection({ view, config, corpus, problems }) },
    frontier: { quota: 'hard', items: frontierSection({ view, problems }) },
  }
  const { suppressed } = dedupe(sections)

  const ranked = rankSections({ corpus, config, workspaceDir, strategy, degraded })

  const packet = {
    workspace: { dir: workspaceDir ?? null },
    sections,
    ranked,
    problems,
    degraded,
    suppressed,
  }
  packet.digest = digestOf(packet)
  return packet
}

/**
 * The ranked half: the strategy port decides what is admitted and how much room it gets, this
 * module only fills it. A port that is missing or fails does not fail the packet — the hard half is
 * complete without it, and the degraded reason says which half is missing and why.
 */
function rankSections({ corpus, config, workspaceDir, strategy, degraded }) {
  const request = {
    workspace: workspaceDir ?? null,
    sections: {
      recipes: corpus.soft.recipes,
      candidate_experiences: corpus.soft.candidate_experiences,
    },
    budget: { maxCharacters: config?.injection?.ranked?.max_characters ?? DEFAULT_RANKED_BUDGET },
  }

  let decision
  if (strategy === undefined || strategy === null || typeof strategy.compose !== 'function') {
    degraded.push({
      code: 'no_ranked_strategy',
      message: 'no strategy port was supplied, so recipes and candidate experiences were neither admitted nor budgeted',
    })
  } else {
    try {
      decision = strategy.compose(request)
    } catch (error) {
      degraded.push({
        code: 'ranked_strategy_failed',
        message: `the strategy port failed: ${error?.message ?? String(error)}`,
      })
    }
  }

  const ranked = {}
  for (const name of RANKED_SECTIONS) {
    ranked[name] = fillSection({
      name,
      items: request.sections[name],
      admission: decision?.sections?.[name],
      delegatedTo: decision?.strategy ?? null,
      explanation: decision?.explanation,
    })
  }
  return ranked
}

/**
 * Fill one ranked section from the port's admission.
 *
 * `itemIds` is honoured verbatim when the port gives one: a strategy that names its picks is the
 * authority on the picks, and reordering them here would be this module ranking after all. Without
 * `itemIds`, the section fills to the granted character budget in corpus order — file order is
 * deterministic and says nothing about importance.
 */
function fillSection({ name, items, admission, delegatedTo, explanation }) {
  const mode = admission?.mode === 'eager' ? 'eager' : 'routed'
  const maxCharacters = Number.isFinite(admission?.maxCharacters) ? Math.max(0, admission.maxCharacters) : 0
  const byId = new Map(items.map((item) => [item.experience_id, item]))
  const requested = admission?.itemIds

  const shown = []
  const staged = []
  const stage = (item, admittance, reason) => {
    staged.push({ ...packetItem(name, item, { delegatedTo, mode, admittance }), reason })
  }

  if (requested !== undefined) {
    // The port named its picks: walk *its* order, and stage everything it did not name. Reordering
    // here would be this module ranking after all.
    const named = new Set(requested)
    for (const item of items) if (!named.has(item.experience_id)) stage(item, 'not_admitted', 'not_admitted')
  }

  let used = 0
  for (const item of requested === undefined ? items : requested.map((id) => byId.get(id)).filter(Boolean)) {
    if (mode === 'routed') {
      stage(item, 'routed', 'routed')
      continue
    }
    const text = packetItem(name, item, { delegatedTo, mode, admittance: 'eager' })
    if (used + text.text.length > maxCharacters) {
      stage(item, 'over_budget', 'over_budget')
      continue
    }
    used += text.text.length
    shown.push(text)
  }

  // A port that names ids this corpus does not have is a wiring bug, not a fact: report it as one.
  const unknown = (requested ?? []).filter((id) => !byId.has(id))

  return {
    mode,
    maxCharacters,
    delegated_to: delegatedTo,
    explanation: explanation ?? admission?.explanation,
    items: shown,
    staged,
    omitted: staged.length,
    unknown_item_ids: unknown,
  }
}

function packetItem(section, item, { delegatedTo, mode, admittance }) {
  const kind = section === 'recipes' ? 'recipe' : 'candidate_experience'
  return {
    fact_id: `${kind}:${item.experience_id}`,
    text: `${kind}: ${item.text}`,
    admittance,
    provenance: {
      kind,
      source: 'experience-file',
      ref: item.path,
      experience_id: item.experience_id,
      section: item.section,
      delegated_to: delegatedTo,
      mode,
    },
  }
}