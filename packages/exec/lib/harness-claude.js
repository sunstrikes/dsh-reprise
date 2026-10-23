/**
 * `claude -p --output-format stream-json` — adapter A of two.
 *
 * Guards: ticket 07 criterion 3 ("both adapters run one real edit, one contract"), and the
 * `执行面` decision that the edge is a **process**, not an in-process subagent: an in-process
 * subagent has no cwd of its own, so it cannot be the thing that lands a candidate inside its own
 * worktree. That is exactly why this adapter refuses `--add-dir`.
 *
 * `--dangerously-skip-permissions` is part of the default on purpose: this runs unattended, and a
 * permission prompt with no TTY is an indefinite hang — the one state this system must never
 * enter. It can be turned off (`skipPermissions: false`) for a host that supplies its own sandbox.
 *
 * @module
 */

import {
  DEFAULT_STREAM_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  buildPrompt,
  landWithCli,
} from './harness.js'

export const ENGINE = 'claude'

/** The flags that make this the streaming `-p` harness, and no other. */
export const CLAUDE_FLAGS = Object.freeze(['-p', '--output-format', 'stream-json'])

/**
 * `prefixArgs` exists only so a test can put a fake CLI in front of the real flags; production
 * adapters leave it empty. `extraArgs` is where a caller adds `--model`, etc.
 */
export function claudeArgs({ prefixArgs = [], extraArgs = [], skipPermissions = true } = {}) {
  return [
    ...prefixArgs,
    ...CLAUDE_FLAGS,
    ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...extraArgs,
  ]
}

/**
 * @param {{
 *   command?: string,
 *   prefixArgs?: string[],
 *   extraArgs?: string[],
 *   skipPermissions?: boolean,
 *   timeoutMs?: number,
 *   streamCapBytes?: number,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: Function,
 *   git?: Function,
 *   makePrompt?: Function,
 * }} [options]
 */
export function createClaudeHarness(options = {}) {
  const {
    command = 'claude',
    prefixArgs = [],
    extraArgs = [],
    skipPermissions = true,
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
    argv: claudeArgs({ prefixArgs, extraArgs, skipPermissions }),

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
        args: claudeArgs({ prefixArgs, extraArgs, skipPermissions }),
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