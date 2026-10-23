#!/usr/bin/env node
/**
 * The candidate implementer for the laptop path.
 *
 * In production this is a coding harness (`claude -p` or `dsh --profile headless`) pinned to the
 * candidate's worktree by `cwd`, briefed with the hypothesis, and cross-checked against git. Here it
 * is a *mechanical* implementer: it applies the hypothesis's own `change` object to
 * `model/structure.json`. That keeps the rest of LAND exactly as it will be in production — the child
 * runs with `cwd` set to the worktree, git alone decides which files changed, and this script's own
 * report is only a cross-check (a disagreement is recorded as `conflict`, not as a bad candidate).
 *
 * It speaks the same stream format as the real adapters: newline-delimited JSON, ending with one
 * `{"type":"result", "result": "<text>"}` event whose text ends with the file report the adapter
 * cross-checks against git.
 *
 * Usage: node apply-change.mjs <candidateId> <hypotheses.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [candidateId, hypothesesPath] = process.argv.slice(2)

const fail = (message) => {
  // Both channels on purpose: the adapter's failure taxonomy reads stderr, `dump` shows the last
  // stderr line as the reason the candidate stopped, and a human reading `driver.log` wants it too.
  process.stderr.write(`apply-change: ${message}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error', result: `could not land: ${message}` })}\n`)
  process.exit(1)
}

if (candidateId === undefined || hypothesesPath === undefined) fail('usage: apply-change.mjs <candidateId> <hypotheses.json>')

let hypotheses
try {
  hypotheses = JSON.parse(readFileSync(hypothesesPath, 'utf8')).hypotheses ?? []
} catch (error) {
  fail(`cannot read ${hypothesesPath}: ${error.message}`)
}

// `r1-h2` → `h2`: the kernel owns the candidate id (`round` + hypothesis id), the hypothesis owns the change.
const hypothesisId = String(candidateId).split('-').at(-1)
const hypothesis = hypotheses.find((entry) => entry.id === hypothesisId)
if (hypothesis === undefined) fail(`no hypothesis ${JSON.stringify(hypothesisId)} in ${hypothesesPath}`)

// `cwd` is the worktree: this path is the only file the candidate is allowed to be reading.
const structurePath = join(process.cwd(), 'model', 'structure.json')
let structure
try {
  structure = JSON.parse(readFileSync(structurePath, 'utf8'))
} catch (error) {
  fail(`cannot read ${structurePath}: ${error.message} — is cwd the candidate worktree?`)
}

const next = { ...structure, ...(hypothesis.change ?? {}) }
if (JSON.stringify(next) === JSON.stringify(structure)) {
  // A no-op change would produce no diff, and a landing with no diff is not a candidate.
  fail(`hypothesis ${hypothesisId} changes nothing in model/structure.json`)
}
writeFileSync(structurePath, `${JSON.stringify(next, null, 2)}\n`)

const report = JSON.stringify({ files: ['model/structure.json'] })
process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: `recorded-${candidateId}`,
    result: `applied ${hypothesis.class} change ${JSON.stringify(hypothesis.change)} as ${candidateId}\n${report}`,
    usage: { total_cost_usd: 0, input_tokens: 0, output_tokens: 0 },
  })}\n`,
)