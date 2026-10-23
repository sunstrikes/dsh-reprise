/**
 * The dsh-mnemon Source adapter: the packet, offered to the host as one read-only memory source.
 *
 * The contract was measured, not guessed (`.scratch/research/cordis-fiber-settling.md`,
 * `dsh-mnemon`'s own type declarations):
 *
 *     MemorySourceDefinition { manifest, create(context) → MemorySourceRuntime }
 *     MemorySourceRuntime    { facts(request, signal), project(request, signal), query?, … }
 *
 * `facts` is metadata for the host's View compiler, `project` is what the model actually reads, and
 * `query` is the on-demand route for anything the strategy routed rather than projected. That is
 * the whole adapter: the packet is assembled in `packet.js`, and this file only translates it into
 * the three calls the host makes.
 *
 * Three properties, each of them a decision:
 *
 *   **Read-only, structurally.** The manifest declares no `actions`, the runtime has no `mutate`,
 *   and no capability is `write`/`maintain`/`archive`. mnemon's auto-capture only ever offers a
 *   write Action for a Source that has one, so "the model cannot write memory" is not a policy
 *   enforced elsewhere — there is nothing here to write with. Memory is written by facts: a
 *   human promotion lands as a file (`core/lib/intents.js`), and the packet reads it.
 *
 *   **Degradation, not failure.** Memory spaces are broken upstream today. Every method here
 *   catches a failed packet build and reports it (`availability: 'unavailable'`, `degraded`,
 *   `evidence.unavailable`); none of them throws into a turn, because the fact plane — not the
 *   packet — is the source of truth, and a loop that cannot render its own context can still tick.
 *
 *   **The hard half is complete whatever the budget.** `project` never truncates guardrails,
 *   singletons or the frontier: a budget that cannot hold them is reported in
 *   `presentation`/provenance so an operator sees an under-provisioned host, instead of the model
 *   seeing a shorter list of prohibitions and no way to know one was dropped.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'

import { HARD_SECTIONS, RANKED_SECTIONS } from './packet.js'

export const SOURCE_TYPE_ID = 'injection-packet'
export const SOURCE_ROLE = 'injection-packet'
export const PACKAGE_NAME = '@dsh-reprise/memory'
export const ROUTE_ID = 'ranked'
export const SOURCE_CAPABILITIES = Object.freeze(['status', 'project', 'search'])

/** Section titles as the model sees them. A hard section says it is complete; that is the point. */
const HARD_TITLES = Object.freeze({
  guardrails: '## guardrails (hard quota, complete, not ranked)',
  singletons: '## singletons (hard quota, complete, not ranked)',
  frontier: '## frontier (current, every candidate)',
})

const MAX_PRESENTATION_ITEMS = 24
const MAX_TITLE_CHARACTERS = 160

/**
 * The manifest, exported so a test (or an operator) can read the contract without running anything.
 *
 * `role` is deliberately not one of mnemon's three built-in roles: a packet that called itself
 * `working-context` would collide with the runtime memory source (`default-three-tier` refuses two
 * sources of one role), and one that called itself `durable-evidence` would claim to be writable
 * memory. A profile selects this source explicitly, by role.
 */
export const SOURCE_MANIFEST = Object.freeze({
  apiVersion: 'dsh-mnemon/v1',
  kind: 'source',
  typeId: SOURCE_TYPE_ID,
  packageName: PACKAGE_NAME,
  role: SOURCE_ROLE,
  capabilities: [...SOURCE_CAPABILITIES],
  consistency: 'exact-snapshot',
  routes: [
    {
      id: ROUTE_ID,
      description:
        'Read the recipes and candidate experiences this workspace promoted but the packet did not project. Use it only when the injected packet is genuinely insufficient.',
      capability: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: [...RANKED_SECTIONS], description: 'Restrict the read to one section.' },
          query: { type: 'string', description: 'Case-insensitive substring to match against the experience text.' },
        },
        additionalProperties: false,
      },
      maxCalls: 2,
      maxResults: 16,
      maxCharacters: 8_000,
    },
  ],
  // Explicit, not merely absent: a reader of this manifest can see that writing was considered.
  actions: [],
  management: {
    label: 'Injection packet',
    description: 'The exact context one model turn receives, assembled from this workspace\'s facts.',
  },
})

/**
 * @param {{ build: () => object }} options `build` returns one assembled packet. It is a port, not
 *   a workspace handle, so the source never reaches into the fact plane itself and its tests never
 *   need one.
 * @returns {{ manifest: object, create: (context: object) => object }}
 */
export function createInjectionPacketSource({ build } = {}) {
  if (typeof build !== 'function') throw new TypeError('createInjectionPacketSource needs a build() port returning a packet')

  return {
    manifest: SOURCE_MANIFEST,
    create(context) {
      const instanceKey = context?.sourceInstanceKey ?? 'source:injection-packet'
      /** The packet the host pinned, so `project` serves the snapshot the strategy actually chose. */
      let pinned

      const attempt = () => {
        try {
          const packet = build()
          pinned = packet
          return { ok: true, packet }
        } catch (error) {
          return { ok: false, error }
        }
      }

      const current = (expectedRevision) => {
        if (pinned !== undefined && (expectedRevision === undefined || pinned.digest === expectedRevision)) {
          return { ok: true, packet: pinned }
        }
        const attempt_ = attempt()
        if (attempt_.ok === true) return attempt_
        if (pinned !== undefined) return { ok: true, packet: pinned }
        return attempt_
      }

      return {
        facts(request, signal) {
          signal?.throwIfAborted?.()
          const result = attempt()
          if (result.ok === false) {
            return {
              sourceInstanceKey: instanceKey,
              sourceTypeId: SOURCE_TYPE_ID,
              role: SOURCE_ROLE,
              availability: 'unavailable',
              revision: 'unavailable',
              capabilities: [...SOURCE_CAPABILITIES],
              routeIds: [ROUTE_ID],
              actionIds: [],
              hints: { unavailable: messageOf(result.error) },
            }
          }

          const packet = result.packet
          const hardItems = HARD_SECTIONS.reduce((total, section) => total + packet.sections[section].items.length, 0)
          return {
            sourceInstanceKey: instanceKey,
            sourceTypeId: SOURCE_TYPE_ID,
            role: SOURCE_ROLE,
            // Degraded, never unavailable, when *some* of the packet exists: the hard quota is the part
            // a turn cannot run without, and it is complete or the build would have thrown.
            availability: packet.degraded.length === 0 && packet.problems.length === 0 ? 'ready' : 'degraded',
            revision: packet.digest,
            capabilities: [...SOURCE_CAPABILITIES],
            routeIds: [ROUTE_ID],
            actionIds: [],
            hints: {
              workspace: packet.workspace.dir,
              hard_items: hardItems,
              ranked: Object.fromEntries(
                RANKED_SECTIONS.map((section) => [
                  section,
                  {
                    mode: packet.ranked[section].mode,
                    shown: packet.ranked[section].items.length,
                    staged: packet.ranked[section].staged.length,
                    delegated_to: packet.ranked[section].delegated_to,
                  },
                ]),
              ),
              degraded: packet.degraded.map((entry) => entry.code),
              problems: packet.problems.map((entry) => entry.code),
            },
          }
        },

        project(request, signal) {
          signal?.throwIfAborted?.()
          if (request?.includeProjection === false) return { fragments: [] }

          const result = current(request?.expectedRevision)
          if (result.ok === false) return { fragments: [], presentation: { visibleItems: 0 } }

          return projectPacket({ packet: result.packet, instanceKey, request })
        },

        query(request) {
          request?.signal?.throwIfAborted?.()
          if (request?.route?.sourceRouteId !== ROUTE_ID) {
            throw new Error(`unknown route: ${String(request?.route?.sourceRouteId)}`)
          }

          const empty = {
            id: `evidence:${randomUUID()}`,
            viewId: request.view.id,
            routeId: request.route.id,
            sourceInstanceKey: instanceKey,
            observedAt: new Date().toISOString(),
            items: [],
            truncated: false,
          }

          const result = current(request.grant?.revision)
          if (result.ok === false) return { ...empty, unavailable: messageOf(result.error) }

          const input = request.input ?? {}
          const sections = RANKED_SECTIONS.filter((section) => input.section === undefined || input.section === section)
          const needle = typeof input.query === 'string' && input.query.trim() !== '' ? input.query.trim().toLowerCase() : undefined
          const pool = sections.flatMap((section) =>
            result.packet.ranked[section].staged.filter((item) => needle === undefined || item.text.toLowerCase().includes(needle)),
          )

          const maxResults = Number.isSafeInteger(request.route.maxResults) && request.route.maxResults > 0
            ? Math.min(request.route.maxResults, SOURCE_MANIFEST.routes[0].maxResults)
            : SOURCE_MANIFEST.routes[0].maxResults
          const maxCharacters = Number.isSafeInteger(request.route.maxCharacters) && request.route.maxCharacters > 0
            ? Math.min(request.route.maxCharacters, SOURCE_MANIFEST.routes[0].maxCharacters)
            : SOURCE_MANIFEST.routes[0].maxCharacters

          const items = []
          let used = 0
          for (const item of pool) {
            if (items.length >= maxResults) break
            if (used + item.text.length > maxCharacters) break
            used += item.text.length
            items.push({ id: item.fact_id, text: item.text, provenance: item.provenance })
          }

          return { ...empty, items, truncated: items.length < pool.length }
        },
      }
    },
  }
}

/** One fragment per section. The hard three are never cut; the ranked one is cut to the host budget. */
function projectPacket({ packet, instanceKey, request }) {
  const maxCharacters = Number.isSafeInteger(request?.maxCharacters) ? Math.max(0, request.maxCharacters) : Number.POSITIVE_INFINITY
  const mode = request?.mode === 'routed' ? 'routed' : 'eager'
  const fragments = []
  const presentation = { items: [] }
  let visible = 0
  let total = 0

  for (const section of HARD_SECTIONS) {
    const items = packet.sections[section].items
    total += items.length
    visible += items.length
    fragments.push({
      id: `${instanceKey}/${section}`,
      sourceInstanceKey: instanceKey,
      mode,
      text: [HARD_TITLES[section], ...items.map((item) => `- ${item.text}`)].join('\n'),
      revision: packet.digest,
      provenance: {
        section,
        quota: 'hard',
        truncated: false,
        digest: packet.digest,
        items: items.map(itemProvenance),
      },
    })
    for (const item of items) {
      if (presentation.items.length >= MAX_PRESENTATION_ITEMS) break
      presentation.items.push({ id: item.fact_id, title: titleOf(item.text) })
    }
  }

  // The ranked half shares one fragment: it is one decision by one strategy, and the host gave it
  // one budget.
  const rankedLines = []
  const rankedShown = []
  const rankedSkipped = []
  let used = 0
  for (const section of RANKED_SECTIONS) {
    total += packet.ranked[section].items.length
    for (const item of packet.ranked[section].items) {
      const line = `- ${item.text}`
      if (used + line.length + 1 > maxCharacters) {
        rankedSkipped.push(item)
        continue
      }
      used += line.length + 1
      rankedLines.push(line)
      rankedShown.push(item)
    }
  }
  visible += rankedShown.length

  fragments.push({
    id: `${instanceKey}/ranked`,
    sourceInstanceKey: instanceKey,
    mode,
    text: rankedLines.length === 0 ? '(none)' : rankedLines.join('\n'),
    revision: packet.digest,
    provenance: {
      section: 'ranked',
      quota: 'ranked',
      delegated_to: packet.ranked.recipes.delegated_to ?? packet.ranked.candidate_experiences.delegated_to,
      sections: Object.fromEntries(
        RANKED_SECTIONS.map((section) => [
          section,
          {
            mode: packet.ranked[section].mode,
            maxCharacters: packet.ranked[section].maxCharacters,
            staged: packet.ranked[section].staged.length,
          },
        ]),
      ),
      over_budget: rankedSkipped.length > 0,
      skipped: rankedSkipped.map(itemProvenance),
      digest: packet.digest,
      items: rankedShown.map(itemProvenance),
    },
  })
  for (const item of rankedShown) {
    if (presentation.items.length >= MAX_PRESENTATION_ITEMS) break
    presentation.items.push({ id: item.fact_id, title: titleOf(item.text) })
  }

  presentation.visibleItems = visible
  presentation.totalItems = total
  return { fragments, presentation }
}

const itemProvenance = (item) => ({
  fact_id: item.fact_id,
  source: item.provenance?.source,
  ref: item.provenance?.ref,
})

const titleOf = (text) =>
  text.length <= MAX_TITLE_CHARACTERS ? text : `${text.slice(0, MAX_TITLE_CHARACTERS - 1)}…`

const messageOf = (error) => error?.message ?? String(error)