/**
 * Guards the acceptance line for the whole fact-plane refactor (issue 06 AC 4, spec 测试决策 seam 3):
 *
 *   **someone who has never read this code can say why a candidate stopped, where it sits, and why
 *   the run ended — from `dump` output alone.**
 *
 * The assertions are on stdout and exit codes, not on function returns, because that is what an
 * operator actually has. `--rebuild` is tested for both outcomes: the check has to be able to fail,
 * otherwise it is decoration.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Store } from '../lib/store.js'
import { renderDump, runDump } from '../lib/cli/dump.js'
import { createCandidate, tick } from '../lib/loop.js'
import { fakeJudge, openWorkspace, runCandidate, seedConfig } from './support/fake-ports.js'

const CONTRACT = { metrics: { primary: 'auc', objectives: { auc: 'up' } } }

/** Every subject's highest sequence number: the cheap fingerprint of "did anything get written". */
const seqsOf = (store) => store.eventSubjects().map((id) => `${id}:${store.maxSeq(id)}`)

/** A finished run with one good candidate, one rejected candidate and a recorded stop reason. */
async function concludedWorkspace() {
  const ports = openWorkspace({ config: { ...CONTRACT, stop: { max_rounds: 1 } } })
  // A host records the run's configuration in the workspace, which is what makes the dump readable
  // without passing the config again later.
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7301 } })
  await runCandidate(ports, {
    candidateId: 'r1-c2',
    round: 1,
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({
        candidate_id: candidateId,
        passed: 'yes',
        checks: [],
        decided_at_ms: now,
      }),
    }),
  })
  const stopped = await tick(ports)
  assert.equal(stopped.stopped.rule, 'max_rounds', 'fixture precondition: the run must have a recorded stop reason')
  return { ports, dir: ports.store.path.replace(/\/workspace\.db$/, '') }
}

test('dump answers "why did the run end" with the rule that fired, and "where did this candidate sit"', async () => {
  const { ports, dir } = await concludedWorkspace()
  ports.store.close()

  const best = runDump(['--candidate', 'r1-c1', '--workspace', dir])
  assert.equal(best.code, 0)
  assert.match(best.output, /frontier position/, 'the reader must be able to see where the candidate sits')
  assert.match(best.output, /position {3}on the frontier, and the best result in the run/)
  assert.match(best.output, /vector {5}auc=0\.7301/, 'the number the comparison used, spelled out')
  assert.match(best.output, /best {7}r1-c1 auc=0\.7301 \(round 1\)/)
  assert.match(best.output, /workspace stop/, 'the run-level conclusion is a different question from the candidate one')
  assert.match(best.output, /rule {7}max_rounds/)
  assert.match(best.output, /reason {5}round 1 complete and nothing is in flight/)
  assert.match(best.output, /rules {6}max_rounds=1 fired/, 'the firing rule is marked, and the others are still shown — "why not that one" is answerable')
})

test('a rejected candidate says why in four-state terms and shows it was never ranked', async () => {
  const { ports, dir } = await concludedWorkspace()
  ports.store.close()

  const rejected = runDump(['--candidate', 'r1-c2', '--workspace', dir])

  assert.match(rejected.output, /why it stopped/)
  assert.match(rejected.output, /status {5}invalid/)
  assert.match(rejected.output, /strict boolean/, 'the failure原文, not a paraphrase')
  assert.match(rejected.output, /frontier position/, 'and the frontier answer belongs in the same "why" section')
  assert.match(
    rejected.output,
    /position {3}unranked — no auc recorded/,
    'a rejected candidate is unranked for a stated reason, not silently missing from the ranking',
  )
  assert.match(rejected.output, /best {7}r1-c1 auc=0\.7301/, 'the ranking it was excluded from is still shown')
})

test('an undecided workspace still reports the stop rules, so "why is it still running" is answerable', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, stop: { max_rounds: 2, max_no_improvement_rounds: 3 } } })
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  const dir = ports.store.path.replace(/\/workspace\.db$/, '')
  ports.store.close()

  const { output } = runDump(['--candidate', 'r1-c1', '--workspace', dir])

  assert.match(output, /workspace stop/)
  assert.match(output, /state {6}running \(1 round\(s\) complete/)
  assert.match(output, /max_no_improvement_rounds=3 enabled/, 'an enabled rule that has not fired is not the same as a disabled one')
})

test('--rebuild confirms that the incremental view still matches the facts', async () => {
  const { ports, dir } = await concludedWorkspace()
  ports.store.close()

  const { code, output } = runDump(['--workspace', dir, '--rebuild'])

  assert.equal(code, 0)
  assert.match(output, /verification \(full rebuild\)/)
  assert.match(output, /result {6}match/)
  assert.match(output, /best=r1-c1 auc=0\.7301/, 'both sides are named, so a reader can compare without trusting the verdict')
})

test('--rebuild fails loudly when a materialised row disagrees with the facts', async () => {
  const { ports, dir } = await concludedWorkspace()
  // A projection bug (or a profile change) left a row that no longer follows from the facts.
  const row = ports.store.getState('r1-c1', 'derived_frontier')
  ports.store.setState('r1-c1', 'derived_frontier', { ...row, metrics: { auc: 0.99 } })
  ports.store.close()

  const { code, output } = runDump(['--workspace', dir, '--rebuild'])

  assert.equal(code, 1, 'a check that cannot fail is not a check, so a mismatch must be a non-zero exit')
  assert.match(output, /result {6}MISMATCH/)
  assert.match(output, /r1-c1/, 'the row that disagrees is named')
  assert.match(output, /incremental {1}best=r1-c1 auc=0\.99/)
  assert.match(output, /rebuilt {5}best=r1-c1 auc=0\.7301/)
})

test('--rebuild combines with --candidate, so one command answers "why" and "can I trust it"', async () => {
  const { ports, dir } = await concludedWorkspace()
  ports.store.close()

  const { code, output } = runDump(['--candidate', 'r1-c1', '--workspace', dir, '--rebuild'])

  assert.equal(code, 0)
  assert.match(output, /why the workspace|workspace stop/)
  assert.match(output, /verification \(full rebuild\)/)
})

test('--rebuild never writes: a check must not be able to change the facts it checks', async () => {
  const { ports, dir } = await concludedWorkspace()
  const before = ports.store.maxSeq('r1-c1')
  const snapshot = seqsOf(ports.store)
  ports.store.close()

  runDump(['--workspace', dir, '--rebuild'])

  const reopened = Store.openReadOnly(dir)
  assert.deepEqual(seqsOf(reopened), snapshot, 'no event was appended by the verification command')
  assert.equal(reopened.maxSeq('r1-c1'), before)
  reopened.close()
})

test('--config lets an old workspace be read with the contract the run used', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, stop: { max_rounds: 0 } } })
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7301 } })
  const dir = ports.store.path.replace(/\/workspace\.db$/, '')
  // The workspace record predates the contract: nothing wrote it yet.
  ports.store.setState(undefined, 'workspace', { paused: null, started_at_ms: ports.clock.now() })
  ports.store.close()

  const withoutConfig = runDump(['--candidate', 'r1-c1', '--workspace', dir])
  assert.match(withoutConfig.output, /not computed \(missing\) — no metric contract/, 'the dump names the state, not only a sentence')

  const path = join(mkdtempSync(join(tmpdir(), 'reprise-config-')), 'config.json')
  writeFileSync(path, JSON.stringify(CONTRACT))
  const withConfig = runDump(['--candidate', 'r1-c1', '--workspace', dir, '--config', path])

  assert.match(withConfig.output, /vector {5}auc=0\.7301/, 'the same contract reproduces the same ranking on old facts')
})

test('the dump renderer is still a pure function of the facts, now including the derived view', async () => {
  const { ports, dir } = await concludedWorkspace()
  ports.store.close()

  const store = Store.openReadOnly(dir)
  const first = renderDump(store, 'r1-c1')
  const second = renderDump(store, 'r1-c1')
  store.close()

  assert.equal(first, second)
  assert.match(first, /frontier position/)
})

test('a candidate with a partial vector is listed as incomplete rather than missing', async () => {
  const ports = openWorkspace({ config: { ...CONTRACT, stop: { max_rounds: 0 } } })
  // A second objective the run never reported for this candidate.
  ports.config = { metrics: { primary: 'auc', objectives: { auc: 'up', loss: 'down' } }, stop: { max_rounds: 0 } }
  seedConfig(ports.store, ports.config)
  createCandidate(ports, { candidateId: 'r1-c1', round: 1, hypothesis: 'only auc is reported' })
  for (let index = 0; index < 12; index += 1) {
    await tick(ports)
    for (const job of ports.platform.jobs.values()) if (job.state === 'running') ports.platform.finish(job.job_id, { auc: 0.7 })
    ports.clock.advance(10_000)
  }
  const dir = ports.store.path.replace(/\/workspace\.db$/, '')
  ports.store.close()

  const { output } = runDump(['--candidate', 'r1-c1', '--workspace', dir])

  assert.match(output, /position {3}unranked — missing loss/, 'the missing objective is named, so the reader knows what to fix')
})
test('dump says which candidate this one was branched from, on the page a person reads', async () => {
  const ports = openWorkspace({ config: CONTRACT })
  seedConfig(ports.store, ports.config)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7301 } })
  // The round planner writes `parent_id` into the phase state when it creates a candidate from the
  // frontier. This is that write, without dragging the whole round workflow into a dump test.
  const phase = ports.store.getState('r1-c1', 'phase')
  ports.store.setState('r1-c1', 'phase', { ...phase, parent_id: 'baseline' })

  const output = renderDump(ports.store, 'r1-c1', { config: CONTRACT })

  assert.match(output, /parent +baseline — the candidate this one was branched from/, 'the criterion is "an operator can recover who this round started from": that means a rendered line')
  ports.store.close()
})
