/**
 * The two artifact kinds the round-level entries need, defined through the contract's public
 * extension seam (`defineArtifact`).
 *
 * Why they live in core rather than in `packages/contract`: `verify_verdict`, `candidate_plan` and
 * `analyze_report` were written with the candidate machine and belong to the contract package. These
 * two belong to the round workflow (`round_reflect`, `land_hypothesis`) and were added by the ticket
 * that built it, against a frozen contract package. The shape is still defined the contract's way —
 * one `check()` returning `missing` / `invalid` / `conflict` lists, precedence decided in one place —
 * so there is exactly one vocabulary for "this artifact is not acceptable", and adding a fourth kind
 * later costs a definition plus fixtures wherever the contract package is unfrozen again.
 *
 * Registration is idempotent: importing this module twice (or alongside another module that already
 * registered the kind) is not an error.
 *
 * @module
 */

import { artifactKinds, checkField, defineArtifact, isMilliseconds, isNonEmptyString, isPlainObject } from '@dsh-reprise/contract'

const defineOnce = (definition) => {
  if (artifactKinds().includes(definition.kind)) return
  defineArtifact(definition)
}

defineOnce({
  kind: 'round_reflect',
  description: 'ROUND_REFLECT: what a finished round taught, and what the next round should examine',
  check(value) {
    if (!isPlainObject(value)) return { invalid: ['round_reflect must be an object'] }
    const findings = { missing: [], invalid: [], conflict: [] }

    checkField(findings, value, 'round', (input) => Number.isSafeInteger(input) && input > 0, 'must be a positive integer')
    checkField(findings, value, 'summary', isNonEmptyString, 'must say what the round taught')
    checkField(findings, value, 'lessons', Array.isArray, 'must be an array of lessons (possibly empty)')
    checkField(findings, value, 'next_round_focus', Array.isArray, 'must be an array of concrete focuses')
    checkField(findings, value, 'at_ms', isMilliseconds, 'must be a non-negative safe integer of milliseconds')

    const lessons = Array.isArray(value.lessons) ? value.lessons : []
    for (const [index, lesson] of lessons.entries()) {
      if (!isPlainObject(lesson)) {
        findings.invalid.push(`lessons[${index}] must be an object`)
        continue
      }
      if (!isNonEmptyString(lesson.statement)) {
        findings.invalid.push(`lessons[${index}].statement must state a generalisable lesson`)
      }
      if (lesson.evidence !== undefined && lesson.evidence !== null && !isNonEmptyString(lesson.evidence)) {
        findings.invalid.push(`lessons[${index}].evidence must be a non-empty string when present`)
      }
    }

    const focus = Array.isArray(value.next_round_focus) ? value.next_round_focus : []
    if (Array.isArray(value.next_round_focus) && focus.length === 0) {
      findings.invalid.push('next_round_focus must not be empty — a round with nothing to try next has not been reflected on')
    }
    for (const [index, item] of focus.entries()) {
      if (!isNonEmptyString(item)) findings.invalid.push(`next_round_focus[${index}] must be a non-empty string`)
    }

    // Two lessons stating the same thing is the fact plane disagreeing with itself about how much
    // was learned: it looks like two findings and is one.
    const statements = lessons.filter(isPlainObject).map((lesson) => lesson.statement).filter(isNonEmptyString)
    const repeated = statements.filter((statement, index) => statements.indexOf(statement) !== index)
    if (repeated.length > 0) {
      findings.conflict.push(`two lessons state the same thing: ${JSON.stringify(repeated[0])}`)
    }

    return findings
  },
})

defineOnce({
  kind: 'land_hypothesis',
  description: 'The structural hypothesis one candidate was created to land, frozen before the worktree is touched',
  check(value) {
    if (!isPlainObject(value)) return { invalid: ['land_hypothesis must be an object'] }
    const findings = { missing: [], invalid: [], conflict: [] }

    checkField(findings, value, 'candidate_id', isNonEmptyString, 'must be a non-empty string')
    checkField(findings, value, 'round', (input) => Number.isSafeInteger(input) && input > 0, 'must be a positive integer')
    checkField(findings, value, 'statement', isNonEmptyString, 'must state the structural hypothesis')
    checkField(findings, value, 'expected_files', Array.isArray, 'must be an array of paths')
    checkField(findings, value, 'metric_contract_ref', isNonEmptyString, 'must name the metric contract it will be measured against')
    checkField(findings, value, 'frozen_at_ms', isMilliseconds, 'must be a non-negative safe integer of milliseconds')

    const files = Array.isArray(value.expected_files) ? value.expected_files : []
    // Stricter than `candidate_plan` on purpose: a plan may sketch a hypothesis before knowing where
    // it lives, but a candidate that names no file cannot claim a landing when it finishes.
    if (Array.isArray(value.expected_files) && files.length === 0) {
      findings.invalid.push('expected_files must not be empty — a hypothesis with no file is a research question, not a candidate')
    }
    for (const [index, file] of files.entries()) {
      if (!isNonEmptyString(file)) findings.invalid.push(`expected_files[${index}] must be a non-empty path`)
    }

    return findings
  },
})

/** The kinds this module registers, for tests and for anyone reporting the contract's surface. */
export const ROUND_ARTIFACT_KINDS = Object.freeze(['round_reflect', 'land_hypothesis'])