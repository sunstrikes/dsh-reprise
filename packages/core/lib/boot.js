/**
 * The half of the plugin that declares no dependency: did the package load, and is its configuration
 * usable?
 *
 * The split is the one lesson from ticket 01 that has to survive into the real plugin. A cordis plugin
 * whose declared dependency is absent is **deferred, not failed** — so a package that never applies
 * and a package whose `timer` never appeared produce the same empty log. Two entry points fix that:
 * this one runs as soon as the host boots and says "I am here, and here is what I think of my
 * configuration"; the ticking half (`tick.js`) declares `inject: ['timer']` and therefore only speaks
 * once the timer exists.
 *
 * It also owns the words the run owes its operator before anything expensive happens: the warnings
 * from `warnings.js` are logged here, at boot, not discovered on the bill.
 *
 * @module
 */

import { resolveConfig } from './config.js'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Where this package reports.
 *
 * Preference order, and the reason for it: an explicit `onLog` (tests, the CLI, an embedder that
 * wants the lines in its own sink), then the host's logger, then nothing at all. Writing its own
 * log file — which the ticket-01 probe did, ~1.5 MB/day — is deliberately not an option: an
 * unattended plugin that keeps a private trace is how a second, unchecked account of the run starts.
 *
 * @param {any} ctx
 * @param {{onLog?: (message: string, detail?: unknown) => void}} [config]
 * @returns {(message: string, detail?: unknown) => void}
 */
export function logFor(ctx, config = {}) {
  if (typeof config?.onLog === 'function') {
    return (message, detail) => {
      try {
        config.onLog(message, detail)
      } catch {
        // A log sink that throws must not be able to stop the loop it observes.
      }
    }
  }

  let logger
  try {
    logger = typeof ctx?.logger === 'function' ? ctx.logger('reprise') : undefined
  } catch {
    logger = undefined
  }

  return (message, detail) => {
    try {
      if (typeof logger?.info === 'function') {
        if (detail === undefined) logger.info(message)
        else logger.info(message, detail)
        return
      }
      if (typeof ctx?.logger === 'function') ctx.logger.info(message)
    } catch {
      // Same reasoning as above: logging is not a reason to fail.
    }
  }
}

/**
 * Resolve the configuration, report the verdict, and hand back the normalised config to mount.
 *
 * `undefined` means "do not tick" — not "something went wrong". Every refusal is already on the log,
 * and the host keeps booting, because a misconfigured workspace is one plugin's problem.
 *
 * @param {object} raw the bundle-patch / loader configuration
 * @param {(message: string, detail?: unknown) => void} log
 * @returns {object | undefined} `{ok, config, warnings, problems}` when the run may start
 */
export function resolveForHost(raw, log) {
  log('applied', { note: 'the package loaded at host boot; the ticking half waits for the timer' })

  let resolved
  try {
    resolved = resolveConfig(raw)
  } catch (error) {
    log(`refusing to start: ${messageOf(error)}`)
    return undefined
  }

  if (!resolved.ok) {
    log(`not ticking: ${resolved.problem}`)
    for (const problem of resolved.problems.slice(1)) log(`also not ticking: ${problem}`)
    return undefined
  }

  for (const warning of resolved.warnings) {
    log(`[${warning.severity}] ${warning.code}: ${warning.message}`, { code: warning.code, label: warning.label })
  }
  return resolved
}