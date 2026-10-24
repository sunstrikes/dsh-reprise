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

/** A content digest, as the gate records the bytes it checked. */
const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

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
    // Optional so that artifacts written before the gate kept an attempt sequence stay readable: absent
    // means "the first and only attempt", which is what every one of them was.
    if (value.attempt !== undefined) {
      if (!Number.isSafeInteger(value.attempt) || value.attempt <= 0) {
        findings.invalid.push('attempt must be a positive integer — a gate record without its place in the sequence cannot be recomputed')
      }
    }

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

    // The evidence the record was computed from, so a second reader can recompute it: the paths with
    // the digest of the bytes each check saw, and the whitelist it was checked against. Optional for
    // the same backwards-compatibility reason as `attempt`, and never trusted as a pass on its own.
    const evidence = value.evidence
    if (evidence !== undefined) {
      if (!isPlainObject(evidence)) {
        findings.invalid.push('evidence must be an object when present')
      } else {
        if (evidence.files !== undefined && !Array.isArray(evidence.files)) {
          findings.invalid.push('evidence.files must be an array of checked files')
        }
        for (const [index, file] of (Array.isArray(evidence.files) ? evidence.files : []).entries()) {
          if (!isPlainObject(file)) {
            findings.invalid.push(`evidence.files[${index}] must be an object`)
            continue
          }
          if (!isNonEmptyString(file.path)) findings.invalid.push(`evidence.files[${index}].path must be a non-empty path`)
          if (!isDigest(file.digest)) {
            findings.invalid.push(`evidence.files[${index}].digest must be a sha256 hex digest — evidence that cannot be re-read cannot be recomputed`)
          }
          if (file.bytes !== undefined && (!Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
            findings.invalid.push(`evidence.files[${index}].bytes must be a non-negative integer`)
          }
        }
        if (evidence.whitelist !== undefined && evidence.whitelist !== null) {
          const whitelist = evidence.whitelist
          if (!Array.isArray(whitelist) || whitelist.some((entry) => !isNonEmptyString(entry))) {
            findings.invalid.push('evidence.whitelist must be an array of paths (or null when the domain declared none)')
          }
        }
        if (evidence.unchecked !== undefined && !Array.isArray(evidence.unchecked)) {
          findings.invalid.push('evidence.unchecked must be an array of paths the kernel could not read')
        }
      }
    }

    // The gate consumes a structured verdict built from two pieces of evidence: the deterministic
    // checks the kernel ran, and the adversarial review. `passed` is the gate's claim *about* them, so
    // these rules only ask whether the claim follows from the evidence. Three ways it may not:
    //
    //   1. the review accepts over a check that failed — the two evidences disagree and neither wins;
    //   2. the record claims a pass its own checks or its own review refuse;
    //   3. the record claims a failure while both evidences say pass (what a recomputation catches).
    //
    // Deliberately *not* here: a review that rejects while every check passed. That is the review
    // doing its job — a syntax check cannot see that the diff moved the evaluation split — and
    // calling it a conflict would turn every ordinary "no" into a finding about malformed artifacts.
    // A unanimous "no" is likewise not a conflict: that candidate failed its gate, and it is rejected
    // with a message and no four-state status at all.
    const failed = checks.filter((check) => isPlainObject(check) && check.result === 'fail')
    const checksPass = checks.length > 0 && failed.length === 0
    const reviewSays = isPlainObject(reviewer) ? reviewer.verdict : undefined

    if (reviewSays === 'accept' && failed.length > 0) {
      const names = failed.map((check) => check.name).join(', ')
      findings.conflict.push(
        `the adversarial review accepted while ${failed.length} check(s) failed (${names}) — the two evidences disagree, so neither wins`,
      )
    }
    if (value.passed === true && failed.length > 0) {
      findings.conflict.push(`passed is true while ${failed.length} check(s) failed`)
    }
    if (value.passed === true && reviewSays === 'reject') {
      findings.conflict.push('passed is true while the adversarial review rejected the candidate')
    }
    if (value.passed === false && checksPass && reviewSays === 'accept') {
      findings.conflict.push('passed is false while every check passed and the adversarial review accepts')
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