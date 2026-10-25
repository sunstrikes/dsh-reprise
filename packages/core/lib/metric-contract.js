/**
 * The metric contract, resolved once, so that "which metric decides, how much of a difference counts,
 * and which way is a run read" has one answer in this kernel.
 *
 * Why this module exists. Three places decide something with the metric contract — the ranking
 * (`frontier.js` chooses `best`), the stop rules (`stop.js` asks whether a round beat the best), and
 * the gate (`judge.js` compares a candidate against the frozen baseline) — and before this module each
 * of them read the contract its own way: one promoted the first objective to primary, one compared
 * strictly with no tolerance at all, one fell back to whatever number the job happened to report. Three
 * readers with three private interpretations is not a missing feature; it is three different answers to
 * "did this candidate improve". `resolveMetricContract` is the only place the contract is read, and the
 * answer is either a fully resolved rule or a named *no contract*.
 *
 * The input is the contract as data — the run's `metrics`, which is the domain pack's
 * `metric-contract.json` unless the run restates it. Nothing here knows a metric name, which is the
 * whole point (spec 领域差异必须是数据, not `if`).
 *
 * ## What the contract can say
 *
 * | field | meaning |
 * |---|---|
 * | `name` | the ref frozen artifacts quote; falls back to `primary` |
 * | `primary` | **the** metric `best` is decided on — required, and one of `objectives` |
 * | `direction` | `higher` / `lower` (`up` / `down` also accepted); must agree with `objectives[primary]` when both are written |
 * | `objectives` | `{metric: "up" \| "down"}` — exactly what the ranking carries, in declaration order |
 * | `guardrail` | `{metric, direction?}` — a *second* ranked metric that must not go backwards while the primary improves |
 * | `minimum_effective_delta` | a positive number, or `{default, <metric>: number}` — how large a difference has to be to count |
 * | `window_mode` | `"mean"` / `"last"`, or `{default, <metric>: "mean" \| "last"}` — how a windowed series collapses to one number per metric |
 * | `role` | prose per metric, carried for the prompts and the dashboard; never parsed (see below) |
 *
 * Two settings are per-metric overridable with the same idiom: a bare value for every ranked metric, or
 * an object whose `default` key holds the value for the metrics not named individually. An override
 * names a metric the `objectives` already rank — a rule about a metric nobody ranks decides nothing.
 *
 * The *default* tolerance is zero, and that is deliberate: a contract that states no tolerance is
 * compared strictly, because a tolerance the domain did not state is a domain decision the kernel
 * cannot make. Declaring a zero is refused anyway, since writing it down says nothing.
 *
 * `role` is prose ("guardrail — ranked and read as a constraint: …"). The machine-readable roles are
 * `primary` and `guardrail`, and the resolution *derives* each metric's `kind` from those two fields.
 * Prose is never pattern-matched into a decision here: a pack whose `role` mentions a metric it does
 * not rank is explained, not refused, and that stays true for as long as nobody teaches the kernel to
 * read English.
 *
 * ## The four states, and why no-contract is two of them
 *
 * `missing` — there is no contract, or it never says the one thing a reader cannot do without (a
 * primary, objectives to rank).
 *
 * `invalid` — a value is there and unusable on its own terms: a direction that is neither higher nor
 * lower, a zero tolerance, `window_mode: "median"`.
 *
 * `conflict` — the contract is well-formed and disagrees with itself: two accounts of "better", a
 * guardrail that is the primary (the objective restated), a tolerance for a metric it does not rank.
 * This is never merged into `invalid` (CODING_STANDARDS §2): one is a document to fix, the other is a
 * document that says two things a human has to choose between, and a reader that reported `invalid`
 * for both would send the next person hunting for a typo that is not there.
 *
 * When a contract earns more than one finding, `status` is the first one in the declared check order
 * and `problems` holds them all — the order is the precedence, the same way the stop rules declare
 * theirs.
 *
 * ## What is deliberately not decided here (deferred)
 *
 * **Whether a metric is measurable in the data this run actually has.** The predecessor carried a
 * "which keys are measurable in this profile" table and a `task × metric` whitelist; that
 * qualification — "the contract ranks `hr@10`, and this run's logs can produce it" — is *not* what
 * this module answers, and a reader must not treat a resolved contract as a promise that a number
 * exists. `readMetric` returns no value, with a reason, when a series does not carry the metric; that
 * is the closest this ticket comes, and the qualification itself is deliberately left for later. The
 * same sentence is in `docs/extending.md`, where a pack author reads about the field.
 *
 * @module
 */

/** The four states a contract can resolve to. `conflict` is never merged into `invalid`. */
export const CONTRACT_STATUSES = Object.freeze(['ok', 'missing', 'invalid', 'conflict'])

/** How a windowed series collapses to one number. */
export const WINDOW_MODES = Object.freeze(['mean', 'last'])

/** A run read as the mean of its windows uses every measurement; the last window may not exist. */
export const DEFAULT_WINDOW_MODE = 'mean'

/** No tolerance declared: strictly better, which is what "a difference is a difference" means. */
export const STRICT_MINIMUM_EFFECTIVE_DELTA = 0

/** The reserved key inside a per-metric setting: the value every metric not named individually gets. */
const DEFAULT_KEY = 'default'

/** `up` / `down` is the frontier's vocabulary; `higher` / `lower` is the judge's. One table converts. */
const DIRECTIONS = Object.freeze({ up: 'up', down: 'down', higher: 'up', lower: 'down' })

/** 'up' / 'down' as the judge's 'higher' / 'lower', for the comparison it owns. */
export const JUDGE_DIRECTION = Object.freeze({ up: 'higher', down: 'lower' })

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
const isWindowMode = (value) => isText(value) && WINDOW_MODES.includes(value.trim().toLowerCase())

/** The normalised direction of a declared value, or undefined when it is not one. */
const normalise = (value) => (isText(value) ? DIRECTIONS[value.trim().toLowerCase()] : undefined)

const asMode = (value) => value.trim().toLowerCase()

const quoted = (names) => (names.length === 0 ? 'none' : names.join(', '))

const describe = (value) => (value === undefined ? 'nothing' : JSON.stringify(value))

/**
 * A judge built from a contract that resolved to *no contract*. It exists so the third reader names
 * the same status as the other two instead of throwing a bare `TypeError` or, worse, judging with a
 * metric nobody declared.
 */
export class NoMetricContractError extends TypeError {
  /**
   * @param {{status: string, message: string}} resolution
   */
  constructor(resolution) {
    super(`a judge needs a resolvable metric contract, and this one is ${resolution.status} — ${resolution.message}`)
    this.name = 'NoMetricContractError'
    this.status = resolution.status
    this.resolution = resolution
  }
}

// ------------------------------------------------------------------ resolution

/**
 * Read one per-metric setting: a bare value for every ranked metric, or `{default, <metric>: value}`.
 *
 * `ranked` is the set of metric names the contract's objectives declare, so an override for anything
 * else is caught here rather than silently deciding nothing.
 *
 * @returns {{ value: unknown, overrides: Map<string, unknown>, problems: {status: string, message: string}[] }}
 */
function perMetricSetting(declared, { field, ranked, isValue, what, decides }) {
  const problems = []
  const overrides = new Map()
  let value

  const reject = (at, got) =>
    problems.push({
      status: 'invalid',
      message: `${at} must be ${what} (got ${describe(got)}) — ${decides}`,
    })

  if (declared === undefined) return { value, overrides, problems }

  if (!isObject(declared)) {
    if (isValue(declared)) value = declared
    else reject(field, declared)
    return { value, overrides, problems }
  }

  for (const [key, entry] of Object.entries(declared)) {
    if (key === DEFAULT_KEY) {
      if (isValue(entry)) value = entry
      else reject(`${field}.${DEFAULT_KEY}`, entry)
      continue
    }
    if (!ranked.includes(key)) {
      problems.push({
        status: 'conflict',
        message:
          `${field}.${key} names a metric the objectives do not rank (${quoted(ranked)}) — ` +
          'a rule for a metric nobody ranks decides nothing',
      })
      continue
    }
    if (!isValue(entry)) {
      reject(`${field}.${key}`, entry)
      continue
    }
    overrides.set(key, entry)
  }
  return { value, overrides, problems }
}

/**
 * Resolve a metric contract into the rules three readers can share, or the named reason there is none.
 *
 * @param {unknown} contract the contract as data (a run's `metrics`, or a pack's `metric-contract.json`)
 * @returns {{
 *   status: 'ok' | 'missing' | 'invalid' | 'conflict',
 *   ok: boolean,
 *   message: string,
 *   error: string | undefined,
 *   problems: {status: string, message: string}[],
 *   ref: string | undefined,
 *   primary: string | undefined,
 *   direction: 'up' | 'down' | undefined,
 *   objectives: {name: string, direction: 'up' | 'down', kind: 'primary' | 'guardrail' | 'objective', minimum_effective_delta: number, window: 'mean' | 'last', role: string | undefined}[],
 *   guardrails: {name: string, direction: 'up' | 'down', kind: 'guardrail', minimum_effective_delta: number, window: 'mean' | 'last', role: string | undefined}[],
 *   defaults: {minimum_effective_delta: number, window: 'mean' | 'last'},
 * }}
 */
export function resolveMetricContract(contract) {
  const problems = []
  const add = (status, message) => problems.push({ status, message })

  /** A resolution that ranks nothing, carrying why. Everything a reader must not guess is undefined. */
  const noContract = () => {
    const [first] = problems
    const status = first?.status ?? 'missing'
    const message = first?.message ?? 'no metric contract resolved'
    return Object.freeze({
      status,
      ok: false,
      message,
      error: message,
      problems: Object.freeze(problems.map((problem) => Object.freeze({ ...problem }))),
      ref: undefined,
      primary: undefined,
      direction: undefined,
      objectives: Object.freeze([]),
      guardrails: Object.freeze([]),
      defaults: Object.freeze({
        minimum_effective_delta: STRICT_MINIMUM_EFFECTIVE_DELTA,
        window: DEFAULT_WINDOW_MODE,
      }),
    })
  }

  if (contract === undefined || contract === null) {
    add('missing', 'no metric contract was resolved — nothing declares a primary metric and the objectives it leads')
    return noContract()
  }
  if (!isObject(contract)) {
    add('invalid', `the metric contract must be a JSON object (got ${describe(contract)})`)
    return noContract()
  }

  // Objectives first: every other rule is keyed by them, so their shape decides whether the rest can
  // even be read. Declaration order is preserved — it is the order a reader sees.
  const declaredObjectives = contract.objectives
  const directions = new Map()
  if (declaredObjectives === undefined) {
    add('missing', 'objectives is required — the metrics this contract ranks, and the only ones a comparison may use')
  } else if (!isObject(declaredObjectives)) {
    add('invalid', `objectives must be an object of {metric: "up" | "down"} (got ${describe(declaredObjectives)})`)
  } else if (Object.keys(declaredObjectives).length === 0) {
    add('invalid', 'objectives is empty — a contract that ranks nothing cannot compare two candidates')
  } else {
    for (const [name, direction] of Object.entries(declaredObjectives)) {
      if (name.trim() === '') add('invalid', 'objectives must not hold an empty metric name')
      else if (normalise(direction) === undefined)
        add('invalid', `objectives.${name} must be "up" or "down" (got ${describe(direction)})`)
      else directions.set(name, normalise(direction))
    }
  }
  const ranked = [...directions.keys()]

  // The primary: required. A contract that names objectives and no primary does not say which one
  // leads, and promoting the first objective would be the kernel ranking on a metric nobody chose.
  let primary
  if (contract.primary === undefined) {
    add('missing', 'primary is required — the one metric the ranking\'s best is decided on, and the gate compares against the baseline')
  } else if (!isText(contract.primary)) {
    add('invalid', `primary must be the name of one of the objectives (got ${describe(contract.primary)})`)
  } else {
    primary = contract.primary.trim()
    if (ranked.length > 0 && !directions.has(primary)) {
      add(
        'conflict',
        `primary ${JSON.stringify(primary)} is not among objectives (${quoted(ranked)}) — ` +
          'the gate would compare a metric the ranking cannot rank',
      )
    }
  }

  // The direction, two ways: the top-level field and the primary's objective. They must agree; when
  // only the objective states it, the contract has still said which way is better and that is enough.
  let direction
  if (contract.direction !== undefined) {
    direction = normalise(contract.direction)
    if (direction === undefined) {
      add('invalid', `direction must be "higher" or "lower" (got ${describe(contract.direction)})`)
    }
  }
  const primaryDirection = primary === undefined ? undefined : directions.get(primary)
  if (direction !== undefined && primaryDirection !== undefined && direction !== primaryDirection) {
    add(
      'conflict',
      `direction is ${JSON.stringify(contract.direction)} but objectives.${primary} is ` +
        `${JSON.stringify(declaredObjectives[primary])} — two accounts of "better" in one contract`,
    )
  }
  direction = direction ?? primaryDirection

  // The guardrail: a second ranked metric that must not go backwards. Restating the primary here is
  // the objective twice, and naming a metric the contract does not rank makes it a comment.
  let guardrail
  if (contract.guardrail !== undefined) {
    const declared = contract.guardrail
    if (!isObject(declared) || !isText(declared.metric)) {
      add('invalid', 'guardrail must be an object naming the metric it protects (guardrail.metric)')
    } else if (ranked.length > 0 && !directions.has(declared.metric.trim())) {
      add(
        'conflict',
        `guardrail.metric ${JSON.stringify(declared.metric)} is not among objectives (${quoted(ranked)}) — ` +
          'a guardrail the ranking cannot rank is a comment',
      )
    } else if (primary !== undefined && declared.metric.trim() === primary) {
      add(
        'conflict',
        `guardrail.metric is the primary ${JSON.stringify(primary)} — a guardrail has to be a second metric, ` +
          'or it is the objective restated',
      )
    } else {
      const name = declared.metric.trim()
      let declaredDirection
      if (declared.direction !== undefined) {
        declaredDirection = normalise(declared.direction)
        const objective = directions.get(name)
        if (declaredDirection === undefined) {
          add('invalid', `guardrail.direction must be "higher" or "lower" (got ${describe(declared.direction)})`)
        } else if (objective !== undefined && declaredDirection !== objective) {
          add(
            'conflict',
            `guardrail.direction is ${JSON.stringify(declared.direction)} but objectives.${name} is ` +
              `${JSON.stringify(declaredObjectives[name])} — two accounts of "better" for one metric`,
          )
        }
      }
      guardrail = { name, direction: declaredDirection ?? directions.get(name) }
    }
  }

  const deltas = perMetricSetting(contract.minimum_effective_delta, {
    field: 'minimum_effective_delta',
    ranked,
    isValue: isPositive,
    what: 'a positive finite number',
    decides: 'zero makes every difference count and a negative counts the wrong way',
  })
  problems.push(...deltas.problems)

  // A tolerance declared for the guardrail and forgotten for the primary is the trap this check exists
  // for: the number a human believes is in force would apply to the metric that matters least, while the
  // primary is compared strictly. Declaring nothing is legitimate (strict); declaring something that
  // skips the primary is not.
  if (contract.minimum_effective_delta !== undefined && primary !== undefined && directions.has(primary)) {
    const primaryDelta = deltas.overrides.get(primary) ?? deltas.value ?? STRICT_MINIMUM_EFFECTIVE_DELTA
    if (primaryDelta === STRICT_MINIMUM_EFFECTIVE_DELTA) {
      add(
        'invalid',
        `minimum_effective_delta has no entry for primary ${JSON.stringify(primary)} and no default — ` +
          'the metric the gate compares against the baseline needs the tolerance most',
      )
    }
  }

  const windows = perMetricSetting(contract.window_mode, {
    field: 'window_mode',
    ranked,
    isValue: isWindowMode,
    what: `one of ${WINDOW_MODES.join(', ')}`,
    decides: 'a series has to be read one way for both sides of a comparison',
  })
  problems.push(...windows.problems)

  if (contract.role !== undefined && !isObject(contract.role)) {
    add('invalid', 'role must be an object of {metric: "<what it is for>"} when present')
  }

  if (problems.length > 0) return noContract()

  const defaults = {
    minimum_effective_delta: deltas.value ?? STRICT_MINIMUM_EFFECTIVE_DELTA,
    window: isText(windows.value) ? asMode(windows.value) : DEFAULT_WINDOW_MODE,
  }
  const roleOf = (name) => (isObject(contract.role) && isText(contract.role[name]) ? contract.role[name] : undefined)

  const objectives = ranked.map((name) =>
    Object.freeze({
      name,
      direction: directions.get(name),
      kind: name === primary ? 'primary' : name === guardrail?.name ? 'guardrail' : 'objective',
      minimum_effective_delta: deltas.overrides.get(name) ?? defaults.minimum_effective_delta,
      window: windows.overrides.has(name) ? asMode(windows.overrides.get(name)) : defaults.window,
      role: roleOf(name),
    }),
  )
  const guardrails = Object.freeze(objectives.filter((objective) => objective.kind === 'guardrail'))
  const ref = isText(contract.name) ? contract.name.trim() : primary

  return Object.freeze({
    status: 'ok',
    ok: true,
    message:
      `primary ${primary} (${direction}) over ${objectives.length} ranked metric(s)${guardrails.length === 0 ? '' : `, guardrail ${quoted(guardrails.map((entry) => entry.name))}`}` +
      `; minimum effective delta ${defaults.minimum_effective_delta} unless a metric overrides it, windows read as ${defaults.window} by default`,
    error: undefined,
    problems: Object.freeze([]),
    ref,
    primary,
    direction,
    objectives: Object.freeze(objectives),
    guardrails,
    defaults: Object.freeze(defaults),
  })
}

/** The resolved rule for one metric, or undefined when the contract does not rank it. */
export function metricRule(resolved, name) {
  return resolved?.objectives?.find((objective) => objective.name === name)
}

/** The resolved rule for the primary metric. */
export function primaryRule(resolved) {
  return metricRule(resolved, resolved?.primary)
}

/**
 * The binding the round workflow freezes: `{name, direction, contract_ref}` in the judge's vocabulary.
 *
 * `rounds.metric` already had this shape and `rounds.js` reads it from the workspace after INIT, so the
 * shape stays — but it is *derived* from the resolved contract rather than declared beside it, which is
 * how the gate and the round planner stop being able to optimise different metrics.
 *
 * @returns {{name: string, direction: 'higher' | 'lower', contract_ref: string} | undefined}
 */
export function bindingOf(resolved) {
  if (resolved?.ok !== true) return undefined
  return { name: resolved.primary, direction: JUDGE_DIRECTION[resolved.direction], contract_ref: resolved.ref }
}

// -------------------------------------------------------------- reading a series

/** The windows of a series, or an empty list when the value is not a series at all. */
function windowsOf(series) {
  if (!isObject(series) || !Array.isArray(series.windows)) return []
  return series.windows.filter(isObject)
}

/**
 * One metric's value in each window of a series, in window order.
 *
 * `value` is `undefined` where the window does not measure it — a metric absent from a window's table,
 * or a non-finite number in it, is **not a measurement** (the shape's own rule: a `nan` loss spike is
 * left out of a mean, and an `inf` gradient does not become the answer). Ticket 21 needs this list, not
 * just the collapsed number: "the last N windows all broke the tolerance" is a statement about windows.
 *
 * @param {{unit?: string, windows?: unknown[]}} series
 * @param {string} name
 * @returns {{index: number, start: number, end: number, value: number | undefined}[]}
 */
export function windowValues(series, name) {
  return windowsOf(series).map((window) => {
    const measured = isObject(window.metrics) ? window.metrics[name] : undefined
    return {
      index: window.index,
      start: window.start,
      end: window.end,
      value: typeof measured === 'number' && Number.isFinite(measured) ? measured : undefined,
    }
  })
}

/**
 * Collapse a windowed series to the one number a comparison uses, the way the contract says to read it.
 *
 * Two modes, both of them per metric:
 *
 *  - **`mean`** — the mean of the finite values, over the windows that measured the metric. Windows
 *    that say nothing about it are not zeros and do not enter the mean.
 *  - **`last`** — the value in the **last window of the series**. If that window does not carry a
 *    finite number for the metric, this run has no last-window value: the answer is "not measured",
 *    with the reason naming the window. An older window is *not* substituted, because then two
 *    readers would disagree — one calling it "the last measurement", one calling it "the last window"
 *    — and the substitution is exactly the kind of silent reinterpretation this module exists to
 *    remove. (The predecessor's stop rule "the last window has no finite number" could only exist
 *    because "last" can be absent.)
 *
 * @param {{unit?: string, windows?: unknown[]}} series
 * @param {{name: string, window?: 'mean' | 'last'}} rule a resolved objective (`metricRule(...)`)
 * @returns {{metric: string, window: 'mean' | 'last', value: number | undefined, reason: string | undefined}}
 */
export function readMetric(series, rule) {
  const name = rule?.name
  const mode = rule?.window === 'last' ? 'last' : DEFAULT_WINDOW_MODE
  const windows = windowValues(series, name)

  if (windows.length === 0) {
    return {
      metric: name,
      window: mode,
      value: undefined,
      reason: `no window series to read ${name} from — no measurement was collected`,
    }
  }

  if (mode === 'last') {
    const last = windows[windows.length - 1]
    if (last.value === undefined) {
      return {
        metric: name,
        window: mode,
        value: undefined,
        reason: `the last window [${last.start}, ${last.end}) does not measure ${name} with a finite number — an older window is not the last one`,
      }
    }
    return { metric: name, window: mode, value: last.value, reason: undefined }
  }

  const measured = windows.filter((window) => window.value !== undefined)
  if (measured.length === 0) {
    return { metric: name, window: mode, value: undefined, reason: `no window measured ${name} with a finite number` }
  }
  const total = measured.reduce((sum, window) => sum + window.value, 0)
  return { metric: name, window: mode, value: total / measured.length, reason: undefined }
}
