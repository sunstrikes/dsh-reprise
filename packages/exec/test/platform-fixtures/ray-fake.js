/**
 * A fake Ray dashboard: real URLs, real envelopes, scripted outcomes.
 *
 * This file exists because of one hard fact about Ray OSS 2.4x: `JobDetails.error_type` is a
 * `TODO(aguo)` in the dashboard handler and never populated, while `TaskState.error_type` (from
 * `/api/v0/tasks`) is. A test that made up its own response shapes could not tell a classifier
 * that reads the first from one that reads the second — so every shape below is copied from the
 * real endpoints, including the decoy `error_type: null` on JobDetails and the
 * `{result, msg, data: {result: {result: [...]}}}` wrapper on the state API.
 *
 * Not a mock of behaviour: which job succeeds and how is scripted per submission id, and every
 * transition is driven by the number of GETs, so the conformance suite's polling loop is what
 * moves the world forward.
 *
 * @module
 */

const JSON_HEADERS = { 'content-type': 'application/json' }

const FAILURE_MESSAGES = {
  code: 'Job failed due to an exception raised in the entrypoint.',
  oom: 'Job failed: worker killed.',
  data: 'Job failed: the driver exited non-zero.',
}

/** Script defaults, chosen to look like a job whose outcome is obvious from the task records. */
function defaultScript(outcome) {
  switch (outcome) {
    case 'oom':
      return { taskErrorType: 'OUT_OF_MEMORY', logs: 'Task was killed by the memory monitor.\n' }
    case 'data':
      // A data problem shows up in the driver log, not as a typed task error: that is precisely the
      // case where the log fallback is the only evidence there is.
      return {
        taskErrorType: null,
        logs: "FileNotFoundError: [Errno 2] No such file or directory: 'data/train.parquet'\n",
      }
    case 'code':
      return {
        taskErrorType: 'TASK_EXECUTION_EXCEPTION',
        logs: 'Traceback (most recent call last):\n  File "train.py", line 42\nValueError: hidden size must be divisible by heads\n',
      }
    default:
      return { taskErrorType: null, logs: 'training...\ndone\n' }
  }
}

export function createFakeRay({ onSucceeded, now = () => 1_700_000_000_000, duplicateResponse = 'ray-400' } = {}) {
  const jobs = new Map()
  const submissionJobs = new Map()
  const scripts = new Map()
  // The package store, keyed by name: `PUT /api/packages/gcs/<name>.zip` is the only inbound channel
  // for code on this cluster (no shared filesystem, no internet), so a fake that accepted a job whose
  // `working_dir` names a package it never received would test the wrong half of the contract.
  const packages = new Map()
  const requests = []
  let counter = 0
  let clock = now()

  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

  const resolve = (ref) => jobs.get(ref) ?? jobs.get(submissionJobs.get(ref))

  function jobDetails(job) {
    // Field list and spelling copied from Ray's JobDetails JSON. `error_type` is always null here,
    // exactly as in OSS Ray: reading it is the bug this fake is built to catch.
    return {
      job_id: job.job_id,
      submission_id: job.submission_id,
      status: job.status,
      entrypoint: job.entrypoint,
      message: job.message,
      error_type: job.script.detailsErrorType ?? null,
      start_time: job.start_time,
      end_time: job.end_time,
      metadata: job.metadata,
      runtime_env: job.runtime_env,
      driver_exit_code: job.driver_exit_code,
      driver_node_id: job.driver_node_id,
    }
  }

  function terminalize(job) {
    const outcome = job.script.outcome ?? 'succeeded'
    if (outcome === 'succeeded') {
      job.status = 'SUCCEEDED'
      job.end_time = job.start_time + 1_000
      onSucceeded?.(job)
      return
    }
    job.status = 'FAILED'
    job.end_time = job.start_time + 1_000
    job.message = FAILURE_MESSAGES[outcome] ?? FAILURE_MESSAGES.code
    job.driver_exit_code = 1
  }

  /** One GET of a job advances the world by one step, so polling is the only clock. */
  function advance(job) {
    // A status this fake does not know how to advance is left exactly as the test set it: that is
    // how a future dashboard vocabulary gets exercised.
    if (!['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STOPPED'].includes(job.status)) return
    if (['SUCCEEDED', 'FAILED', 'STOPPED'].includes(job.status)) return
    job.polls += 1
    if (job.script.hang === true) {
      job.status = 'RUNNING'
      return
    }
    if (job.polls === 1) {
      job.status = 'RUNNING'
      return
    }
    terminalize(job)
  }

  async function handle(request) {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    const path = url.pathname
    requests.push({ method, path, search: url.search, body: request.body })

    const packageMatch = path.match(/^\/api\/packages\/([^/]+)\/([^/]+)$/)
    if (method === 'PUT' && packageMatch !== null) {
      const [, protocol, name] = packageMatch
      if (protocol !== 'gcs') return reply({ detail: `unknown package protocol ${protocol}` }, 500)
      if (!name.endsWith('.zip')) return reply({ detail: 'only .zip packages are accepted' }, 400)
      packages.set(name, Buffer.from(request.body ?? []))
      return reply({ [name]: `gcs://${name}` }, 200)
    }

    if (method === 'POST' && (path === '/api/jobs/' || path === '/api/jobs')) {
      const body = JSON.parse(request.body ?? '{}')
      const submissionId = body.submission_id
      // Ray resolves `runtime_env.working_dir` through the package store. A gcs:// URI whose package
      // was never uploaded fails the job at setup on the real cluster, so it fails the submission here.
      const workingDir = body.runtime_env?.working_dir
      if (typeof workingDir === 'string' && workingDir.startsWith('gcs://')) {
        const name = workingDir.slice('gcs://'.length)
        if (!packages.has(name)) return reply({ detail: `package ${name} was never uploaded` }, 400)
      }
      if (submissionJobs.has(submissionId)) {
        // Both shapes are real: OSS Ray answers 400 with this `detail` string from job_manager's
        // `put_info(overwrite=False)`; a newer proxy in front of it answers 409. We handle both.
        return duplicateResponse === 'plain-409'
          ? reply({ detail: `Job with submission_id ${submissionId} already exists` }, 409)
          : reply({ detail: `Job with submission_id ${submissionId} already exists` }, 400)
      }
      counter += 1
      const script = { outcome: 'succeeded', ...(scripts.get(submissionId) ?? {}) }
      const job = {
        job_id: `raysubmit_${String(counter).padStart(4, '0')}`,
        submission_id: submissionId,
        status: 'PENDING',
        entrypoint: body.entrypoint,
        message: null,
        start_time: clock,
        end_time: null,
        metadata: body.metadata ?? {},
        runtime_env: body.runtime_env ?? {},
        driver_exit_code: null,
        driver_node_id: 'node-head-1',
        polls: 0,
        disturbed: false,
        script: { ...defaultScript(script.outcome), ...script },
      }
      jobs.set(job.job_id, job)
      submissionJobs.set(submissionId, job.job_id)
      clock += 1_000
      return reply({ job_id: job.job_id, submission_id: submissionId }, 200)
    }

    const stopMatch = path.match(/^\/api\/jobs\/([^/]+)\/stop$/)
    if (method === 'POST' && stopMatch !== null) {
      const job = resolve(decodeURIComponent(stopMatch[1]))
      if (job === undefined) return reply({ detail: `Job '${stopMatch[1]}' does not exist` }, 404)
      job.status = 'STOPPED'
      job.message = 'Job stopped by user.'
      job.end_time = job.start_time + 500
      return reply({ stopped: true }, 200)
    }

    const logsMatch = path.match(/^\/api\/jobs\/([^/]+)\/logs$/)
    if (method === 'GET' && logsMatch !== null) {
      const job = resolve(decodeURIComponent(logsMatch[1]))
      if (job === undefined) return reply({ detail: `Job '${logsMatch[1]}' does not exist` }, 404)
      return reply({ logs: job.script.logs ?? '' }, 200)
    }

    if (method === 'GET' && path === '/api/v0/tasks') {
      const jobId = url.searchParams.get('filter_values') ?? ''
      const job = resolve(jobId)
      if (job === undefined) {
        return reply({ result: true, msg: '', data: { result: { result: [], total: 0, num_after_truncation: 0, partial_failure_warning: '' } } }, 200)
      }
      const rows =
        job.status === 'FAILED'
          ? [
              {
                type: 'TASK',
                task_id: `task-${job.job_id}`,
                job_id: job.job_id,
                state: 'FAILED',
                error_type: job.script.taskErrorType ?? null,
                error_message: job.script.taskErrorType === null ? null : (job.script.logs ?? '').trim(),
              },
            ]
          : []
      return reply(
        { result: true, msg: '', data: { result: { result: rows, total: rows.length, num_after_truncation: rows.length, partial_failure_warning: '' } } },
        200,
      )
    }

    const detailsMatch = path.match(/^\/api\/jobs\/([^/]+)$/)
    if (method === 'GET' && detailsMatch !== null) {
      const ref = decodeURIComponent(detailsMatch[1])
      const job = resolve(ref)
      if (job === undefined) return reply({ detail: `Job '${ref}' does not exist` }, 404)
      // A submission the dashboard cannot answer for yet: user story 15's grace window, made real.
      // `hideFromDetails` counts down, so the second submit's lookup misses while the POST still knows.
      if (jobs.has(ref) === false && job.script.hideFromDetails > 0) {
        job.script.hideFromDetails -= 1
        return reply({ detail: `Job '${ref}' does not exist` }, 404)
      }
      if (job.script.disturb === 'vanish' && job.disturbed === false) {
        job.disturbed = true
        return reply({ detail: `Job '${ref}' does not exist` }, 404)
      }
      if (job.script.disturb === 'unavailable' && job.disturbed === false) {
        job.disturbed = true
        throw new TypeError('fetch failed')
      }
      advance(job)
      return reply(jobDetails(job), 200)
    }

    return reply({ detail: `unexpected ${method} ${path}` }, 500)
  }

  return {
    jobs,
    packages,
    requests,
    /** Script a job before it is submitted; the platform's `plan()` runs first, so this is a hook. */
    script(submissionId, spec) {
      scripts.set(submissionId, spec)
    },
    job: (ref) => resolve(ref),
    fetch: async (input, init = {}) =>
      handle({
        url: typeof input === 'string' ? input : input.url,
        method: init.method ?? 'GET',
        body: init.body,
      }),
  }
}