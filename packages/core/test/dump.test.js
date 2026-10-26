import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { dirname } from 'node:path'

import { fileArtifacts } from '../lib/artifacts.js'
import { Store } from '../lib/store.js'
import { renderDump, runDump } from '../lib/cli/dump.js'
import { openWorkspace, runCandidate } from './support/fake-ports.js'

const AT = 1_761_091_200_000
const DUMP = fileURLToPath(new URL('../lib/cli/dump.js', import.meta.url))

/** A workspace whose candidate stopped at REJECTED, written through the store's public API only. */
function rejectedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-dump-'))
  const store = Store.open(dir)

  store.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT, event_type: 'candidate_created', payload: { round: 1 } })
  store.freezeBinding('c1', 'parent_binding', { parent_id: 'baseline-0' }, AT)
  store.appendEvent({ candidate_id: 'c1', wall_clock_ms: AT + 1000, event_type: 'land_done', payload: { engine: 'claude' } })
  store.appendEvent({
    candidate_id: 'c1',
    wall_clock_ms: AT + 2000,
    event_type: 'gate_result',
    payload: {
      phase: 'VERIFY',
      status: 'invalid',
      message: 'verify_gate.passed must be a strict boolean',
      artifact: 'artifacts/c1/verify_verdict.json',
    },
  })
  store.appendEvent({
    candidate_id: 'c1',
    wall_clock_ms: AT + 3000,
    event_type: 'candidate_rejected',
    payload: { phase: 'VERIFY', reject_reason: 'verify_gate.passed must be a strict boolean' },
  })
  // The state never caught up with the last event — the same lag a crash would leave.
  store.setState('c1', 'phase', { phase: 'REJECTED', round: 1 })
  store.setAppliedSeq('c1', 3)
  store.close()
  return dir
}

test('dump answers why a candidate stopped, without the reader knowing the code', () => {
  const dir = rejectedWorkspace()
  const { code, output } = runDump(['--candidate', 'c1', '--workspace', dir])
  assert.equal(code, 0)

  assert.match(output, /candidate {2}c1/)
  assert.match(output, /phase {6}REJECTED/)
  assert.match(output, /timeline/)
  for (const type of ['candidate_created', 'land_done', 'gate_result', 'candidate_rejected']) {
    assert.ok(output.includes(type), `the timeline must show ${type}`)
  }

  assert.match(output, /why it stopped/)
  assert.match(output, /status {5}invalid/, 'the four-state conclusion must be shown verbatim')
  assert.match(output, /verify_gate\.passed must be a strict boolean/, 'the blocking message in full')
  assert.match(output, /at phase {3}VERIFY/)
  assert.match(output, /artifacts\/c1\/verify_verdict\.json/, 'the artifact the verdict came from')
  assert.match(output, /identity bindings/, 'provenance is part of the answer')
  assert.match(output, /applied_seq 3 {2}\*\* 1 event\(s\) recorded but not folded into state \*\*/, 'a lagging state is called out')
})

test('dump never writes: it opens the fact plane read-only', () => {
  const dir = rejectedWorkspace()
  const before = Store.openReadOnly(dir)
  const seqBefore = before.maxSeq('c1')
  before.close()

  runDump(['--candidate', 'c1', '--workspace', dir])

  const after = Store.openReadOnly(dir)
  assert.equal(after.maxSeq('c1'), seqBefore)
  after.close()
})

test('an unknown candidate says so instead of printing an empty page', () => {
  const dir = rejectedWorkspace()
  const { code, output } = runDump(['--candidate', 'nobody', '--workspace', dir])
  assert.equal(code, 0)
  assert.match(output, /No facts recorded for "nobody"/)
})

test('a workspace with no candidate at all is a usage error, not a crash', () => {
  const { code, output } = runDump([])
  assert.equal(code, 2)
  assert.match(output, /usage: dump --candidate/)
})

test('the CLI is wired: the script itself prints the same dump', () => {
  const dir = rejectedWorkspace()
  const printed = execFileSync(process.execPath, [DUMP, '--candidate', 'c1', '--workspace', dir], {
    encoding: 'utf8',
  })
  assert.match(printed, /why it stopped/)
  assert.match(printed, /verify_gate\.passed must be a strict boolean/)
})

test('the renderer is a pure function of the facts', () => {
  const dir = rejectedWorkspace()
  const store = Store.openReadOnly(dir)
  const first = renderDump(store, 'c1')
  const second = renderDump(store, 'c1')
  store.close()
  assert.equal(first, second, 'same facts, same page — no clock and no randomness in the renderer')
})
test('a paused run says which kind of pause it is: one clears itself, one does not', () => {
  const dir = rejectedWorkspace()
  const store = Store.open(dir)
  const workspace = { paused: { reason: 'budget_exhausted', automatic: true, at_ms: AT } }
  store.setState(undefined, 'workspace', workspace)
  store.close()

  const automatic = renderDump(Store.openReadOnly(dir), 'c1')
  assert.match(automatic, /workspace paused/)
  assert.match(automatic, /reason {5}budget_exhausted/)
  assert.match(automatic, /source {5}automatic — clears itself once the cause is gone/)

  const writable = Store.open(dir)
  writable.setState(undefined, 'workspace', {
    paused: { reason: 'reviewing metrics', automatic: false, at_ms: AT, intent_id: 'p-1' },
  })
  writable.close()

  const manual = renderDump(Store.openReadOnly(dir), 'c1')
  assert.match(manual, /source {5}manual — only a resume intent clears this/)
  assert.match(manual, /from {7}intent p-1/, 'a manual pause names the file that asked for it')
})

/** A two-round run that recorded parents: `r2-c1` started from `r1-c1`, and `r1-c2` was left behind. */
async function branchWorkspace() {
  const config = { metrics: { primary: 'auc', objectives: { auc: 'up' } } }
  const ports = openWorkspace({ config })
  const assign = (candidateId, parentId) => {
    const phase = ports.store.getState(candidateId, 'phase') ?? {}
    ports.store.setState(candidateId, 'phase', { ...phase, parent_id: parentId })
  }
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.72 } })
  await runCandidate(ports, { candidateId: 'r1-c2', round: 1, metrics: { auc: 0.7 } })
  assign('r1-c1', 'baseline')
  assign('r1-c2', 'baseline')
  fileArtifacts(join(dirname(ports.store.path), 'artifacts')).write('round-2/parents', {
    address: 'test-address-2',
    content: {
      round: 2,
      parents: ['r1-c1'],
      empty: false,
      frontier: [{ candidate_id: 'r1-c1' }, { candidate_id: 'r1-c2' }],
      rotation: { axes: ['auc'], offset: 0 },
    },
  })
  await runCandidate(ports, { candidateId: 'r2-c1', round: 2, metrics: { auc: 0.73 } })
  assign('r2-c1', 'r1-c1')
  const dir = dirname(ports.store.path)
  ports.store.close()
  return dir
}

test('dump --tree prints the lineage, and the reason each branch ends', async () => {
  const dir = await branchWorkspace()

  const { code, output } = runDump(['--tree', '--workspace', dir])

  assert.equal(code, 0)
  assert.match(output, /tree\s+2 round\(s\), 3 candidate\(s\), 3 edge\(s\)/, 'two rounds of facts, and an edge for every parent recorded')
  assert.match(output, /r1-c1\s+done\s+auc=0\.72\s+continued -> r2-c1/, 'a node with a child names it')
  assert.match(
    output,
    /r1-c2\s+done\s+auc=0\.7\s+passed over in round 2 \(1 parent\(s\), auc led, offset 0\)/,
    'and the round that passed it over says on what roster, and which axis led it',
  )
  assert.match(output, /r2-c1\s+frontier\s+auc=0\.73\s+no later round yet/)
  assert.match(output, /└─ r1-c2/, 'the lineage is drawn, not just listed')
})
