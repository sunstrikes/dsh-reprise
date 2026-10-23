/**
 * The judge: the model-facing half of the loop, and the guard that keeps a model opinion from
 * becoming a number.
 *
 * Five call sites exist, and they are the only places the loop consults a model:
 * LAND (briefing the implementer), VERIFY's adversarial review, CAND_ANALYZE, ROUND_PLAN and
 * ROUND_REFLECT. Each one's exit is an artifact — validated by the contract before the phase may
 * advance — so a model can influence the run only by producing something a validator accepts.
 *
 * Two decisions are visible everywhere in this file:
 *
 * **Numbers belong to the kernel.** Metrics come from the monitor, the comparison comes from the
 * metric contract, and the verdict (`improved` / `regressed` / `inconclusive`) is arithmetic done
 * here. The model is asked for prose and for one enum. If it returns a score anyway, nothing reads
 * it: there is no code path from a model-supplied number into an artifact field, the frontier or
 * the stop rule. That is stronger than "the model is asked not to score".
 *
 * **The judge records opinions; the contract decides.** VERIFY is a hybrid phase: the L1 static
 * checks are deterministic facts computed by the kernel, and the adversarial review is a model that
 * participates in the verdict. The judge does not silently merge them. When they disagree — the
 * review accepts while a static check failed — the artifact carries both, the contract returns
 * `conflict`, and the candidate stops with the disagreement on record. Merging here would erase the
 * one fact a human needs to tell "the candidate is bad" from "the gate is confused".
 *
 * @module
 */

import { isNonEmptyString, isPlainObject } from '@dsh-reprise/contract'

import { loadSkill, loadSkills, renderPrompt } from './skills.js'

// Registers `round_reflect` and `land_hypothesis` with the contract as a side effect of importing.
import './artifact-kinds.js'

/** What the model is asked to answer at each call site. Wire format lives in code, next to the parser. */
export const ANSWER_SHAPES = Object.freeze({
  land: '{"files": ["path/one", "path/two"]}',
  verify:
    '{"verdict": "accept" | "reject", "rationale": "<one or two sentences naming the file or symbol>", "concerns": [{"check": "<what you looked at>", "detail": "<what you found>"}]}',
  cand_analyze: '{"root_cause": "<the mechanism, in one or two sentences>"}',
  round_plan: '{"hypotheses": [{"id": "h1", "statement": "<one structural claim>", "expected_files": ["path/one"]}]}',
  round_reflect:
    '{"summary": "<what this round taught, in a few sentences>", "lessons": [{"statement": "<a generalisable lesson>", "evidence": "<the candidate or observation it came from>"}], "next_round_focus": ["<a concrete thing the next round should look at>"]}',
})

const VERDICTS = Object.freeze(['improved', 'regressed', 'inconclusive'])

// ---------------------------------------------------------------- helpers

const describe = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Read the model's answer as a JSON object, tolerating the prose models put around it.
 *
 * A fenced block and a "last JSON object in the text" pass are both here because both shapes are
 * what a real harness produces. What is *not* tolerated is a number where an object was asked for:
 * that returns `undefined`, and the call site fails closed.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown> | undefined}
 */
export function parseAnswer(raw) {
  if (isPlainObject(raw)) return raw
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined

  const attempts = [text]
  for (const match of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)) attempts.push(match[1].trim())
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open >= 0 && close > open) attempts.push(text.slice(open, close + 1))

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (isPlainObject(parsed)) return parsed
    } catch {
      // Try the next shape; a model that wrapped its JSON in prose is normal, not an error.
    }
  }
  return undefined
}

const asString = (value) => (isNonEmptyString(value) ? value.trim() : undefined)

/** A list of strings, dropping anything that is not a non-empty string. Never coerces numbers. */
const asStringList = (value) =>
  Array.isArray(value) ? value.map(asString).filter((entry) => entry !== undefined) : []

/**
 * The deterministic L1 checks of the VERIFY gate.
 *
 * These are deliberately facts the kernel can read without IO: they answer "is this candidate even
 * reviewable?" A deeper check (imports resolve, the tree builds) belongs to the phase worker that
 * has the worktree; it contributes checks through the same list, so the contract's rule — a verdict
 * contradicting a failed check is a conflict — covers it without changes here.
 *
 * @param {{ candidateId?: string, state?: any, parent?: any }} input
 * @returns {{ name: string, result: 'pass' | 'fail' }[]}
 */
export function defaultStaticChecks({ state, parent } = {}) {
  const round = state?.round
  return [
    { name: 'hypothesis_recorded', result: asString(state?.hypothesis) === undefined ? 'fail' : 'pass' },
    {
      name: 'round_recorded',
      result: Number.isSafeInteger(round) && round > 0 ? 'pass' : 'fail',
    },
    {
      name: 'parent_binding_frozen',
      result:
        typeof parent?.parent_commit === 'string' && /^[0-9a-f]{7,64}$/.test(parent.parent_commit)
          ? 'pass'
          : 'fail',
    },
  ]
}

/** A finite number, or undefined. The only door a number may enter an artifact through. */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * Which reported number is the primary metric. The metric contract names it; if it does not name
 * one, the first numeric key in sorted order is used so the choice is at least reproducible.
 *
 * @returns {{ metric: string, value: number } | undefined}
 */
export function pickMetric(metrics, name) {
  if (!isPlainObject(metrics)) return undefined
  const named = finite(metrics[name])
  if (named !== undefined) return { metric: name, value: named }
  const fallback = Object.keys(metrics)
    .filter((key) => finite(metrics[key]) !== undefined)
    .sort()[0]
  return fallback === undefined ? undefined : { metric: fallback, value: metrics[fallback] }
}

/**
 * Compare against the frozen baseline. No tolerance band: how much of a difference counts is a
 * metric-contract question, and inventing a threshold here would be the kernel deciding a domain
 * question. No comparable baseline means `inconclusive`, never a guess.
 *
 * @param {{ value: number } | undefined} observed
 * @param {number | undefined} baseline
 * @param {'higher' | 'lower'} direction
 */
export function compareMetric(observed, baseline, direction = 'higher') {
  if (observed === undefined || baseline === undefined) return 'inconclusive'
  if (observed.value === baseline) return 'inconclusive'
  const better = direction === 'lower' ? observed.value < baseline : observed.value > baseline
  return better ? 'improved' : 'regressed'
}

// ------------------------------------------------------------------ judge

/**
 * Everything domain-specific arrives as an argument from the pack (`domain.js`): the prompts
 * directory, the metric contract and the adjustable surface. There is deliberately no default for
 * any of them — a judge that fell back to a metric name or a prompt of its own would be the kernel
 * answering a domain question, and the answer would look exactly like a configured one.
 *
 * @param {{
 *   model: (request: { call_site: string, prompt: string, facts: object, answer_schema: string }) => Promise<unknown>,
 *   skillsDir: string,
 *   metric: { name: string, direction?: 'higher' | 'lower' | 'up' | 'down', contract_ref?: string },
 *   surface?: { files?: string[], keys?: string[], symbols?: string[] },
 *   baseline?: number | { value: number } | (() => number | { value: number } | undefined | Promise<number | { value: number } | undefined>),
 *   staticChecks?: (input: object) => { name: string, result: 'pass' | 'fail' }[],
 *   artifacts?: { write: (name: string, value: unknown) => unknown },
 *   packet?: (request: { call_site: string, facts: object }) => { lines?: string[], digest?: string } | undefined,
 * }} options
 */
export function createJudge({
  model,
  skillsDir,
  metric = {},
  surface,
  baseline,
  staticChecks = defaultStaticChecks,
  artifacts,
  packet,
} = {}) {
  if (typeof model !== 'function') {
    throw new TypeError(
      'a judge needs a model port — an async function that answers one structured request; nothing else may answer for it',
    )
  }
  if (typeof staticChecks !== 'function') throw new TypeError('staticChecks must be a function returning check results')
  if (!isNonEmptyString(skillsDir)) {
    throw new TypeError(
      'a judge needs skillsDir — the five prompts are the domain pack\'s, and the kernel ships none (see domain.js)',
    )
  }
  if (!isPlainObject(metric) || !isNonEmptyString(metric.name)) {
    throw new TypeError(
      'a judge needs the metric contract\'s primary metric (metric.name) — the domain pack declares it, and the kernel has no default',
    )
  }

  // Fail at construction, not mid-round: a missing skill produces a prompt with no instructions,
  // and a model without instructions still answers.
  loadSkills(skillsDir)

  const metricContract = Object.freeze({
    name: metric.name,
    direction: metric.direction === 'lower' || metric.direction === 'down' ? 'lower' : 'higher',
    contractRef: isNonEmptyString(metric.contract_ref) ? metric.contract_ref : metric.name,
  })

  // The adjustable surface, as the model sees it: which files, knobs and symbols a candidate may
  // touch. Absent means the domain declared none, and the prompt then says nothing rather than
  // inventing a whitelist; gate two is where an out-of-bounds change is refused (ticket 24).
  const allowedSurface =
    isPlainObject(surface)
      ? {
          files: Array.isArray(surface.files) ? surface.files : [],
          keys: Array.isArray(surface.keys) ? surface.keys : [],
          symbols: Array.isArray(surface.symbols) ? surface.symbols : [],
        }
      : undefined
  const surfaceFacts = allowedSurface === undefined ? {} : { allowed_surface: allowedSurface }

  const persist = (kind, candidateId, artifact) => {
    if (typeof artifacts?.write !== 'function') return artifact
    // The reference the fact plane records (`verify_verdict:<id>`) resolves to this name.
    artifacts.write(`${kind}:${candidateId}`, artifact)
    return artifact
  }

  /**
   * One request to the model, rendered from the skill on disk right now — so editing markdown
   * changes the very next prompt without a rebuild.
   *
   * A model port that throws is not allowed to kill the tick: the workspace may be hours into a run
   * and an upstream 503 must not take the loop down. Each call site fails closed instead, and says
   * why in its artifact.
   */
  const ask = async (callSite, facts) => {
    const skill = loadSkill(skillsDir, callSite)
    const answerSchema = ANSWER_SHAPES[callSite]

    // What the model is allowed to remember is a fact, not a rendering detail: the packet is built
    // by the memory layer from the workspace's own facts and handed over verbatim.
    let injection
    try {
      injection = typeof packet === 'function' ? packet({ call_site: callSite, facts }) : undefined
    } catch (error) {
      injection = { lines: [`(the injection packet could not be built: ${describe(error)})`] }
    }
    const prompt = renderPrompt(skill, { facts, answer: answerSchema, packet: injection?.lines ?? [] })
    let raw
    try {
      raw = await model({ call_site: callSite, prompt, facts, answer_schema: answerSchema })
    } catch (error) {
      return { answer: undefined, prompt, problem: `the model port failed: ${describe(error)}` }
    }
    const answer = parseAnswer(raw)
    if (answer === undefined) {
      return { answer: undefined, prompt, problem: 'the model did not return a JSON object' }
    }
    return { answer, prompt }
  }

  const baselineValue = async () => {
    const raw = typeof baseline === 'function' ? await baseline() : baseline
    const direct = finite(raw)
    if (direct !== undefined) return direct
    if (isPlainObject(raw)) return finite(raw.value)
    return undefined
  }

  /** The adversarial review, normalised into the one enum the gate consumes. */
  const reviewOf = (answer, problem) => {
    if (problem !== undefined) {
      return { verdict: 'reject', rationale: `the adversarial review could not be obtained: ${problem}`, concerns: [] }
    }
    const raw = answer.verdict
    const verdict = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    const rationale = asString(answer.rationale)
    const concerns = Array.isArray(answer.concerns)
      ? answer.concerns
          .filter(isPlainObject)
          .map((concern) => ({ check: asString(concern.check) ?? 'unspecified', detail: asString(concern.detail) ?? '' }))
      : []

    if (verdict !== 'accept' && verdict !== 'reject') {
      // Not an abstention. An unverified candidate that advances spends a GPU hour to learn nothing.
      return {
        verdict: 'reject',
        rationale: `the adversarial review did not answer accept or reject${rationale === undefined ? '' : `: ${rationale}`}`,
        concerns,
      }
    }
    return { verdict, rationale: rationale ?? (verdict === 'accept' ? 'accepted without comment' : 'rejected without comment'), concerns }
  }

  return {
    /**
     * VERIFY: L1 checks (kernel) + adversarial review (model), recorded side by side.
     *
     * `passed` is the review's answer, not a merge of the two opinions. The contract is the referee:
     * a pass that contradicts a failed check comes back as `conflict`, and the candidate stops with
     * both facts preserved.
     */
    async verify({ candidateId, state, parent, now, files } = {}) {
      const checks = staticChecks({ candidateId, state, parent, files })
      const facts = {
        candidate_id: candidateId,
        round: state?.round ?? null,
        hypothesis: state?.hypothesis ?? null,
        parent_binding: parent === undefined ? null : { parent_id: parent.parent_id ?? null, parent_commit: parent.parent_commit ?? null },
        files: Array.isArray(files) ? files : [],
        ...surfaceFacts,
        l1_checks: checks,
      }
      const { answer, problem } = await ask('verify', facts)
      const reviewer = reviewOf(answer, problem)
      return persist('verify_verdict', candidateId, {
        candidate_id: candidateId,
        passed: reviewer.verdict === 'accept',
        checks,
        reviewer,
        decided_at_ms: now,
      })
    },

    /**
     * CAND_ANALYZE: the numbers are read from the monitor and compared by code; the model supplies
     * the mechanism. `concluded` echoes `observed` on purpose — the contract rejects a report that
     * reasons from one value and reports another, which is the shape a "helpful" model would take
     * when it thinks the metric should have moved.
     */
    async analyze({ candidateId, state, job, collected, now } = {}) {
      // Where the numbers come from, in order: what `collect()` fetched, what the monitor recorded
      // when it saw the job succeed (MONITOR_POLL hands the metrics over on the candidate state),
      // and whatever the job ledger carries. Three sources because a platform may report metrics at
      // submit-poll time, only on collect, or both — and an analysis that silently reasoned from an
      // empty object would produce a confident report about nothing.
      const metrics = [collected?.metrics, state?.metrics, job?.metrics].find(isPlainObject) ?? {}
      const observed = pickMetric(metrics, metricContract.name)
      const frozenBaseline = await baselineValue()
      const verdict = compareMetric(observed, frozenBaseline, metricContract.direction)

      const facts = {
        candidate_id: candidateId,
        round: state?.round ?? null,
        hypothesis: state?.hypothesis ?? null,
        metric_contract: { name: metricContract.name, direction: metricContract.direction, contract_ref: metricContract.contractRef },
        observed: observed ?? null,
        baseline: frozenBaseline ?? null,
        verdict,
        reported_metrics: metrics,
      }
      const { answer } = await ask('cand_analyze', facts)
      // Kept as the model wrote it, not coerced: an absent root cause is `missing` (nothing was
      // produced) and an empty one is `invalid` (something was produced that is not a finding).
      // Collapsing both into `undefined` here would undo the distinction the contract exists for.
      const rootCause = typeof answer?.root_cause === 'string' ? answer.root_cause.trim() : undefined

      return persist('analyze_report', candidateId, {
        candidate_id: candidateId,
        verdict: VERDICTS.includes(verdict) ? verdict : 'inconclusive',
        root_cause: rootCause,
        observed,
        concluded: observed === undefined ? undefined : { metric: observed.metric, value: observed.value },
        at_ms: now,
      })
    },

    /**
     * ROUND_PLAN: the model proposes the round's structural hypotheses; the kernel owns the round
     * number, the metric-contract reference and the hypothesis ids.
     *
     * Ids are assigned here rather than trusted from the answer because identity is the kernel's
     * (a candidate is created from `round` + hypothesis id). Content — the statement and the files
     * it expects to touch — is the model's, verbatim, and the contract decides whether it is usable.
     */
    async plan({ round, facts } = {}) {
      const { answer } = await ask('round_plan', { ...facts, round })
      const raw = Array.isArray(answer?.hypotheses) ? answer.hypotheses : []
      const hypotheses = raw.map((hypothesis, index) => {
        if (!isPlainObject(hypothesis)) return hypothesis
        return {
          id: asString(hypothesis.id) ?? `h${index + 1}`,
          statement: typeof hypothesis.statement === 'string' ? hypothesis.statement.trim() : undefined,
          expected_files: asStringList(hypothesis.expected_files),
        }
      })
      return {
        round,
        hypotheses,
        metric_contract_ref: metricContract.contractRef,
      }
    },

    /**
     * ROUND_REFLECT: what the finished round taught. Text and structure only — there is deliberately
     * no field for "stop", because the stop rule is measured in code and a model's recommendation is
     * not an input to it.
     */
    async reflect({ round, facts, now } = {}) {
      const { answer } = await ask('round_reflect', { ...facts, round })
      const lessons = Array.isArray(answer?.lessons)
        ? answer.lessons.map((lesson) =>
            isPlainObject(lesson)
              ? { statement: typeof lesson.statement === 'string' ? lesson.statement.trim() : undefined, evidence: asString(lesson.evidence) }
              : lesson,
          )
        : []

      return {
        round,
        summary: typeof answer?.summary === 'string' ? answer.summary.trim() : undefined,
        lessons,
        next_round_focus: asStringList(answer?.next_round_focus),
        at_ms: now,
      }
    },

    /**
     * LAND: freeze the hypothesis this candidate exists to test, and brief the implementer from the
     * markdown skill. No model call here — the model at this phase is the coding harness inside the
     * worktree, not the judge. What this entry owns is that the hypothesis is complete *before* the
     * worktree is touched: a candidate that names no file cannot be landed or reviewed.
     */
    async land({ candidateId, round, hypothesis, now } = {}) {
      const skill = loadSkill(skillsDir, 'land')
      const statement = typeof hypothesis?.statement === 'string' ? hypothesis.statement.trim() : hypothesis?.statement
      const artifact = {
        candidate_id: candidateId,
        round,
        hypothesis_id: hypothesis?.id ?? null,
        statement,
        expected_files: Array.isArray(hypothesis?.expected_files) ? hypothesis.expected_files : [],
        metric_contract_ref: metricContract.contractRef,
        frozen_at_ms: now,
      }
      const prompt = renderPrompt(skill, {
        facts: {
          candidate_id: candidateId,
          round,
          hypothesis: { id: hypothesis?.id ?? null, statement: statement ?? null, expected_files: hypothesis?.expected_files ?? [] },
          metric_contract: { name: metricContract.name, direction: metricContract.direction, contract_ref: metricContract.contractRef },
          ...surfaceFacts,
        },
        answer: ANSWER_SHAPES.land,
      })
      return { artifact: persist('land_hypothesis', candidateId, artifact), prompt }
    },
  }
}