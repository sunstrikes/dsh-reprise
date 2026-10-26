/**
 * Conformance adapter for the Ray executor: a scripted fake dashboard, and a plan that submits the
 * entrypoint a real candidate would submit.
 *
 * The fake writes the metrics file when a job reaches SUCCEEDED, because that is what the real job
 * does — the executor's job is to read it, not to invent it.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRayPlatform } from '../../lib/platform-ray.js'
import { createFakeRay } from './ray-fake.js'

/**
 * @param {{duplicateResponse?: 'plain-409'|'ray-400'}} [options]
 * @returns {Promise<{platform: object, fake: object, script: Function, close: Function, root: string}>}
 */
export async function rayHarness({ duplicateResponse } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reprise-exec-ray-'))
  const metricsDir = join(root, 'metrics')
  const artifactsDir = join(root, 'artifacts')
  mkdirSync(metricsDir, { recursive: true })

  const specs = new Map()
  const fake = createFakeRay({
    duplicateResponse,
    onSucceeded: (job) => {
      const spec = specs.get(job.submission_id)
      if (spec?.metrics === undefined) return
      writeFileSync(join(metricsDir, `${job.submission_id}.metrics.json`), JSON.stringify({ metrics: spec.metrics }))
    },
  })

  const platform = createRayPlatform({
    baseUrl: 'http://ray.fake:8265',
    request: fake.request,
    plan: ({ candidateId, submissionId }) => {
      // Submitting is what registers the job with the fake, exactly as the real submit body is what
      // the cluster reads.
      fake.script(submissionId, specs.get(candidateId) ?? specs.get(submissionId) ?? {})
      return {
        entrypoint: ['python', '-m', 'train', '--smoke'],
        runtimeEnv: { working_dir: '/worktrees/round_0001/cand' },
        metadata: { candidate_id: candidateId },
        numGpus: 0,
      }
    },
    metricsDir,
    artifactsDir,
    name: 'ray-test',
  })

  return {
    platform,
    fake,
    root,
    script(candidateId, spec) {
      specs.set(candidateId, spec)
    },
    async close() {
      // The fake has no processes and no sockets, so there is nothing to stop.
    },
  }
}