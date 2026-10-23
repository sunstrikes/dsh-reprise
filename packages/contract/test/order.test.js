import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANDIDATE_PHASES,
  isBeyond,
  isKnownCandidatePhase,
  isPast,
  isTerminal,
  requirementsAt,
} from '../lib/index.js'

test('isBeyond is strict and isPast is not', () => {
  assert.equal(isPast('VERIFY', 'VERIFY'), true)
  assert.equal(isBeyond('VERIFY', 'VERIFY'), false, 'the whole point: a phase is not beyond itself')
  assert.equal(isBeyond('SUBMIT_QUEUED', 'VERIFY'), true)
  assert.equal(isBeyond('LAND', 'SUBMIT'), false)
})

test('unknown phases never satisfy a boundary', () => {
  assert.equal(isPast('NOPE', 'VERIFY'), false)
  assert.equal(isBeyond('NOPE', 'VERIFY'), false)
  assert.equal(isKnownCandidatePhase('NOPE'), false)
  assert.equal(isKnownCandidatePhase('REJECTED'), true, 'terminal phases are known, just not on the path')
})

test('a phase never requires what it is about to produce', () => {
  // Regression guard for the prototype bug: an inclusive comparison here made VERIFY demand the
  // verify_gate that VERIFY itself creates, and two candidates died on the first tick.
  for (const phase of CANDIDATE_PHASES) {
    const { bindings, needsJob } = requirementsAt(phase)
    if (phase === 'LAND') {
      assert.ok(!bindings.includes('parent_binding'), 'LAND must not demand the binding it freezes')
    }
    if (phase === 'VERIFY') {
      assert.ok(!bindings.includes('verify_gate'), 'VERIFY must not demand the gate it produces')
    }
    if (phase === 'SUBMIT') {
      assert.ok(!needsJob, 'SUBMIT must not demand the job row it produces')
    }
  }
})

test('requirements grow monotonically along the path', () => {
  const seen = CANDIDATE_PHASES.map((phase) => {
    const { bindings, needsJob } = requirementsAt(phase)
    return { phase, bindings: bindings.length, needsJob }
  })
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index].bindings >= seen[index - 1].bindings, `${seen[index].phase} dropped a requirement`)
    if (seen[index - 1].needsJob) assert.ok(seen[index].needsJob, `${seen[index].phase} dropped the job requirement`)
  }
})

test('terminal phases are the two that end a candidate', () => {
  assert.deepEqual(CANDIDATE_PHASES.filter(isTerminal), ['DONE'])
  assert.equal(isTerminal('REJECTED'), true)
  assert.equal(isTerminal('LAND'), false)
})