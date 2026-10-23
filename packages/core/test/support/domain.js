/**
 * The shipped pack, for tests that need a domain but are not testing the pack loader.
 *
 * A judge has no defaults of its own any more — its five prompts and its metric contract come from
 * the domain pack — so a test that exercises a judgement phase has to say which domain it is judging
 * in. `examples/feed-structure` is the domain this repository ships, and naming it here (rather than
 * in the kernel) is the point: tests may name a metric, the kernel may not.
 *
 * This file is not a test: `npm test` runs `*.test.js` only.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJudge } from '../../lib/judge.js'

/** `<repo>/examples/feed-structure` — read through the same loader production uses where possible. */
export const FEED_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'examples', 'feed-structure')

/** The five prompts, as the pack names them. */
export const FEED_PROMPTS_DIR = join(FEED_PACK_DIR, 'prompts')

/** The metric this example optimises. A test may name it; a kernel module may not. */
export const FEED_METRIC = Object.freeze({ name: 'auc', direction: 'higher' })

/** A second pack that is only configuration, used to prove a new domain needs no kernel change. */
export const CONFIG_ONLY_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'config-only-domain')

/**
 * `createJudge` with the shipped domain filled in, so a test states only what it is about.
 * Anything it passes wins — including `skillsDir`, `metric` and `surface`.
 *
 * @param {object} [options]
 */
export function judgeFor(options = {}) {
  return createJudge({ skillsDir: FEED_PROMPTS_DIR, metric: FEED_METRIC, ...options })
}