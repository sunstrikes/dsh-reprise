#!/usr/bin/env node
/**
 * The model port for the laptop path — a *recording*, not a model.
 *
 * The kernel consults a model at five call sites and each answer must become an artifact a validator
 * accepts before a phase may advance. On a laptop with no provider, the honest substitute is a
 * command that replays recorded answers through the same wire format: one JSON request on stdin, one
 * JSON answer on stdout. Everything downstream — parsing, validation, fail-closed refusal — is the
 * real path.
 *
 * Replace it and nothing else changes: point `model.command` in `config.json` at a wrapper around
 * your engine (`claude -p`, `dsh --profile headless`). That path is *unverified in this checkout* —
 * the two candidate-harness adapters in `packages/exec` are also only tested against a fake CLI — so
 * treat the first real run as an integration exercise, not as a known-good configuration.
 *
 * Two behaviours worth knowing, because they are the ones you can watch:
 *
 *   - a hypothesis whose `class` is not declared in `priors.json` makes the plan *refused* rather
 *     than silently filtered — add a fourth hypothesis with `"class": "moonshot"` and see the run
 *     back off and then pause for a human;
 *   - round 2 replays round 1's hypotheses. The recording has one round of ideas; a real model would
 *     propose new ones from the reflection.
 *
 * Usage: node recorded-model.mjs <hypotheses.json> <recorded/judgement.json> <priors.json>
 */
import { readFileSync } from 'node:fs'

const [hypothesesPath, judgementPath, priorsPath] = process.argv.slice(2)

const readJson = (path) => {
  if (path === undefined) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
    })
    process.stdin.on('end', () => resolve(text))
  })
}

const request = JSON.parse((await readStdin()) || '{}')
const facts = request.facts ?? {}
const hypotheses = readJson(hypothesesPath).hypotheses ?? []
const judgement = readJson(judgementPath)
const priors = readJson(priorsPath)

/** The plan is the catalogue, filtered to the classes the priors declare and cut to what the round affords. */
function plan() {
  const classes = new Set((priors.hypothesis_classes ?? []).map((entry) => entry.id))
  const wanted = Number.isSafeInteger(facts.candidates_per_round) ? facts.candidates_per_round : hypotheses.length
  const selected = hypotheses.slice(0, Math.max(1, wanted))

  const undeclared = selected.find((hypothesis) => classes.size > 0 && !classes.has(hypothesis.class))
  if (undeclared !== undefined) {
    // An answer the contract will refuse, on purpose: a plan built on a prior nobody wrote down is
    // not a plan. The workspace records the refusal and backs off.
    return { refused: `hypothesis ${undeclared.id} claims class ${JSON.stringify(undeclared.class)}, which priors.json does not declare` }
  }

  return {
    hypotheses: selected.map((hypothesis) => ({
      id: hypothesis.id,
      statement: hypothesis.statement,
      expected_files: hypothesis.expected_files,
    })),
  }
}

function answer() {
  switch (request.call_site) {
    case 'round_plan':
      return plan()
    case 'verify':
      return judgement.verify ?? {}
    case 'cand_analyze':
      return judgement.cand_analyze?.[facts.candidate_id] ?? {}
    case 'round_reflect':
      return judgement.round_reflect ?? {}
    default:
      // Unknown call site: answer nothing rather than something plausible. The judge fails closed.
      return {}
  }
}

process.stdout.write(`${JSON.stringify(answer())}\n`)