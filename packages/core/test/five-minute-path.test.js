/**
 * The five-step path, executed.
 *
 * Contract guarded (ticket 13, user stories 22/23/24/26): a stranger who clones this repository and
 * follows README's five steps reaches **a real metric** with no GPU, no cluster, no Rust toolchain and
 * no private CLI. The only way to know that is to run the commands the README prints — so this test
 * runs exactly those five, in order, as separate processes from the repository root, and it also
 * asserts the README still contains them.
 *
 * What is *not* verified here, deliberately:
 *
 *   - **A model.** The example's model port replays recorded answers (`recorded/judgement.json`). The
 *     four judgement phases are therefore real code paths over recorded content, not a live provider.
 *   - **A coding harness.** The candidate implementer is a mechanical script applying the
 *     hypothesis's own change. It really edits a real git worktree and its diff really comes from
 *     `git diff`, but no model wrote the edit.
 *   - **A cluster.** The executor is a local subprocess. The Ray adapter is covered by its own
 *     conformance suite, not here.
 *
 * Everything else is the real thing: the phase machine, the four-state validators, the identity
 * binding chain, the SQLite fact plane, the reserve/settle ledger, the frontier, the stop rule — and
 * the number in the last assertion came out of a process that trained a model.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Exactly what README prints, in order. `{workspace}` is the only substitution the test makes. */
const STEPS = [
  { step: 1, command: 'node scripts/link-workspace.mjs' },
  { step: 2, command: 'node examples/feed-structure/init.mjs {workspace}' },
  { step: 3, command: 'node examples/feed-structure/inspect.mjs' },
  { step: 4, command: 'node packages/core/lib/cli/run.js --workspace {workspace} --config examples/feed-structure/config.json' },
  {
    step: 5,
    command: 'node packages/core/lib/cli/dump.js --candidate {candidate} --workspace {workspace}',
  },
]

/** `node <script> ...args`, run from the repository root — the way the README tells you to run it. */
function run(command, replacements) {
  const filled = command.replace('{workspace}', replacements.workspace).replace('{candidate}', replacements.candidate ?? '')
  const [binary, ...rest] = filled.split(' ')
  assert.equal(binary, 'node', 'the README prints node commands; running anything else would test a different path')
  const result = spawnSync(process.execPath, rest, { cwd: ROOT, encoding: 'utf8', timeout: 180_000 })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

test('the README prints five steps, no more and no fewer', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const headings = readme.split('\n').filter((line) => /^### Step \d/.test(line))
  assert.equal(headings.length, 5, `a stranger counts the steps; the ticket says five, the README has ${headings.length}`)
  for (const { command } of STEPS) {
    const printed = command.replace('{workspace}', '.workspace/feed').replace('{candidate}', 'r1-h2')
    assert.ok(readme.includes(printed), `step's command is in the README verbatim:\n  ${printed}`)
  }
})

test('a stranger reaches a first real metric, without a cluster, a GPU, or a model provider', () => {
  const workspace = join(mkdtempSync(join(tmpdir(), 'reprise-five-minute-')), 'feed')

  // 1 — prerequisites and workspace links.
  const linked = run(STEPS[0].command, { workspace })
  assert.equal(linked.code, 0, `step 1 failed:\n${linked.stdout}\n${linked.stderr}`)
  assert.match(linked.stdout, /ready\./, 'step 1 says what to run next, so nobody has to read this repo to find out')

  // 2 — build the workspace: a model repo, a frozen priors manifest, and a measured baseline.
  const init = run(STEPS[1].command, { workspace })
  assert.equal(init.code, 0, `step 2 failed:\n${init.stdout}\n${init.stderr}`)
  const baseline = init.stdout.match(/baseline\s+auc=([0-9.]+)/)
  assert.ok(baseline, `step 2 must print the baseline it measured, not just claim one:\n${init.stdout}`)
  assert.ok(Number(baseline[1]) > 0.5, 'a baseline below chance would mean the benchmark is broken, not that the model is')

  // 3 — the four files you own, on one screen.
  const inspect = run(STEPS[2].command, { workspace })
  assert.equal(inspect.code, 0, `step 3 failed:\n${inspect.stderr}`)
  assert.match(inspect.stdout, /capacity, interaction, regularisation/, 'the hypothesis classes are configuration')
  assert.match(inspect.stdout, /metric-contract\.json/)

  // 4 — run the loop until it concludes.
  const runLoop = run(STEPS[3].command, { workspace })
  assert.equal(runLoop.code, 0, `step 4 failed:\n${runLoop.stdout}\n${runLoop.stderr}`)
  const best = runLoop.stdout.match(/best\s+(r\d+-h\d+)\s+auc=([0-9.]+)/)
  assert.ok(best, `step 4 must name the winning candidate and its metric:\n${runLoop.stdout}`)
  assert.ok(
    Number(best[2]) > Number(baseline[1]),
    `the winner (${best[2]}) must beat the baseline (${baseline[1]}) — otherwise this example demonstrates nothing`,
  )
  assert.match(runLoop.stdout, /stop\s+max_rounds/, 'the run says why it ended')
  assert.match(runLoop.stdout, /ticks\s+\d+ in [0-9.]+s/, 'the run reports how much work it did')

  // 5 — explain one candidate, from the fact plane alone.
  const dump = run(STEPS[4].command, { workspace, candidate: best[1] })
  assert.equal(dump.code, 0, `step 5 failed:\n${dump.stdout}\n${dump.stderr}`)
  assert.match(dump.stdout, /frontier position/)
  assert.match(dump.stdout, new RegExp(`auc=${best[2].replace('.', '\\.')}`), 'the dump agrees with the run about the number')
  assert.match(dump.stdout, /identity bindings/, 'the identity chain is on the record, not reconstructed in prose')
  assert.match(dump.stdout, /parent_commit/, 'a candidate with no parent still proves which commit it branched from')

  // The projection the dump renders is also checkable against a full replay of the facts.
  const rebuilt = run('node packages/core/lib/cli/dump.js --workspace {workspace} --rebuild', { workspace })
  assert.equal(rebuilt.code, 0, `the rebuild check failed:\n${rebuilt.stdout}\n${rebuilt.stderr}`)
  assert.match(rebuilt.stdout, /result\s+match/, 'the materialised view still follows from the events')
})
test('the metric direction is data: flip it in the config and the other candidate wins', () => {
  const workspace = join(mkdtempSync(join(tmpdir(), 'reprise-five-minute-lower-')), 'feed')
  assert.equal(run(STEPS[1].command, { workspace }).code, 0, 'the workspace build is not the thing under test')

  // The only edits: which direction is better, in the two places the contract names. No code changes.
  const config = JSON.parse(readFileSync(join(ROOT, 'examples/feed-structure/config.json'), 'utf8'))
  config.workspace = workspace
  config.metrics.objectives.auc = 'down'
  config.rounds.metric.direction = 'lower'
  const configPath = join(workspace, 'config-lower.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const lowered = run(
    `node packages/core/lib/cli/run.js --workspace {workspace} --config ${configPath}`,
    { workspace },
  )
  assert.equal(lowered.code, 0, `the run failed after a config-only change:\n${lowered.stdout}\n${lowered.stderr}`)
  assert.doesNotMatch(lowered.stdout, /metric_direction_mismatch/, 'both declarations were flipped, so nothing is inconsistent')
  assert.match(
    lowered.stdout,
    /best\s+r1-h1\s+auc=/,
    `with auc pointing down, the lower of the two candidates wins — no code change:\n${lowered.stdout}`,
  )
  assert.match(lowered.stdout, /verdict\s+regressed against the baseline/)
})