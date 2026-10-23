/**
 * Guards the job-executor contract (ticket 08, spec "执行面": A 端 and B 端 both cross a process
 * boundary and speak JSON; `state` includes `lost`/`unknown`; `error_class` includes `canceled` and
 * never merges it into `failed`).
 *
 * The point of this file is the *pairing*: the same assertions run against a real local subprocess
 * and against Ray-over-an-injected-fetch. If they both pass, "switch executor" is a package swap and
 * not a kernel change; if one implementation drifts, it shows up here rather than as a stuck
 * candidate three hours into an unattended night.
 *
 * The suite itself lives in `lib/platform.js` because it is part of the contract we publish, not
 * part of our test folder: a contributor writing a Slurm backend runs this exact function.
 */

import test from 'node:test'

import { runPlatformConformance } from '../lib/platform.js'
import { localHarness } from './platform-fixtures/local-adapter.js'
import { rayHarness } from './platform-fixtures/ray-adapter.js'

test('the local subprocess executor passes the job-executor conformance suite', async (t) => {
  await runPlatformConformance(t, { name: 'local', fresh: localHarness })
})

test('the Ray executor passes the same suite against a fake dashboard', async (t) => {
  await runPlatformConformance(t, { name: 'ray', fresh: () => rayHarness() })
})