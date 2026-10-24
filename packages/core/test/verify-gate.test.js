/**
 * Gate two at the phase-machine seam: two pieces of evidence, one routing decision.
 *
 * The ticket behind this file asks for five things, and each one is a test below:
 *
 * 1. **The static report is the kernel's.** Syntax, the adjustable-surface whitelist and residual
 *    conflict markers are read off the candidate's worktree by code (`gate.js`). The model never sees
 *    a check it can write; it sees the report as evidence.
 * 2. **The adversarial review must land as accept / reject.** An answer that does not parse is a
 *    failure, not an abstention — an unverified candidate that advances spends a GPU hour to learn
 *    nothing.
 * 3. **The two contradicting each other is `conflict`, not `invalid`.** The review accepting over a
 *    failed check is the fact plane disagreeing with itself, and neither opinion wins.
 * 4. **A failed attempt is not a permanent death.** Every attempt is a numbered, recomputable record;
 *    a plain "no" is retried on a backoff and only exhausting the attempt budget rejects the
 *    candidate. (The predecessor wrote the gate once and rejected on any disagreement; that is
 *    precisely the behaviour this ticket does not inherit.)
 * 5. **Only a gate that passed reaches `SUBMIT_QUEUED`.**
 *
 * The four states stay honest throughout: `invalid` is an artifact that exists and breaks its schema,
 * `conflict` is two facts that must agree and do not, and a candidate that simply failed its gate is
 * rejected with a message and **no four-state status at all**.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { fileArtifacts, memoryArtifacts } from '../lib/artifacts.js'
import { tick } from '../lib/loop.js'
import { Store } from '../lib/store.js'
import { FEED_PROMPTS_DIR, judgeFor } from './support/domain.js'
import { FakeClock, fakePlatform } from './support/fake-ports.js'

const AT = 1_761_091_200_000

const SURFACE = { files: ['model/structure.json'] }

/** A candidate worktree holding exactly the files the harness claims it changed. */
function worktree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-verify-gate-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content, 'utf8')
  }
  return dir
}

/** A harness that lands the given files, the way `landWithCli` reports git's answer. */
const harnessFor = (files) => ({
  land: ({ candidateId }) => ({
    ok: true,
    engine: 'fake-harness',
    parent_id: 'baseline-0',
    parent_commit: 'aaa1111',
    files,
    files_changed: files.length,
    candidateId,
  }),
})

/** A model port that answers the review from a script, one answer per call. */
function reviewScript(answers) {
  const calls = []
  const model = async (request) => {
    calls.push(request)
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(request) : next
  }
  return { model, calls }
}

function setup({ files = { 'model/structure.json': '{"hidden_units": 64}\n' }, answers, gate, artifacts } = {}) {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-verify-gate-store-')))
  const clock = new FakeClock()
  const dir = worktree(files)
  const stored = artifacts ?? memoryArtifacts()
  const script = reviewScript(
    answers ?? [{ verdict: 'accept', rationale: 'only the knob moved', concerns: [] }],
  )
  const judge = judgeFor({
    model: script.model,
    surface: SURFACE,
    artifacts: stored,
  })
  const config = { gate: { base_ms: 1_000, max_ms: 8_000, max_attempts: 3, ...(gate ?? {}) } }
  const ports = {
    store,
    clock,
    platform: fakePlatform(),
    harness: harnessFor(Object.keys(files)),
    judge,
    artifacts: stored,
    config,
  }
  store.setState('c1', 'phase', {
    phase: 'LAND',
    round: 1,
    hypothesis: 'widen the embedding table to 2^22',
    worktree_dir: dir,
  })
  return { ports, store, clock, dir, model: script, artifacts: stored }
}

/** Tick until the candidate reaches one of these phases (or the budget runs out). */
async function tickUntil(ports, phases, { maxTicks = 12 } = {}) {
  for (let index = 0; index < maxTicks; index += 1) {
    const phase = ports.store.getState('c1', 'phase')?.phase
    if (phases.includes(phase)) return phase
    await tick(ports)
    ports.clock.advance(10_000)
  }
  return ports.store.getState('c1', 'phase')?.phase
}

/** The message a rejection recorded, whichever field the event shape uses. */
const rejectionMessage = (store) => {
  const payload = store.eventsFor('c1').at(-1).payload
  return payload.blocking_message ?? payload.reject_reason ?? payload.message ?? ''
}

/** Tick n times, advancing the clock between ticks so a backoff actually elapses. */
async function steps(ports, count, { advanceMs = 10_000 } = {}) {
  const actions = []
  for (let index = 0; index < count; index += 1) {
    const result = await tick(ports)
    actions.push(...result.actions)
    ports.clock.advance(advanceMs)
  }
  return actions
}

const gateEvents = (store) => store.eventsFor('c1').filter((event) => event.event_type === 'gate_result')

// ------------------------------------------------------- the gate's evidence

test('a candidate whose evidence agrees reaches SUBMIT_QUEUED — the only way in', async () => {
  const { ports, store } = setup()
  await steps(ports, 3)

  assert.equal(store.getState('c1', 'phase').phase, 'SUBMIT_QUEUED')
  const gate = store.binding('c1', 'verify_gate')
  assert.equal(gate.passed, true)
  assert.equal(gate.attempt, 1, 'the binding names which attempt passed')
  assert.equal(gate.record, 'verify_verdict:c1:a1', 'and the record a reader has to recompute')
  assert.equal(gate.checks, 6, 'the three metadata checks and the three static ones')
  assert.equal(ports.platform.size, 0, 'the gate routed to the queue, and nothing was submitted yet')
  store.close()
})

test('a static check the model overlooked stops the candidate before it reaches the queue', async () => {
  const { ports, store, model } = setup({
    files: {
      'model/structure.json': '<<<<<<< HEAD\n{"hidden_units": 64}\n=======\n{"hidden_units": 32}\n>>>>>>> other\n',
    },
    answers: [{ verdict: 'accept', rationale: 'looks fine to me' }],
  })
  await steps(ports, 3)

  const state = store.getState('c1', 'phase')
  assert.equal(state.phase, 'REJECTED')
  const rejection = store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, 'conflict', 'the review passed what a check refused — not invalid, not a pass')
  assert.match(rejectionMessage(store), /conflict_markers|accepted while/)
  assert.equal(ports.platform.size, 0)
  // The review was handed the kernel's report: it had the fact and passed anyway, which is exactly
  // the disagreement a human needs to see.
  assert.equal(model.calls[0].facts.static_report.checks.find((check) => check.name === 'conflict_markers').result, 'fail')
  store.close()
})

test('an out-of-bounds change is refused by the whitelist, and the review cannot overrule it', async () => {
  const { ports, store } = setup({
    files: { 'model/structure.json': '{"hidden_units": 64}\n', 'eval/split.py': 'print("moved the split")\n' },
    answers: [{ verdict: 'accept', rationale: 'minimal diff' }],
  })
  await steps(ports, 3)

  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  assert.equal(store.eventsFor('c1').at(-1).payload.status, 'conflict')
  assert.equal(store.bindings('c1').verify_gate, undefined, 'no gate was frozen for a candidate that never passed one')
  store.close()
})

test('a broken diff — a file that does not parse — fails the syntax check', async () => {
  const { ports, store } = setup({
    files: { 'model/structure.json': '{"hidden_units": 64,' },
    answers: [{ verdict: 'accept', rationale: 'the numbers look fine' }],
  })
  await steps(ports, 3)

  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  const rejection = store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, 'conflict')
  assert.match(rejectionMessage(store), /syntax/)
  store.close()
})

test('the model cannot contribute a check, only the review: an invented check list is ignored', async () => {
  const { ports, store } = setup({
    files: { 'model/structure.json': '{"hidden_units": 64,' },
    answers: [{ verdict: 'accept', rationale: 'all good', checks: [{ name: 'syntax', result: 'pass' }] }],
  })
  await steps(ports, 3)

  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  const record = ports.store.eventsFor('c1').at(-1).payload
  assert.equal(record.status, 'conflict', 'the kernel\'s syntax check said fail, and the model\'s claim changed nothing')
  store.close()
})

// ------------------------------------------------- the review's own failures

test('a review that does not answer accept or reject is a failure, and one failure is not a death', async () => {
  const { ports, store } = setup({
    // An answer that is structured but is not the enum the gate consumes. (A port that returns no
    // object at all is a different event — a model outage — and is covered by test/model-failure.)
    answers: [{ verdict: 'probably fine', rationale: 'I think it is fine, but I could not decide', score: 0.82 }],
    gate: { max_attempts: 2 },
  })
  await steps(ports, 3)

  const attempts = gateEvents(store)
  assert.equal(attempts.length, 1, 'the first attempt is recorded as a failed gate, not as a rejection')
  assert.equal(attempts[0].payload.status, 'fail', 'an unparseable review is a plain failure — nothing was malformed')
  assert.equal(attempts[0].payload.attempt, 1)
  assert.match(attempts[0].payload.message, /did not pass/i)

  // The candidate is still alive after the first attempt, and only the attempt budget ends it.
  assert.equal(store.getState('c1', 'phase').phase, 'VERIFY')
  await steps(ports, 2)
  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  const rejection = store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, undefined, 'the attempt budget ran out: not a malformed artifact, not a contradiction')
  assert.match(rejection.payload.reject_reason, /did not pass/)
  assert.equal(rejection.payload.attempts, 2)
  assert.equal(ports.platform.size, 0)
  store.close()
})

test('a failed attempt stops being permanent: the second attempt can pass and reach the queue', async () => {
  const { ports, store, artifacts } = setup({
    answers: [
      { verdict: 'reject', rationale: 'it also changes the evaluation split' },
      { verdict: 'accept', rationale: 'only the knob moved' },
    ],
  })

  await steps(ports, 3)
  assert.equal(store.getState('c1', 'phase').phase, 'VERIFY', 'one rejection does not kill the candidate')
  assert.equal(gateEvents(store)[0].payload.status, 'fail')

  assert.equal(await tickUntil(ports, ['SUBMIT_QUEUED']), 'SUBMIT_QUEUED', 'the retry entered VERIFY again and the gate passed')

  const records = gateEvents(store)
  assert.deepEqual(records.map((event) => event.payload.attempt), [1, 2], 'the records carry their place in the sequence')
  assert.equal(store.binding('c1', 'verify_gate').attempt, 2)

  assert.equal(artifacts.read('verify_verdict:c1:a1').attempt, 1, 'attempt 1 is still on disk, so it can be recomputed')
  assert.equal(artifacts.read('verify_verdict:c1:a1').passed, false)
  assert.equal(artifacts.read('verify_verdict:c1:a2').passed, true)
  store.close()
})

test('the attempt budget is the run\'s, not the kernel\'s: max_attempts 1 restores a single try', async () => {
  const { ports, store } = setup({
    answers: [{ verdict: 'reject', rationale: 'it also changes the evaluation split' }],
    gate: { max_attempts: 1 },
  })
  await steps(ports, 3)

  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  assert.equal(store.eventsFor('c1').at(-1).payload.status, undefined)
  store.close()
})

// ------------------------------------------------------------- recomputation

test('a record that no longer recomputes from its own evidence is a conflict, not a second try', async () => {
  const artifacts = memoryArtifacts()
  const { ports, store } = setup({
    files: { 'model/structure.json': '{"hidden_units": 64}\n' },
    answers: [{ verdict: 'reject', rationale: 'not convinced' }],
    artifacts,
  })

  // Attempt 1 rejects plainly, so the candidate stays in VERIFY and attempt 2 recomputes attempt 1.
  await steps(ports, 3)
  assert.equal(store.getState('c1', 'phase').phase, 'VERIFY')

  // Somebody rewrote the stored record so that it claims a check failed over bytes that pass. The
  // next attempt recomputes the previous record before asking for a new one, and refuses to build
  // on a record the fact plane cannot reproduce.
  const stored = artifacts.read('verify_verdict:c1:a1')
  artifacts.write('verify_verdict:c1:a1', {
    ...stored,
    checks: stored.checks.map((check) => (check.name === 'syntax' ? { ...check, result: 'fail' } : check)),
  })

  await steps(ports, 3)
  assert.equal(store.getState('c1', 'phase').phase, 'REJECTED')
  const rejection = store.eventsFor('c1').at(-1)
  assert.equal(rejection.payload.status, 'conflict', 'a deterministic check disagreed with itself')
  assert.match(rejectionMessage(store), /cannot be reproduced|syntax/)
  store.close()
})

test('a recheck of a tree that moved on is not a conflict — it is why the retry can pass', async () => {
  const artifacts = memoryArtifacts()
  const { ports, store, dir } = setup({
    files: { 'model/structure.json': '{"hidden_units": 64}\n' },
    answers: [
      { verdict: 'reject', rationale: 'the shape changed' },
      { verdict: 'accept', rationale: 'now it is only the knob' },
    ],
    artifacts,
  })

  await steps(ports, 3)
  writeFileSync(join(dir, 'model/structure.json'), '{"hidden_units": 128}\n', 'utf8')
  assert.equal(await tickUntil(ports, ['SUBMIT_QUEUED']), 'SUBMIT_QUEUED', 'a fixed tree passes on the next attempt')
  assert.equal(
    store.eventsFor('c1').some((event) => event.payload?.status === 'conflict'),
    false,
    'a tree that moved on is stale, not contradictory — nothing was flagged for a human',
  )
  store.close()
})

test('a crash that loses the state row still leaves the gate the diff and the tree to check', async () => {
  const { ports, store, dir } = setup()
  await steps(ports, 2) // LAND and BUILD: the facts are on disk, the state is about to be lost
  const { foldEvents } = await import('../lib/loop.js')
  store.setState('c1', 'phase', {})
  store.setAppliedSeq('c1', 0)

  foldEvents(store, 'c1')
  const rebuilt = store.getState('c1', 'phase')
  assert.deepEqual(rebuilt.files, ['model/structure.json'], 'the diff git reported is a fact, not state-only')
  assert.equal(rebuilt.worktree_dir, dir, 'and so is the tree the gate has to read')
  store.close()
})

test('every gate conclusion is on the timeline with its attempt, so a dump can say which try failed', async () => {
  const artifacts = fileArtifacts(mkdtempSync(join(tmpdir(), 'reprise-verify-gate-artifacts-')))
  const { ports, store } = setup({
    answers: [
      { verdict: 'reject', rationale: 'not convinced' },
      { verdict: 'accept', rationale: 'fine now' },
    ],
    artifacts,
  })
  await steps(ports, 5)

  const { renderDump } = await import('../lib/cli/dump.js')
  const output = renderDump(store, 'c1')
  assert.match(output, /gate_result/)
  assert.match(output, /attempt=1/)
  assert.match(output, /attempt=2/)
  assert.match(output, /verify_verdict:c1:a1/, 'the record a reader has to recompute is named')
  store.close()
})