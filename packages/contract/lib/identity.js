/**
 * The identity binding chain and the candidate gate.
 *
 * `parent_binding → verify_gate → fold_state` answers three questions in one place: whose child
 * this candidate is, what was verified, and what it folded into. The point of validating it as a
 * chain rather than reading four files opportunistically is that "is the chain complete?" must
 * have a decidable answer.
 *
 * @module
 */

import { requirementsAt, isKnownCandidatePhase } from './order.js'
import { conflict, fromFindings, invalid, missing } from './status.js'

/** Kinds, in chain order. */
export const BINDING_KINDS = Object.freeze(['parent_binding', 'verify_gate', 'fold_state'])

/**
 * The candidate gate: may this candidate advance from its current phase?
 *
 * @param {{
 *   state?: { phase?: string } | undefined,
 *   bindings?: Record<string, any>,
 *   job?: unknown,
 * }} input
 */
export function validateCandidate({ state, bindings = {}, job } = {}) {
  if (state === undefined) return missing('candidate state was never written')

  const phase = state.phase
  if (phase === undefined || phase === null || phase === '') return invalid('candidate state has no phase')
  if (!isKnownCandidatePhase(phase)) return invalid(`candidate state has unknown phase "${phase}"`)

  const findings = { missing: [], invalid: [], conflict: [] }
  const { bindings: required, needsJob } = requirementsAt(phase)

  for (const kind of required) {
    if (bindings[kind] === undefined) {
      findings.missing.push(`binding "${kind}" was never frozen for phase ${phase}`)
    }
  }

  // A job row is created *by* SUBMIT, so only phases after SUBMIT may require it.
  if (needsJob && job === undefined) {
    findings.missing.push('candidate passed SUBMIT but has no job ledger row')
  }

  const gate = bindings.verify_gate
  const parent = bindings.parent_binding

  if (gate !== undefined && typeof gate.passed !== 'boolean') {
    findings.invalid.push('verify_gate.passed must be a strict boolean')
  }

  if (parent !== undefined && gate !== undefined && parent.parent_id !== gate.parent_id) {
    findings.conflict.push(
      `verify_gate.parent_id=${JSON.stringify(gate.parent_id)} disagrees with parent_binding.parent_id=${JSON.stringify(parent.parent_id)}`,
    )
  }

  return fromFindings(findings)
}

/**
 * The full chain, for the phases that must be able to prove provenance — everything at `DONE`
 * and any later re-derivation. Stricter than `validateCandidate`: `fold_state` is mandatory here.
 *
 * @param {Record<string, any>} bindings
 */
export function validateChain(bindings = {}) {
  const findings = { missing: [], invalid: [], conflict: [] }

  for (const kind of BINDING_KINDS) {
    if (bindings[kind] === undefined) findings.missing.push(`binding "${kind}" is not frozen`)
  }

  const { parent_binding: parent, verify_gate: gate, fold_state: fold } = bindings

  if (gate !== undefined && gate.passed !== true) {
    findings.invalid.push('verify_gate did not pass with an explicit boolean true')
  }

  if (parent !== undefined && gate !== undefined && gate.parent_id !== parent.parent_id) {
    findings.conflict.push('verify_gate belongs to a different parent than parent_binding')
  }

  if (parent !== undefined && fold !== undefined && fold.parent_commit !== parent.parent_commit) {
    findings.conflict.push('fold_state.parent_commit disagrees with parent_binding.parent_commit')
  }

  return fromFindings(findings)
}