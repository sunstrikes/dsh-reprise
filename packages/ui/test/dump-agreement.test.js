/**
 * Guards the decision "the dashboard and `dump` are two renderers over one projection, so they cannot
 * disagree" (spec 展示层 "projection 的计算搬成 host 侧只读模块（可测、可被 `dump` 复用）"; ticket 11
 * AC 3 and 6: "候选详情能直接指向 06 号票的 `dump` 里同一份失败原文，不出现两套口径").
 *
 * The seam is the two *outputs*: `dump`'s rendered text (a process-level surface, ticket 06's
 * acceptance object) and the JSON a route hands the browser. Nothing here re-derives a value the way
 * the code does — every expectation is read out of the dump text and compared to the JSON, so a change
 * to either renderer that makes them tell different stories fails this file.
 *
 * What it covers:
 *
 *   - the failure text: byte-identical, not "equivalent" — the ticket says the candidate page must
 *     point at the same words;
 *   - the four-state verdict, the phase it was decided at, and the event that recorded it;
 *   - the frontier position and the best result, which is where a second derivation would drift first;
 *   - the workspace stop decision: rule, limit, observed, message, best;
 *   - the identity bindings and the referenced artifacts, which `dump` prints verbatim;
 *   - config resolution: an unrecorded run must be reported as unranked by *both* paths.
 */

import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'

import { renderDump } from '../../core/lib/cli/dump.js'
import { Store } from '../../core/lib/store.js'
import { tick } from '../../core/lib/loop.js'
import { fakeJudge, forgetRecordedConfig, openWorkspace, runCandidate, seedConfig } from '../../core/test/support/fake-ports.js'
import { candidateHandler, conclusionHandler, overviewHandler } from '../lib/routes.js'

const RUN_CONFIG = {
  metrics: { primary: undefined, objectives: { auc: 'up' } },
  stop: { max_rounds: 1 },
  budget: { gpu_hours_limit: 4 },
}

/** A finished run with one accepted candidate and one rejected one, config recorded, store closed. */
async function concludedRun({ recordConfig = true } = {}) {
  const ports = openWorkspace({ config: RUN_CONFIG })
  if (recordConfig) seedConfig(ports.store, RUN_CONFIG)
  await runCandidate(ports, { candidateId: 'r1-c1', round: 1, metrics: { auc: 0.7 } })
  await runCandidate(ports, {
    candidateId: 'r1-c2',
    round: 1,
    judge: fakeJudge({
      verify: ({ candidateId, now }) => ({ candidate_id: candidateId, passed: 'yes-please', checks: [], decided_at_ms: now }),
    }),
  })
  await tick(ports)
  // Modelling a workspace from before the kernel recorded its run configuration.
  if (!recordConfig) forgetRecordedConfig(ports.store, ['metrics', 'stop', 'budget', 'injection'])
  const dir = dirname(ports.store.path)
  ports.store.close()
  return dir
}

/** The named sections `dump` prints (headers are the lines with no indentation and no column gap). */
function sections(text) {
  const out = new Map()
  let current = ['']
  out.set('', current)
  for (const line of text.split('\n')) {
    const isHeader = line !== '' && !line.startsWith(' ') && !line.includes('  ')
    if (isHeader) {
      current = []
      out.set(line, current)
      continue
    }
    current.push(line)
  }
  return out
}

/** One `label  value` row of a dump section — the rendering `dump` uses with an 11-wide label column. */
function field(block, label) {
  const prefix = `  ${label.padEnd(11)}`
  const line = block.find((candidate) => candidate.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length)
}

/** The unindented header block at the top of a dump (`workspace`, `candidate`, `phase`, `events`). */
function heading(block, label) {
  const prefix = label.padEnd(11)
  const line = block.find((candidate) => candidate.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length)
}

const rows = (block) => block.filter((line) => line.startsWith('  ') && line.trim() !== '')

test('the candidate page and `dump` tell the same story about why a candidate stopped', async () => {
  const dir = await concludedRun()
  const store = Store.openReadOnly(dir)
  const text = renderDump(store, 'r1-c2', { config: RUN_CONFIG })
  store.close()

  const view = candidateHandler(dir, { candidate: 'r1-c2' }).data
  const dump = sections(text)
  const head = dump.get('')
  const why = dump.get('why it stopped')

  assert.equal(heading(head, 'phase'), view.phase, 'both renderers read the same phase')
  assert.equal(heading(head, 'events'), String(view.lag.maxSeq), 'and the same event count')
  assert.equal(field(why, 'at phase'), view.rejection.phase)
  assert.equal(field(why, 'status'), view.rejection.status, 'the four-state conclusion, identically')
  assert.equal(field(why, 'message'), view.rejection.message, 'the failure text, word for word')
  assert.equal(
    field(why, 'recorded'),
    `${new Date(view.rejection.atMs).toISOString()} (event ${view.rejection.seq} ${view.rejection.eventType})`,
  )
  assert.ok(
    text.includes(view.rejection.message),
    'the browser can point at the same failing text `dump` prints — the ticket\'s "no two vocabularies"',
  )
  assert.equal(field(why, 'from'), view.rejection.artifact, 'and both name the artifact the verdict came from')
})

test('the candidate page and `dump` agree on the frontier position and the best result', async () => {
  const dir = await concludedRun()
  const store = Store.openReadOnly(dir)
  const positioned = sections(renderDump(store, 'r1-c1', { config: RUN_CONFIG }))
  const unranked = sections(renderDump(store, 'r1-c2', { config: RUN_CONFIG }))
  store.close()

  const accepted = candidateHandler(dir, { candidate: 'r1-c1' }).data
  const rejected = candidateHandler(dir, { candidate: 'r1-c2' }).data

  assert.equal(field(positioned.get('frontier position'), 'position'), 'on the frontier, and the best result in the run')
  assert.equal(accepted.frontier.position, 'frontier')
  assert.equal(accepted.frontier.onFrontier, true)
  assert.equal(
    field(positioned.get('frontier position'), 'best'),
    `${accepted.frontier.best.candidate_id} ${accepted.frontier.best.metric}=${accepted.frontier.best.value} (round ${accepted.frontier.best.round})`,
  )
  assert.equal(
    field(unranked.get('frontier position'), 'best'),
    `${rejected.frontier.best.candidate_id} ${rejected.frontier.best.metric}=${rejected.frontier.best.value} (round ${rejected.frontier.best.round})`,
    'even a candidate with no number sees the same best as the dump',
  )
  assert.equal(field(unranked.get('frontier position'), 'position'), 'unranked — no auc recorded')
  assert.equal(rejected.frontier.position, 'unranked')
  assert.deepEqual(rejected.frontier.missing, ['auc'])
})

test('the conclusion page and `dump` agree on the stop decision, reason included', async () => {
  const dir = await concludedRun()
  const store = Store.openReadOnly(dir)
  const text = renderDump(store, 'r1-c1', { config: RUN_CONFIG })
  store.close()

  const final = conclusionHandler(dir, {}).data
  const overview = overviewHandler(dir, {}).data
  const stop = sections(text).get('workspace stop')

  assert.equal(field(stop, 'state'), 'FINALIZE')
  assert.equal(field(stop, 'rule'), final.stopped.rule)
  assert.equal(field(stop, 'rule'), overview.stop.rule, 'and the overview reads the same recorded rule')
  assert.equal(field(stop, 'reason'), final.stopped.message, 'one stop reason, one wording')
  assert.equal(field(stop, 'reason'), overview.stop.message)
  assert.equal(
    field(stop, 'limit'),
    `${final.stopped.limit}   observed ${final.stopped.observed}`,
    'the limit and what was observed travel together in both renderers',
  )
  assert.equal(
    field(stop, 'best'),
    `${final.best.candidate_id} ${final.best.metric}=${final.best.value} (round ${final.best.round})`,
  )
  assert.equal(final.stopped.stopped, true)
})

test('the identity bindings and artifacts on the page are the ones `dump` prints, unchanged', async () => {
  const dir = await concludedRun()
  const store = Store.openReadOnly(dir)
  const dump = sections(renderDump(store, 'r1-c2', { config: RUN_CONFIG }))
  store.close()

  const view = candidateHandler(dir, { candidate: 'r1-c2' }).data

  const bindings = rows(dump.get('identity bindings')).map((line) => {
    const trimmed = line.slice(2)
    const kind = trimmed.slice(0, 16).trim()
    return [kind, JSON.parse(trimmed.slice(16))]
  })
  assert.deepEqual(bindings.map(([kind]) => kind), Object.keys(view.bindings).sort())
  for (const [kind, value] of bindings) assert.deepEqual(view.bindings[kind], value)

  const artifacts = rows(dump.get('referenced artifacts')).map((line) => line.slice(2))
  assert.deepEqual(artifacts, view.artifacts, 'the artifact list is the same list, not a similar one')
  assert.ok(artifacts.length > 0, 'the fixture really did reference an artifact')
})

test('neither path invents a ranking for a run that never recorded its metric contract', async () => {
  const dir = await concludedRun({ recordConfig: false })
  const store = Store.openReadOnly(dir)
  const text = renderDump(store, 'r1-c1', {})
  store.close()

  const view = candidateHandler(dir, { candidate: 'r1-c1' }).data
  const overview = overviewHandler(dir, {}).data
  const positioned = sections(text).get('frontier position')

  assert.match(rows(positioned)[0], /not computed/)
  assert.equal(overview.metricContract.ok, false, 'the page says it too, so neither side guesses a direction')
  assert.match(overview.metricContract.error, /no metric contract/)
  assert.equal(view.frontier.position, 'unranked', 'and no candidate claims a position it cannot have')
})