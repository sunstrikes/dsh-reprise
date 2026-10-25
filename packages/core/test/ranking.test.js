/**
 * Guards the decision "the frontier, the objective vector and the best candidate are computed in
 * code, from facts, and never from a model output" (spec: 相位机 / 判停; issue 06).
 *
 * Every assertion here answers a question the loop asks itself: which candidate is better, on what
 * number, and which candidates are still worth comparing. If these tests go red, the loop is either
 * ranking on the wrong number or ranking on a number nobody can trace back to a fact.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DERIVED_VERSION, ranking, rebuildRanking, roundHistory } from '../lib/ranking.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

/**
 * The kernel config shape is `{ metrics }`, the same as `{ budget }` and `{ poll }`. The primary is
 * named explicitly: a contract that ranks objectives and never says which one leads is `missing`
 * (the resolution refuses to promote the first objective — that was the silent default ticket 20
 * removed), so a test that means "auc decides" says so.
 */
const config = (objectives) => ({ metrics: { primary: Object.keys(objectives)[0], objectives } })
const AUC_ONLY = config({ auc: 'up' })

test('the best candidate is the one with the best platform-reported metric, chosen in code', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.7123 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.7301 } })
  await runCandidate(ports, { candidateId: 'c3', metrics: { auc: 0.6802 } })

  const view = ranking(ports.store, AUC_ONLY)

  assert.equal(view.best.candidate_id, 'c2', 'the highest auc is the best candidate — no model was asked')
  assert.equal(view.best.value, 0.7301, 'the value is the one the platform reported, to the digit')
  assert.equal(view.best.metric, 'auc', 'the contract names the primary objective, so a dump can say what "best" means')
  assert.deepEqual(view.frontier, ['c2'], 'with one objective the frontier is the single maximum')
  assert.equal(view.candidates.find((row) => row.candidate_id === 'c1').dominatedBy, 'c2')
  assert.equal(view.candidates.find((row) => row.candidate_id === 'c1').onFrontier, false)
  assert.equal(
    view.candidates.every((row) => row.round === 1),
    true,
    'the round is read from the candidate_created fact, so a view can be grouped by round',
  )
  ports.store.close()
})

test('the objective vector records the metric names the contract declared, in a stable order', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71, loss: 0.31, notes: 'warmup' } })

  const view = ranking(ports.store, config({ auc: 'up', loss: 'down' }))

  assert.deepEqual(
    view.contract.objectives.map(({ name, direction, kind }) => ({ name, direction, kind })),
    [
      { name: 'auc', direction: 'up', kind: 'primary' },
      { name: 'loss', direction: 'down', kind: 'objective' },
    ],
    'the vector is the declared objectives, in declaration order — not every number the job emitted',
  )
  assert.deepEqual(view.candidates[0].vector, { auc: 0.71, loss: 0.31 })
  assert.equal(
    'notes' in view.candidates[0].vector,
    false,
    'a metric no objective names cannot leak into the comparison, or the frontier would rank on noise',
  )
  ports.store.close()
})

test('a direction of "down" ranks a lower loss as better', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.71, loss: 0.25 } })

  const view = ranking(ports.store, config({ loss: 'down' }))

  assert.equal(view.best.candidate_id, 'c2', 'lower is better when the contract says the metric goes down')
  assert.deepEqual(view.frontier, ['c2'])
  ports.store.close()
})

test('candidates that trade off on different objectives both stay on the frontier', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.7301, loss: 0.32 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.7188, loss: 0.27 } })
  await runCandidate(ports, { candidateId: 'c3', metrics: { auc: 0.7001, loss: 0.35 } })

  const view = ranking(ports.store, config({ auc: 'up', loss: 'down' }))

  assert.deepEqual(view.frontier, ['c1', 'c2'], 'neither trade-off dominates the other, so both are worth keeping')
  assert.equal(view.best.candidate_id, 'c1', 'the best is decided on the primary objective alone')
  assert.equal(
    view.candidates.find((row) => row.candidate_id === 'c3').dominatedBy,
    'c1',
    'a candidate worse on every objective is dominated, and the view names who dominated it',
  )
  ports.store.close()
})

test('a candidate missing an objective is reported as incomplete instead of scored on part of a vector', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.75 } })

  const view = ranking(ports.store, config({ auc: 'up', loss: 'down' }))

  assert.equal(
    view.best.candidate_id,
    'c1',
    'a candidate with a partial vector cannot be ranked best, even when its number looks better',
  )
  assert.deepEqual(view.frontier, ['c1'])
  assert.deepEqual(
    view.incomplete,
    [{ candidate_id: 'c2', missing: ['loss'] }],
    'the missing metric is named, not silently treated as zero',
  )
  ports.store.close()
})

test('a tie is broken by round then id, so a new round must beat the incumbent to take the best slot', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'r1-c2', round: 1, metrics: { auc: 0.72 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.72 } })

  const view = ranking(ports.store, AUC_ONLY)

  assert.equal(
    view.best.candidate_id,
    'r1-c2',
    'an equal result does not displace the incumbent — otherwise "no improvement" could never be observed',
  )
  assert.deepEqual(view.frontier, ['r1-c2', 'r2-c1'], 'an exact tie is not a domination in either direction')
  ports.store.close()
})

test('rounds are grouped from facts, and a round is complete only when nothing in it is still running', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.74 } })
  const view = ranking(ports.store, AUC_ONLY)

  const rounds = roundHistory(view)

  assert.deepEqual(
    rounds.map((entry) => ({ round: entry.round, complete: entry.complete, best: entry.best?.value })),
    [
      { round: 1, complete: true, best: 0.7 },
      { round: 2, complete: true, best: 0.74 },
    ],
    'a round whose candidates all reached a terminal fact is complete; the round best comes from the facts',
  )
  assert.deepEqual(
    rounds.map((entry) => entry.improving),
    [true, true],
    'the first round establishes the best and round 2 beat it',
  )
  assert.deepEqual(
    rounds.map((entry) => entry.empty),
    [false, false],
    'a round that produced a comparable result is not empty',
  )
  ports.store.close()
})

test('a round whose candidates produced no metrics is empty, which is a different fact from "worse"', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  // Round 2 dies in VERIFY: a malformed verdict, no job, therefore no metric.
  await runCandidate(ports, {
    candidateId: 'r2-c1',
    round: 2,
    judge: { verify: () => ({ candidate_id: 'r2-c1', passed: 'yes' }) },
  }).catch(() => {})
  const view = ranking(ports.store, AUC_ONLY)

  const rounds = roundHistory(view)

  assert.equal(rounds[1].complete, true, 'the round is finished — it finished by dying')
  assert.equal(rounds[1].empty, true, 'a round with no comparable result is empty, not "no improvement"')
  assert.equal(rounds[1].best, undefined)
  assert.equal(rounds[1].improving, false)
  ports.store.close()
})

test('a metric contract that nobody declared yields no ranking and says why', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71 } })

  const view = ranking(ports.store, undefined)

  assert.equal(view.contract.ok, false, 'the kernel has no domain knowledge, so it cannot invent a direction')
  assert.equal(
    view.best,
    undefined,
    'without a contract there is no "better" — guessing a direction would be a domain decision',
  )
  assert.deepEqual(view.frontier, [])
  assert.match(
    view.contract.error,
    /metric contract/i,
    'the reason is stated so a dump can explain an empty conclusion',
  )
  ports.store.close()
})

test('a contract with an unknown direction is refused instead of silently treated as "up"', async () => {
  const ports = openWorkspace()

  const view = ranking(ports.store, config({ auc: 'maximize' }))

  assert.equal(view.contract.ok, false)
  assert.match(view.contract.error, /objectives\.auc/, 'the error names the field that is wrong')
})

test('the incremental view and a full rebuild agree on the same facts', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71, loss: 0.3 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.74, loss: 0.33 } })
  const contract = config({ auc: 'up', loss: 'down' })

  const incremental = ranking(ports.store, contract)
  const rebuilt = rebuildRanking(ports.store, contract)

  assert.deepEqual(
    rebuilt,
    incremental,
    'the rebuild exists to check the incremental path; if they disagree, old facts have silently changed meaning',
  )
  ports.store.close()
})

test('the incremental path re-derives only the candidate that gained an event', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71 } })
  ranking(ports.store, AUC_ONLY) // cold: derives everything

  // Warm cache: the second call must not read a single event row. A view that "hits the cache" and
  // then re-reads and re-sorts everything is the 9.4 s/tick regression this design exists to avoid.
  const warmGuard = instrument(ports.store)
  const warm = ranking(warmGuard.store, AUC_ONLY)
  assert.deepEqual(warmGuard.reads, [], 'no event was read at all')
  assert.equal(warm.best.value, 0.71, 'the answer came from the materialised row')

  // One new candidate: only that candidate's events are read, and only the ones since its stamp.
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.74 } })
  const tracked = instrument(ports.store, { strict: false })
  const caughtUp = ranking(tracked.store, AUC_ONLY)
  assert.deepEqual(
    tracked.reads.map((label) => label.split(':')[1]),
    ['c2'],
    'only the new candidate was folded — c1 came from its materialised row, not from a re-scan',
  )
  assert.equal(caughtUp.best.candidate_id, 'c2')
  ports.store.close()
})

/**
 * A store whose event reads are visible. `strict` blocks them outright: the assertion then is that
 * the code never reached for the stream, not that it happened to be fast.
 */
function instrument(store, { strict = true } = {}) {
  const reads = []
  const blocked = (label) => {
    reads.push(label)
    if (!strict) return undefined
    throw new Error(`the incremental path read the event stream: ${label}`)
  }
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property === 'eventsFor') return (candidateId) => blocked(`eventsFor:${candidateId}`) ?? target.eventsFor(candidateId)
      if (property === 'eventsAfter') {
        return (candidateId, seq) => blocked(`eventsAfter:${candidateId}:${seq}`) ?? target.eventsAfter(candidateId, seq)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { store: proxy, reads }
}

test('a full rebuild catches a materialised row that no longer matches its facts', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71 } })
  await runCandidate(ports, { candidateId: 'c2', metrics: { auc: 0.74 } })
  ranking(ports.store, AUC_ONLY) // warm the cache

  // Hand-edit the derived row — the stand-in for a projection bug, or for a profile that changed
  // how a metric is read after the fact.
  const row = ports.store.getState('c2', 'derived_frontier')
  ports.store.setState('c2', 'derived_frontier', { ...row, metrics: { auc: 0.99 } })

  assert.equal(ranking(ports.store, AUC_ONLY).best.value, 0.99, 'the incremental path trusts its own row')
  assert.equal(
    rebuildRanking(ports.store, AUC_ONLY).best.value,
    0.74,
    'the rebuild ignores the cache, which is the only way the check can fail visibly',
  )
  assert.equal(rebuildRanking(ports.store, AUC_ONLY).best.candidate_id, 'c2')
  ports.store.close()
})

test('the view can be computed without writing, so a read-only handle can render it', async () => {
  const { Store } = await import('../lib/store.js')
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.71 } })
  const dir = ports.store.path.replace(/\/workspace\.db$/, '')
  ports.store.close()

  const readOnly = Store.openReadOnly(dir)
  try {
    const view = ranking(readOnly, AUC_ONLY, { persist: false })
    assert.equal(view.best.candidate_id, 'c1', 'a dashboard must be able to read the frontier without writing to the facts')
  } finally {
    readOnly.close()
  }
})
test('a materialised row written by a different reader version is discarded, not trusted', async () => {
  const ports = openWorkspace()
  await runCandidate(ports, { candidateId: 'c1', metrics: { auc: 0.7301 } })
  ranking(ports.store, AUC_ONLY) // warm the cache

  // A projection change bumps DERIVED_VERSION; the old row still carries a matching stamp, so the
  // stamp alone would keep serving a view the current code would not produce.
  const row = ports.store.getState('c1', 'derived_frontier')
  assert.equal(row.version, DERIVED_VERSION, 'the row records the reader version that wrote it')
  ports.store.setState('c1', 'derived_frontier', { ...row, version: DERIVED_VERSION - 1, metrics: { auc: 0.1 } })

  assert.equal(
    ranking(ports.store, AUC_ONLY).best.value,
    0.7301,
    'a row from an older reader must be re-derived from the facts, or a fixed projection bug keeps serving its own old answer',
  )
  assert.equal(
    ports.store.getState('c1', 'derived_frontier').version,
    DERIVED_VERSION,
    'and the fresh row is persisted, so the re-derivation happens once',
  )
  ports.store.close()
})
