/**
 * `dsh --profile headless --json` — adapter B of two.
 *
 * Guards: ticket 07 criterion 3. It is deliberately a near-copy of the claude adapter: when the
 * second engine is a thin wrapper, the shared body in `harness.js` is where the decisions live, and
 * a third engine costs an argv builder plus a result normaliser rather than a second implementation
 * of "cwd is the worktree, git owns the diff".
 *
 * Two differences from the claude argv are load-bearing:
 *
 * - `--profile headless` is the shipped headless app (`dsh headless` is only an alias), so the
 *   invocation survives a profile rename.
 * - The trailing `-` makes the task come from stdin, which is where the prompt is written for both
 *   adapters. Passing the prompt as argv instead would put a multi-kilobyte hypothesis into the
 *   process table.
 *
 * The headless run-event vocabulary (`--json`, newline-delimited) is not verified against a real
 * `dsh` in this checkout; `parseStream`/`pickResult` in `harness.js` accept both a `type:"result"`
 * event and a `final:true` event, so the shape difference stays in one place when it is confirmed.
 *
 * @module
 */

import {
  DEFAULT_STREAM_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  buildPrompt,
  landWithCli,
} from './harness.js'

export const ENGINE = 'dsh'

/** The task argument (`-`) is last: the prompt travels on stdin for both engines. */
export const DSH_FLAGS = Object.freeze(['--profile', 'headless', '--json', '-'])

/** `prefixArgs` is the test seam for a fake CLI; `extraArgs` is where a caller adds app flags. */
export function dshArgs({ prefixArgs = [], extraArgs = [] } = {}) {
  return [...prefixArgs, ...DSH_FLAGS, ...extraArgs]
}

/**
 * @param {{
 *   command?: string,
 *   prefixArgs?: string[],
 *   extraArgs?: string[],
 *   timeoutMs?: number,
 *   streamCapBytes?: number,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: Function,
 *   git?: Function,
 *   makePrompt?: Function,
 * }} [options]
 */
export function createDshHarness(options = {}) {
  const {
    command = 'dsh',
    prefixArgs = [],
    extraArgs = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    streamCapBytes = DEFAULT_STREAM_CAP_BYTES,
    env,
    spawn,
    git,
    makePrompt = buildPrompt,
  } = options

  return {
    engine: ENGINE,
    command,
    argv: dshArgs({ prefixArgs, extraArgs }),

    /**
     * @param {{
     *   candidateId: string,
     *   hypothesis: string,
     *   round?: number,
     *   worktreeDir: string,
     *   baseRef: string,
     *   parentId?: string|null,
     * }} input
     */
    async land({ candidateId, hypothesis, round = 1, worktreeDir, baseRef, parentId = null }) {
      return landWithCli({
        engine: ENGINE,
        command,
        args: dshArgs({ prefixArgs, extraArgs }),
        candidateId,
        hypothesis,
        round,
        worktreeDir,
        baseRef,
        parentId,
        prompt: makePrompt({ candidateId, hypothesis, round, worktreeDir }),
        timeoutMs,
        streamCapBytes,
        env,
        spawn,
        git,
      })
    },
  }
}