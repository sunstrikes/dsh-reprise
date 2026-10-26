/**
 * The job ledger's vocabulary: what identifies one of our jobs on a shared cluster, and what the
 * cluster's listing says back to us.
 *
 * The cluster is shared and its cards are not reserved (measured, ticket 14: two 8-card jobs ran at
 * the same time on the same eight cards). So two questions have to have answers that do not involve
 * a person reading the dashboard: **which jobs are ours**, and **which jobs of ours does the ledger
 * not know about**. Both are *views* — computed from the ledger's facts plus a live listing — and
 * neither is ever written back as if a listing were a fact (a listing is somebody else's mutable
 * state; caching it would produce a second account of the cluster).
 *
 * Two decisions worth naming:
 *
 *  - **The identity is the submission id, and the marker is the same string.** A listing row may
 *    carry `job_id: null` (measured: 80 of 167 rows had one), while `submission_id` always survives.
 *    The marker names the candidate id and the round the job was submitted in, so matching never
 *    depends on the cluster's own id. It is written *and read back* on two channels: the job's
 *    `metadata` (what we send) and `submission_id` itself (what the listing always answers with —
 *    measured 2026-10-25: not one of the 167 listing rows carried `metadata` at all).
 *  - **A job with somebody else's identity is `foreign`, not an orphan.** The cluster had 106 jobs
 *    from other work before this ledger existed. Calling those "ours but unrecorded" is how an
 *    automatic cleanup kills somebody else's training; only a marker we wrote can make a job a
 *    candidate for collection.
 *
 * @module
 */

/** Every marker we write starts here. A row that does not is not ours, whatever else it says. */
export const MARKER_PREFIX = 'reprise'

/** Where the marker travels inside a job's `metadata` (string-only: Ray refuses anything else). */
export const MARKER_KEY = 'marker'

/**
 * The marker for one job: the candidate it evaluates and the round it was submitted in.
 *
 * Fail-closed on a missing round: a marker without one names half a job, and "round unknown" would
 * make two submissions for one candidate indistinguishable in the listing.
 *
 * @param {{candidateId: string, round: number}} input
 */
export function jobMarker({ candidateId, round }) {
  if (typeof candidateId !== 'string' || candidateId === '') {
    throw new TypeError('a job marker needs the candidate id it evaluates')
  }
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new TypeError(`a job marker needs the round it was submitted in (got ${JSON.stringify(round)})`)
  }
  return `${MARKER_PREFIX}:candidate=${candidateId}:round=${round}`
}

/**
 * The marker for the baseline job.
 *
 * It names neither a candidate nor a round, because the baseline is neither: it is the denominator
 * every candidate is measured against, dispatched once per workspace. Giving it a candidate marker
 * with two invented fields would make "which candidate is this" answerable with a lie, and the round
 * a job was submitted in is exactly what distinguishes two submissions of one candidate.
 */
export const BASELINE_MARKER = `${MARKER_PREFIX}:baseline`

export function baselineMarker() {
  return BASELINE_MARKER
}

/**
 * The name one job of ours is submitted under — the same string as its marker, by construction.
 *
 * **Why this exists.** Measured on the live cluster (2026-10-25, `GET /api/v0/jobs?limit=200`, 167
 * rows): a listing row's keys are exactly `job_id, submission_id, entrypoint, type, status, message,
 * error_type, driver_info`. Not one row carried `metadata`, and 80 had `job_id: null`. The per-job
 * route does return metadata, so the marker was never lost — but it was unreadable *from the
 * listing*, which is where an orphan is found, so every job of ours classified as `foreign`. Making
 * the submission id carry the same two facts gives the identity a channel that always survives, and
 * it costs nothing: the idempotency key already had to be one per job.
 *
 * Two shapes, and no third:
 *
 *  - `reprise:candidate=<id>:round=<n>` for a candidate in a round — the round is in the key because
 *    one candidate may be run more than once and two submissions must be two jobs (today's key was
 *    the bare candidate id, so a second round's submit resolved to the *first* round's finished job).
 *  - `reprise:baseline` for the denominator, which has neither a candidate nor a round.
 *
 * `probe: true` asks for the **round-less** form (`reprise:candidate=<id>`): the family root a
 * recovering process asks the platform about when it does not know which attempt it is looking for
 * (`platform.find`). Nothing is ever submitted under it, and `parseMarker` refuses it, so it can
 * never masquerade as a job. Without `probe` the round remains mandatory, exactly as in `jobMarker`:
 * a key that names half a job would let two submissions collide.
 *
 * @param {{candidateId?: string, round?: number, baseline?: boolean, probe?: boolean}} input
 */
export function submissionIdFor({ candidateId, round, baseline = false, probe = false } = {}) {
  if (baseline === true) return baselineMarker()
  if (probe === true) {
    if (typeof candidateId !== 'string' || candidateId === '') {
      throw new TypeError('a submission id needs the candidate id it evaluates')
    }
    return `${MARKER_PREFIX}:candidate=${candidateId}`
  }
  return jobMarker({ candidateId, round })
}

/**
 * The marker a submission id carries, or `undefined` when that id is not one of ours.
 *
 * One vocabulary, read from whichever channel the cluster handed us: this is the same parser as
 * `parseMarker`, so a submission id and a `metadata.marker` can never disagree about what a job is.
 * A foreign id (`raysubmit_…`, `autotrain-smoke-…`) answers `undefined` — inventing a candidate from
 * somebody else's string is how their training becomes eligible for collection.
 */
export function markerFromSubmissionId(submissionId) {
  if (typeof submissionId !== 'string') return undefined
  return parseMarker(submissionId) === undefined ? undefined : submissionId
}

/**
 * Read a marker back. `undefined` for anything that is not ours — including somebody else's job and
 * a value that does not parse, because inventing a candidate from a broken string is how a foreign
 * job becomes eligible for collection.
 *
 * The baseline form parses to `baseline: true` and nothing else: a caller that needs a candidate id
 * gets `undefined` rather than the reserved subject dressed up as one.
 */
export function parseMarker(text) {
  if (typeof text !== 'string') return undefined
  if (text === BASELINE_MARKER) return { baseline: true }
  const match = /^reprise:candidate=(.+):round=(\d+)$/.exec(text)
  if (match === null) return undefined
  return { candidateId: match[1], round: Number(match[2]) }
}

/** Does this string claim to be one of ours, even if it does not parse? */
export function carriesOurPrefix(text) {
  return typeof text === 'string' && text.startsWith(`${MARKER_PREFIX}:`)
}
/**
 * The terminal conclusion of one observation, in the ledger's own vocabulary.
 *
 * `canceled` gets its own value because somebody stopping our job is not a candidate defect: a job
 * we (or an operator, or the cluster) stopped says nothing about the code it was evaluating, and
 * recording it as `failed` hands the next round a bug that never existed. `lost` stays itself for the
 * same reason — the platform forgot the job, it did not run it badly.
 *
 * `undefined` means "still in flight": only a terminal observation has an outcome.
 *
 * @param {{state?: string, error_class?: string}} observation a poll/collect answer
 */
export function outcomeOf(observation) {
  const state = observation?.state
  if (state === 'succeeded') return 'succeeded'
  if (state === 'lost') return 'lost'
  if (state === 'failed') return observation?.error_class === 'canceled' ? 'canceled' : 'failed'
  return undefined
}

/** Every terminal outcome a ledger row may carry. */
export const OUTCOMES = Object.freeze(['succeeded', 'failed', 'canceled', 'lost'])

/** Job statuses after which the cluster will do nothing more on its own. */
const TERMINAL_STATUSES = Object.freeze(['SUCCEEDED', 'FAILED', 'STOPPED', 'LOST'])

/**
 * One row of the cluster's listing, in words this repository can use.
 *
 * The marker is read from the first channel that has it: a top-level `marker`, the job's
 * `metadata.marker` (what we send), and finally the `submission_id` itself (what the listing always
 * answers with — measured: the live listing carried no `metadata` on any row). Reading all three is
 * what makes an orphan visible on a cluster that dropped one of them, and it cannot invent a job:
 * each channel is parsed by the same vocabulary, and anything else stays `null`.
 *
 * Tolerant about a missing `job_id` too, because the listing is somebody else's data. `reference` is
 * the id to use when talking about the job afterwards: the cluster's own id when it has one, the
 * submission id when it does not — measured on Ray 2.59, `GET|POST /api/jobs/<submission_id>`
 * resolves for rows whose document reports `job_id: null`, so a null id is not a job that cannot be
 * addressed.
 */
export function readListingRow(raw) {
  const row = raw ?? {}
  const metadataMarker = row.metadata?.[MARKER_KEY]
  const marker =
    typeof row.marker === 'string'
      ? row.marker
      : typeof metadataMarker === 'string'
        ? metadataMarker
        : markerFromSubmissionId(row.submission_id)
  const parsed = parseMarker(marker)
  const jobId = typeof row.job_id === 'string' && row.job_id !== '' ? row.job_id : null
  const submissionId = typeof row.submission_id === 'string' && row.submission_id !== '' ? row.submission_id : null
  const status = String(row.status ?? row.state ?? '').toUpperCase()
  const metadataRound = Number(row.metadata?.round)
  return {
    job_id: jobId,
    submission_id: submissionId,
    reference: jobId ?? submissionId,
    marker: typeof marker === 'string' ? marker : null,
    baseline: parsed?.baseline === true,
    candidate_id: parsed?.candidateId ?? (typeof row.metadata?.candidate_id === 'string' ? row.metadata.candidate_id : null),
    round: parsed?.round ?? (Number.isSafeInteger(metadataRound) ? metadataRound : null),
    status,
    terminal: TERMINAL_STATUSES.includes(status),
  }
}

/**
 * The ledger view: which listed jobs are ours, which carry our marker with no ledger row (orphans),
 * and which belong to somebody else.
 *
 * A view in the strict sense — computed from the ledger's facts plus one live listing, never cached
 * back. Deleting it loses nothing; that is what makes it safe to answer "what is running" from a
 * mutable external world.
 *
 * `read: false` is a first-class answer: an unreadable listing must never be handed back as "there
 * are none", because that is the answer somebody acts on.
 *
 * @param {{rows: object[], listing: {ok: boolean, jobs?: object[], message?: string}}} input
 */
export function jobReport({ rows = [], listing } = {}) {
  const read = listing?.ok === true && Array.isArray(listing.jobs)
  const reason = read ? undefined : (listing?.message ?? 'the executor returned no job listing')
  const bySubmission = new Map(rows.map((row) => [row.submission_id, row]))
  // A listing row and a ledger row can name the same job in two vocabularies: the ledger writes the
  // marker into its `submission_id` (`reprise:candidate=<id>:round=<n>`), while a cluster that keeps
  // metadata reports the same marker in `metadata.marker` and an older submission id in the row. So
  // identity is the *candidate and round*, which both vocabularies carry, and the submission id is
  // only the fast path — without this, a recorded job reads as an orphan of itself.
  const identity = (candidateId, round) =>
    candidateId === null || candidateId === undefined ? undefined : `${candidateId}#${round ?? ''}`
  const byIdentity = new Map()
  for (const row of rows) {
    const marker = parseMarker(row.marker)
    const key = identity(row.candidate_id ?? marker?.candidateId, row.round ?? marker?.round)
    if (key !== undefined) byIdentity.set(key, row)
  }
  const ours = []
  const orphans = []
  const foreign = []
  const unlisted = []
  const seen = new Set()

  if (read) {
    for (const raw of listing.jobs) {
      const job = readListingRow(raw)
      const known =
        (job.submission_id === null ? undefined : bySubmission.get(job.submission_id)) ??
        byIdentity.get(identity(job.candidate_id, job.round))
      if (known !== undefined) {
        seen.add(known.submission_id)
        ours.push({ ...job, round: known.round ?? job.round, outcome: known.outcome ?? null, error_class: known.error_class ?? null })
      } else if (carriesOurPrefix(job.marker) || parseMarker(job.marker) !== undefined) {
        orphans.push(job)
      } else {
        foreign.push(job)
      }
    }
    // Recorded but no longer listed: the job is gone from the cluster's view. Reported, not judged —
    // a finished job may legitimately drop out of a listing.
    for (const row of rows) if (!seen.has(row.submission_id)) unlisted.push(row)
  }

  return { read, ...(reason === undefined ? {} : { reason }), ledger: rows, ours, orphans, foreign, unlisted }
}

/**
 * The cluster's listing, or an honest "we could not look".
 *
 * An executor that never implemented `list()` is not an error — the local executor has no cluster to
 * be shared with — but it does mean orphans cannot be told from strangers, and saying that is
 * different from answering "there are none".
 */
export async function readListing(platform) {
  if (typeof platform?.list !== 'function') {
    return { ok: false, message: 'this executor cannot list its jobs, so an orphan cannot be told from somebody else\u2019s work' }
  }
  try {
    const answer = await platform.list()
    if (answer?.ok === true && Array.isArray(answer.jobs)) return answer
    return { ok: false, message: answer?.message ?? 'the executor returned an unreadable job listing' }
  } catch (error) {
    return { ok: false, message: `the job listing could not be read: ${error?.message ?? error}` }
  }
}

/**
 * Stop the orphans a person explicitly named. **Never** called from a tick.
 *
 * Why an explicit action and not a side effect: the cluster had 106 jobs from other work before this
 * ledger existed, and the difference between "ours but unrecorded" and "somebody else's" is a marker
 * inside a string field. A heartbeat that acts on that difference kills a stranger's training the
 * first time a marker is wrong; a person reading a list does not.
 *
 * It refuses, with the reason, anything the view does not call an orphan: a foreign job, a job the
 * ledger knows (that one is collected through its candidate's state), an already-finished job, and an
 * id nobody has heard of. Refusals are answers, not exceptions — the caller asked about four ids and
 * should be told about four ids.
 *
 * @param {{platform: object, store: object, report: object, jobIds?: string[], now?: number}} input
 * @returns {Promise<{stopped: object[], refusals: {job_id: string, reason: string}[]}>}
 */
export async function reapOrphans({ platform, store, report, jobIds = [], now = Date.now() }) {
  if (report?.read !== true) {
    return { stopped: [], refusals: jobIds.map((jobId) => ({ job_id: jobId, reason: `the cluster listing was not read (${report?.reason ?? 'unknown'})` })) }
  }

  const stopped = []
  const refusals = []
  for (const jobId of jobIds) {
    const matches = (job) => job.job_id === jobId || job.submission_id === jobId || job.reference === jobId
    const candidate = report.orphans.find(matches)

    if (candidate === undefined) {
      const foreign = report.foreign.find(matches)
      const ours = report.ours.find(matches) ?? report.ledger.find((row) => row.job_id === jobId || row.submission_id === jobId)
      if (foreign !== undefined) {
        refusals.push({ job_id: jobId, reason: 'not ours: this job carries no marker written by this repository, so nothing here may stop it' })
      } else if (ours !== undefined) {
        refusals.push({ job_id: jobId, reason: 'the ledger knows this job; collect it through its candidate\u2019s state, not with an orphan sweep' })
      } else {
        refusals.push({ job_id: jobId, reason: 'not in the cluster listing' })
      }
      continue
    }

    if (candidate.terminal === true) {
      refusals.push({ job_id: jobId, reason: `already finished (status ${candidate.status || 'unknown'}); there is nothing to stop` })
      continue
    }

    const canceled = await platform.cancel(candidate.reference)
    if (canceled?.accepted !== true) {
      refusals.push({ job_id: jobId, reason: `the cluster did not accept the stop (state ${canceled?.state_after ?? 'unknown'})` })
      continue
    }

    store.logOp(
      'orphan_reaped',
      {
        job_id: candidate.job_id,
        submission_id: candidate.submission_id,
        marker: candidate.marker,
        status: candidate.status,
        state_after: canceled.state_after,
      },
      now,
    )
    stopped.push(candidate)
  }
  return { stopped, refusals }
}

// ------------------------------------------------------- GPU exclusivity

/**
 * The two ways a run may claim the cards, and there are exactly two.
 *
 * `single_job` — at most one training job of ours is in flight, so nothing we start competes with
 * anything else we started. `cuda_visible_devices` — every submission pins its own devices, so two
 * jobs may run as long as they were given disjoint cards.
 *
 * They cannot both be true: the first says "we own the node while we run", the second says "we own a
 * slice of it". A configuration that declares both is refused at boot (`config.js`), and one that
 * declares neither is warned about by name (`warnings.js`) — the cluster reserves nothing, measured.
 */
export const GPU_EXCLUSIVITY = Object.freeze(['single_job', 'cuda_visible_devices'])

/** `0`, `0,1`, `2, 3` — a comma-separated list of device indices, nothing else. */
const DEVICE_LIST = /^\d+(,\s*\d+)*$/

/** The exclusivity this configuration chose, or `undefined` when it declared neither. */
export function gpuExclusivityOf(config) {
  const executor = config?.executor ?? {}
  if (executor.gpu_exclusivity !== undefined) return executor.gpu_exclusivity
  // Naming the devices *is* choosing to write them; the mode word is then redundant rather than
  // required, because two spellings of one decision must not disagree about which one was made.
  if (executor.cuda_visible_devices !== undefined) return 'cuda_visible_devices'
  return undefined
}

/** The devices to write into a submission, when that is the chosen mode. */
export function cudaVisibleDevicesOf(config) {
  if (gpuExclusivityOf(config) !== 'cuda_visible_devices') return undefined
  const devices = config?.executor?.cuda_visible_devices
  return typeof devices === 'string' ? devices.replace(/\s+/g, '') : undefined
}

/**
 * What is wrong with the exclusivity declaration, if anything. Refusals only — the "declared
 * neither" case is a warning, because it is legal and merely dangerous.
 *
 * @param {object} executor the resolved executor entry (run or domain pack)
 * @returns {string[]} one message per problem, phrased for the person editing the config
 */
export function gpuExclusivityProblems(executor) {
  const problems = []
  const mode = executor?.gpu_exclusivity
  const devices = executor?.cuda_visible_devices

  if (mode !== undefined && !GPU_EXCLUSIVITY.includes(mode)) {
    problems.push(
      `executor.gpu_exclusivity must be one of ${GPU_EXCLUSIVITY.join(', ')} (got ${JSON.stringify(mode)}) — ` +
        'either only one training job at a time, or each submission writes its own CUDA_VISIBLE_DEVICES',
    )
  }
  if (devices !== undefined && (typeof devices !== 'string' || !DEVICE_LIST.test(devices))) {
    problems.push(
      `executor.cuda_visible_devices must be a comma-separated list of device indices, e.g. "0,1,2,3" ` +
        `(got ${JSON.stringify(devices)}) — the value is handed to the job verbatim`,
    )
  }
  if (devices !== undefined && mode === 'single_job') {
    problems.push(
      'executor declares gpu_exclusivity: single_job and cuda_visible_devices at once — those are two different ' +
        'claims about who owns the cards; keep one',
    )
  }
  if (mode === 'cuda_visible_devices' && devices === undefined) {
    problems.push(
      'executor.gpu_exclusivity is cuda_visible_devices but executor.cuda_visible_devices is not set — the submission ' +
        'would claim exclusivity and write nothing',
    )
  }
  return problems
}
