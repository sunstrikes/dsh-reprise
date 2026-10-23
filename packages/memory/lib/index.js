/**
 * `@dsh-reprise/memory` — the injection packet, and the dsh-mnemon Source that carries it.
 *
 * Four modules, one direction of dependency and one decision each:
 *
 *   `packet.js`      facts → the packet. Hard quota supplied verbatim; the ranked half delegated.
 *   `experiences.js` the promoted experience files, each with exactly one home in the packet.
 *   `strategy.js`    the port that owns ranked admission and budget, plus the mnemon adapter.
 *   `source.js`      the packet as a read-only mnemon Source (`{manifest, create}` → `{facts, project, query?}`).
 *   `render.js`      the dump-facing list: every packet line, and the fact that produced it.
 *   `register.js`    the plugin entry point: `inject = ['mnemonMemory']`, `apply(ctx, config)`.
 *
 * Nothing here writes to a fact plane, has a clock, or ranks anything. The fact plane belongs to
 * `core`; this package renders it for a model turn and for a reader afterwards.
 *
 * @module
 */

export { HARD_SECTIONS, RANKED_SECTIONS, buildPacket } from './packet.js'
export { EXPERIENCE_SECTIONS, MAX_TEXT, readExperiences, splitCorpus, validateExperience } from './experiences.js'
export { PACKET_SCENARIO, SOFT_SOURCES, mnemonStrategyPort } from './strategy.js'
export {
  PACKAGE_NAME,
  ROUTE_ID,
  SOURCE_CAPABILITIES,
  SOURCE_MANIFEST,
  SOURCE_ROLE,
  SOURCE_TYPE_ID,
  createInjectionPacketSource,
} from './source.js'
export { packetLines, renderPacket } from './render.js'
export { apply, inject, memoryPlugin, name, registration } from './register.js'