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
 * metric contract — resolved once in `metric-contract.js`, so "which metric counts" and "how large a
 * difference counts" are answered in one place for this gate, the ranking and the stop rules — and
 * the verdict (`improved` / `regressed` / `inconclusive`) is arithmetic done here. The model is asked
 * for prose and for one enum. If it returns a score anyway, nothing reads it: there is no code path
 * from a model-supplied number into an artifact field, the frontier or the stop rule. That is
 * stronger than "the model is asked not to score".
 *
 * **One question, one answer, or one closed failure.** Every entry below asks through the model
 * port with a structured question (`buildQuestion`) and receives a structured answer; the prose a
 * model wraps it in is the adapter's problem (`@dsh-reprise/exec/model`), not this file's. When no
 * answer arrives — a missing binary, a non-zero exit, a timeout, an unparseable reply — the entry
 * rejects with `ModelUnavailable`, whose one class is `model_unavailable`. Every judgement point
 * therefore fails the same way, and none of them turns an outage into "the review said reject" or
 * "the analysis found nothing".
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
import { CAUSES, ModelUnavailable, asModelUnavailable, buildQuestion } from '@dsh-reprise/exec/model'

import { staticReport } from './gate.js'
import { JUDGE_DIRECTION, NoMetricContractError, metricRule, resolveMetricContract } from './metric-contract.js'
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
 * The number the contract's metric reports, or nothing.
 *
 * There is deliberately no fallback: picking "the first numeric key in sorted order" when the named
 * metric is absent is the kernel choosing a metric, and it makes a run that measured nothing look like
 * a run that improved on something. A missing number is `inconclusive` (`compareMetric`), which a
 * candidate can be rejected by and a stop rule can read as "no evidence".
 *
 * @returns {{ metric: string, value: number } | undefined}
 */
export function pickMetric(metrics, name) {
  if (!isPlainObject(metrics) || typeof name !== 'string') return undefined
  const named = finite(metrics[name])
  return named === undefined ? undefined : { metric: name, value: named }
}

/**
 * Compare against the frozen baseline.
 *
 * `minimumDelta` is the contract's minimum effective delta for this metric (0 when it declares none):
 * a move smaller than it is not a difference, so the answer is `inconclusive` — "the data cannot tell
 * these two apart" — rather than an improvement the next round extrapolates from. A move of exactly
 * the tolerance counts, because a "minimum effective" delta is the least difference that is effective.
 *
 * The threshold is a parameter and never a constant here: how much of a difference counts is a
 * metric-contract question, and a number compiled into this file would be the kernel deciding it.
 * No comparable baseline means `inconclusive`, never a guess.
 *
 * @param {{ value: number } | undefined} observed
 * @param {number | undefined} baseline
 * @param {'higher' | 'lower'} direction
 * @param {number} [minimumDelta] the contract's tolerance for this metric
 */
export function compareMetric(observed, baseline, direction = 'higher', minimumDelta = 0) {
  if (observed === undefined || baseline === undefined) return 'inconclusive'
  const difference = observed.value - baseline
  if (difference === 0) return 'inconclusive'
  const tolerance = typeof minimumDelta === 'number' && Number.isFinite(minimumDelta) && minimumDelta > 0 ? minimumDelta : 0
  if (Math.abs(difference) < tolerance) return 'inconclusive'
  const better = direction === 'lower' ? difference < 0 : difference > 0
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
 *   model: (question: object) => Promise<object>,
 *   skillsDir: string,
 *   metricContract: object,
 *   surface?: { files?: string[], keys?: string[], symbols?: string[] },
 *   baseline?: number | { value: number } | (() => number | { value: number } | undefined | Promise<number | { value: number } | undefined>),
 *   staticChecks?: (input: object) => { name: string, result: 'pass' | 'fail' }[],
 *   artifacts?: { write: (name: string, value: unknown) => unknown },
 *   packet?: (request: { call_site: string, facts: object }) => { lines?: string[], digest?: string } | undefined,
 *   readFile?: (path: string) => string,
 *   parsers?: Record<string, (content: string, context: { path: string }) => void>,
 * }} options
 */
export function createJudge({
  model,
  skillsDir,
  metricContract,
  surface,
  baseline,
  staticChecks = defaultStaticChecks,
  artifacts,
  packet,
  readFile,
  parsers,
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
  // Fail at construction, not mid-round: a missing skill produces a prompt with no instructions, and a
  // model without instructions still answers — the same is true of a judge with no metric contract,
  // which would answer about a metric it invented. The refusal names the same status the ranking and
  // the stop rules report (`missing` / `conflict`), so a workspace that cannot decide says one thing.
  const contract = resolveMetricContract(metricContract)
  if (!contract.ok) throw new NoMetricContractError(contract)
  const primary = metricRule(contract, contract.primary)
  if (primary === undefined) {
    // Unreachable while `resolveMetricContract` keeps its own invariant (an `ok` contract ranks its
    // primary); kept so a future resolution change fails with a name instead of a TypeError.
    throw new NoMetricContractError({
      status: 'missing',
      message: `the primary ${JSON.stringify(contract.primary)} is not among the ranked objectives`,
    })
  }

  loadSkills(skillsDir)

  // The judge's own vocabulary for a direction (`higher` / `lower`), derived once from the resolution.
  const metricContractFacts = Object.freeze({
    name: contract.primary,
    direction: JUDGE_DIRECTION[primary.direction],
    contract_ref: contract.ref,
    minimum_effective_delta: primary.minimum_effective_delta,
    window: primary.window,
    guardrails: contract.guardrails.map((guardrail) => guardrail.name),
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

  const persist = (kind, candidateId, artifact, ref = undefined) => {
    if (typeof artifacts?.write !== 'function') return artifact
    // The reference the fact plane records (`verify_verdict:<id>`) resolves to this name.
    artifacts.write(`${kind}:${candidateId}`, artifact)
    // A gate attempt keeps its own reference as well: attempt 2 must not overwrite the record of
    // attempt 1, or "one failed attempt is not permanent" would have nothing to recompute against.
    if (ref !== undefined) artifacts.write(`${kind}:${candidateId}:${ref}`, artifact)
    return artifact
  }

  /**
   * One request to the model, rendered from the skill on disk right now — so editing markdown
   * changes the very next prompt without a rebuild.
   *
   * The question is built by the same function every caller uses (`buildQuestion`), which is what
   * gives each call a content-addressed id and lets the adapter file the prompt and the answer side
   * by side. `subject` and `ref` are the kernel's identifiers — the candidate a judgement is about,
   * and the place in an attempt sequence — because an audit reader has to be able to file the record
   * next to the artifact it explains.
   *
   * Everything that is not a structured answer becomes `ModelUnavailable` and travels out of the
   * entry: an outage must not be recorded as an opinion (the review "rejecting", the analysis
   * "finding nothing"), because then a candidate dies of a broken provider.
   */
  const ask = async (callSite, facts, ref = null) => {
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
    const question = buildQuestion({
      call_site: callSite,
      subject: subjectOf(facts),
      ref,
      prompt,
      facts,
      answer_schema: answerSchema,
    })

    let answer
    try {
      answer = await model(question)
    } catch (error) {
      throw asModelUnavailable(error, { question })
    }
    if (!isPlainObject(answer)) {
      // A port that hands back anything other than an object has not answered. This is the same
      // closed class as an unreadable CLI reply: the call site cannot tell them apart, and it must
      // not have to.
      throw new ModelUnavailable({
        cause: CAUSES.unparseableAnswer,
        message: 'the model port returned no structured answer',
        question,
      })
    }
    return { answer, prompt }
  }

  /** What a judgement is about, as the audit record names it: a candidate, or a round. */
  const subjectOf = (facts) => {
    if (isNonEmptyString(facts?.candidate_id)) return facts.candidate_id
    if (Number.isSafeInteger(facts?.round)) return `round-${facts.round}`
    return null
  }

  const baselineValue = async () => {
    const raw = typeof baseline === 'function' ? await baseline() : baseline
    const direct = finite(raw)
    if (direct !== undefined) return direct
    if (isPlainObject(raw)) return finite(raw.value)
    return undefined
  }

  /** The adversarial review, normalised into the one enum the gate consumes. */
  const reviewOf = (answer) => {
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
     * The contract this judge decides with — the same resolved object the ranking and the stop rules
     * read, exposed so a caller (or a dump) can print what "improved" meant without a second lookup.
     */
    contract,

    /**
     * VERIFY: the kernel's static report + the model's adversarial review, recorded side by side.
     *
     * The two pieces of evidence have different owners and neither is merged into the other:
     *
     *   - `checks` is the report `gate.js` computed from the candidate's worktree — syntax, the
     *     adjustable-surface whitelist and residual conflict markers. A model cannot add, drop or
     *     reword one: anything it sends named `checks` is ignored below.
     *   - `reviewer` is the one thing the model is asked for. `passed` is the gate's *claim* about the
     *     two, `reviewer.verdict === 'accept'` **and** no check failed.
     *
     * The contract is then the referee. When the review accepts over a check that failed, the claim
     * cannot follow from the evidence, `validateArtifact` returns `conflict`, and the loop stops the
     * candidate with both facts preserved. A unanimous "no" is not a conflict: that candidate simply
     * failed its gate.
     *
     * `attempt` is the gate record's place in the sequence. It is the kernel's number, not the
     * model's, and it is what lets attempt 2 be recorded without erasing attempt 1.
     */
    async verify({ candidateId, state, parent, now, files, worktreeDir, attempt } = {}) {
      const attemptNumber = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1
      const changed = Array.isArray(files) ? files : []

      const report = staticReport({
        candidateId,
        files: changed,
        worktreeDir,
        surface: allowedSurface,
        readFile,
        parsers,
      })
      // The deeper checks a phase worker (or a test) contributes stay additive: they arrive through
      // the same list, so the contract's rule — evidence that disagrees with the review is a conflict
      // — covers them without a second mechanism.
      const checks = [...staticChecks({ candidateId, state, parent, files: changed }), ...report.checks]
      const checksOk = checks.length > 0 && checks.every((check) => check.result === 'pass')

      const facts = {
        candidate_id: candidateId,
        round: state?.round ?? null,
        hypothesis: state?.hypothesis ?? null,
        parent_binding: parent === undefined ? null : { parent_id: parent.parent_id ?? null, parent_commit: parent.parent_commit ?? null },
        files: changed,
        ...surfaceFacts,
        attempt: attemptNumber,
        static_report: {
          ready_to_submit: report.ready_to_submit,
          checks: report.checks,
          unchecked: report.unchecked,
        },
        l1_checks: checks,
      }
      const { answer } = await ask('verify', facts, `a${attemptNumber}`)
      const reviewer = reviewOf(answer)
      return persist(
        'verify_verdict',
        candidateId,
        {
          candidate_id: candidateId,
          attempt: attemptNumber,
          passed: reviewer.verdict === 'accept' && checksOk,
          checks,
          reviewer,
          decided_at_ms: now,
          // What the checks ran over, so this record can be recomputed rather than trusted.
          evidence: {
            whitelist: report.whitelist,
            files: report.files,
            unchecked: report.unchecked,
          },
        },
        `a${attemptNumber}`,
      )
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
      const observed = pickMetric(metrics, contract.primary)
      const frozenBaseline = await baselineValue()
      // The tolerance is the contract's, for this metric: a move it does not consider a difference is
      // `inconclusive`, so a candidate cannot be admitted on noise.
      const verdict = compareMetric(observed, frozenBaseline, metricContractFacts.direction, primary.minimum_effective_delta)

      const facts = {
        candidate_id: candidateId,
        round: state?.round ?? null,
        hypothesis: state?.hypothesis ?? null,
        metric_contract: { ...metricContractFacts },
        observed: observed ?? null,
        baseline: frozenBaseline ?? null,
        verdict,
        reported_metrics: metrics,
      }
      const { answer } = await ask('cand_analyze', facts)
      // Kept as the model wrote it, not coerced: an absent root cause is `missing` (nothing was
      // produced) and an empty one is `invalid` (something was produced that is not a finding).
      // Collapsing both into `undefined` here would undo the distinction the contract exists for.
      const rootCause = typeof answer.root_cause === 'string' ? answer.root_cause.trim() : undefined

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
      const raw = Array.isArray(answer.hypotheses) ? answer.hypotheses : []
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
        metric_contract_ref: metricContractFacts.contract_ref,
      }
    },

    /**
     * ROUND_REFLECT: what the finished round taught. Text and structure only — there is deliberately
     * no field for "stop", because the stop rule is measured in code and a model's recommendation is
     * not an input to it.
     */
    async reflect({ round, facts, now } = {}) {
      const { answer } = await ask('round_reflect', { ...facts, round })
      const lessons = Array.isArray(answer.lessons)
        ? answer.lessons.map((lesson) =>
            isPlainObject(lesson)
              ? { statement: typeof lesson.statement === 'string' ? lesson.statement.trim() : undefined, evidence: asString(lesson.evidence) }
              : lesson,
          )
        : []

      return {
        round,
        summary: typeof answer.summary === 'string' ? answer.summary.trim() : undefined,
        lessons,
        next_round_focus: asStringList(answer.next_round_focus),
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
        metric_contract_ref: metricContractFacts.contract_ref,
        frozen_at_ms: now,
      }
      const prompt = renderPrompt(skill, {
        facts: {
          candidate_id: candidateId,
          round,
          hypothesis: { id: hypothesis?.id ?? null, statement: statement ?? null, expected_files: hypothesis?.expected_files ?? [] },
          metric_contract: { ...metricContractFacts },
          ...surfaceFacts,
        },
        answer: ANSWER_SHAPES.land,
      })
      return { artifact: persist('land_hypothesis', candidateId, artifact), prompt }
    },
  }
}