/**
 * Artifact registry: the contract's shape, and the place where "one more artifact kind" is a
 * validator plus fixtures rather than a change to the kernel.
 *
 * A kind declares a `check(value)` that returns three message lists instead of a boolean. That is
 * the whole trick: precedence (missing → invalid → conflict) lives in one place, and a validator
 * never has to decide which of four states it is in.
 *
 * @module
 */

import { fromFindings, invalid } from './status.js'

/**
 * @typedef {(value: unknown) => {
 *   missing?: string[],
 *   invalid?: string[],
 *   conflict?: string[],
 * }} ArtifactCheck
 * @typedef {{
 *   kind: string,
 *   description?: string,
 *   schemaVersion?: number,
 *   check: ArtifactCheck,
 * }} ArtifactDefinition
 */

/** @type {Map<string, ArtifactDefinition>} */
const registry = new Map()

/**
 * @param {ArtifactDefinition} definition
 * @returns {void}
 */
export function defineArtifact(definition) {
  const { kind, check } = definition
  if (typeof kind !== 'string' || kind.trim() === '') throw new Error('artifact kind must be a non-empty string')
  if (typeof check !== 'function') throw new Error(`artifact "${kind}" must provide check()`)
  if (registry.has(kind)) throw new Error(`artifact "${kind}" is already defined`)
  registry.set(kind, { schemaVersion: 1, ...definition })
}

/** @returns {string[]} registered kinds, in definition order */
export const artifactKinds = () => [...registry.keys()]

/** The version this kernel speaks for a kind. */
export const artifactSchemaVersion = (kind) => registry.get(kind)?.schemaVersion

/**
 * Artifact versions and the store's `user_version` evolve independently: artifacts are carried
 * away by git and read by other tools, while the database stays on this machine. A kind bumps
 * its own version and stays readable at the old one for as long as it can.
 *
 * @param {string} kind
 * @param {unknown} value
 */
export function validateArtifact(kind, value) {
  const definition = registry.get(kind)
  if (definition === undefined) return invalid(`unknown artifact kind "${kind}"`)

  if (isPlainObject(value) && value.schema_version !== undefined) {
    const expected = definition.schemaVersion ?? 1
    if (value.schema_version !== expected) {
      return invalid(`schema_version ${JSON.stringify(value.schema_version)} is not the version this kernel speaks for ${kind} (${expected})`)
    }
  }

  return fromFindings(definition.check(value))
}

/** A non-empty string, or a message saying why not. */
export const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Milliseconds since the epoch, in the range a wall-clock timestamp can actually occupy.
 *
 * Two constraints in one predicate, both learned the hard way:
 *
 * 1. Nanoseconds (~1.79e18) exceed `Number.MAX_SAFE_INTEGER`, and `node:sqlite` throws a
 *    RangeError reading them back. Python's arbitrary-precision integers hid that completely.
 * 2. Seconds are a *unit* error rather than an overflow: 1.7e9 reads as a perfectly good integer
 *    and lands every timestamp in 1970, which turns "this job is stale" into "this job is
 *    ancient" without anything failing. The lower bound is 2001-09-09 (1e12 ms).
 *
 * Durations are not timestamps. If you need to store "30 seconds", name it `timeout_seconds` and
 * validate it as seconds — do not put it in a `*_ms` field.
 */
export const isMilliseconds = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1e12

/** A non-negative safe integer with no epoch interpretation — for counts, not for time. */
export const isCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Shared field checks. Each pushes into the lists a `check()` is already accumulating, so a
 * validator reads as a list of facts rather than a nest of conditionals.
 *
 * @param {{ missing: string[], invalid: string[] }} findings
 * @param {Record<string, unknown>} value
 * @param {string} field
 * @param {(input: unknown) => boolean} predicate
 * @param {string} why
 */
export function checkField(findings, value, field, predicate, why) {
  if (!(field in value) || value[field] === undefined || value[field] === null) {
    findings.missing.push(`${field} is required`)
    return
  }
  if (!predicate(value[field])) findings.invalid.push(`${field} ${why}`)
}