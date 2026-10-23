/**
 * The four states. They are not severity levels of one boolean, and they must never be
 * collapsed into one: `conflict` means the fact plane disagrees with itself, `invalid` means an
 * artifact exists but breaks its schema, `missing` means a required fact was never produced.
 * Recovery treats each differently — a missing artifact can be regenerated, an invalid one must
 * be rejected, a conflicting pair needs a human or a re-derivation.
 *
 * @module
 */

export const OK = 'ok'
export const MISSING = 'missing'
export const CONFLICT = 'conflict'
export const INVALID = 'invalid'

/** @type {ReadonlyArray<Status>} */
export const STATUSES = Object.freeze([OK, MISSING, CONFLICT, INVALID])

/** Every state except `ok` blocks progress. */
export const BLOCKING = new Set([MISSING, CONFLICT, INVALID])

/**
 * @typedef {'ok' | 'missing' | 'conflict' | 'invalid'} Status
 * @typedef {{ status: Status, message: string }} Validation
 */

/** @returns {Validation} */
export const ok = () => ({ status: OK, message: '' })

/**
 * @param {Status} status
 * @param {string} message
 * @returns {Validation}
 */
export const fail = (status, message) => ({ status, message })

/** @returns {Validation} */
export const missing = (message) => fail(MISSING, message)

/** @returns {Validation} */
export const conflict = (message) => fail(CONFLICT, message)

/** @returns {Validation} */
export const invalid = (message) => fail(INVALID, message)

/** @param {Validation} validation */
export const isOk = (validation) => validation.status === OK

/** @param {Validation} validation */
export const isBlocking = (validation) => BLOCKING.has(validation.status)

/**
 * Builds a validation from three message lists, applying the documented precedence:
 * **missing → invalid → conflict**. Precedence is not cosmetic: you cannot judge whether facts
 * agree before you know they all exist, and you cannot call two artifacts contradictory when one
 * of them is malformed.
 *
 * @param {{ missing?: string[], invalid?: string[], conflict?: string[] }} findings
 * @returns {Validation}
 */
export function fromFindings(findings) {
  const { missing: absent = [], invalid: malformed = [], conflict: disagreeing = [] } = findings ?? {}
  if (absent.length > 0) return missing(absent.join('; '))
  if (malformed.length > 0) return invalid(malformed.join('; '))
  if (disagreeing.length > 0) return conflict(disagreeing.join('; '))
  return ok()
}