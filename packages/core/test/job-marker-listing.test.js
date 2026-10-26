/**
 * Guards the fix for a marker that was never where we looked.
 *
 * Measured on the live cluster, not a theory. `GET http://10.92.7.207:8258/api/v0/jobs?limit=200`
 * answers 167 rows whose keys are exactly `job_id, submission_id, entrypoint, type, status, message,
 * error_type, driver_info` — **no row carries `metadata` at all**, and 80 rows have `job_id: null`.
 * The per-job route does carry metadata, so it is not lost, only absent from the listing. A marker
 * that lives only in `metadata` is therefore a marker the orphan view can never read: every job of
 * ours came back `foreign`, which is fail-closed and harmless but silently unable to report the
 * ticket's orphan bullet ("a job the ledger does not know, still running on the cluster, is listed").
 *
 * So the identity travels on `submission_id`, which always survives:
 *
 *  1. **One builder, two readings.** `submissionIdFor` is the single derivation of a job's name and
 *     equals the marker by construction; `parseMarker` / `markerFromSubmissionId` read that same
 *     vocabulary back from whichever channel the cluster used, and refuse anything that is not ours
 *     (`raysubmit_…`, `autotrain-smoke-…`) rather than inventing a candidate from it.
 *  2. **A listing with no `metadata` still classifies everything.** Ours, orphans, foreign and
 *     unlisted all come out of a listing shaped like the measured one, including a null `job_id`.
 *  3. **The id is the idempotency key, round included.** The same candidate in the same round is the
 *     same id (a resubmission after a crash resolves to the same job); a different round is a
 *     different id, because two attempts of one candidate are two jobs.
 *  4. **`metadata` keeps working.** Clusters that do carry it are still read, so the fix adds a
 *     channel rather than replacing one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  baselineMarker,
  jobMarker,
  jobReport,
  markerFromSubmissionId,
  parseMarker,
  readListingRow,
  submissionIdFor,
} from '../lib/jobs.js'

/** The id of the one job a candidate ran in one round: the same string on both channels. */
const CANDIDATE_1_1 = 'reprise:candidate=r1-h1:round=1'

/**
 * One row in the shape the live cluster actually sends.
 *
 * The key set is the measurement, and that is the whole point of this fixture: a row built from a
 * convenient superset (with `metadata` on it) would pass while the real cluster still answered
 * `foreign` for everything.
 */
function listingRow({ jobId = 'raysubmit_0101', submissionId, status = 'RUNNING' }) {
  return {
    job_id: jobId,
    submission_id: submissionId,
    entrypoint: 'python -m train --config cfg/train.yaml',
    type: 'SUBMISSION',
    status,
    message: null,
    error_type: null,
    driver_info: null,
  }
}

/** A ledger row as `loop.js` writes it: the submission id and the marker are one string. */
function ledgerRow({ candidateId, round, jobId, outcome = null }) {
  return {
    job_id: jobId,
    candidate_id: candidateId,
    submission_id: submissionIdFor({ candidateId, round }),
    marker: submissionIdFor({ candidateId, round }),
    kind: 'candidate',
    round,
    state: 'running',
    outcome,
    error_class: null,
  }
}

test('the submission id is the marker, and either channel reads back as the same job', () => {
  const submissionId = submissionIdFor({ candidateId: 'r2-h1', round: 2 })

  assert.equal(submissionId, 'reprise:candidate=r2-h1:round=2')
  assert.equal(
    submissionId,
    jobMarker({ candidateId: 'r2-h1', round: 2 }),
    'one derivation per concept: the id we submit under and the marker we write are the same string',
  )
  assert.deepEqual(parseMarker(submissionId), { candidateId: 'r2-h1', round: 2 })
  assert.equal(markerFromSubmissionId(submissionId), submissionId, 'the submission id reads back as our marker')

  assert.equal(submissionIdFor({ baseline: true }), 'reprise:baseline')
  assert.equal(submissionIdFor({ baseline: true }), baselineMarker(), 'the baseline has one name too')
  assert.deepEqual(parseMarker('reprise:baseline'), { baseline: true })
  assert.equal(markerFromSubmissionId('reprise:baseline'), 'reprise:baseline')
})

test('a foreign id never parses into one of ours', () => {
  for (const foreign of ['raysubmit_0001', 'autotrain-smoke-1792741140', 'someone-elses-work', '', undefined, null, 42]) {
    assert.equal(parseMarker(foreign), undefined, `${JSON.stringify(foreign)} is not ours`)
    assert.equal(markerFromSubmissionId(foreign), undefined, `${JSON.stringify(foreign)} is not ours`)
  }
})

test('the same candidate and round always produce the same submission id; another round does not', () => {
  const once = submissionIdFor({ candidateId: 'r2-h1', round: 2 })
  const twice = submissionIdFor({ candidateId: 'r2-h1', round: 2 })
  assert.equal(once, twice, 'submit is idempotent: the same candidate and round cannot bill twice')

  const nextRound = submissionIdFor({ candidateId: 'r2-h1', round: 3 })
  assert.notEqual(nextRound, once, 'two attempts of one candidate are two jobs, and the listing must tell them apart')
  assert.notEqual(submissionIdFor({ candidateId: 'r2-h2', round: 2 }), once, 'and two candidates are never one job')

  assert.equal(
    submissionIdFor({ baseline: true }),
    'reprise:baseline',
    'the baseline is one job per workspace, so its id carries no round to compare',
  )
})

test('a listing row without metadata still says which job it is', () => {
  const row = listingRow({ submissionId: CANDIDATE_1_1 })

  assert.deepEqual(Object.keys(row).sort(), [
    'driver_info',
    'entrypoint',
    'error_type',
    'job_id',
    'message',
    'status',
    'submission_id',
    'type',
  ])
  assert.equal(row.metadata, undefined, 'the fixture is the measured shape: the cluster does not send metadata')

  const job = readListingRow(row)
  assert.equal(job.marker, CANDIDATE_1_1, 'the submission id is the marker when metadata is absent')
  assert.equal(job.candidate_id, 'r1-h1')
  assert.equal(job.round, 1)
  assert.equal(job.baseline, false)
  assert.equal(job.reference, 'raysubmit_0101')

  const unreadable = readListingRow(listingRow({ jobId: null, submissionId: 'autotrain-smoke-1792741140' }))
  assert.equal(unreadable.marker, null, 'somebody else\u2019s id names nothing of ours')
  assert.equal(unreadable.candidate_id, null)
  assert.equal(unreadable.reference, 'autotrain-smoke-1792741140', 'a null job id still leaves the job addressable')
})

test('ours, orphans, foreign and unlisted all come out of a listing that carries no metadata', () => {
  const rows = [
    ledgerRow({ candidateId: 'r1-h1', round: 1, jobId: 'raysubmit_0101', outcome: 'succeeded' }),
    // Recorded, but the cluster no longer lists it: reported, never judged.
    ledgerRow({ candidateId: 'r3-h1', round: 3, jobId: 'raysubmit_0303' }),
  ]
  const listing = {
    ok: true,
    jobs: [
      // Ours, and the cluster's own id is null — 80 of 167 measured rows look like this.
      listingRow({ jobId: null, submissionId: CANDIDATE_1_1, status: 'SUCCEEDED' }),
      // Our marker, no ledger row: submitted by a process that died before recording it.
      listingRow({ jobId: 'raysubmit_0202', submissionId: submissionIdFor({ candidateId: 'r2-h9', round: 2 }) }),
      // Other teams' work, which is never actionable from here.
      listingRow({ jobId: 'raysubmit_9001', submissionId: 'autotrain-smoke-1792741140', status: 'FAILED' }),
      listingRow({ jobId: null, submissionId: 'raysubmit_9002' }),
    ],
  }

  const report = jobReport({ rows, listing })

  assert.equal(report.read, true)
  assert.deepEqual(report.ours.map((job) => job.submission_id), [CANDIDATE_1_1])
  assert.equal(report.ours[0].job_id, null, 'a null cluster id is not a reason to lose the job')
  assert.equal(report.ours[0].outcome, 'succeeded', 'the ledger row supplies the outcome the listing does not carry')
  assert.equal(report.ours[0].round, 1)

  assert.deepEqual(report.orphans.map((job) => job.submission_id), ['reprise:candidate=r2-h9:round=2'])
  assert.equal(report.orphans[0].reference, 'raysubmit_0202', 'the orphan is addressable, so it can be stopped by name')

  assert.deepEqual(
    report.foreign.map((job) => job.submission_id).sort(),
    ['autotrain-smoke-1792741140', 'raysubmit_9002'],
    'a job with no identity of ours stays foreign: that is what keeps an automatic stop away from other teams',
  )

  assert.deepEqual(report.unlisted.map((row) => row.submission_id), [submissionIdFor({ candidateId: 'r3-h1', round: 3 })])
})

test('the metadata channel still classifies a job on a cluster that carries it', () => {
  // A row whose submission id says nothing to us, but whose metadata holds our marker: the older
  // channel, kept because the fix adds a reading rather than replacing one.
  const job = readListingRow({
    job_id: 'raysubmit_0404',
    submission_id: 'legacy-submission',
    status: 'RUNNING',
    metadata: { marker: jobMarker({ candidateId: 'r4-h1', round: 4 }) },
  })

  assert.equal(job.marker, 'reprise:candidate=r4-h1:round=4')
  assert.equal(job.round, 4)

  const report = jobReport({ rows: [], listing: { ok: true, jobs: [{ job_id: 'raysubmit_0404', submission_id: 'legacy-submission', status: 'RUNNING', metadata: { marker: jobMarker({ candidateId: 'r4-h1', round: 4 }) } }] } })
  assert.deepEqual(report.orphans.map((entry) => entry.submission_id), ['legacy-submission'])
})