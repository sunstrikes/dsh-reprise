/**
 * `dsh-reprise`'s host entry: a bundle row that composes two halves.
 *
 * Why two plugins instead of one `apply()`. The host loads this package at boot and applies it before
 * any session exists (user story 39) — but the ticking half needs `timer`, and a cordis plugin whose
 * declared dependency is missing is *deferred rather than failed*. One merged plugin would therefore
 * make "the package was never loaded" and "the timer never appeared" produce the same empty log; a
 * merged plugin that reached for the timer without declaring it would instead throw. So:
 *
 *   boot.js      declares nothing → always applies → reports the package loaded, and the config verdict
 *   tick.js      declares `inject: ['timer']` → applies only once the timer is reachable → ticks
 *   dashboard.js declares `inject: ['connection']` → applies only where there is an HTTP surface
 *
 * This file only composes them, and never lets either half take the host down: a plugin is a guest in
 * somebody else's boot sequence, and a misconfigured workspace is one guest's problem.
 *
 * @module
 */

import * as boot from './boot.js'
import * as dashboard from './dashboard.js'
import * as statusTool from './status-tool.js'
import * as tick from './tick.js'

export const name = 'reprise'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * @param {any} ctx the host's context
 * @param {object} [config] the plugin configuration, validated in `config.js`
 */
export function apply(ctx, config = {}) {
  const log = boot.logFor(ctx, config)
  try {
    const resolved = boot.resolveForHost(config, log)
    if (resolved === undefined) return
    ctx.plugin(tick, resolved.config)
    // Independent of the loop on purpose: a host with no connection surface simply never applies this
    // child, and a host with no timer still gets the dashboard.
    ctx.plugin(dashboard, resolved.config)
    // The same projection the dashboard reads, reachable from a conversation: "how is the run doing"
    // is a question the model should be able to answer without opening a browser.
    ctx.plugin(statusTool, { ...resolved.config, log })
  } catch (error) {
    // Last resort: the boot half is not allowed to throw into the host's loader. Whatever went wrong
    // here is one log line away from a bug report instead of a failed startup.
    log(`refusing to start: ${messageOf(error)}`)
  }
}