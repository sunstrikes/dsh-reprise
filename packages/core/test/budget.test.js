import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Store } from '../lib/store.js'
import {
  DEFAULT_BUDGET,
  autoResumeIfClear,
  budgetOf,
  canDispatch,
  evaluate,
  pause,
  resume,
  spendOf,
} from '../lib/budget.js'

const AT = 1_761_091_200_000
const HOUR = 3_600_000

const clockAt = (t) => ({ now: () => t, set: (v) => (t = v) })

function setup({ budget, startedAt = AT } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-budget-')))
  store.setState(undefined, 'workspace', { paused: null, started_at_ms: startedAt })
  const clock = clockAt(AT)
  const config = budget === undefined ? undefined : { budget }
  const workspace = () => store.getState(undefined, 'workspace')
  return { store, clock, config, workspace }
}

test('the open-source default has no GPU ceiling and judges no tokens', () => {
  const { store, clock, config } = setup()
  store.settle('c1', 999, clock.now(), 10_000_000)

  const decision = evaluate(store, store.getState(undefined, 'workspace'), config, clock.now())
  assert.equal(decision.verdict, 'ok', 'an unlimited budget must never gate on spend')
  assert.equal(DEFAULT_BUDGET.judge_tokens, false)
  assert.deepEqual(canDispatch(store, store.getState(undefined, 'workspace'), config, clock.now()).ok, true)
  store.close()
})

test('a reservation is spent the moment it is made', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 1, soft_ratio: 0.8 } })
  store.reserve('c1', 0.5, clock.now())

  const spend = spendOf(store)
  assert.equal(spend.inFlightGpuHours, 0.5)
  assert.equal(spend.usedGpuHours, 0.5, 'money promised is not money available')

  store.settle('c1', 0.5, clock.now())
  assert.equal(spendOf(store).usedGpuHours, 0.5, 'settling moves it, it does not double it')
  store.close()
})

test('the soft limit stops new dispatch and nothing else', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 1, soft_ratio: 0.8 } })
  store.reserve('c1', 0.8, clock.now())

  const decision = evaluate(store, store.getState(undefined, 'workspace'), config, clock.now())
  assert.equal(decision.verdict, 'soft')
  const permit = canDispatch(store, store.getState(undefined, 'workspace'), config, clock.now())
  assert.equal(permit.ok, false)
  assert.equal(permit.reason, 'soft', 'the reason is what the log and the dump will show')
  assert.equal(permit.decision.usedGpuHours, 0.8)
  store.close()
})

test('the hard limit is a different verdict from the soft one', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 1, soft_ratio: 0.8 } })
  store.reserve('c1', 1, clock.now())
  assert.equal(evaluate(store, store.getState(undefined, 'workspace'), config, clock.now()).verdict, 'hard')
  store.close()
})

test('tokens are recorded and never decide anything', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 1, judge_tokens: false } })
  store.settle('c1', 0, clock.now(), 500_000_000)

  assert.equal(spendOf(store).tokens, 500_000_000, 'the number is kept')
  assert.equal(
    evaluate(store, store.getState(undefined, 'workspace'), config, clock.now()).verdict,
    'ok',
    'half a billion tokens must not stop a run — the meter is not the gate',
  )
  store.close()
})

test('wall-clock pacing is a third ceiling and it pauses the same way', () => {
  const { store, clock, config } = setup({ budget: { max_runtime_hours: 1 } })
  const workspace = () => store.getState(undefined, 'workspace')

  assert.equal(evaluate(store, workspace(), config, AT + HOUR / 2).verdict, 'ok')
  const later = evaluate(store, workspace(), config, AT + 2 * HOUR)
  assert.equal(later.verdict, 'runtime')
  assert.ok(later.elapsedHours >= 2)
  store.close()
})

test('an automatic pause clears itself once the cause is gone', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 1, soft_ratio: 0.8 } })
  store.reserve('c1', 1, clock.now())
  pause(store, clock, { reason: 'budget_exhausted', automatic: true, used_gpu_hours: 1, gpu_hours_limit: 1 })

  const stillBlocked = autoResumeIfClear(store, clock, config, clock.now())
  assert.equal(stillBlocked.status, 'still_blocked', 'nothing changed, so nothing resumes')

  // Raising the ceiling by hand (a pending grant, ticket 12) is enough: no restart, no special case.
  store.setState(undefined, 'workspace', { ...store.getState(undefined, 'workspace'), budget: { gpu_hours_limit: 100 } })
  const cleared = autoResumeIfClear(store, clock, config, clock.now())
  assert.equal(cleared.status, 'resumed')
  assert.equal(store.getState(undefined, 'workspace').paused, null)
  store.close()
})

test('a manual pause never clears itself', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 100 } })
  pause(store, clock, { reason: 'operator', automatic: false })

  const auto = autoResumeIfClear(store, clock, config, clock.now())
  assert.equal(auto.status, 'not_applicable', 'code may not undo a human')

  const refused = resume(store, clock)
  assert.equal(refused.status, 'needs_human')
  assert.equal(store.getState(undefined, 'workspace').paused.reason, 'operator')

  const forced = resume(store, clock, { force: true })
  assert.equal(forced.status, 'resumed')
  assert.equal(forced.was.reason, 'operator', 'the resume receipt says what was lifted')
  store.close()
})

test('resuming a workspace that is not paused is a no-op, not an error', () => {
  const { store, clock } = setup()
  assert.equal(resume(store, clock).status, 'not_paused')
  store.close()
})

test('a budget in the workspace overrides config, and only when it is set', () => {
  const { store, clock, config } = setup({ budget: { gpu_hours_limit: 1 } })
  const workspace = () => store.getState(undefined, 'workspace')

  assert.equal(budgetOf(workspace(), config).gpu_hours_limit, 1, 'config supplies the value')
  store.setState(undefined, 'workspace', { ...workspace(), budget: { gpu_hours_limit: 4 } })
  assert.equal(budgetOf(workspace(), config).gpu_hours_limit, 4, 'the workspace wins when it speaks')
  store.close()
})
test('a reservation survives a restart: a crash never refunds money', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-budget-'))
  const first = Store.open(dir)
  first.reserve('c1', 0.75, AT)
  first.close()

  const reopened = Store.open(dir)
  assert.equal(spendOf(reopened).usedGpuHours, 0.75, 'in-flight spend is still on the books after a crash')
  assert.equal(spendOf(reopened).inFlightGpuHours, 0.75)
  reopened.close()
})
