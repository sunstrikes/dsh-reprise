/**
 * Fixtures for the injection packet tests.
 *
 * The view below is the *documented* shape of the frontier view (`frontier.js`), written out by hand
 * instead of imported from core. Two reasons, both deliberate: `packages/memory` is allowed to
 * depend on `contract` only, and the packet must be testable without a real fact plane, because it
 * is assembled from a view a caller supplies. A test that imported core's `frontier()` would be
 * proving core's arithmetic again and would break the package boundary to do it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A candidate row exactly as `frontier()` renders it. */
export function row(overrides = {}) {
  return {
    candidate_id: 'c1',
    round: 1,
    status: 'done',
    metrics: {},
    vector: {},
    complete: false,
    missing: [],
    onFrontier: false,
    dominatedBy: null,
    stamped_seq: 1,
    ...overrides,
  }
}

/** A frontier view. `candidates` are positional: the packet must not reorder them. */
export function frontierView({
  primary = 'auc',
  objectives = [['auc', 'up']],
  candidates = [],
  best,
  contract,
} = {}) {
  const normalised = objectives.map(([name, direction]) => ({ name, direction }))
  const complete = candidates.filter((candidate) => candidate.complete)
  return {
    contract: contract ?? { ok: true, primary, objectives: normalised, error: undefined },
    candidates,
    best:
      best === undefined
        ? (() => {
            const ranked = candidates
              .filter((candidate) => candidate.complete)
              .sort((left, right) => right.vector[primary] - left.vector[primary])
            if (ranked.length === 0) return undefined
            const winner = ranked[0]
            return {
              candidate_id: winner.candidate_id,
              round: winner.round,
              metric: primary,
              value: winner.vector[primary],
            }
          })()
        : best,
    frontier: complete.filter((candidate) => candidate.onFrontier).map((candidate) => candidate.candidate_id),
    incomplete: candidates
      .filter((candidate) => !candidate.complete && candidate.missing.length > 0)
      .map((candidate) => ({ candidate_id: candidate.candidate_id, missing: candidate.missing })),
    seqs: Object.fromEntries(candidates.map((candidate) => [candidate.candidate_id, candidate.stamped_seq])),
  }
}

/** One done candidate with a complete auc vector. */
export function done(id, value, extra = {}) {
  return row({
    candidate_id: id,
    metrics: { auc: value },
    vector: { auc: value },
    complete: true,
    onFrontier: true,
    ...extra,
  })
}

/** A temp workspace directory, optionally seeded with promoted experience files. */
export function workspace(experiences = []) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-memory-'))
  mkdirSync(join(dir, 'experiences'), { recursive: true })
  for (const experience of experiences) writeExperience(dir, experience)
  return dir
}

/** Writes one promoted experience the way `core/lib/intents.js` writes it. */
export function writeExperience(dir, experience) {
  const { experience_id: id, ...rest } = experience
  writeFileSync(
    join(dir, 'experiences', `${id}.json`),
    `${JSON.stringify({ experience_id: id, ...rest }, null, 2)}\n`,
    'utf8',
  )
}

/** Writes raw bytes, for the malformed-file cases. */
export function writeRawExperience(dir, name, bytes) {
  writeFileSync(join(dir, 'experiences', `${name}.json`), bytes, 'utf8')
}

/** Guardrails + search space as a workspace config would declare them. */
export function injectionConfig({
  forbidden = ['add a second attention block'],
  patterns = ['raising the learning rate to fix instability'],
  searchSpace,
} = {}) {
  return {
    injection: {
      guardrails: { forbidden_directions: forbidden, anti_patterns: patterns },
      ...(searchSpace === undefined ? {} : { search_space: searchSpace }),
    },
  }
}