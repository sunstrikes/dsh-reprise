/**
 * Host registration: the one place this package touches a running dsh.
 *
 * The rules are not stylistic choices; each one cost a debugging round to measure:
 *
 *   1. **Declare the service.** `ctx.mnemonMemory` — and therefore every method on it — is only
 *      reachable from a plugin that lists it in `export const inject`. `ctx.get()` would report the
 *      service present and then throw on the first method call.
 *   2. **Read it from the ctx you were given.** Two hosts (two profiles, two tests) must not share a
 *      registration, so there is no module-level handle.
 *   3. **Nothing assumes synchronous visibility.** The source definition is built with no host at
 *      all; the registration is created inside `ctx.effect`, so `ctx.plugin()`'s promise settling is
 *      the only thing that has to happen before the host sees it, and disposal takes it away again.
 *   4. **Nothing is registered that could write.** The contribution carries `sources` only — no
 *      `strategyExtensions`, so no capture slot — and the source itself declares no action.
 *
 * This mirrors `installMemory` from `dsh-mnemon/extension-sdk` without importing it: the package
 * depends on `contract` only, and a dependency on mnemon's SDK would pin this adapter to a version
 * of a package the host resolves for us.
 *
 * Mounting is a manifest fact, not a code fact: `package.json` exports `./lib/index.js` and declares
 * `dsh.bundle.patch` → `cordis.patch.yml`, whose single row (`reprise-memory`) inserts
 * `@dsh-reprise/memory`. `apply`/`inject` are the entry points that row lands on; `index.js` is the
 * module surface everything else consumes. A profile that mounts it must still select a strategy
 * that admits role `injection-packet` (`general` does; `default-three-tier` does not) and, if the
 * recipes should be projected eagerly rather than left on the read route, list
 * `source:reprise-injection-packet-recipes` and
 * `source:reprise-injection-packet-candidate-experiences` in `residentSourceKeys`.
 *
 * @module
 */

import { buildPacket } from './packet.js'
import { createInjectionPacketSource } from './source.js'

export const name = '@dsh-reprise/memory'

/** The measured rule: an undeclared service may be probed, never accessed. */
export const inject = ['mnemonMemory']

export const memoryPlugin = Object.freeze({
  apiVersion: 'dsh-mnemon/plugin/v1',
  packageName: name,
  label: { en: 'Reprise injection packet', 'zh-CN': 'Reprise 注入包' },
  description: {
    en: 'The exact context one model turn receives, assembled from this workspace\'s facts.',
    'zh-CN': '模型单轮实际获得的上下文，由本工作区的事实装配而成。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.injection-packet' }],
})

/**
 * Build the contribution object. Kept separate from `apply` so it can be tested (and inspected)
 * without a cordis context at all.
 *
 * @param {{ build?: () => object, workspaceDir?: string, view?: () => object, config?: object, strategy?: object }} options
 */
export function registration(options = {}) {
  const build = options.build ?? defaultBuild(options)
  return { plugin: memoryPlugin, sources: [createInjectionPacketSource({ build })] }
}

/**
 * The fallback builder, for the window before `core` wires the frontier in.
 *
 * It produces an honest but thin packet: the workspace's promoted experiences and its configured
 * guardrails are real, and the frontier section says no view was supplied. That is deliberately
 * *not* an error — a source that refuses to mount until core is wired would make "memory is
 * mounted" untestable before the wiring exists.
 */
function defaultBuild({ workspaceDir, view, config, strategy } = {}) {
  return () =>
    buildPacket({
      workspaceDir,
      config,
      strategy,
      view: typeof view === 'function' ? view() : undefined,
    })
}

/**
 * The plugin entry point. `apply` runs only once every declared service exists (cordis defers a
 * plugin whose dependency is absent, which is exactly why the definition above does not need one).
 *
 * @param {object} ctx the plugin's own cordis context
 * @param {{
 *   build?: () => object,
 *   workspaceDir?: string,
 *   view?: () => object,
 *   config?: object,
 *   strategy?: object,
 *   instanceId?: string,
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const service = ctx?.mnemonMemory
  if (service === undefined || typeof service.installContributions !== 'function') {
    // Fail loudly rather than install nothing: a silent no-op here is indistinguishable in the log
    // from a deferred plugin, and the whole point of declaring `inject` is to avoid that ambiguity.
    throw new Error(`${name}: ctx.mnemonMemory is unavailable — declare it in "inject" and let cordis settle the fiber`)
  }

  const contribution = registration(config)
  const instanceId = config.instanceId ?? 'reprise-injection-packet'

  ctx.effect(
    () => service.installContributions(contribution, { instanceId }),
    'reprise-memory: install injection-packet source',
  )
}