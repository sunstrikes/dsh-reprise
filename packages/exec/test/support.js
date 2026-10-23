/**
 * Shared rig for the candidate-harness tests: a throwaway git repository, a *real* linked worktree
 * for the candidate, and a fake CLI that stands in for `claude` / `dsh`.
 *
 * The fake CLI is a test fixture, not a model. Every test here must pass on a laptop with no
 * network, no API key and no coding harness installed — otherwise the suite would encode "the
 * machine this ran on" rather than the port's contract.
 *
 * Not a test file itself (the `npm test` glob only takes `*.test.js`).
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Run git hermetically: no global config, no prompts, a known identity for the base commit. */
export function git(cwd, ...args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'init.defaultBranch=main',
      '-c',
      'user.name=reprise-test',
      '-c',
      'user.email=reprise@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  )
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/**
 * A runner-shaped fixture: the repository, the base commit, and one candidate worktree plus one
 * `refs/reprise/*` ref — both created here, by the test, because **creating them is the
 * runner's job** and the adapter under test must never do it.
 */
export function makeRunner(t) {
  const root = mkdtempSync(join(tmpdir(), 'reprise-exec-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init')
  writeFileSync(join(repo, 'README.md'), '# the candidate tree\n')
  writeFileSync(join(repo, 'config.py'), 'learning_rate = 1e-3\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'base commit')
  const base = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'update-ref', 'refs/reprise/cand-1', base)

  const worktreeDir = join(root, 'worktree-cand-1')
  git(repo, 'worktree', 'add', '--detach', worktreeDir, base)

  const runner = {
    root,
    repo,
    base,
    worktreeDir,
    refs: () => git(repo, 'show-ref'),
    worktrees: () => git(repo, 'worktree', 'list', '--porcelain'),
    tracePath: (name = 'trace') => join(root, `${name}.json`),
    addWorktree: (dir = worktreeDir) => git(repo, 'worktree', 'add', '--detach', dir, base),
    removeWorktree: (dir = worktreeDir) => git(repo, 'worktree', 'remove', '--force', dir),
    removeRef: () => git(repo, 'update-ref', '-d', 'refs/reprise/cand-1'),
  }

  t.after(() => rmSync(root, { recursive: true, force: true }))
  return runner
}

/** Wire an adapter to the fake CLI. `prefixArgs` is the adapter's documented test seam. */
export function fakeHarness(adapter, { mode = 'ok', trace, fakeCli, ...overrides } = {}) {
  return adapter.create({
    command: process.execPath,
    prefixArgs: [fakeCli],
    env: {
      ...process.env,
      FAKE_MODE: mode,
      ...(trace === undefined ? {} : { FAKE_TRACE: trace }),
    },
    ...overrides,
  })
}

export function readTrace(trace) {
  return JSON.parse(readFileSync(trace, 'utf8'))
}

export function writeFakeCli(dir) {
  const path = join(dir, 'fake-cli.mjs')
  writeFileSync(path, `${FAKE_CLI_LINES.join('\n')}\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * The fake harness. It reads its prompt from stdin, records argv/cwd/prompt, edits two files in
 * whatever directory it was started in, and prints newline-delimited JSON events. `FAKE_MODE`
 * selects the failure it should simulate; the default is a clean landing.
 */
const FAKE_CLI_LINES = [
  "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  '',
  'process.stdout.on("error", () => {})',
  'const mode = process.env.FAKE_MODE ?? "ok"',
  'const cwd = process.cwd()',
  'let prompt = ""',
  'try { prompt = readFileSync(0, "utf8") } catch { prompt = "" }',
  'if (process.env.FAKE_TRACE) {',
  '  writeFileSync(process.env.FAKE_TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd, stdin: prompt }))',
  '}',
  'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n")',
  'const report = (files) => "I edited the worktree at " + cwd + ".\\n\\n```json\\n" + JSON.stringify({ files }) + "\\n```\\n"',
  'const edit = () => {',
  '  writeFileSync(join(cwd, "candidate.py"), "# written by the fake harness\\n")',
  '  appendFileSync(join(cwd, "README.md"), "- a line the candidate added\\n")',
  '}',
  '',
  'if (mode === "ok" || mode === "no-report" || mode === "mismatch") {',
  '  edit()',
  '  emit({ type: "system", subtype: "init", session_id: "fake-session" })',
  '  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "editing" }] } })',
  '  const files = mode === "mismatch" ? ["candidate.py", "ghost.py"] : ["README.md", "candidate.py"]',
  '  const text = mode === "no-report"',
  '    ? "I edited the worktree at " + cwd + " and left the file report out on purpose."',
  '    : report(files)',
  '  emit({ type: "result", subtype: "success", session_id: "fake-session", total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 22 }, result: text })',
  '}',
  '',
  'if (mode === "exit-nonzero") {',
  '  process.stderr.write("boom: the fake harness fell over\\n")',
  '  process.exitCode = 9',
  '}',
  '',
  'if (mode === "edit-then-crash") {',
  '  edit()',
  '  process.stderr.write("boom: the fake harness died mid-edit\\n")',
  '  process.exitCode = 9',
  '}',
  '',
  'if (mode === "killed") process.kill(process.pid, "SIGKILL")',
  '',
  'if (mode === "timeout") setTimeout(() => {}, 60000)',
  '',
  'if (mode === "garbage") {',
  '  process.stdout.write("this is not json\\nnor is this\\n")',
  '}',
  '',
  'if (mode === "no-result") {',
  '  emit({ type: "system", subtype: "init" })',
  '  emit({ type: "assistant" })',
  '}',
  '',
  'if (mode === "flood") {',
  '  const line = "x".repeat(400)',
  '  for (let index = 0; index < 20000; index += 1) process.stdout.write(line + "\\n")',
  '  setTimeout(() => {}, 1000)',
  '}',
  '',
  'if (mode === "refusal") {',
  '  emit({ type: "result", subtype: "refusal", result: "I will not rewrite the trainer." })',
  '}',
  '',
  'if (mode === "subtype-error") {',
  '  emit({ type: "result", subtype: "error_max_turns", result: "I ran out of turns." })',
  '}',
  '',
  'if (mode === "credential") {',
  '  process.stderr.write("HTTP 401 unauthorized: the harness cannot authenticate\\n")',
  '  process.exitCode = 1',
  '}',
  '',
  'if (mode === "transient") {',
  '  process.stderr.write("429 too many requests, try again later\\n")',
  '  process.exitCode = 1',
  '}',
]