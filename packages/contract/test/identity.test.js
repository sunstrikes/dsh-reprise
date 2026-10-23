import assert from 'node:assert/strict'
import test from 'node:test'

import { fromFindings, validateCandidate, validateChain } from '../lib/index.js'

const parent = { parent_id: 'baseline-0', parent_commit: 'aaa111' }
const gate = { parent_id: 'baseline-0', passed: true }
const fold = { parent_commit: 'aaa111' }
const job = { job_id: 'j1', state: 'running' }

test('a candidate with nothing written is missing, not invalid', () => {
  const result = validateCandidate({ state: undefined })
  assert.equal(result.status, 'missing')
})

test('a state without a phase is invalid', () => {
  assert.equal(validateCandidate({ state: {} }).status, 'invalid')
  assert.equal(validateCandidate({ state: { phase: 'NOPE' } }).status, 'invalid')
})

test('requirements follow the phase, using isBeyond', () => {
  // LAND freezes parent_binding, so LAND may not require it.
  assert.equal(validateCandidate({ state: { phase: 'LAND' } }).status, 'ok')
  assert.equal(validateCandidate({ state: { phase: 'LAND' }, bindings: { parent_binding: parent } }).status, 'ok')

  // Everything after LAND may.
  assert.equal(validateCandidate({ state: { phase: 'BUILD' } }).status, 'missing')

  // VERIFY may not demand its own output.
  assert.equal(validateCandidate({ state: { phase: 'VERIFY' }, bindings: { parent_binding: parent } }).status, 'ok')

  // Past VERIFY, the gate is mandatory…
  const pastGate = validateCandidate({ state: { phase: 'SUBMIT_QUEUED' }, bindings: { parent_binding: parent } })
  assert.equal(pastGate.status, 'missing')
  assert.match(pastGate.message, /verify_gate/)

  // …and past SUBMIT, so is the job row.
  const pastSubmit = validateCandidate({
    state: { phase: 'MONITOR_POLL' },
    bindings: { parent_binding: parent, verify_gate: gate },
  })
  assert.equal(pastSubmit.status, 'missing')
  assert.match(pastSubmit.message, /job/)
})

test('a well-formed candidate past SUBMIT is ok', () => {
  const result = validateCandidate({
    state: { phase: 'MONITOR_POLL' },
    bindings: { parent_binding: parent, verify_gate: gate },
    job,
  })
  assert.equal(result.status, 'ok', result.message)
})

test('a gate that did not pass with a strict boolean true is invalid', () => {
  const result = validateCandidate({
    state: { phase: 'SUBMIT_QUEUED' },
    bindings: { parent_binding: parent, verify_gate: { parent_id: 'baseline-0', passed: 'true' } },
  })
  assert.equal(result.status, 'invalid')
})

test('bindings that disagree about the parent are a conflict, not a failure', () => {
  const result = validateCandidate({
    state: { phase: 'SUBMIT_QUEUED' },
    bindings: { parent_binding: parent, verify_gate: { parent_id: 'baseline-9', passed: true } },
  })
  assert.equal(result.status, 'conflict')
  assert.match(result.message, /disagrees/)
})

test('precedence is missing, then invalid, then conflict', () => {
  // Says it in one place so no validator has to rediscover it.
  assert.equal(fromFindings({ conflict: ['c'], invalid: ['i'], missing: ['m'] }).status, 'missing')
  assert.equal(fromFindings({ conflict: ['c'], invalid: ['i'], missing: [] }).status, 'invalid')
  assert.equal(fromFindings({ conflict: ['c'], invalid: [], missing: [] }).status, 'conflict')
  assert.equal(fromFindings({}).status, 'ok')
})

test('the full chain demands all three links and cross-checks them', () => {
  assert.equal(validateChain({}).status, 'missing')
  assert.equal(validateChain({ parent_binding: parent }).status, 'missing')

  const complete = { parent_binding: parent, verify_gate: gate, fold_state: fold }
  assert.equal(validateChain(complete).status, 'ok')

  const wrongParent = { ...complete, verify_gate: { parent_id: 'baseline-9', passed: true } }
  assert.equal(validateChain(wrongParent).status, 'conflict')

  const wrongCommit = { ...complete, fold_state: { parent_commit: 'bbb222' } }
  const commitResult = validateChain(wrongCommit)
  assert.equal(commitResult.status, 'conflict')
  assert.match(commitResult.message, /parent_commit/)

  const notPassed = { ...complete, verify_gate: { parent_id: 'baseline-0', passed: false } }
  assert.equal(validateChain(notPassed).status, 'invalid')
})