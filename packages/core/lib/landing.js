/**
 * The landing's own record: what the implementer was asked, and what it left in the tree.
 *
 * LAND is the one phase whose work happens outside this process — a child edits a worktree the
 * runner owns — so, unlike every other phase, repeating it is not neutral. The second run meets a
 * tree that already carries the first run's edit. Ticket 28 measured what that costs on a real
 * workspace: after a retry the implementer was asked to make the same edit twice, and the second run
 * exited 1 because the line it had been told to change already held the new value. The candidate was
 * then rejected for its own progress.
 *
 * Two facts survive that crash window, and this module reads both:
 *
 *  - **the landing record**, filed by the port the moment the child exits (`recordLandCall` in
 *    `ports.js`). It is therefore older than anything the kernel writes afterwards, and it carries
 *    the prompt the implementer was given, the answer it produced and the diff inventory git
 *    reported.
 *  - **`land_done`**, the kernel's own fact, written after the frozen parent binding. A crash between
 *    that event and the state row leaves it on disk with a phase row that still says LAND.
 *
 * A LAND that finds either for its own candidate **and round** has already done its work. Everything
 * else — no artifact store, a landing that never returned, a record belonging to a different round —
 * means the phase has not done its work yet, and running the implementer is then correct.
 *
 * @module
 */

import { modelCallName } from '@dsh-reprise/exec/model'

/**
 * Where the landing's record is filed.
 *
 * The name is not spelled here: it is the one the port writes through the same builder, so a change
 * to the audit trail's layout cannot silently make LAND stop finding its own work.
 */
export const landingRecordName = (candidateId) => modelCallName({ call_site: 'land', subject: candidateId })

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value !== ''

const filesOf = (value) =>
  Array.isArray(value) ? value.filter((file) => typeof file === 'string' && file !== '') : []

const textOrNull = (value) => (isText(value) ? value : null)

/**
 * The newest `land_done` this round produced, if any.
 *
 * A payload written before `round` became part of it belongs to whatever round the candidate was in
 * when it landed — there was no other, so it is not ambiguous.
 */
function landDoneEvent(store, candidateId, round) {
  if (typeof store?.eventsFor !== 'function') return undefined
  const wanted = round ?? null
  return store
    .eventsFor(candidateId)
    .filter((event) => event.event_type === 'land_done')
    .reverse()
    .find((event) => event.payload?.round === undefined || (event.payload.round ?? null) === wanted)
}

/**
 * What this phase already did for this candidate and round.
 *
 * @param {{store?: any, artifacts?: any}} workspace the fact plane and the artifact store
 * @param {{candidateId: string, round?: number}} subject
 * @returns {{status: 'none'} | {
 *   status: 'landed' | 'conflict', source: 'event' | 'record', seq?: number,
 *   engine: string, files: string[], files_changed: number,
 *   parent_id: string | null, parent_commit: string | undefined, worktree_dir: string | undefined,
 *   message: string, record: string | undefined,
 * }}
 */
export function recordedLanding({ store, artifacts } = {}, { candidateId, round } = {}) {
  if (!isText(candidateId)) return { status: 'none' }
  const wanted = round ?? null

  const event = landDoneEvent(store, candidateId, round)
  if (event !== undefined) {
    const payload = isObject(event.payload) ? event.payload : {}
    const files = filesOf(payload.files)
    return {
      status: 'landed',
      source: 'event',
      seq: event.local_seq,
      engine: textOrNull(payload.engine) ?? 'unknown',
      files,
      files_changed: Number.isSafeInteger(payload.files_changed) ? payload.files_changed : files.length,
      parent_id: textOrNull(payload.parent_id),
      parent_commit: textOrNull(payload.parent_commit) ?? undefined,
      worktree_dir: textOrNull(payload.worktree_dir) ?? undefined,
      message: '',
      record: textOrNull(payload.record) ?? undefined,
    }
  }

  if (typeof artifacts?.read !== 'function') return { status: 'none' }
  const record = artifacts.read(landingRecordName(candidateId))
  if (!isObject(record)) return { status: 'none' }

  const facts = isObject(record.facts) ? record.facts : {}
  const answer = isObject(record.answer) ? record.answer : {}
  if (facts.candidate_id !== candidateId) return { status: 'none' }
  if ((facts.round ?? null) !== wanted) return { status: 'none' }
  // Without the commit the landing establishes no identity, and the whole binding chain hangs off
  // it: a record that cannot say whose child this candidate is cannot be adopted.
  if (!isText(answer.parent_commit)) return { status: 'none' }

  const files = filesOf(answer.files)
  const base = {
    source: 'record',
    engine: textOrNull(answer.engine) ?? 'unknown',
    files,
    files_changed: Number.isSafeInteger(answer.files_changed) ? answer.files_changed : files.length,
    parent_id: textOrNull(facts.parent_id),
    parent_commit: answer.parent_commit,
    worktree_dir: textOrNull(facts.worktree_dir) ?? undefined,
    message: textOrNull(answer.message) ?? 'the recorded landing failed',
    record: landingRecordName(candidateId),
  }

  // Two accounts of the same edit disagreeing is a contradiction the contract has a name for; it is
  // replayed as one rather than re-run, because re-running cannot resolve which account is right.
  if (answer.conflict === true || answer.cross_check === 'mismatch') return { status: 'conflict', ...base }

  // Work was left in the tree. Whether the implementer's own stream was readable is not a property
  // of that work: a `command` implementer that prints its own words is filed as an outage, and the
  // edit it made is still the edit this round asked for.
  if (answer.ok === true || files.length > 0) return { status: 'landed', ...base }

  return { status: 'none' }
}