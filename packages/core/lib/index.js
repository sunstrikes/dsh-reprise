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
 * The dashboard is mounted on **two** conditions, not one: a run that may tick, and a run whose
 * configuration was refused. A refused run used to take the display half down with it — the page then
 * answered 404 while the client still drew it, which is a blank screen precisely when somebody has
 * gone looking for the reason. The page is read-only; it needs a workspace directory and, for a
 * refusal, the sentence saying why the loop is silent (`boot.displayForHost`). The ticking half and
 * the status tool still need a run, so they keep their own condition.
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
 * The configuration a display-only mount gets: where to read, why the loop is silent, and nothing
 * else. Passing the refused configuration itself would hand the display half keys nobody validated —
 * `dashboard.js`'s `platformFor` refuses to build a platform without an executor for that reason.
 */
function displayOnly(config, display) {
  return { workspaceDir: display.workspaceDir, notice: display.notice, onLog: config.onLog, importUi: config.importUi }
}

/**
 * @param {any} ctx the host's context
 * @param {object} [config] the plugin configuration, validated in `config.js`
 */
export function apply(ctx, config = {}) {
  const log = boot.logFor(ctx, config)
  try {
    const resolved = boot.resolveForHost(config, log)
    // Decided before the run half's verdict is honoured: the run half may be refused, and the page
    // that says so is still this plugin's job. Cheap on the valid path — it reads `workspaceDir`.
    const display = boot.displayForHost(config, resolved, log)

    if (resolved.ok === true) {
      ctx.plugin(tick, resolved.config)
      // The same projection the dashboard reads, reachable from a conversation: "how is the run doing"
      // is a question the model should be able to answer without opening a browser. It reads a
      // workspace *as a run*, so it stays under this condition and not the display one.
      ctx.plugin(statusTool, { ...resolved.config, log })
    }

    if (display === undefined) return
    // Independent of the loop on purpose: a host with no connection surface simply never applies this
    // child, and a host with no timer still gets the dashboard.
    ctx.plugin(dashboard, resolved.ok === true ? resolved.config : displayOnly(config, display))
  } catch (error) {
    // Last resort: the boot half is not allowed to throw into the host's loader. Whatever went wrong
    // here is one log line away from a bug report instead of a failed startup.
    log(`refusing to start: ${messageOf(error)}`)
  }
}