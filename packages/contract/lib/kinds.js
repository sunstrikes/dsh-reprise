/**
 * The artifact kinds this kernel understands.
 *
 * Domain differences belong in data, not here: an artifact kind states *shape and internal
 * consistency* only. Whether a delta of +0.004 counts as improvement is a metric contract question,
 * answered elsewhere. These three exist because they cover the three model-backed
 * phases that produce a decision, and because a fourth kind must cost nothing but a validator
 * and its fixtures.
 *
 * @module
 */

import {
  checkField,
  defineArtifact,
  isMilliseconds,
  isNonEmptyString,
  isPlainObject,
} from './artifact.js'

const VERDICTS = ['improved', 'regressed', 'inconclusive']

defineArtifact({
  kind: 'verify_verdict',
  description: 'What the VERIFY phase decided, and on what evidence',
  check(value) {
    if (!isPlainObject(value)) return { invalid: ['verify_verdict must be an object'] }
    const findings = { missing: [], invalid: [], conflict: [] }

    checkField(findings, value, 'candidate_id', isNonEmptyString, 'must be a non-empty string')
    checkField(findings, value, 'passed', (input) => typeof input === 'boolean', 'must be a strict boolean')
    checkField(findings, value, 'checks', Array.isArray, 'must be an array')
    checkField(findings, value, 'decided_at_ms', isMilliseconds, 'must be a non-negative safe integer of milliseconds')

    const checks = Array.isArray(value.checks) ? value.checks : []
    if (Array.isArray(value.checks) && checks.length === 0) {
      findings.invalid.push('checks must not be empty — a verdict with no checks is an opinion')
    }
    for (const [index, check] of checks.entries()) {
      if (!isPlainObject(check)) {
        findings.invalid.push(`checks[${index}] must be an object`)
        continue
      }
      if (!isNonEmptyString(check.name)) findings.invalid.push(`checks[${index}].name must be a non-empty string`)
      if (check.result !== 'pass' && check.result !== 'fail') {
        findings.invalid.push(`checks[${index}].result must be "pass" or "fail"`)
      }
    }

    const reviewer = value.reviewer
    if (reviewer !== undefined) {
      if (!isPlainObject(reviewer)) {
        findings.invalid.push('reviewer must be an object when present')
      } else if (reviewer.verdict !== 'accept' && reviewer.verdict !== 'reject') {
        findings.invalid.push('reviewer.verdict must be "accept" or "reject"')
      }
    }

    // The adversarial review participates in the verdict, so a gate that passes while the review
    // rejects — or while its own checks failed — is the fact plane disagreeing with itself.
    if (value.passed === true) {
      const failed = checks.filter((check) => isPlainObject(check) && check.result === 'fail')
      if (failed.length > 0) {
        findings.conflict.push(`passed is true while ${failed.length} check(s) failed`)
      }
      if (isPlainObject(reviewer) && reviewer.verdict === 'reject') {
        findings.conflict.push('passed is true while the adversarial review rejected the candidate')
      }
    }

    return findings
  },
})

defineArtifact({
  kind: 'candidate_plan',
  description: 'A round plan: the structural hypotheses this round will try to land',
  check(value) {
    if (!isPlainObject(value)) return { invalid: ['candidate_plan must be an object'] }
    const findings = { missing: [], invalid: [], conflict: [] }

    checkField(findings, value, 'round', (input) => Number.isSafeInteger(input) && input > 0, 'must be a positive integer')
    checkField(findings, value, 'hypotheses', Array.isArray, 'must be an array')
    checkField(findings, value, 'metric_contract_ref', isNonEmptyString, 'must name the metric contract it plans against')

    const hypotheses = Array.isArray(value.hypotheses) ? value.hypotheses : []
    if (Array.isArray(value.hypotheses) && hypotheses.length === 0) {
      findings.invalid.push('hypotheses must not be empty — a round with no hypothesis cannot be planned')
    }
    for (const [index, hypothesis] of hypotheses.entries()) {
      if (!isPlainObject(hypothesis)) {
        findings.invalid.push(`hypotheses[${index}] must be an object`)
        continue
      }
      if (!isNonEmptyString(hypothesis.id)) findings.invalid.push(`hypotheses[${index}].id must be a non-empty string`)
      if (!isNonEmptyString(hypothesis.statement)) {
        findings.invalid.push(`hypotheses[${index}].statement must state the structural hypothesis`)
      }
      if (!Array.isArray(hypothesis.expected_files)) {
        findings.invalid.push(`hypotheses[${index}].expected_files must be an array`)
      }
    }

    const ids = hypotheses.filter(isPlainObject).map((hypothesis) => hypothesis.id)
    const duplicates = ids.filter((id, index) => isNonEmptyString(id) && ids.indexOf(id) !== index)
    if (duplicates.length > 0) findings.conflict.push(`two hypotheses share the id ${JSON.stringify(duplicates[0])}`)

    return findings
  },
})

defineArtifact({
  kind: 'analyze_report',
  description: 'CAND_ANALYZE: what the candidate achieved, and why',
  check(value) {
    if (!isPlainObject(value)) return { invalid: ['analyze_report must be an object'] }
    const findings = { missing: [], invalid: [], conflict: [] }

    checkField(findings, value, 'candidate_id', isNonEmptyString, 'must be a non-empty string')
    checkField(findings, value, 'verdict', (input) => VERDICTS.includes(input), `must be one of ${VERDICTS.join('/')}`)
    checkField(findings, value, 'root_cause', isNonEmptyString, 'must state a root cause')
    checkField(findings, value, 'observed', isPlainObject, 'must be the evidence the analysis reasoned from')
    checkField(findings, value, 'concluded', isPlainObject, 'must echo the value the analysis concluded')
    checkField(findings, value, 'at_ms', isMilliseconds, 'must be a non-negative safe integer of milliseconds')

    for (const field of ['observed', 'concluded']) {
      const point = value[field]
      if (!isPlainObject(point)) continue
      if (!isNonEmptyString(point.metric)) findings.invalid.push(`${field}.metric must be a non-empty string`)
      if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
        findings.invalid.push(`${field}.value must be a finite number`)
      }
    }

    // Echoing the observed value is the point of this kind: an analysis that reasons from one
    // number and reports another is a contradiction we can catch without a model in the loop.
    const { observed, concluded } = value
    if (isPlainObject(observed) && isPlainObject(concluded)) {
      if (observed.metric !== concluded.metric) {
        findings.conflict.push('concluded.metric differs from observed.metric')
      }
      if (observed.value !== concluded.value) {
        findings.conflict.push(
          `concluded ${concluded.metric}=${JSON.stringify(concluded.value)} but observed ${observed.metric}=${JSON.stringify(observed.value)}`,
        )
      }
    }

    return findings
  },
})