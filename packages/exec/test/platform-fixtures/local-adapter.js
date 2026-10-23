/**
 * Conformance adapter for the local executor: turns a scripted outcome into a real command.
 *
 * The port has no "pretend this job failed" hook on purpose, so this file does what a real caller
 * would do — build a command line from a plan — and then lets the *process* produce the outcome:
 * a traceback on stderr, a self-imposed SIGKILL, a missing input file, a sleep that never ends.
 * Everything the conformance suite observes therefore travelled through a real process boundary.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalPlatform } from '../../lib/platform-local.js'

const PREAMBLE = `import { writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
`

function scriptFor(spec) {
  // A disturbance replaces the job's own end state: the whole point is that the outcome becomes
  // unobservable, or the record disappears, before the executor can report anything.
  if (spec.disturb === 'unavailable') {
    // The supervisor is SIGKILLed, so no status is ever recorded. That is the honest local analogue
    // of a dashboard that cannot be reached: the outcome is not knowable from here.
    return `process.kill(process.ppid, 'SIGKILL')\nawait sleep(50)\n`
  }
  if (spec.disturb === 'vanish') {
    // The job's own record is destroyed. That is what "the platform says this job never existed"
    // means on a filesystem-backed medium, and it is the only way `lost` can be produced here.
    return `rmSync(process.env.REPRISE_JOB_DIR, { recursive: true, force: true })\nawait sleep(50)\n`
  }
  switch (spec.outcome) {
    case 'code':
      return `process.stderr.write('Traceback (most recent call last):\\n  File "train.py", line 42, in <module>\\nValueError: hidden size must be divisible by heads\\n')\nprocess.exit(1)\n`
    case 'oom':
      // A real local OOM arrives as SIGKILL from the kernel, not as a message. Killing ourselves
      // reproduces the observation the classifier actually has to work with.
      return `process.kill(process.pid, 'SIGKILL')\nawait sleep(50)\n`
    case 'data':
      return `process.stderr.write("FileNotFoundError: [Errno 2] No such file or directory: 'data/train.parquet'\\n")\nprocess.exit(1)\n`
    case 'hang':
      return `await sleep(60_000)\n`
    default:
      return `await sleep(${spec.delayMs ?? 60})\nawait writeFile(process.env.REPRISE_METRICS_PATH, JSON.stringify({ metrics: ${JSON.stringify(spec.metrics ?? {})} }))\n`
  }
}

/** @returns {Promise<{platform: object, script: Function, close: Function, root: string}>} */
export async function localHarness() {
  const root = mkdtempSync(join(tmpdir(), 'reprise-exec-local-'))
  const rootDir = join(root, 'jobs')
  const scriptsDir = join(root, 'scripts')
  mkdirSync(rootDir, { recursive: true })
  mkdirSync(scriptsDir, { recursive: true })

  const specs = new Map()
  const platform = createLocalPlatform({
    rootDir,
    name: 'local-test',
    plan: ({ candidateId, submissionId }) => {
      const spec = specs.get(candidateId) ?? specs.get(submissionId) ?? { outcome: 'succeeded', metrics: {} }
      const file = join(scriptsDir, `${candidateId}.mjs`)
      writeFileSync(file, PREAMBLE + scriptFor(spec))
      return { command: [process.execPath, file], cwd: root }
    },
  })

  return {
    platform,
    root,
    script(candidateId, spec) {
      specs.set(candidateId, spec)
    },
    async close() {
      // Never leave a 60-second sleeper behind: a test suite that leaks child processes gets run
      // less often, and then it stops guarding anything.
      for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          await platform.cancel(entry.name)
        } catch {}
      }
    },
  }
}