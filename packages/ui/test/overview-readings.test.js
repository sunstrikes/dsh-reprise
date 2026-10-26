/**
 * Guards ticket #4's data half: the readings row (`rounds / candidates / GPU hours / frontier`), the
 * budget bar, the cluster cell and the stop gauges (spec §6.3, §6.6, §6.9).
 *
 * The seam is the overview the route hands the browser — `overviewHandler(workspace, query, { clock })`
 * — because the thing these fields have to survive is a renderer that is not allowed to derive
 * anything: **every ratio the bar is drawn with is published here**, and every "we could not measure
 * this" is a `null` plus a sentence rather than a `0`.
 *
 * Two properties are the point, and each one has a defect behind it:
 *
 *   - `reserved − settled` is a *reservation*, not work in flight: a candidate that finished without
 *     spending its whole reservation leaves the difference behind, so the field the page reads is
 *     named for what it is;
 *   - a number nobody could measure is `null`. The ledger cannot count cards it never listed, and a
 *     `0` there is the answer somebody acts on.
 */

import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'

import { overview } from '../../core/lib/projection.js'
import { createCandidate, tick } from '../../core/lib/loop.js'
import { overviewHandler } from '../lib/routes.js'
import { AT, openWorkspace, runCandidate, seedConfig } from '../../core/test/support/fake-ports.js'

const HOUR = 3_600_000

const config = (extra = {}) => ({ metrics: { primary: 'auc', objectives: { auc: 'up' } }, ...extra })

/** A fake clock standing in for the route's own: the page's `now` arrives from the caller, not from a `Date.now()` inside the projection. */
const clockAt = (ms) => ({ now: () => ms })

/** Two finished rounds and no open store — the state the page reads when the loop has exited. */
async function concluded({ stop = { max_rounds: 0 }, budget = { gpu_hours_limit: 4 } } = {}) {
  const ports = openWorkspace({ config: config({ stop, budget }) })
  seedConfig(ports.store, ports.config)
  ports.store.setState(undefined, 'workspace', { ...ports.store.getState(undefined, 'workspace', {}), budget })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })
  const dir = dirname(ports.store.path)
  ports.store.close()
  return dir
}

// ------------------------------------------------------------------ the stop gauges

test('every enabled stop rule arrives with the value it has reached, measured against the clock the route was given', async () => {
  const dir = await concluded({
    stop: { max_rounds: 20, max_no_improvement_rounds: 3, consecutive_empty_rounds: 2, max_wall_hours: 10 },
  })

  const answer = await overviewHandler(dir, {}, { clock: clockAt(AT + 5 * HOUR) })
  const rules = answer.data.stop.rules

  assert.deepEqual(
    rules.map((rule) => [rule.rule, rule.enabled, rule.observed, rule.distancePercent]),
    [
      ['max_rounds', true, 2, 10],
      // Round 2 beat round 1, so nothing is waiting to improve on it yet.
      ['max_no_improvement_rounds', true, 0, 0],
      ['consecutive_empty_rounds', true, 0, 0],
      // Five hours between the recorded start and the reading the caller handed in.
      ['max_wall_hours', true, 5, 50],
      ['max_windows', false, null, null],
    ],
    'the gauges read the values the decision reads, and the limit that is off has no reading at all',
  )

  // The same route with a later clock: the wall clock is the caller's reading, not a `Date.now()`
  // buried in the projection, which would make "how close is this run to its time limit" untestable.
  const later = await overviewHandler(dir, {}, { clock: clockAt(AT + 9 * HOUR) })
  assert.equal(later.data.stop.rules.find((rule) => rule.rule === 'max_wall_hours').observed, 9)
})

test('a stopped run lists every rule with the limit that was in force when it concluded', async () => {
  const ports = openWorkspace({ config: config({ stop: { max_rounds: 2 } }) })
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.7401 } })
  await tick(ports)
  assert.equal(ports.store.getState(undefined, 'workspace').stopped.rule, 'max_rounds', 'fixture: the run concluded')

  // Read with a configuration that was changed afterwards — `dump --config` is exactly this shape.
  const view = overview(ports.store, { config: config({ stop: { max_rounds: 20, max_no_improvement_rounds: 3 } }), now: AT })
  ports.store.close()

  const rules = view.stop.rules
  assert.equal(view.stop.rule, 'max_rounds', 'the recorded conclusion is what the page says happened')
  assert.deepEqual(
    rules.map((rule) => [rule.rule, rule.limit]),
    [
      ['max_rounds', 2],
      ['max_no_improvement_rounds', 0],
      ['consecutive_empty_rounds', 0],
      ['max_wall_hours', 0],
      ['max_windows', 0],
    ],
    'the panel lists the rules that decided, not the ones a later edit would have decided with',
  )
  const fired = rules.find((rule) => rule.rule === 'max_rounds')
  assert.equal(fired.observed, view.stop.observed, 'and the rule that fired shows the value it fired on')
  assert.equal(fired.distancePercent, 100)
})

// ------------------------------------------------------------------- the budget bar

test('the budget bar publishes its three materials, so no renderer divides two numbers', async () => {
  const ports = openWorkspace({ config: config({ budget: { gpu_hours_limit: 4 } }) })
  seedConfig(ports.store, ports.config)
  ports.store.setState(undefined, 'workspace', { ...ports.store.getState(undefined, 'workspace', {}), budget: { gpu_hours_limit: 4 } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  // A second candidate whose job is still running: money reserved, not settled.
  createCandidate(ports, { candidateId: 'r1-c2', round: 1, hypothesis: 'still queued' })
  for (let index = 0; index < 6; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }

  const view = overview(ports.store, { config: ports.config })
  ports.store.close()

  const budget = view.spend.budget
  assert.equal(budget.limited, true)
  assert.equal(budget.scaleGpuHours, 4, 'a capped bar is drawn against the cap')
  assert.equal(budget.settledPercent, 12.5, 'half a GPU hour out of four')
  assert.equal(budget.reservedPercent, 12.5, 'and the reservation beside it, as its own material')
  assert.equal(budget.remainingPercent, 75)
  assert.equal(budget.remainingGpuHours, 3, 'and what is left of the cap, in the same unit as the other two')
  assert.equal(budget.softLimitPercent, 80, 'the soft limit sits at the budget\'s own ratio, not one the page guessed')
  assert.equal(budget.over, false)
  assert.equal(
    budget.reservedUnsettledGpuHours,
    0.5,
    'the reservation is published under the name of what it is: reserved, not yet settled',
  )
})

test('no cap is a state: the bar is scaled by what was used, and there is no limit marker to draw', async () => {
  const ports = openWorkspace({ config: config({ budget: { gpu_hours_limit: 0 } }) })
  seedConfig(ports.store, ports.config)
  ports.store.setState(undefined, 'workspace', { ...ports.store.getState(undefined, 'workspace', {}), budget: { gpu_hours_limit: 0 } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.71 } })

  const view = overview(ports.store, { config: ports.config })
  ports.store.close()

  const budget = view.spend.budget
  assert.equal(budget.limited, false, 'zero means unlimited, as everywhere else in the kernel')
  assert.equal(budget.scaleGpuHours, 1, 'so the bar is scaled by what was spent — never by a 0 that would be a floor')
  assert.equal(budget.settledPercent, 100)
  assert.equal(budget.remainingPercent, 0, 'with no cap there is no "remaining" to draw')
  assert.equal(budget.remainingGpuHours, 0, 'and nothing to name in that unit either')
  assert.equal(budget.softLimitPercent, null, 'and no soft-limit marker either')
})

// ---------------------------------------------------------------- the frontier cell

test('the frontier readings name the value each member carries, so the cell lists them without a lookup', async () => {
  const dir = await concluded()

  const frontier = (await overviewHandler(dir, {})).data.frontier

  // One objective, so round 2 dominates round 1 and the frontier holds the leader alone.
  assert.equal(frontier.size, 1)
  assert.equal(frontier.primary, 'auc', 'the cell names the metric the readings are in')
  assert.equal(frontier.objectives.length, 1, 'and how many objectives the frontier is spread across')
  assert.equal(frontier.readings.length, frontier.members.length, 'one reading per member, no more and no fewer')
  assert.deepEqual(frontier.readings, [{ candidate_id: 'r2-c1', value: 0.7401 }])
})

// ---------------------------------------------------------------- the cluster cell

test('a cluster nobody could ask is drawn as unknown, next to what our own ledger supports', async () => {
  const ports = openWorkspace({ config: config({ budget: { gpu_hours_limit: 4 } }) })
  seedConfig(ports.store, ports.config)
  // Two cards per job is what the executor claims; a job still open is what our ledger knows about.
  ports.store.setState(undefined, 'workspace', {
    ...ports.store.getState(undefined, 'workspace', {}),
    executor: { kind: 'ray', num_gpus: 2 },
  })
  createCandidate(ports, { candidateId: 'r1-c1', round: 1, hypothesis: 'queued for a card' })
  for (let index = 0; index < 6; index += 1) {
    await tick(ports)
    ports.clock.advance(1_000)
  }

  const cluster = (await overviewHandler(dirname(ports.store.path), {})).data.cluster
  ports.store.close()

  assert.equal(cluster.read, false, 'no listing source was given, so the cluster was not asked')
  assert.equal(cluster.cards.inUse, null, 'and "unknown" is null, never 0 — somebody acts on 0 cards')
  assert.equal(cluster.cards.floor, 2, 'our own ledger holds one open job at two cards each')
  assert.equal(cluster.cards.floorAbsent, null)
})

test('a ledger that cannot say how many cards it holds says so, instead of printing a dash that reads as zero', async () => {
  const dir = await concluded()

  const cluster = (await overviewHandler(dir, {})).data.cluster

  assert.equal(cluster.read, false)
  assert.equal(cluster.cards.inUse, null)
  assert.equal(cluster.cards.floor, null, 'this run never recorded how many cards a job claims, so there is no floor to print')
  assert.match(cluster.cards.floorAbsent, /cards/, 'and the page is told why, in a sentence it can show')
})