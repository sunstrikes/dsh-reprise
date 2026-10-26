/**
 * The `windows` command: the claim "the same window parsed twice yields the same samples" has to be
 * runnable on real bytes, by a person, after a real job.
 *
 * Contract guarded (ticket 19: "一次真跑产出一串窗口样本，同一段窗口重复解析结果一致" and "解析不出
 * 任何窗口时判 data 失败并附原因"); three properties:
 *
 *   1. the same file parsed twice prints byte-identical JSON (diff-able, hash-able, no clock);
 *   2. a refusal exits non-zero, writes **nothing** to stdout and the reason to stderr — an empty
 *      series must never read as a success in a shell pipeline;
 *   3. the entry point is wired: running the file as a script prints what calling it returns.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCli } from '../lib/cli/windows.js'

const CLI = fileURLToPath(new URL('../lib/cli/windows.js', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/tensorboard/scalars-4x3.tfevents', import.meta.url))
const LOG = [
  'epoch 0',
  'REPRISE_WINDOWS {"schema_version":1,"unit":"step","windows":[{"index":0,"start":0,"end":10,"metrics":{"metric_a":1.5}}]}',
].join('\n')

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'reprise-windows-'))
  return { dir, path: (name) => join(dir, name), close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the same event file parsed twice prints byte-identical samples', () => {
  const first = runCli(['--event-file', FIXTURE, '--window-steps', '10'])
  const second = runCli(['--event-file', FIXTURE, '--window-steps', '10'])

  assert.equal(first.code, 0, first.stderr)
  assert.equal(second.stdout, first.stdout, 'a clock or an unstable key order would make these differ')

  const series = JSON.parse(first.stdout)
  assert.equal(series.unit, 'step')
  assert.equal(series.windows.length, 4)
  assert.equal(series.windows[0].start, 0)
})

test('a refusal is a data failure on stderr with stdout left empty, and exit code 2', () => {
  const made = workspace()
  try {
    const clipped = made.path('run.tfevents')
    writeFileSync(clipped, readFileSync(FIXTURE).subarray(0, 100))
    const result = runCli(['--event-file', clipped, '--window-steps', '10'])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a shell pipeline must not be able to read half a series as a whole one')
    assert.match(result.stderr, /^data failure: /)
    assert.match(result.stderr, /ends mid-record/)
  } finally {
    made.close()
  }
})

test('a caller mistake is a usage error, not a data failure', () => {
  for (const [label, argv, expected] of [
    ['no window size', ['--event-file', FIXTURE], /--window-steps/],
    ['nothing to parse', [], /nothing to parse/],
    ['an unknown flag', ['--nonsense', 'x'], /unknown flag/],
  ]) {
    const result = runCli(argv)
    assert.equal(result.code, 1, label)
    assert.match(result.stderr, expected, label)
    assert.equal(result.stdout, '')
  }
})

test('the driver-log channel is reachable from the same command', () => {
  const made = workspace()
  try {
    const log = made.path('driver.log')
    writeFileSync(log, LOG)
    const result = runCli(['--log', log])

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).windows[0].metrics.metric_a, 1.5)
  } finally {
    made.close()
  }
})

test('the file is wired as a script: running it prints what calling it returns', () => {
  const spawned = spawnSync(process.execPath, [CLI, '--event-file', FIXTURE, '--window-steps', '10'], {
    encoding: 'utf8',
  })
  assert.equal(spawned.status, 0, spawned.stderr)
  assert.deepEqual(JSON.parse(spawned.stdout), JSON.parse(runCli(['--event-file', FIXTURE, '--window-steps', '10']).stdout))
})