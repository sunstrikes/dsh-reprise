/**
 * The wire the Ray adapter speaks over — `node:http`/`node:https`, not `globalThis.fetch`.
 *
 * Measured on the live cluster (Ray 2.59, 2026-10-24). The dashboard has a CSRF / DNS-rebinding guard
 * (`dashboard/optional_utils.py::is_browser_request`): a request counts as **browser traffic** when
 * its `User-Agent` starts with `Mozilla`, *or* when any `Referer` / `Origin` / `Sec-Fetch-*` header is
 * present — and browser traffic may only `GET`. A write from one answers
 * `405 '<METHOD>' method not allowed for browser traffic`.
 *
 * Node's global `fetch` (undici) sends `sec-fetch-mode: cors` on **every** request, including plain
 * server-side ones, so `fetch()` cannot submit a job to this dashboard at all: the package `PUT` and
 * the job `POST` are both refused before the cluster reads a byte of them. The first live acceptance
 * run of ticket 15 died exactly there.
 *
 * Hence this transport. It is one transport for reads and writes on purpose: a rule of the form
 * "writes use X, reads use Y" is a rule the next reader will not expect, and the two would drift
 * apart in their error handling long before anyone noticed. The header set is ours — a plain
 * `user-agent`, and `Referer` / `Origin` / `Sec-Fetch-*` are dropped even if a caller supplies them,
 * because the guard decides "browser" from exactly those and a 405 is a miserable thing to debug.
 *
 * The port is injectable (`createRayPlatform({ request })`), which is what keeps the suite able to
 * run the adapter with no cluster, no socket and no network.
 *
 * @module
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Our own user agent. Not `Mozilla…`: the guard classifies that as a browser and refuses writes. */
export const DEFAULT_USER_AGENT = 'dsh-reprise-ray/1.0'

/** Headers that make the dashboard treat a request as a browser and refuse anything but a GET. */
const BROWSER_ONLY_PREFIXES = ['sec-fetch-']
const BROWSER_ONLY_NAMES = ['referer', 'origin']

/**
 * Is this header set one the dashboard would call browser traffic? Exported because the adapter's
 * failure message has to explain the 405 it got, and because a test can assert the answer without
 * reimplementing the rule from memory.
 */
export function isBrowserTraffic(headers = {}) {
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase()
    if (BROWSER_ONLY_NAMES.includes(name)) return true
    if (BROWSER_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
    if (name === 'user-agent' && String(value).startsWith('Mozilla')) return true
  }
  return false
}

function wireHeaders(headers, userAgent) {
  const out = {}
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase()
    if (BROWSER_ONLY_NAMES.includes(name) || BROWSER_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    if (name === 'user-agent' || value === undefined) continue
    out[name] = String(value)
  }
  out['user-agent'] = userAgent
  return out
}

/**
 * @param {{timeout_ms?: number, user_agent?: string}} [options]
 * @returns {(request: {method: string, url: string, headers?: object, body?: Buffer|string}) =>
 *   Promise<{status: number, headers: object, text: string}>}
 */
export function createHttpRequest({ timeout_ms: timeoutMs = 30_000, user_agent: userAgent = DEFAULT_USER_AGENT } = {}) {
  return function send({ method = 'GET', url, headers, body }) {
    return new Promise((resolve, reject) => {
      let target
      try {
        target = new URL(url)
      } catch (error) {
        reject(new Error(`ray transport: ${url} is not a URL (${error?.message ?? error})`))
        return
      }
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
      const finalHeaders = wireHeaders(headers, userAgent)
      if (payload !== undefined) finalHeaders['content-length'] = String(payload.length)

      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const outgoing = send(target, { method, headers: finalHeaders }, (incoming) => {
        const chunks = []
        incoming.on('data', (chunk) => chunks.push(chunk))
        incoming.on('error', fail)
        incoming.on('end', () => {
          if (settled) return
          settled = true
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers ?? {},
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
      // A dashboard that never answers must not hold a tick open forever: a hung socket is the one
      // failure mode with no conclusion of its own.
      outgoing.setTimeout(timeoutMs, () => {
        outgoing.destroy(new Error(`ray transport: no answer within ${timeoutMs}ms`))
      })
      outgoing.on('error', fail)
      if (payload !== undefined) outgoing.write(payload)
      outgoing.end()
    })
  }
}