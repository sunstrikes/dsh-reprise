#!/usr/bin/env node
/**
 * Step 3 of the five-minute path: the domain pack you own, on one screen, with what to change in each.
 *
 * The ticket's second criterion is that a metric's *direction*, its *role* and the *structural
 * hypothesis classes* are configuration, not code. This command is that claim made checkable: it reads
 * the pack the loop reads — `domain.json` names the parts, and every line below points at one of them
 * — and prints where each of those three lives. Nothing here is inferred: a line that lies would be
 * visible in the file it points at.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const say = (line = '') => process.stdout.write(`${line}\n`)
const read = (name) => JSON.parse(readFileSync(join(HERE, name), 'utf8'))

const manifest = read('domain.json')
const contract = read(manifest.metric_contract)
const priors = read(manifest.priors)
const surface = read(manifest.surface)
const executor = read(manifest.executor)
const hypotheses = read('hypotheses.json')
const config = read('config.json')

const rule = (title) => {
  say('')
  say(title)
  say('-'.repeat(title.length))
}

rule('0. the domain pack — examples/feed-structure/domain.json')
say(`  name           ${manifest.name}`)
say(`  metric         ${manifest.metric_contract}`)
say(`  priors         ${manifest.priors}`)
say(`  surface        ${manifest.surface}`)
say(`  prompts        ${manifest.prompts}/  (land, verify, cand-analyze, round-plan, round-reflect)`)
say(`  executor       ${manifest.executor}`)
say('  the kernel reads all five from here; nothing about this domain lives in the code')

rule(`1. the metric contract — examples/feed-structure/${manifest.metric_contract}`)
say(`  primary        ${contract.primary} (${contract.direction})`)
say(`  objectives     ${JSON.stringify(contract.objectives)}  ← the frontier ranks exactly these`)
for (const [name, role] of Object.entries(contract.role)) say(`  role           ${name.padEnd(14)} ${role}`)
say(`  change a direction here (and in config.json): ${JSON.stringify(contract.objectives)} / rounds.metric.direction`)

rule(`2. the adjustable surface — examples/feed-structure/${manifest.surface}`)
say(`  files          ${surface.files.join(', ')}   ← a candidate's diff is checked against this whitelist`)
say(`  keys           ${(surface.keys ?? []).join(', ') || '(none)'}`)
say(`  symbols        ${(surface.symbols ?? []).join(', ') || '(none)'}`)
say('  a change outside this surface is out of bounds; the keys are the knobs priors.json gives values for')

rule(`3. the priors — examples/feed-structure/${manifest.priors}`)
for (const [name, entry] of Object.entries(priors.search_space)) {
  say(`  space          ${name.padEnd(14)} ${entry.kind.padEnd(18)} ${JSON.stringify(entry.values)}`)
}
say(`  classes        ${priors.hypothesis_classes.map((entry) => entry.id).join(', ')}`)
say(`                 a hypothesis whose class is not declared here makes the plan refused`)
for (const prior of priors.priors) say(`  prior          ${prior.statement}`)
say('  frozen         node examples/feed-structure/init.mjs writes priors.manifest.json (sha256 of what you started from)')

rule('4. this round’s hypotheses — examples/feed-structure/hypotheses.json')
const perRound = config.rounds.candidates_per_round
for (const [index, hypothesis] of hypotheses.hypotheses.entries()) {
  const runs = index < perRound ? 'runs' : 'does not run'
  say(`  ${hypothesis.id.padEnd(3)} ${hypothesis.class.padEnd(15)} ${hypothesis.statement}`)
  say(`      change ${JSON.stringify(hypothesis.change)}  (${runs}: rounds.candidates_per_round = ${perRound})`)
}
say(`  to run the third: set rounds.candidates_per_round to ${hypotheses.hypotheses.length} in config.json — no code change`)

rule('5. the wiring — examples/feed-structure/config.json')
say(`  domain         ${config.domain}   (the pack every line above comes from)`)
say(`  executor       ${executor.kind}: ${executor.command.join(' ')}   (cwd = the candidate worktree, from ${manifest.executor})`)
say(`  candidate      ${config.candidate.kind}: ${config.candidate.command.join(' ')}`)
say(`  model          ${config.model.command.join(' ')}`)
say(`  runner         repo=${config.runner.repo} dir=${config.runner.dir} base=${config.runner.base_ref}`)
say(`  budget         gpu_hours_limit=${config.budget.gpu_hours_limit} (0 = unlimited) candidate_gpu_hours=${config.budget.candidate_gpu_hours}`)
say(`  rounds         max_rounds=${config.rounds.max_rounds} candidates_per_round=${perRound}`)
say('')
say('every one of those is a file a text editor can change; none of them is code.')