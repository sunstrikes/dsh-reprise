/**
 * The ranked-section port, and the one adapter that points it at a dsh-mnemon strategy.
 *
 * The packet has two halves. The hard half is fixed by the spec and rendered by this package. The
 * other half — recipes and candidate experiences — cannot be fixed, because there is always more of
 * it than fits. *Something* must decide what is resident and how much room it gets, and the spec's
 * decision is that the something is mnemon's strategy, not a relevance score re-invented here.
 *
 * So the boundary is a port with one method, and this file holds the only adapter:
 *
 *     compose({ workspace, sections, budget }) → { strategy, explanation, sections }
 *
 * `mnemonStrategyPort` calls a real `MemoryStrategyDefinition.compose()` — the same object
 * `dsh-mnemon-strategy-*` packages export — with a real `MemoryViewRequest` and real
 * `MemoryAvailableSource` descriptors, then translates the resulting `MemoryViewSpec` back into a
 * per-section decision. What it deliberately does not do: score, sort, summarise, or second-guess.
 * Whatever the strategy grants is what the packet uses.
 *
 * Consequence worth knowing before wiring a profile: with mnemon's `general` strategy no source is
 * resident unless `residentSourceKeys` names it, and with `default-three-tier` a source must carry
 * one of its three roles to be admitted at all. Both are mnemon's policy, and both surface honestly
 * in the packet as `mode: routed` with a zero budget — never as a silently empty section.
 *
 * @module
 */

/**
 * The two sections this port speaks for.
 *
 * The instance keys must match the host's own Source-key pattern (`source:` followed by a stable
 * entry id — mnemon validates it before admitting a source, and `general`'s `residentSourceKeys`
 * only accepts keys of that shape). They name the two *slices of the packet* a strategy is asked to
 * budget, which is why they are not the keys of any installed package: a profile that wants the
 * recipes projected eagerly lists them in `residentSourceKeys`.
 *
 * Roles are deliberately not one of mnemon's three built-in roles, because a packet is not
 * "working context", "narrative", or "durable evidence" and must not displace a source that is.
 */
export const SOFT_SOURCES = Object.freeze([
  {
    section: 'recipes',
    sourceInstanceKey: 'source:reprise-injection-packet-recipes',
    sourceTypeId: 'injection-packet-recipes',
    role: 'recipe',
  },
  {
    section: 'candidate_experiences',
    sourceInstanceKey: 'source:reprise-injection-packet-candidate-experiences',
    sourceTypeId: 'injection-packet-candidate-experiences',
    role: 'candidate-experience',
  },
])

/** mnemon's own defaults, restated here so the request is complete without importing mnemon. */
const BASE_BUDGET = Object.freeze({
  maxProjectionCharacters: 65_536,
  maxRoutes: 16,
  maxActions: 16,
  maxEvidenceResults: 16,
  maxEvidenceCharacters: 16_384,
})

/** The scenario string a View request carries, so a strategy can special-case a packet if it wants. */
export const PACKET_SCENARIO = 'reprise.injection-packet'

function descriptorOf(source) {
  return {
    sourceInstanceKey: source.sourceInstanceKey,
    sourceTypeId: source.sourceTypeId,
    role: source.role,
    availability: 'ready',
    revision: '0',
    capabilities: ['project', 'search'],
    routeIds: ['read'],
    actionIds: [],
    routes: [],
    actions: [],
  }
}

/**
 * Wrap a mnemon `MemoryStrategyDefinition` as the ranked-section port.
 *
 * @param {{ manifest?: object, compose: Function }} definition a strategy definition object, as
 *   exported by a `dsh-mnemon-strategy-*` package. A definition without `compose` is a wiring bug
 *   and is refused here rather than turning every section empty.
 * @returns {{ strategy: string, compose: (request: object) => object }}
 */
export function mnemonStrategyPort(definition) {
  if (definition === null || typeof definition !== 'object' || typeof definition.compose !== 'function') {
    throw new TypeError('mnemonStrategyPort needs a strategy definition with a compose() method')
  }
  const typeId = definition.manifest?.typeId ?? 'unnamed-strategy'

  return {
    strategy: typeId,
    compose(request) {
      const viewRequest = {
        scope: { storage: 'workspace', ...(request.workspace === null ? {} : { workspaceId: request.workspace }) },
        scenario: PACKET_SCENARIO,
        budget: { ...BASE_BUDGET, maxProjectionCharacters: request.budget.maxCharacters },
      }
      const sources = SOFT_SOURCES.map(descriptorOf)
      const spec = definition.compose(viewRequest, sources)

      const sections = {}
      for (const source of SOFT_SOURCES) {
        const selected = spec?.sources?.find((candidate) => candidate.sourceInstanceKey === source.sourceInstanceKey)
        sections[source.section] =
          selected?.projection === undefined
            ? { mode: 'routed', maxCharacters: 0 }
            : { mode: selected.projection.mode, maxCharacters: selected.projection.maxCharacters }
      }

      return {
        strategy: spec?.strategyTypeId ?? typeId,
        explanation: spec?.explanation,
        sections,
      }
    },
  }
}