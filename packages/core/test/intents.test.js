/**
 * Contract guarded here (ticket 12): **a human intent is a file, not an API call.**
 *
 * 1. A file dropped in `pending/` is consumed by the next tick, lands an event naming it, and is
 *    applied exactly once — re-placing it must not apply it again.
 * 2. Whoever writes it (CLI now, UI later) writes the same file, so the two paths cannot produce
 *    two contradictory records.
 * 3. Nothing waits for a human forever: every hold carries a deadline, and a hold without one is
 *    refused rather than left to hang. A run continues whether or not anybody answers.
 * 4. Malformed or over-reaching intents are refused with a reason and change no state.
 * 5. A manual pause is only clearable by a human; an automatic pause clears itself once its cause
 *    is gone — and a grant is what removes that cause, without a restart.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Store } from '../lib/store.js'
import { createCandidate, tick } from '../lib/loop.js'
import { listIntents, placeIntent } from '../lib/intents.js'

const AT = 1_761_091_200_000
const CLI = fileURLToPath(new URL('../lib/cli/intents.js', import.meta.url))

class FakeClock {
  constructor(at = AT) {
    this.t = at
  }
  now() {
    return this.t
  }
  advance(ms) {
    this.t += ms
  }
}

/** Ports good enough to walk a candidate; intent tests only ever reach LAND. */
function fakePorts() {
  const jobs = new Map()
  let counter = 0
  const platform = {
    jobs,
    submit({ submissionId, candidateId }) {
      counter += 1
      const job = { job_id: `job-${counter}`, submission_id: submissionId, candidate_id: candidateId, state: 'running' }
      jobs.set(job.job_id, job)
      return { job_id: job.job_id, harness: 'fake', state: 'running' }
    },
    find(candidateId) {
      return [...jobs.values()].find((job) => job.candidate_id === candidateId)
    },
    poll(jobId) {
      const job = jobs.get(jobId)
      return job === undefined ? { state: 'lost' } : { state: job.state, metrics: job.metrics }
    },
  }
  const harness = { land: ({ candidateId }) => ({ engine: 'fake', parent_id: 'baseline-0', parent_commit: 'aaa111', candidateId }) }
  const judge = {
    verify: ({ candidateId, now }) => ({
      candidate_id: candidateId,
      passed: true,
      checks: [{ name: 'static_imports', result: 'pass' }],
      reviewer: { verdict: 'accept', rationale: 'no behaviour change outside the module' },
      decided_at_ms: now,
    }),
    analyze: ({ candidateId, now }) => ({
      candidate_id: candidateId,
      verdict: 'improved',
      observed: { metric: 'auc', value: 0.71 },
      concluded: { metric: 'auc', value: 0.71 },
      root_cause: 'wider table',
      at_ms: now,
    }),
  }
  return { platform, harness, judge }
}

function setup({ config, startedAt = AT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-intents-'))
  const store = Store.open(dir)
  // The workspace record is seeded here so a refusal test can fingerprint it afterwards; the
  // kernel would seed the same shape on its first tick.
  store.setState(undefined, 'workspace', { paused: null, started_at_ms: startedAt })
  const clock = new FakeClock(startedAt)
  const ports = { store, clock, config, ...fakePorts() }
  return { dir, store, clock, ports, config }
}

const pendingFiles = (dir) => {
  try {
    return readdirSync(join(dir, 'pending')).sort()
  } catch {
    return []
  }
}
const records = (dir, kind) => {
  try {
    return readdirSync(join(dir, 'intents', kind)).sort()
  } catch {
    return []
  }
}
const events = (store, type) =>
  store.eventsFor('workspace').filter((event) => type === undefined || event.event_type === type)
const eventTypesOf = (store, candidateId) => store.eventsFor(candidateId).map((event) => event.event_type)
const existsSyncJoin = (dir, ...parts) => existsSync(join(dir, ...parts))

// ------------------------------------------------------- one intent, once

test('a grant placed as a file is consumed by the next tick, once, and lands an event', async () => {
  const { dir, store, clock, ports } = setup({ config: { budget: { gpu_hours_limit: 1, soft_ratio: 0.8 } } })
  store.reserve('c1', 1, clock.now())

  // Spending the whole budget pauses automatically; that is ticket 05's verdict, not this one.
  const first = await tick(ports)
  assert.equal(first.paused.reason, 'budget_exhausted')

  placeIntent(dir, { kind: 'grant', intent_id: 'g-1', additional_gpu_hours: 0.5 }, { now: clock.now() })
  assert.deepEqual(pendingFiles(dir), ['g-1.json'])

  clock.advance(1_000)
  const second = await tick(ports)
  assert.equal(second.paused, null, 'the grant raised the limit, so the automatic pause cleared itself')
  assert.equal(store.getState(undefined, 'workspace').budget.gpu_hours_limit, 1.5)
  assert.deepEqual(pendingFiles(dir), [], 'a consumed intent leaves pending/')
  assert.deepEqual(records(dir, 'applied'), ['g-1.json'])

  const [applied] = events(store, 'intent_applied')
  assert.equal(applied.payload.intent_id, 'g-1')
  assert.equal(applied.payload.kind, 'grant')
  assert.equal(applied.payload.decision_source, 'human')
  assert.equal(applied.payload.fallback, false)

  // Placing the very same file again must not grant twice: the record is the ledger.
  const again = placeIntent(dir, { kind: 'grant', intent_id: 'g-1', additional_gpu_hours: 0.5 }, { now: clock.now() })
  assert.equal(again.status, 'placed', 'pending/ is empty again, so the writer accepts it')
  clock.advance(1_000)
  await tick(ports)

  assert.equal(store.getState(undefined, 'workspace').budget.gpu_hours_limit, 1.5, 'still one grant, not two')
  assert.equal(events(store, 'intent_applied').length, 1, 'one consumption, one applied event')
  const refused = events(store, 'intent_refused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].payload.reason, 'already_consumed')
  assert.deepEqual(pendingFiles(dir), [])
  store.close()
})

test('placing the same id while it is still pending does not overwrite the fact', () => {
  const { dir, store, clock } = setup()
  const first = placeIntent(dir, { kind: 'pause', intent_id: 'p-1', reason: 'hold the cluster' }, { now: clock.now() })
  assert.equal(first.status, 'placed')

  const second = placeIntent(dir, { kind: 'pause', intent_id: 'p-1', reason: 'something else' }, { now: clock.now() })
  assert.equal(second.status, 'exists')
  const onDisk = JSON.parse(readFileSync(join(dir, 'pending', 'p-1.json'), 'utf8'))
  assert.equal(onDisk.reason, 'hold the cluster', 'the first writer wins; the fact is not silently replaced')

  const listed = listIntents(dir, { now: clock.now() })
  assert.deepEqual(
    listed.pending.map((entry) => [entry.intent_id, entry.kind]),
    [['p-1', 'pause']],
  )
  store.close()
})
// ------------------------------------------------------------- the CLI seam

test('the command line places the same fact a UI would, and the next tick adopts it', async () => {
  const { dir, store, clock, ports } = setup()

  // A real process, because the acceptance line is "drive it without the UI".
  const placed = execFileSync(
    process.execPath,
    [CLI, 'place', 'pause', '--reason', 'cluster maintenance', '--id', 'p-cli', '--workspace', dir, '--now', String(clock.now())],
    { encoding: 'utf8' },
  )
  assert.match(placed, /placed pause p-cli/)
  const onDisk = JSON.parse(readFileSync(join(dir, 'pending', 'p-cli.json'), 'utf8'))
  assert.deepEqual(onDisk, { kind: 'pause', reason: 'cluster maintenance', intent_id: 'p-cli', placed_at_ms: AT })

  // The dashboard button will call the very same writer. When it disagrees with the CLI about an
  // id, the second writer is told the fact already exists — it never replaces what is on disk, so
  // the two paths cannot produce two contradictory records of one act.
  const clash = placeIntent(dir, { kind: 'pause', intent_id: 'p-cli', reason: 'a different reason' }, { now: clock.now() })
  assert.equal(clash.status, 'exists')
  assert.equal(JSON.parse(readFileSync(join(dir, 'pending', 'p-cli.json'), 'utf8')).reason, 'cluster maintenance')

  const { paused } = await tick(ports)
  assert.equal(paused.reason, 'cluster maintenance')
  assert.equal(paused.automatic, false, 'a pause typed by a person is a manual pause')

  const applied = events(store, 'intent_applied')
  assert.equal(applied.length, 1)
  assert.equal(applied[0].payload.intent_id, 'p-cli')

  const listed = execFileSync(process.execPath, [CLI, 'list', '--workspace', dir], { encoding: 'utf8' })
  assert.match(listed, /refused\s+\(0\)/)
  assert.match(listed, /applied\s+\(1\)/)
  assert.match(listed, /p-cli\s+pause\s+human/)
  store.close()
})

test('the command line refuses to write a malformed intent, and says why', () => {
  const { dir, store } = setup()
  assert.throws(
    () => execFileSync(process.execPath, [CLI, 'place', 'grant', '--additional-gpu-hours', '-1', '--workspace', dir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 1 && /invalid_additional_gpu_hours: -1/.test(error.stderr),
  )
  assert.deepEqual(pendingFiles(dir), [], 'a malformed intent is never written')
  store.close()
})

// ------------------------------------------------------- refused, and told why

/**
 * One row per way an intent can be wrong. Every row must be refused, must say what is wrong, and
 * must leave the workspace exactly as it found it — fail-closed means "the file is inert".
 */
const REFUSALS = [
  { name: 'not JSON at all', file: 'r-json', body: '{"kind": "grant",', reason: /^invalid_json: / },
  { name: 'not an object', file: 'r-array', body: '[]', reason: /^not_an_object$/ },
  { name: 'no kind', file: 'r-nokind', body: { intent_id: 'r-nokind' }, reason: /^unknown_kind: null$/ },
  { name: 'invented kind', file: 'r-kind', body: { kind: 'explode', intent_id: 'r-kind' }, reason: /^unknown_kind: "explode"$/ },
  { name: 'identity that disagrees with the filename', file: 'r-mismatch', body: { kind: 'pause', intent_id: 'somewhere-else' }, reason: /^intent_id_mismatch: / },
  { name: 'identity that is a path', file: 'r-path', body: { kind: 'pause', intent_id: '../../escape' }, reason: /^invalid_intent_id: "..\/..\/escape"$/ },
  { name: 'a held proposal with no deadline', file: 'r-hold', body: { kind: 'proposal', intent_id: 'r-hold', candidate_id: 'c9', hypothesis: 'x', requires_approval: true }, reason: /^hold_without_deadline$/ },
  { name: 'a deadline on a proposal nobody has to approve', file: 'r-deadline', body: { kind: 'proposal', intent_id: 'r-deadline', candidate_id: 'c9', hypothesis: 'x', deadline_ms: AT + 1000 }, reason: /^deadline_without_hold$/ },
  { name: 'a proposal with no hypothesis', file: 'r-hypo', body: { kind: 'proposal', intent_id: 'r-hypo', candidate_id: 'c9' }, reason: /^missing_hypothesis$/ },
  { name: 'a negative grant', file: 'r-neg', body: { kind: 'grant', intent_id: 'r-neg', additional_gpu_hours: -1 }, reason: /^invalid_additional_gpu_hours: -1$/ },
  { name: 'a grant of `true` (a boolean is not an hour)', file: 'r-bool', body: { kind: 'grant', intent_id: 'r-bool', additional_gpu_hours: true }, reason: /^invalid_additional_gpu_hours: true$/ },
  { name: 'a grant of nothing', file: 'r-empty', body: { kind: 'grant', intent_id: 'r-empty' }, reason: /^nothing_to_grant$/ },
  { name: 'a grant with a field nobody implements', file: 'r-typo', body: { kind: 'grant', intent_id: 'r-typo', additional_gpu_hours: 1, autoapply: true }, reason: /^unknown_field: grant\.autoapply$/ },
  { name: 'an anchor to a candidate that never existed', file: 'r-ghost', body: { kind: 'anchor', intent_id: 'r-ghost', candidate_id: 'ghost', commit: 'abcdef1' }, reason: /^unknown_candidate: ghost$/ },
  { name: 'an anchor whose commit is not a commit', file: 'r-sha', body: { kind: 'anchor', intent_id: 'r-sha', candidate_id: 'c1', commit: 'nope' }, reason: /^invalid_commit: "nope"$/ },
  { name: 'a resume when nothing is paused', file: 'r-resume', body: { kind: 'resume', intent_id: 'r-resume' }, reason: /^not_paused: nothing to resume$/ },
  { name: 'an approval of something unknown', file: 'r-approve', body: { kind: 'approval', intent_id: 'r-approve', target: 'nope', decision: 'approve' }, reason: /^unknown_target: nope$/ },
  { name: 'an unknown decision', file: 'r-decision', body: { kind: 'approval', intent_id: 'r-decision', target: 'nope', decision: 'maybe' }, reason: /^invalid_decision: "maybe"$/ },
  { name: 'a grant on an unlimited budget', file: 'r-unlimited', body: { kind: 'grant', intent_id: 'r-unlimited', additional_gpu_hours: 5 }, reason: /^budget_unlimited: / },
  { name: 'an anchor to a candidate that is not done', file: 'r-notdone', body: { kind: 'anchor', intent_id: 'r-notdone', candidate_id: 'c1', commit: 'abcdef1' }, reason: /^candidate_not_done: c1 is LAND$/ },
  { name: 'a pause while already paused', file: 'r-paused', body: { kind: 'pause', intent_id: 'r-paused' }, reason: /^already_paused: / },
]

test('every wrong intent is refused, changes nothing, and says what is wrong', async () => {
  for (const row of REFUSALS) {
    // A *manual* pause, because an automatic one whose cause is gone clears itself on the same
    // tick — and then the state would move for a reason that has nothing to do with this intent.
    const paused = row.file === 'r-paused' ? { reason: 'cluster maintenance', automatic: false, at_ms: AT } : null
    const { dir, store, clock, ports } = setup()
    store.setState(undefined, 'workspace', { paused, started_at_ms: AT, budget: { gpu_hours_limit: 0 } })
    // c1 is mid-flight, so "anchor to a candidate that is not done" has something to refuse.
    createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the table' })

    const body = typeof row.body === 'string' ? row.body : JSON.stringify(row.body)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', `${row.file}.json`), body)

    const before = JSON.stringify(store.getState(undefined, 'workspace'))
    const totalsBefore = JSON.stringify(store.totals())

    await tick(ports)

    const receipt = JSON.parse(readFileSync(join(dir, 'intents', 'refused', `${row.file}.json`), 'utf8'))
    assert.match(receipt.reason, row.reason, `${row.name}: the receipt must say why`)
    assert.equal(receipt.outcome, 'refused')

    const [event] = events(store, 'intent_refused').filter((entry) => entry.payload.intent_id === row.file)
    assert.ok(event !== undefined, `${row.name}: a refusal is an event, not a silent skip`)
    assert.equal(event.payload.reason, receipt.reason)
    assert.equal(event.payload.kind, receipt.kind)

    assert.equal(JSON.stringify(store.getState(undefined, 'workspace')), before, `${row.name}: workspace state must not move`)
    assert.equal(JSON.stringify(store.totals()), totalsBefore, `${row.name}: the ledger must not move`)
    assert.deepEqual(pendingFiles(dir), [], `${row.name}: a refused intent is consumed, not retried forever`)
    store.close()
  }
})

test('a replayed placement of an applied intent cannot apply it twice', async () => {
  const { dir, store, clock, ports } = setup({ config: { budget: { gpu_hours_limit: 1 } } })
  placeIntent(dir, { kind: 'grant', intent_id: 'g-once', additional_gpu_hours: 1 }, { now: clock.now() })
  await tick(ports)

  // Byte-for-byte the same file again, and then a *different* file claiming the same identity:
  // both are the same mistake — an identity that was already spent.
  placeIntent(dir, { kind: 'grant', intent_id: 'g-once', additional_gpu_hours: 1 }, { now: clock.now() })
  placeIntent(dir, { kind: 'grant', intent_id: 'g-once', additional_gpu_hours: 99 }, { now: clock.now() })
  await tick(ports)

  assert.equal(store.getState(undefined, 'workspace').budget.gpu_hours_limit, 2, 'one grant of one hour')
  const applied = events(store, 'intent_applied')
  assert.equal(applied.length, 1)
  const duplicates = events(store, 'intent_refused')
  assert.equal(duplicates.length, 1, 'the duplicate is refused once, not once per tick')
  assert.equal(duplicates[0].payload.reason, 'already_consumed')
  assert.equal(duplicates[0].payload.existing_outcome, 'applied')
  store.close()
})

// ------------------------------------------------- pause and resume, two kinds

test('a pause marker stops the run in that same tick, and only a human clears it', async () => {
  const { dir, store, clock, ports } = setup({ config: { budget: { gpu_hours_limit: 100 } } })
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the table' })

  placeIntent(dir, { kind: 'pause', intent_id: 'p-1', reason: 'reviewing metrics' }, { now: clock.now() })

  const { paused } = await tick(ports)
  assert.equal(paused.reason, 'reviewing metrics')
  assert.equal(paused.automatic, false, 'a pause typed by a person is never automatic')
  assert.equal(store.getState('c1', 'phase').phase, 'LAND', 'the pause is consumed before any phase work')

  // Money is not the cause, so money cannot fix it — this is the whole difference between the two
  // kinds of pause, expressed as an observable: the grant lands, the pause stays.
  placeIntent(dir, { kind: 'grant', intent_id: 'g-1', additional_gpu_hours: 10 }, { now: clock.now() })
  clock.advance(1_000)
  const afterGrant = await tick(ports)
  assert.equal(afterGrant.paused.reason, 'reviewing metrics', 'a grant must not resurrect a run a human stopped')
  assert.equal(store.getState(undefined, 'workspace').budget.gpu_hours_limit, 110, 'the grant still applied')
  assert.equal(store.getState('c1', 'phase').phase, 'LAND', 'and no work happened while paused')

  placeIntent(dir, { kind: 'resume', intent_id: 'r-1' }, { now: clock.now() })
  clock.advance(1_000)
  const resumed = await tick(ports)
  assert.equal(resumed.paused, null)
  assert.equal(store.getState(undefined, 'workspace').resumed_at_ms, AT + 2_000)
  assert.equal(store.getState('c1', 'phase').phase, 'BUILD', 'the run picks up where it stood')

  const receipt = JSON.parse(readFileSync(join(dir, 'intents', 'applied', 'r-1.json'), 'utf8'))
  assert.equal(receipt.intent.kind, 'resume')
  assert.equal(receipt.was.reason, 'reviewing metrics', 'the receipt remembers which pause it lifted')
  store.close()
})

test('an automatic pause says so, keeps the run stopped, and clears when the grant removes the cause', async () => {
  const { dir, store, clock, ports } = setup({ config: { budget: { gpu_hours_limit: 1, soft_ratio: 0.8 } } })
  store.reserve('c1', 1, clock.now())

  const first = await tick(ports)
  assert.equal(first.paused.automatic, true)
  assert.equal(first.paused.reason, 'budget_exhausted')
  assert.deepEqual(eventTypesOf(store, 'workspace'), [], 'the pause is ticket 05 code, not an intent')

  // Two ticks with nobody answering: an automatic pause is a standing verdict, not a spin.
  clock.advance(1_000)
  assert.equal((await tick(ports)).paused.reason, 'budget_exhausted')

  placeIntent(dir, { kind: 'grant', intent_id: 'g-1', additional_gpu_hours: 2 }, { now: clock.now() })
  clock.advance(1_000)
  const cleared = await tick(ports)
  assert.equal(cleared.paused, null, 'the cause is gone, so the pause is gone — no restart, no human')
  const [applied] = events(store, 'intent_applied')
  assert.equal(applied.payload.intent_id, 'g-1')
  store.close()
})

test('a resume arrives with force: it can lift a manual pause, and says which one', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(dir, { kind: 'pause', intent_id: 'p-1', reason: 'checking something' }, { now: clock.now() })
  await tick(ports)
  assert.equal(store.getState(undefined, 'workspace').paused.automatic, false)

  placeIntent(dir, { kind: 'resume', intent_id: 'r-1' }, { now: clock.now() })
  clock.advance(1_000)
  await tick(ports)
  const workspace = store.getState(undefined, 'workspace')
  assert.equal(workspace.paused, null)
  assert.equal(workspace.resumed_at_ms, AT + 1_000)

  // The resume is itself a consumed intent, so it has its own receipt and event.
  assert.deepEqual(records(dir, 'applied').sort(), ['p-1.json', 'r-1.json'])
  assert.equal(events(store, 'intent_applied').length, 2)
  store.close()
})

// ------------------------------------------- nothing waits for a human forever

/** Tick until `c1` is terminal, finishing its job on each pass — a stand-in for an unattended night. */
async function drive(ports, { maxTicks = 30 } = {}) {
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await tick(ports)
    if (result.paused !== null) return result
    for (const job of ports.platform.jobs.values()) if (job.state === 'running') Object.assign(job, { state: 'succeeded', metrics: { auc: 0.72 } })
    const phase = ports.store.getState('c1', 'phase')?.phase
    if (phase === 'DONE' || phase === 'REJECTED') return result
    ports.clock.advance(10_000)
  }
  return undefined
}

test('a held proposal does not stop the run: the night continues while nobody answers', async () => {
  const { dir, store, clock, ports } = setup()
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the table' })
  placeIntent(
    dir,
    { kind: 'proposal', intent_id: 'pr-1', candidate_id: 'c9', hypothesis: 'try a wider table', requires_approval: true, deadline_ms: AT + 30 * 60_000, on_timeout: 'refuse' },
    { now: clock.now() },
  )

  await drive(ports)

  assert.equal(store.getState('c1', 'phase').phase, 'DONE', 'the held proposal never blocks the candidate')
  assert.equal(store.getState('c9', 'phase'), undefined, 'and it was not applied either')
  assert.deepEqual(pendingFiles(dir), ['pr-1.json'], 'it is still waiting, not silently dropped')
  assert.deepEqual(events(store), [], 'nobody was asked, so nothing was decided')
  store.close()
})

test('nobody answers: the deadline applies the predetermined answer and says so, not "approved"', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(
    dir,
    { kind: 'proposal', intent_id: 'pr-2', candidate_id: 'c9', hypothesis: 'try a wider table', requires_approval: true, deadline_ms: AT + 60_000 },
    { now: clock.now() },
  )

  // Inside the deadline it is inert.
  await tick(ports)
  assert.deepEqual(pendingFiles(dir), ['pr-2.json'])
  assert.deepEqual(events(store), [])
  const waiting = listIntents(dir, { now: AT }).pending[0]
  assert.equal(waiting.held, true)
  assert.equal(waiting.deadline_ms, AT + 60_000)

  // The deadline passes with no answer, and the default (refuse) applies by itself.
  clock.advance(60_000)
  await tick(ports)

  const receipt = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'pr-2.json'), 'utf8'))
  assert.match(receipt.reason, /^approval_timeout: no approval before /)
  const [event] = events(store, 'intent_refused')
  assert.equal(event.payload.intent_id, 'pr-2')
  assert.equal(event.payload.fallback, true, 'the event must say fallback, not approval')
  assert.equal(event.payload.decision_source, 'timeout')
  assert.deepEqual(pendingFiles(dir), [], 'the fallback consumed it once')
  assert.equal(store.getState('c9', 'phase'), undefined, 'the default is the safe one')

  // And the run is still alive: another tick changes nothing but does not hang either.
  clock.advance(10_000)
  const after = await tick(ports)
  assert.equal(after.paused, null)
  assert.equal(events(store, 'intent_refused').length, 1, 'the fallback is decided once, not every tick')
  store.close()
})

test('nobody answers, but the proposal declares "apply": the run adopts it and the event says fallback', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(
    dir,
    { kind: 'proposal', intent_id: 'pr-3', candidate_id: 'c9', hypothesis: 'wider table', requires_approval: true, deadline_ms: AT + 60_000, on_timeout: 'apply' },
    { now: clock.now() },
  )

  await tick(ports)
  assert.equal(store.getState('c9', 'phase'), undefined)

  clock.advance(60_000)
  await tick(ports)

  // Created by the fallback and advanced one step inside the same tick.
  assert.equal(store.getState('c9', 'phase').phase, 'BUILD', 'the candidate exists')
  assert.equal(store.eventsFor('c9')[0].event_type, 'candidate_created')
  const receipt = JSON.parse(readFileSync(join(dir, 'intents', 'applied', 'pr-3.json'), 'utf8'))
  assert.equal(receipt.decision_source, 'timeout')
  assert.equal(receipt.fallback, true)
  const [event] = events(store, 'intent_applied')
  assert.equal(event.payload.fallback, true)
  assert.equal(event.payload.decision_source, 'timeout', 'a timeout is never reported as a human decision')
  store.close()
})

test('a human answers inside the deadline: that decision is the one that counts', async () => {
  const { dir, store, clock, ports } = setup()
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the table' })
  placeIntent(
    dir,
    { kind: 'proposal', intent_id: 'pr-4', candidate_id: 'c9', hypothesis: 'wider table', requires_approval: true, deadline_ms: AT + 600_000, on_timeout: 'apply' },
    { now: clock.now() },
  )
  await tick(ports)
  assert.equal(store.getState('c9', 'phase'), undefined)

  placeIntent(dir, { kind: 'approval', intent_id: 'ap-4', target: 'pr-4', decision: 'approve' }, { now: clock.now() })
  clock.advance(1_000)
  await tick(ports)

  assert.equal(store.getState('c9', 'phase').phase, 'BUILD', 'the approval created the candidate')
  assert.equal(store.eventsFor('c9')[0].event_type, 'candidate_created')
  const proposalReceipt = JSON.parse(readFileSync(join(dir, 'intents', 'applied', 'pr-4.json'), 'utf8'))
  assert.equal(proposalReceipt.decision_source, 'human')
  assert.equal(proposalReceipt.fallback, false)
  assert.equal(proposalReceipt.approval_intent_id, 'ap-4')
  assert.ok(existsSyncJoin(dir, 'intents', 'applied', 'ap-4.json'), 'the approval is a consumed intent in its own right')
  assert.deepEqual(pendingFiles(dir), [])
  await drive(ports)
  store.close()
})

test('a human refusal inside the deadline refuses the proposal, and nothing is created', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(
    dir,
    { kind: 'proposal', intent_id: 'pr-5', candidate_id: 'c9', hypothesis: 'wider table', requires_approval: true, deadline_ms: AT + 600_000 },
    { now: clock.now() },
  )
  await tick(ports)
  placeIntent(dir, { kind: 'approval', intent_id: 'ap-5', target: 'pr-5', decision: 'refuse' }, { now: clock.now() })
  clock.advance(1_000)
  await tick(ports)

  assert.equal(store.getState('c9', 'phase'), undefined)
  const receipt = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'pr-5.json'), 'utf8'))
  assert.equal(receipt.reason, 'refused_by_human')
  const [event] = events(store, 'intent_refused')
  assert.equal(event.payload.fallback, false, 'a human said no; that is not a fallback')
  assert.equal(events(store, 'intent_applied').filter((entry) => entry.payload.intent_id === 'ap-5').length, 1)
  store.close()
})

test('an approval that arrives after the deadline is refused: the fallback already decided', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(
    dir,
    { kind: 'proposal', intent_id: 'pr-6', candidate_id: 'c9', hypothesis: 'wider table', requires_approval: true, deadline_ms: AT + 60_000 },
    { now: clock.now() },
  )
  await tick(ports)

  clock.advance(120_000)
  placeIntent(dir, { kind: 'approval', intent_id: 'ap-6', target: 'pr-6', decision: 'approve' }, { now: clock.now() })
  await tick(ports)

  const approval = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'ap-6.json'), 'utf8'))
  assert.match(approval.reason, /^target_expired: pr-6 passed its deadline at /)
  assert.equal(store.getState('c9', 'phase'), undefined, 'a late approval does not resurrect the proposal')
  const proposal = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'pr-6.json'), 'utf8'))
  assert.match(proposal.reason, /^approval_timeout: /)
  store.close()
})

test('the default proposal needs no approval: it is adopted by the next tick', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(dir, { kind: 'proposal', intent_id: 'pr-7', candidate_id: 'c9', hypothesis: 'wider table', round: 2 }, { now: clock.now() })
  await tick(ports)

  const state = store.getState('c9', 'phase')
  assert.equal(state.phase, 'BUILD', 'created and advanced in the same tick')
  assert.equal(state.round, 2)
  const [created] = store.eventsFor('c9')
  assert.equal(created.event_type, 'candidate_created')
  assert.equal(created.payload.hypothesis, 'wider table')
  store.close()
})

// ------------------------------------------------ anchor, experience, and the rest

/** Walk one candidate to DONE so an anchor has something finished to point at. */
async function doneCandidate(ports) {
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the table' })
  await drive(ports)
  assert.equal(ports.store.getState('c1', 'phase').phase, 'DONE')
}

test('a code-base anchor moves the base ref forward, and only to a finished candidate', async () => {
  const { dir, store, clock, ports } = setup()
  await doneCandidate(ports)

  placeIntent(dir, { kind: 'anchor', intent_id: 'a-1', candidate_id: 'c1', commit: 'abcdef1234' }, { now: clock.now() })
  clock.advance(1_000)
  await tick(ports)

  const workspace = store.getState(undefined, 'workspace')
  assert.deepEqual(workspace.code_base_anchor, { candidate_id: 'c1', commit: 'abcdef1234', intent_id: 'a-1' })
  assert.equal(events(store, 'intent_applied')[0].payload.candidate_id, 'c1')
  assert.equal(events(store, 'intent_applied')[0].payload.commit, 'abcdef1234')
  assert.deepEqual(records(dir, 'applied'), ['a-1.json'])
  store.close()
})

test('a promoted experience is a file the injection packet can read, and it is promoted once', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(
    dir,
    { kind: 'experience', intent_id: 'e-1', experience_id: 'exp-warmup', text: 'a warmup of one epoch prevents the loss spike', section: 'singletons' },
    { now: clock.now() },
  )
  await tick(ports)

  const artifact = JSON.parse(readFileSync(join(dir, 'experiences', 'exp-warmup.json'), 'utf8'))
  assert.equal(artifact.experience_id, 'exp-warmup')
  assert.equal(artifact.section, 'singletons')
  assert.equal(artifact.intent_id, 'e-1')
  assert.deepEqual(
    store.getState(undefined, 'workspace').experiences.map((entry) => entry.experience_id),
    ['exp-warmup'],
  )

  // The same experience under a *different* intent id is still the same experience: promoting it
  // twice would double-count it in every future injection.
  placeIntent(dir, { kind: 'experience', intent_id: 'e-2', experience_id: 'exp-warmup', text: 'again' }, { now: clock.now() })
  clock.advance(1_000)
  await tick(ports)

  assert.equal(store.getState(undefined, 'workspace').experiences.length, 1)
  const refused = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'e-2.json'), 'utf8'))
  assert.match(refused.reason, /^already_promoted: exp-warmup$/)
  store.close()
})

test('an approval of a proposal that never asked for one is refused, not silently applied', async () => {
  const { dir, store, clock, ports } = setup()
  placeIntent(dir, { kind: 'proposal', intent_id: 'pr-8', candidate_id: 'c9', hypothesis: 'wider table' }, { now: clock.now() })
  placeIntent(dir, { kind: 'approval', intent_id: 'ap-8', target: 'pr-8', decision: 'approve' }, { now: clock.now() })
  await tick(ports)

  const refused = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'ap-8.json'), 'utf8'))
  assert.match(refused.reason, /^target_not_held: pr-8 /)
  // The proposal itself was applied on its own terms — the refused approval changed nothing.
  assert.equal(store.getState('c9', 'phase').phase, 'BUILD')
  store.close()
})

test('a proposal that duplicates a live candidate is refused as over-reaching', async () => {
  const { dir, store, clock, ports } = setup()
  createCandidate(ports, { candidateId: 'c1', round: 1, hypothesis: 'widen the table' })
  placeIntent(dir, { kind: 'proposal', intent_id: 'pr-9', candidate_id: 'c1', hypothesis: 'the same idea again' }, { now: clock.now() })
  await tick(ports)

  const refused = JSON.parse(readFileSync(join(dir, 'intents', 'refused', 'pr-9.json'), 'utf8'))
  assert.equal(refused.reason, 'candidate_exists: c1')
  assert.deepEqual(
    store.eventsFor('c1').filter((event) => event.event_type === 'candidate_created').length,
    1,
    'one candidate, one creation',
  )
  store.close()
})

test('the CLI can place every kind of intent by hand', () => {
  const { dir, store, clock } = setup()
  const cases = [
    ['cli-proposal', ['proposal', '--candidate-id', 'c9', '--hypothesis', 'wider table'], (intent) => intent.candidate_id === 'c9'],
    [
      'cli-hold',
      ['proposal', '--candidate-id', 'c8', '--hypothesis', 'x', '--requires-approval', '--ttl-ms', '60000', '--on-timeout', 'apply'],
      (intent) => intent.deadline_ms === AT + 60_000 && intent.on_timeout === 'apply',
    ],
    ['cli-grant', ['grant', '--additional-gpu-hours', '2'], (intent) => intent.additional_gpu_hours === 2],
    ['cli-anchor', ['anchor', '--candidate-id', 'c1', '--commit', 'abcdef1'], (intent) => intent.commit === 'abcdef1'],
    ['cli-pause', ['pause', '--reason', 'maintenance'], (intent) => intent.reason === 'maintenance'],
    ['cli-resume', ['resume'], (intent) => intent.kind === 'resume'],
    ['cli-approval', ['approval', '--target', 'pr-1', '--decision', 'approve'], (intent) => intent.decision === 'approve'],
    ['cli-experience', ['experience', '--experience-id', 'exp-1', '--text', 'warm up first', '--section', 'recipes'], (intent) => intent.section === 'recipes'],
  ]
  for (const [id, args, check] of cases) {
    const output = execFileSync(process.execPath, [CLI, 'place', ...args, '--id', id, '--workspace', dir, '--now', String(clock.now())], {
      encoding: 'utf8',
    })
    assert.equal(output.trim(), `placed ${args[0]} ${id} in ${id}.json`)
    assert.ok(check(JSON.parse(readFileSync(join(dir, 'pending', `${id}.json`), 'utf8'))), `${id} wrote what it was told`)
  }

  // Without --id the writer must not let two intents share one identity: that would lose an intent
  // silently, which is precisely the failure mode pending files exist to prevent.
  for (let index = 0; index < 2; index += 1) {
    execFileSync(process.execPath, [CLI, 'place', 'pause', '--workspace', dir, '--now', String(clock.now())], { encoding: 'utf8' })
  }
  const generated = pendingFiles(dir).filter((name) => name.startsWith('pause-'))
  assert.equal(generated.length, 2, 'two placements, two files')
  assert.equal(new Set(pendingFiles(dir)).size, cases.length + 2)
  store.close()
})
