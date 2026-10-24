#!/usr/bin/env node
/**
 * Turn one run's training output into windowed samples, from the command line.
 *
 * Why a CLI and not only a library: "the same window parsed twice yields the same samples" is a claim
 * somebody has to be able to check on real bytes, after a real job, without writing a script. So:
 *
 * ```
 * node packages/exec/lib/cli/windows.js --event-file run.tfevents --window-steps 10 > a.json
 * node packages/exec/lib/cli/windows.js --event-file run.tfevents --window-steps 10 > b.json
 * diff a.json b.json            # a parser with a clock or an unstable key order fails here
 * ```
 *
 * and, for the payload a cluster job prints because there is no shared filesystem:
 *
 * ```
 * node packages/exec/lib/cli/windows.js --log driver.log > series.json
 * ```
 *
 * The output is the `window_series` document, nothing else, so it can be piped, hashed or committed.
 * A refusal is a `data` failure: the reason goes to stderr, the exit code is 2, and stdout stays
 * empty — an empty series must never be mistaken for a successful one.
 *
 * @module
 */

import { readFileSync } from 'node:fs'

import { parseEventFile, parseWindowLog } from '../window-samples.js'

const USAGE = `usage:
  node packages/exec/lib/cli/windows.js --event-file <path> --window-steps <n> [--unit <unit>]
  node packages/exec/lib/cli/windows.js --log <path>
`

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') return { help: true }
    const value = argv[index + 1]
    if (value === undefined) throw new TypeError(`${flag} needs a value\n${USAGE}`)
    index += 1
    if (flag === '--event-file') options.eventFile = value
    else if (flag === '--log') options.log = value
    else if (flag === '--window-steps') options.windowSteps = Number(value)
    else if (flag === '--unit') options.unit = value
    else throw new TypeError(`unknown flag ${flag}\n${USAGE}`)
  }
  if (options.eventFile === undefined && options.log === undefined) throw new TypeError(`nothing to parse\n${USAGE}`)
  if (options.eventFile !== undefined && options.windowSteps === undefined) {
    throw new TypeError(`--event-file needs --window-steps: a window is a choice about the experiment, not a default`)
  }
  return options
}

/**
 * @param {string[]} argv
 * @param {{writeFile?: (text: string) => void}} [context] injectable so the command is testable
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function runCli(argv, { writeFile } = {}) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    return { code: 1, stdout: '', stderr: `${error.message}\n` }
  }
  if (options.help === true) return { code: 0, stdout: USAGE, stderr: '' }

  const parsed =
    options.eventFile !== undefined
      ? parseEventFile(readFileSync(options.eventFile), {
          window_steps: options.windowSteps,
          ...(options.unit === undefined ? {} : { unit: options.unit }),
        })
      : parseWindowLog(readFileSync(options.log, 'utf8'))

  if (parsed.ok !== true) {
    return { code: 2, stdout: '', stderr: `data failure: ${parsed.reason}\n` }
  }
  const text = `${JSON.stringify(parsed.series, null, 2)}\n`
  writeFile?.(text)
  return { code: 0, stdout: text, stderr: '' }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const result = runCli(process.argv.slice(2))
  if (result.stdout !== '') process.stdout.write(result.stdout)
  if (result.stderr !== '') process.stderr.write(result.stderr)
  process.exitCode = result.code
}