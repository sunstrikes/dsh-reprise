/**
 * The dashboard page — a viewer of one workspace, and nothing else.
 *
 * It talks to the four read-only routes the host already serves, every request is a `GET`, and it
 * never sends anything back: v1 has no write endpoint, so there is no button here that could change a
 * run. The increment protocol is the cursor the answer handed back — `?after=<cursor>` — so a poll
 * costs the new facts and not the whole history, and the same protocol can become a stream later
 * without the page changing what it asks for.
 *
 * Plain ESM on purpose: the host serves this file directly (there is no bundler in the path and no
 * build artefact to keep in sync), and the page loads it by a relative URL next to itself. The second
 * import — `format.js` — is resolved the same way, against this module's own URL, so both files are
 * served out of one directory and cannot go out of step.
 *
 * All fact-derived text goes in through `textContent`, never `innerHTML`: candidate ids, verdict
 * messages and artifact paths come from the workspace, and a dashboard is not allowed to become an
 * injection surface for the thing it is watching.
 *
 * The page renders; it does not compute. The one thing it asks a reader to believe — the conclusion —
 * is read out of the projection's own comparison block (what we measured, what against, how much), so
 * the percentage on this page and the number `dump` prints are the same derivation.
 */

import { EM_DASH, change, clock, cursor, cursorAt, fixed, number, pathTail, percent } from './format.js'
import { SHAPE_WORDS, VERDICT_WORDS, phaseMark } from './states.js'

/**
 * The views this page shows. Paths are absolute because the host mounts them on its own origin.
 *
 * `calls` is the audit list and `call` opens one record: the judgement a model was asked for, with
 * the prompt it read and the words it returned. Reading a call is a second request on purpose, so the
 * list can carry a hundred calls without carrying a hundred prompts.
 */
const ROUTES = {
  overview: '/api/reprise/overview',
  rounds: '/api/reprise/rounds',
  candidate: '/api/reprise/candidate',
  conclusion: '/api/reprise/conclusion',
  calls: '/api/reprise/calls',
  call: '/api/reprise/call',
}

/** Poll cadence. The old dashboard re-read everything every 30s; this one only asks for increments. */
export const POLL_MS = 5_000

/** How many facts the "new facts" panel keeps before dropping the oldest. */
const STREAM_LIMIT = 200

/**
 * One route URL, with the cursor, the candidate and the audit reference as query parameters.
 *
 * @param {keyof ROUTES} view
 * @param {{ cursor?: string | null, candidate?: string | null, ref?: string | null }} [options]
 */
export function urlFor(view, { cursor, candidate, ref } = {}) {
  const query = []
  if (cursor) query.push(`after=${encodeURIComponent(cursor)}`)
  if (candidate) query.push(`candidate=${encodeURIComponent(candidate)}`)
  if (ref) query.push(`ref=${encodeURIComponent(ref)}`)
  return query.length === 0 ? ROUTES[view] : `${ROUTES[view]}?${query.join('&')}`
}

/**
 * A fact's stamp on screen: `#9`.
 *
 * Three places print it — the phase path, the timeline and the fact stream — and it is written once
 * because it is the thing a reader quotes back ("that fact"), so `9` and `#9` must not both exist on
 * one page. `#` and not `seq 9`: one glyph, in the mono face, at the edge of the row.
 */
const seqStamp = (seq) => `#${seq}`

/** The card count, or the word for "we could not ask". */
const cardsInUse = (cluster) =>
  cluster?.cards === undefined || cluster?.cards === null
    ? EM_DASH
    : cluster.cards.inUse === null
      ? 'unknown'
      : number(cluster.cards.inUse)

/**
 * The name each stop rule goes by on the page.
 *
 * This is a *label*, not a counter: which value a rule has reached arrives from the projection
 * (`observed`), because a page that mapped a rule name to a counter of its own would be the second
 * derivation that turns "3/3" into a different number from the one recorded in the conclusion. A rule
 * the kernel adds and this table forgets falls back to its identifier — visible and ugly, which is
 * the honest failure.
 */
const RULE_WORDS = Object.freeze({
  max_rounds: 'rounds completed',
  max_no_improvement_rounds: 'no improvement',
  consecutive_empty_rounds: 'empty round',
  max_wall_hours: 'wall clock',
  max_windows: 'windows',
})

/** What a rule has to say for itself when it has no reading, and when it has one. */
function ruleReading(rule) {
  if (rule.enabled !== true) return 'off'
  if (rule.observed === null) return 'not measured'
  return `${number(rule.observed)}/${number(rule.limit)}`
}

/**
 * One stop rule: its name, a gauge of the distance left, and the reading.
 *
 * The gauge fills with `distancePercent`, which the projection computed — reaching the limit is *stopping*,
 * not succeeding, so the bar is a distance and never a progress bar. `data-state` carries the four
 * things a rule can be (measured, fired, off, and "nobody could measure it"), and each one is drawn
 * differently: a name at tertiary ink with no gauge for a rule that is off, a bold name and a filled
 * dot for the rule that fired.
 */
function stopRule(rule, { fired = false } = {}) {
  const state = rule.enabled !== true ? 'disabled' : rule.observed === null ? 'blocked' : fired ? 'fired' : 'measured'
  return el('div', { class: 'stop-rule', 'data-rule': rule.rule, 'data-state': state }, [
    el('span', { class: 'stop-rule-name', text: RULE_WORDS[rule.rule] ?? rule.rule }),
    rule.enabled === true && rule.observed !== null
      ? el(
          'span',
          {
            class: 'stop-gauge',
            role: 'progressbar',
            'aria-label': `${RULE_WORDS[rule.rule] ?? rule.rule}: ${ruleReading(rule)}`,
            'aria-valuenow': String(rule.observed),
            'aria-valuemin': '0',
            'aria-valuemax': String(rule.limit),
          },
          [el('span', { class: 'stop-gauge-fill', style: `width: ${rule.distancePercent.toFixed(2)}%` })],
        )
      : null,
    el('span', { class: 'stop-rule-reading', text: ruleReading(rule) }),
    fired ? el('span', { class: 'stop-dot', 'aria-hidden': 'true' }) : null,
  ])
}

/** The sentences behind the gauges: why a rule is off, and why one has no reading. */
function ruleNotes(rules) {
  return rules
    .filter((rule) => rule.enabled === true && rule.observed === null)
    .map((rule) =>
      el('p', {
        class: 'note',
        text: `${RULE_WORDS[rule.rule] ?? rule.rule}: ${rule.reason ?? rule.unmeasured ?? 'this rule has no reading'}`,
      }),
    )
}

/**
 * The stop section: one row of gauges while the run is going, a two-column panel once it has stopped.
 *
 * Running, it answers "will this end on its own, and how soon"; stopped, it answers "why here" on the
 * left and lists *every* rule with its observed value on the right, so a reader can see which rule
 * would have been next. The rule that fired is bold and carries a dot — weight and shape, never hue
 * (CODING_STANDARDS §2).
 */
function renderStop(answer) {
  const root = document.getElementById('stop')
  root.className = 'stop'
  root.replaceChildren()

  const data = answer?.data
  if (data === null || data === undefined) {
    root.append(el('h2', { text: 'Stop rules' }), el('p', { class: 'empty', text: answer?.reason ?? 'no facts recorded yet' }))
    return
  }

  const stop = data.stop ?? {}
  const rules = stop.rules ?? []

  if (stop.stopped === true) {
    root.className = 'card stop'
    root.append(
      el('h2', { text: 'Why it stopped here' }),
      el('div', { class: 'stop-panel' }, [
        el('div', { class: 'stop-why' }, [
          el('p', { class: 'stop-why-rule', text: stop.rule ?? EM_DASH }),
          el('p', { class: 'stop-why-message', text: stop.message ?? '(no message recorded)' }),
          el('p', {
            class: 'stop-why-reading',
            text: `observed ${number(stop.observed)} / limit ${number(stop.limit)}`,
          }),
          el('p', {
            class: 'dim',
            text: `recorded ${clock(stop.atMs)} · event ${number(stop.eventSeq)}`,
          }),
        ]),
        el(
          'div',
          { class: 'stop-rules', 'data-layout': 'panel' },
          rules.map((rule) => stopRule(rule, { fired: rule.rule === stop.rule })),
        ),
      ]),
      ...ruleNotes(rules),
      el('p', {
        class: 'dim',
        text: 'Every rule is listed with the value it had reached, so "which one would have been next" is answerable.',
      }),
    )
    return
  }

  root.append(
    el('h2', { text: 'Stop rules' }),
    el('div', { class: 'stop-rules' }, rules.map((rule) => stopRule(rule))),
    el('p', { class: 'stop-summary', text: 'none of them has fired' }),
    ...ruleNotes(rules),
  )
}

/**
 * The budget bar: settled (solid), reserved but not yet settled (hatch), and what is left of the cap.
 *
 * The three materials and the two markers all arrive as percentages, because a page that divided two
 * GPU-hour readings would be a second derivation of a number the panel will also print. They are a
 * fill, a hatch and an emptiness rather than three colours: the bar has to survive a greyscale
 * screenshot, and amber-on-white is the one hue this design spends.
 *
 * The words over the middle material matter as much as the numbers: `reserved − settled` includes
 * what a finished candidate reserved and did not spend, so it is "reserved, not yet settled" — money
 * still held against the ledger — and never "in flight", which would claim the work is running.
 */
function budgetBar(spend) {
  const budget = spend?.budget
  if (budget === undefined || budget === null) return null
  if (budget.scaleGpuHours === null) {
    return el('p', { class: 'reading-sub', text: 'nothing spent yet — there is no bar to draw' })
  }

  const track = el('div', { class: 'budget-track' }, [
    el('span', { class: 'budget-segment', 'data-material': 'settled', style: `width: ${number(budget.settledPercent)}%` }),
    el('span', { class: 'budget-segment', 'data-material': 'reserved', style: `width: ${number(budget.reservedPercent)}%` }),
    el('span', { class: 'budget-segment', 'data-material': 'remaining', style: `width: ${number(budget.remainingPercent)}%` }),
    budget.softLimitPercent === null
      ? null
      : el('span', {
          class: 'budget-marker',
          'data-marker': 'soft',
          style: `left: ${number(budget.softLimitPercent)}%`,
        }),
    budget.limited ? el('span', { class: 'budget-marker', 'data-marker': 'limit', style: 'left: 100%' }) : null,
  ])

  const legend = el('p', { class: 'budget-legend' }, [
    budgetKey('settled', `settled ${number(spend.settledGpuHours)}`),
    budgetKey('reserved', `reserved, not yet settled ${number(budget.reservedUnsettledGpuHours)}`),
    // With no cap there is no remainder to name: the bar is the whole of what was used.
    budget.limited ? budgetKey('remaining', `remaining ${number(budget.remainingGpuHours)}`) : null,
    budget.limited
      ? el('span', { class: 'budget-key' }, [
          el('i', { 'data-marker': 'soft' }),
          `soft limit ${number(spend.softLimitGpuHours)}`,
        ])
      : null,
    budget.limited
      ? el('span', { class: 'budget-key' }, [el('i', { 'data-marker': 'limit' }), `cap ${number(spend.limitGpuHours)}`])
      : el('span', { class: 'budget-key', text: 'no cap — the bar is scaled by what was used' }),
  ])

  return el('div', { class: 'budget' }, [
    el('div', { class: 'budget-head' }, [
      el('span', {
        class: 'reading-value',
        text: number(spend.settledGpuHours),
      }),
      el('span', {
        class: 'reading-unit',
        text: budget.limited ? `/ ${number(spend.limitGpuHours)} GPU h` : 'GPU h, no cap',
      }),
    ]),
    track,
    legend,
  ])
}

/** One entry of the bar's legend: the material's swatch, then its name. */
function budgetKey(material, word) {
  return el('span', { class: 'budget-key' }, [el('i', { 'data-material': material }), word])
}

/**
 * One cell of the readings row: a label, the headline number with its unit, and the sentences under
 * it. The unit is a word rather than a slash (`5` + `rounds completed`), because a `/` beside a
 * number invites the reader to divide it by the next one — and `5 / 20` would turn the round cap into
 * a target, which it is not.
 */
function reading(label, value, unit, subs = [], extra = []) {
  return el('div', { class: 'reading' }, [
    el('dt', { class: 'reading-label', text: label }),
    el('dd', { class: 'reading-headline' }, [
      value ?? EM_DASH,
      unit === undefined ? null : el('span', { class: 'reading-unit', text: unit }),
    ]),
    ...subs.filter(Boolean).map((text) => el('dd', { class: 'reading-sub', text })),
    ...extra,
  ])
}

/**
 * The readings row (spec §6.6): rounds, candidates, GPU hours with the budget bar, the frontier, and
 * what the run occupies on a shared cluster.
 *
 * Every number is the projection's, including the three shares of the budget bar; the page decides
 * only how to *say* them. Two of these cells can be "unknown", and both say so in words: the cluster
 * a page could not ask, and — when the run never recorded how many cards a job claims — the floor its
 * own ledger could support. Neither is ever drawn as `0`, which is the answer somebody acts on.
 */
function renderReadings(answer) {
  const root = document.getElementById('readings')
  root.replaceChildren()

  const data = answer?.data
  if (data === null || data === undefined) {
    root.append(
      el('div', { class: 'reading' }, [
        el('dt', { class: 'reading-label', text: 'Readings' }),
        el('dd', { class: 'reading-sub', text: answer?.reason ?? 'no facts recorded yet' }),
      ]),
    )
    return
  }

  const rounds = data.rounds
  const candidates = data.candidates
  const spend = data.spend
  const frontier = data.frontier ?? {}
  const cluster = data.cluster ?? {}
  const cards = cluster.cards ?? {}
  const queue = cluster.queue ?? {}

  // One place decides how to say a card count the page could not ask for: `unknown`, never `0`.
  const clusterValue = el('span', { class: 'reading-value', text: cardsInUse(cluster) })
  const clusterSubs = []
  if (cluster.read === true) {
    clusterSubs.push(`our ledger holds ${number((cluster.jobs?.open ?? []).length)} open job(s), ${number(cards.perJob)} card(s) each`)
  } else if (cards.floor === null) {
    clusterSubs.push(cards.floorAbsent ?? 'our own ledger cannot say how many cards it holds')
  } else {
    clusterSubs.push(`our own ledger holds at least ${number(cards.floor)} card(s)`)
  }
  if (cluster.read !== true && cluster.reason) clusterSubs.push(cluster.reason)

  // Who is waiting, and *why*: the projection's own hold vocabulary, mapped to a sentence here. A
  // count with no cause leaves a reader unable to tell "the budget is spent" from "another job is
  // holding the cards", which are two different things to do about it.
  const waiting = queue.waiting ?? []

  root.append(
    reading(
      'Rounds',
      el('span', { class: 'reading-value', text: number(rounds.completed) }),
      'rounds completed',
      [
        rounds.total === 0 ? 'no round yet' : `current round ${number(rounds.current)}`,
        `empty streak ${number(rounds.emptyStreak)}`,
      ],
    ),
    reading(
      'Candidates',
      el('span', { class: 'reading-value', text: number(candidates.total) }),
      undefined,
      [
        `completed ${number(candidates.done)} · rejected ${number(candidates.rejected)} · in flight ${number(candidates.inFlight.length)}`,
      ],
      // Which candidates those are. The rail marks them in 9px slashes; a reader who wants the ids
      // reads them here, and the count above stops being a number with no referent (ticket #7 moved
      // this list out of the retired Overview card).
      [
        el(
          'ul',
          { class: 'reading-list' },
          candidates.inFlight.map((candidateId) => el('li', { text: candidateId })),
        ),
      ],
    ),
    reading('GPU hours', budgetBar(spend) ?? el('span', { class: 'reading-value', text: number(spend?.settledGpuHours) }), undefined, [
      `reserved, not yet settled ${number(spend?.budget?.reservedUnsettledGpuHours)} — held against the ledger, including what a finished candidate did not spend`,
      // Model tokens are part of what a run costs and are not GPU hours: the retired Overview card
      // was the only place they appeared, so they live beside the spend they belong to.
      `tokens ${number(spend?.tokens)}`,
    ]),
    reading(
      'Frontier',
      el('span', { class: 'reading-value', text: number(frontier.size) }),
      'members',
      [
        `${number(frontier.objectives?.length)} objective(s)`,
        `primary ${frontier.primary ?? 'none declared'}`,
      ],
      [
        el(
          'ul',
          { class: 'reading-list' },
          (frontier.readings ?? []).map((member) =>
            el('li', { text: measurement(member.candidate_id, frontier.primary, member.value) }),
          ),
        ),
      ],
    ),
    reading('Cluster', clusterValue, 'cards in use', clusterSubs, [
      el('dd', { class: 'reading-sub', text: `waiting ${number(queue.count)}` }),
      waiting.length === 0
        ? null
        : el(
            'ul',
            { class: 'reading-list' },
            waiting.map((entry) =>
              el('li', { text: `${entry.candidate_id} — ${HOLD_WORDS[entry.reason] ?? entry.reason ?? 'no hold recorded'}` }),
            ),
          ),
    ]),
  )
}

/**
 * Why a candidate is sitting at SUBMIT_QUEUED, in the words the decision used.
 *
 * The reason is `holdReason()`'s in the projection — `budget` or `single_job_gpu` — and this is only
 * its label: the page must not decide *whether* a candidate is held, because the loop holds it and the
 * two would eventually disagree. A reason the kernel adds and this table forgets falls back to its
 * identifier: visible and ugly, which is the honest failure.
 */
const HOLD_WORDS = Object.freeze({
  budget: 'the budget soft limit is reached',
  single_job_gpu: 'another job holds the cards (gpu_exclusivity: single_job)',
})

/** One element, with text and listeners attached safely. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === 'text') node.textContent = String(value)
    else if (key === 'class') node.className = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children) if (child !== undefined && child !== null) node.append(child)
  return node
}

/**
 * One metric reading, spelled one way: `auc=0.7331`, or `r5-h2 auc=0.7331` when the candidate that
 * set it is part of the answer.
 *
 * Every place the page prints "this candidate scored this much on this metric" goes through here,
 * because the one thing the pre-redesign page got wrong in three places at once was assembling that string by
 * hand next to a raw value — which is how `undefined=0.7211` reached a reader's screen.
 */
const measurement = (candidateId, metric, value) =>
  `${candidateId === null || candidateId === undefined || candidateId === '' ? '' : `${candidateId} `}` +
  `${metric ?? EM_DASH}=${number(value)}`

/** The state of the page: one cursor per answer, one dedupe set, one bounded stream. */
const state = {
  cursors: new Map(),
  seen: new Set(),
  /** The most recent facts, newest kept bounded: the stream is a window, not a history. */
  events: [],
  /** How many facts the page has read at all — the number beside the stream's title. */
  factTotal: 0,
  selected: null,
  /** When the last *successful* poll completed: the `read at` stamp, and what "last good read" means. */
  readAt: null,
  lastError: null,
  /** The audit list as last read, whether the reader left it open, and the one call they opened. */
  audit: null,
  auditOpen: false,
  openCall: null,
  openCallRecord: null,
}

/**
 * The candidate the page was opened on: `?candidate=r5-h2`.
 *
 * A dashboard that always starts by asking the reader to click cannot be linked to, quoted in a
 * review, or screenshotted at a particular candidate — and "look at r3-k1" is the sentence a reader
 * actually sends. The selection is read, never written back: v1 shows a run, it does not navigate one.
 */
function requestedCandidate() {
  try {
    const value = new URLSearchParams(location.search).get('candidate')
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

/** One read with no cursor bookkeeping — the audit's detail request is not part of the increment. */
async function readOnce(view, options = {}) {
  const response = await fetch(urlFor(view, options), { headers: { accept: 'application/json' }, cache: 'no-store' })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${view}: HTTP ${response.status} — ${answer?.error?.message ?? 'no answer'}`)
  return answer
}

async function read(view, options = {}) {
  const key = `${view}|${options.candidate ?? ''}`
  const url = urlFor(view, { cursor: state.cursors.get(key), ...options })
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${view}: HTTP ${response.status} — ${answer?.error?.message ?? 'no answer'}`)
  }
  if (answer.cursor) state.cursors.set(key, answer.cursor)
  for (const event of answer.incremental?.events ?? []) {
    // The server is idempotent; so is the page. A repeated cursor must not double a timeline.
    if (state.seen.has(event.cursor)) continue
    state.seen.add(event.cursor)
    state.events.push(event)
    state.factTotal += 1
  }
  if (state.events.length > STREAM_LIMIT) state.events.splice(0, state.events.length - STREAM_LIMIT)
  return answer
}

// ------------------------------------------------------------------ rendering

/**
 * The phase capsule in the masthead — the only place on the page the workspace phase appears.
 *
 * It answers the first question a reader has: *is it still running, and where is it*. The capsule
 * carries three things and each has one source: the phase name (the workspace record), the state word
 * (the recorded stop conclusion — a run that has concluded says `stopped`, not `running`), and a dot
 * that is decoration for the same fact the word already states. Nothing here is derived: `phase` is
 * `null` on a run that has not recorded one, and the capsule says so in words instead of printing a
 * dash that reads as "none of your business".
 *
 * `aria-live="polite"` on the capsule itself (index.html) is the point: a phase change is worth
 * hearing, and a screen reader that is told once per poll that nothing changed hears nothing.
 */
function renderPhase(answer) {
  const root = document.getElementById('phase')
  const data = answer?.data

  if (data === null || data === undefined) {
    root.dataset.state = 'unknown'
    root.replaceChildren(
      el('span', { class: 'phase-capsule-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'phase-capsule-name', text: 'no facts yet' }),
    )
    return
  }

  const stopped = data.stop?.stopped === true
  root.dataset.state = stopped ? 'stopped' : 'running'
  root.replaceChildren(
    el('span', { class: 'phase-capsule-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'phase-capsule-name', text: data.workspace?.phase ?? 'phase not recorded' }),
    el('span', { class: 'phase-capsule-state', text: stopped ? 'stopped' : 'running' }),
  )
}

/**
 * The capsule when the very first read failed: `connecting…` is a promise the page cannot keep.
 *
 * A dashboard pointed at a workspace it cannot open (a corrupt fact plane, a host that answers 500)
 * has not read the phase — so it says `not read` rather than leaving the initial placeholder up
 * forever, which is the one thing an unreachable page must not do: look like a slow one.
 */
function renderPhaseUnread() {
  const root = document.getElementById('phase')
  root.dataset.state = 'unknown'
  root.replaceChildren(
    el('span', { class: 'phase-capsule-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'phase-capsule-name', text: 'not read' }),
    el('span', { class: 'phase-capsule-state', text: 'unknown' }),
  )
}

/**
 * The strip under the conclusion: the loud facts that are not a step in any region.
 *
 * Three kinds, and all three are the projection's own sentences rather than a code this page invents:
 * the warnings the run owes a reader (`warnings.js` — an executor that does not reserve GPUs, say),
 * the notes the route attached to its own answer ("this workspace never recorded a budget"), and the
 * metric contract's refusal when it disagrees with itself (spec §6.9 puts that one above the stop
 * rules, which is where this strip sits).
 *
 * A failed poll is reported here too, in the same voice as the others: a dashboard that leaves its
 * last good page up is right, but staying silent about *why* it is stale is not (spec §6.9's 500 row).
 */
function renderStrips(answer) {
  const root = document.getElementById('strips')
  root.replaceChildren()

  if (state.lastError !== null && state.lastError !== undefined) {
    root.append(
      el('p', {
        class: 'warning',
        text: `could not read ${state.lastError instanceof Error ? state.lastError.message : String(state.lastError)}`,
      }),
      el('p', {
        class: 'note',
        text:
          state.readAt === null || state.readAt === undefined
            ? 'nothing has been read successfully yet, so the page is still empty'
            : `the page is showing the last successful read (${clock(state.readAt)})`,
      }),
    )
  }

  const data = answer?.data
  if (data === null || data === undefined) {
    for (const note of answer?.notes ?? []) root.append(el('p', { class: 'note', text: note }))
    return
  }

  for (const warning of data.warnings ?? []) {
    root.append(el('p', { class: warning.severity === 'warning' ? 'warning' : 'note', text: warning.label ?? warning.code }))
    // The label is the headline ("未声明 GPU 排他"); the message is what it costs. Both are the
    // projection's words, and a warning nobody can act on is only half a warning.
    if (typeof warning.message === 'string' && warning.message !== '' && warning.message !== warning.label) {
      root.append(el('p', { class: 'dim', text: warning.message }))
    }
  }

  if (data.metricContract?.ok !== true) {
    root.append(
      el('p', { class: 'note', text: `nothing can be ranked — ${data.metricContract?.error ?? 'no metric contract'}` }),
    )
  }

  for (const note of answer?.notes ?? []) root.append(el('p', { class: 'note', text: note }))
}

/**
 * The staircase: the best result after each round, and the round rail underneath it.
 *
 * This replaces the old Rounds table. It answers one question at a glance — *is this run getting
 * better?* — and it answers it the same way for a reader who cannot see it: the chart carries a
 * one-sentence `aria-label`, and the same rounds are expandable below as a table.
 *
 * What the page may and may not decide:
 *
 *   - **Draw.** Slot geometry, where a value sits between the published axis bounds, which marker is
 *     filled (the projection's `improving`), which candidate is which shape (the projection's
 *     `shape`). That is placement, and it is the only arithmetic here — one division per mark.
 *   - **Not derive.** No running maximum, no comparison of two results, no binning of "empty". The
 *     cumulative series, the axis and the verdicts all arrive computed (`ladder` in the conclusion
 *     view, `cumulative`/`verdict`/`shape` in the rounds view), so the step this page draws and the
 *     one `dump` prints are the same number.
 *
 * The chart and the rail share one slot model: `n+1` slots (INIT, then one per round), whose width is
 * `--reprise-slot`. The plot places its marks by that fraction and the rail divides the same width
 * into the same number of equal cells, so the two cannot drift apart (spec §6.4).
 */
function renderLadder(roundsAnswer, conclusionAnswer) {
  const root = document.getElementById('ladder')
  root.replaceChildren(el('h2', { text: 'Best so far, round by round' }))

  const rounds = roundsAnswer?.data
  if (!Array.isArray(rounds) || rounds.length === 0) {
    root.append(el('p', { class: 'empty', text: roundsAnswer?.reason ?? 'no round has facts yet' }))
    return
  }

  const data = conclusionAnswer?.data
  const ladder = data?.ladder ?? null
  const metric = ladder?.metric ?? null
  const axis = ladder?.axis ?? null
  const baseline = ladder?.baseline ?? null
  const best = data?.best ?? null

  // One slot per round, plus the INIT slot the axis starts from.
  const slots = rounds.length + 1
  const slot = 100 / slots
  const grid = el('div', {
    class: 'ladder',
    'data-slots': String(slots),
    style: `--reprise-slot: ${slot.toFixed(6)}%`,
  })

  // The sentence the chart is read as. It says the same thing to a sighted reader and to a screen
  // reader, and it is what the plot's role="img" carries, because a picture of a staircase is not
  // accessible on its own.
  const summary = ladderSentence({ rounds, best, baseline, metric })
  root.append(el('p', { class: 'ladder-summary', text: summary }))

  if (axis === null) {
    // Nothing comparable: no axis, no plot, and the rail is what survives (spec §6.9). The chart is
    // dropped rather than drawn empty — an empty frame reads as "no change", which is a different
    // claim from "nothing was measured".
    root.append(
      el('p', { class: 'note', text: ladder?.axisAbsent ?? 'no comparable result yet, so there is no staircase to draw' }),
    )
  } else {
    grid.append(
      el('div', { class: 'ladder-axis' }, [axis.top, axis.middle, axis.bottom].map((bound) =>
        el('span', { class: 'ladder-axis-label', text: fixed(bound) }),
      )),
      ladderPlot({ rounds, axis, baseline, slot, summary }),
    )
  }

  // The rail goes *inside* the ladder's grid, in the second row of the same second column as the
  // plot: that is what makes a marker and the round under it share one slot width.
  grid.append(rail({ rounds, metric, slots }))
  root.append(grid, ladderKey({ baseline }), ladderTable({ rounds, metric }))
}

/**
 * Where a value sits inside the plot, measured from the top in percent.
 *
 * Drawing geometry, not a derivation: the bounds are the projection's (`ladder.axis`), and this only
 * answers "how far down the box" — the one division the page performs on a metric, which is why the
 * axis is published instead of computed from the series. The guard is for a degenerate axis (the two
 * published bounds equal), where the division would not be a number at all; it compares the axis to
 * itself and never two results.
 */
function heightPercent(value, axis) {
  const range = axis.top - axis.bottom
  if (range === 0) return 50
  return ((axis.top - value) / range) * 100
}

/** The plot: the INIT baseline, the steps, the risers, and one marker per round that produced a best. */
function ladderPlot({ rounds, axis, baseline, slot, summary }) {
  const plot = el('div', { class: 'ladder-plot', role: 'img', 'aria-label': summary })

  if (baseline !== null) {
    // A missing baseline is not zero and not the last best: the line is dropped, and the key says it
    // was not recorded (spec §6.9). The page never invents a value to draw.
    plot.append(
      el('div', { class: 'ladder-baseline', style: `top: ${heightPercent(baseline.value, axis).toFixed(3)}%` }, [
        el('span', {
          class: 'ladder-baseline-label',
          text: `${baseline.metric ?? 'baseline'} ${number(baseline.value)} · INIT frozen`,
        }),
      ]),
    )
  }

  rounds.forEach((entry, index) => {
    const cumulative = entry.cumulative
    if (cumulative === null || cumulative === undefined) return
    // Slot 0 is INIT, so round `index` sits in slot `index + 1`; a mark sits at the slot's centre.
    const centre = (index + 1.5) * slot
    const level = heightPercent(cumulative.value, axis)
    const previous = rounds[index - 1]?.cumulative ?? null

    // The step runs from this round's centre to the next slot's — and off the right edge after the
    // last round, because the best then stands. `improving` is the projection's word for "this round
    // is where it rose", so the riser needs no comparison of its own.
    const tail = index === rounds.length - 1 ? slot / 2 : slot
    plot.append(
      el('span', {
        class: 'ladder-step',
        style: `left: ${centre.toFixed(3)}%; width: ${tail.toFixed(3)}%; top: ${level.toFixed(3)}%`,
      }),
    )

    if (entry.improving === true && previous !== null) {
      // A running best never falls, so the riser runs from this round's level down to the previous
      // one: the height is one subtraction of two *placements*, and there is no "which is higher" to
      // decide — the projection already decided it with `improving`.
      const from = heightPercent(previous.value, axis)
      plot.append(
        el('span', {
          class: 'ladder-riser',
          style: `left: ${centre.toFixed(3)}%; top: ${level.toFixed(3)}%; height: ${(from - level).toFixed(3)}%`,
        }),
      )
    }

    // A round that produced no comparable number gets no marker: the step runs on at the value the
    // run still held, and the gap at the slot is the fact (spec §6.4 — "只有真正抬高了最好成绩的那一轮
    // 才填实标记；持平轮留空心；空轮在轨道上是可见的空位").
    if (entry.empty !== true) {
      plot.append(
        el('span', {
          class: 'ladder-marker',
          'data-filled': entry.improving === true ? 'true' : 'false',
          style: `left: ${centre.toFixed(3)}%; top: ${level.toFixed(3)}%`,
        }),
      )
    }
  })

  return plot
}

/** One candidate's accessible name: who it is, what shape it is, and what it scored if it scored. */
function candidateLabel(candidate, metric) {
  const shape = SHAPE_WORDS[candidate.shape] ?? candidate.shape
  const score = candidate.value === null || candidate.value === undefined ? '' : ` · ${metric ?? 'value'} ${number(candidate.value)}`
  return `${candidate.candidate_id} · ${shape}${score}`
}

/**
 * The round rail: one cell per round, one square per candidate.
 *
 * The squares are real buttons — keyboard reachable, `aria-pressed` on the one the inspector is
 * showing, and a click re-points the inspector. Shape carries the meaning (filled, hollow, hatched,
 * struck through), never hue: two readers, one of them colour-blind, have to separate "rejected"
 * from "in flight" from "invalid artifact" from an empty slot.
 */
function rail({ rounds, metric, slots }) {
  const cells = [
    el('div', { class: 'rail-cell', 'data-round': 'init' }, [
      el('div', { class: 'rail-candidates', 'data-role': 'none' }),
      el('span', { class: 'rail-round', text: 'INIT' }),
      el('span', { class: 'rail-verdict', 'data-verdict': 'init', text: 'baseline' }),
    ]),
  ]

  for (const entry of rounds) {
    const candidates = entry.candidates ?? []
    cells.push(
      el('div', { class: 'rail-cell', 'data-round': String(entry.round), 'data-verdict': entry.verdict }, [
        el(
          'div',
          { class: 'rail-candidates' },
          candidates.map((candidate) =>
            el('button', {
              type: 'button',
              class: 'rail-candidate',
              'data-shape': candidate.shape,
              'aria-pressed': state.selected === candidate.candidate_id ? 'true' : 'false',
              'aria-label': candidateLabel(candidate, metric),
              title: candidateLabel(candidate, metric),
              onclick: () => select(candidate.candidate_id),
            }),
          ),
        ),
        el('span', { class: 'rail-round', text: `R${number(entry.round)}` }),
        el('span', {
          class: 'rail-verdict',
          'data-verdict': entry.verdict,
          text: VERDICT_WORDS[entry.verdict] ?? entry.verdict,
        }),
      ]),
    )
  }

  // The rail shares the plot's slot model: `slots` cells across the same width, so the mark above a
  // round and the round's own cell line up. The count is in the DOM (`data-slots`) so a probe can
  // check the two views were built from the same number.
  return el('div', { class: 'rail', 'data-slots': String(slots) }, cells)
}

/** The key: five shapes and the baseline line, because a shape nobody can name is not information. */
function ladderKey({ baseline }) {
  const key = el('p', { class: 'ladder-key' })
  for (const [shape, word] of Object.entries(SHAPE_WORDS)) {
    key.append(el('span', {}, [el('i', { class: 'rail-candidate', 'data-shape': shape }), word]))
  }
  key.append(
    baseline === null
      ? el('span', { text: 'baseline not recorded — no INIT line' })
      : el('span', {}, [el('span', { class: 'ladder-key-line' }), `baseline ${number(baseline.value)} · INIT frozen`]),
  )
  return key
}

/** The text alternative: the same rounds as a table, because a chart cannot be read aloud. */
function ladderTable({ rounds, metric }) {
  const body = el('tbody')
  for (const entry of rounds) {
    body.append(
      el('tr', {}, [
        el('td', { text: `R${number(entry.round)}` }),
        el('td', { text: VERDICT_WORDS[entry.verdict] ?? entry.verdict }),
        el('td', {
          text:
            entry.best === null || entry.best === undefined
              ? EM_DASH
              : measurement(entry.best.candidate_id, entry.best.metric, entry.best.value),
        }),
        el('td', {
          text:
            entry.cumulative === null || entry.cumulative === undefined
              ? EM_DASH
              : measurement(entry.cumulative.candidate_id, entry.cumulative.metric, entry.cumulative.value),
        }),
        el('td', {
          text: (entry.candidates ?? [])
            .map((candidate) => `${candidate.candidate_id} ${candidate.verdict ?? candidate.status}`)
            .join(' · '),
        }),
      ]),
    )
  }
  return el('details', { class: 'ladder-aside' }, [
    el('summary', { text: 'Read it as a table' }),
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, ['round', 'what happened', 'best in the round', 'best after', 'candidates'].map((label) =>
          el('th', { text: label }),
        )),
      ]),
      body,
    ]),
    el('p', {
      class: 'dim',
      text: `Each round on the primary metric (${metric ?? 'none declared'}); a candidate is named with the gate's own four-state word when it has one.`,
    }),
  ])
}

/**
 * The one sentence the staircase is worth. Same text for the plot's `aria-label` and for the visible
 * summary: two renderings of one sentence is one claim, two sentences is two.
 *
 * It states only what the projection published — how many rounds there were, the best result and the
 * round it was set in, and whether a baseline was recorded at all. "No baseline" is a sentence here,
 * never a zero and never an em dash.
 */
function ladderSentence({ rounds, best, baseline, metric }) {
  const what =
    best === null || best === undefined
      ? `None of the ${number(rounds.length)} rounds produced a comparable ${metric ?? 'result'} yet.`
      : `${number(rounds.length)} rounds: the best ${metric ?? 'result'} is ${number(best.value)}, set in round ${number(best.round)}.`
  const against =
    baseline === null
      ? ' No baseline was recorded, so there is no INIT line to measure against.'
      : ` The INIT baseline, ${number(baseline.value)}, is the dashed line.`
  return what + against
}

/** The metric readings a candidate carries, in one line: the primary first, then the rest by name. */
function measuredText(detail) {
  const vector = detail.frontier.vector ?? {}
  const primary = detail.frontier.best?.metric ?? null
  const names = Object.keys(vector).sort((left, right) => {
    if (left === primary) return -1
    if (right === primary) return 1
    return left < right ? -1 : left > right ? 1 : 0
  })
  if (names.length === 0) return 'no metric measured'
  return `measured ${names.map((name) => measurement(null, name, vector[name])).join(' ')}`
}

/**
 * Who this candidate is, in one row: its id, its round, the shape word the rail draws for it, its
 * job, and what it was measured at — then, under it, what it set out to do.
 *
 * The shape word is read from `SHAPE_WORDS`, the same module the rail reads, so the sentence here and
 * the square over its round cannot call one candidate two things. Nothing in this row says whether
 * the news is good: "in flight", "rejected" and "invalid artifact" are facts about where it got to.
 */
function renderIdentity(detail) {
  const job = detail.job
  const identity = el('div', { class: 'identity' })

  identity.append(
    el('div', { class: 'identity-line' }, [
      el('span', { class: 'identity-id', text: detail.candidate_id }),
      el('span', {
        class: 'identity-round',
        text: detail.round === null || detail.round === undefined ? 'no round recorded' : `round ${number(detail.round)}`,
      }),
      el('span', { class: 'identity-shape', text: SHAPE_WORDS[detail.shape] ?? detail.shape ?? EM_DASH }),
    ]),
  )

  identity.append(
    el('p', { class: 'identity-meta' }, [
      el('span', {
        text:
          job === null || job === undefined
            ? 'no job recorded'
            : `job ${job.job_id} · ${job.state} · attempts ${number(job.attempts)}${job.error_class === null || job.error_class === undefined ? '' : ` · ${job.error_class}`}`,
      }),
      el('span', { text: ' · ' }),
      el('span', { text: measuredText(detail) }),
    ]),
  )

  // The hypothesis is the one sentence that explains why this candidate exists, and it is recorded
  // once, when the candidate is created. A candidate a human proposed may have none — that is a
  // fact too, and it is said in words rather than left as a gap.
  identity.append(
    typeof detail.hypothesis === 'string' && detail.hypothesis !== ''
      ? el('p', { class: 'identity-hypothesis', text: detail.hypothesis })
      : el('p', { class: 'identity-hypothesis dim', text: 'no hypothesis was recorded for this candidate' }),
  )

  if (detail.lag.pending > 0) {
    identity.append(
      el('p', {
        class: 'note',
        text: `${number(detail.lag.pending)} event(s) recorded but not yet folded into state — this page shows the facts, the kernel will catch up`,
      }),
    )
  }
  return identity
}

/**
 * The whole path, all eight phases, drawn from the projection.
 *
 * Every phase carries a mark **and** the word for it. The mark is for the reader scanning down the
 * row and the word is for the reader who cannot see the difference between a dashed square and a
 * hatched one — which is also what makes the four states survive a greyscale screenshot. The phase
 * order is the payload's: the page cannot import the contract, and a list kept here would be a
 * second order to drift from the kernel's.
 *
 * "Not reached" is drawn as its own mark rather than as an empty `ok`: ticket 29 exists because a
 * candidate that never got to a phase was being read as a candidate that failed it.
 */
function renderPhasePath(phasePath, status) {
  const list = el('ol', { class: 'phase-path' })
  // "Here" answers "where is it now", which is a question only a running candidate has. A finished
  // one walked the whole path and a rejected one left it, so neither is *in* a phase — and a stale
  // state row (the kernel folds its state a moment after the fact) must not be drawn as a claim
  // against a candidate whose own record says it finished.
  const running = status === 'active'
  for (const step of phasePath) {
    const mark = phaseMark({ status: step.status, reached: step.reached })
    const here = running && step.current === true
    const item = el(
      'li',
      { class: 'phase', 'data-mark': mark.mark, 'data-current': here ? 'true' : 'false' },
      [
        el('span', { class: 'phase-mark', 'aria-hidden': 'true' }),
        el('span', { class: 'phase-name', text: step.phase }),
        el('span', { class: 'phase-word', text: mark.word }),
      ],
    )
    if (here) item.append(el('span', { class: 'phase-here', text: 'here' }))
    // The fact that recorded this phase's verdict: its seq and the instant it happened. A reader
    // checking the page against the fact plane needs both, and neither is derivable from the others.
    if (Number.isSafeInteger(step.seq)) {
      item.append(el('span', { class: 'phase-stamp', text: `${seqStamp(step.seq)} ${clock(step.atMs)}` }))
    }
    list.append(item)
  }
  return el('section', { class: 'inspector-section' }, [el('h3', { text: 'the phases it walked' }), list])
}

/**
 * Why it stopped: the original words, and the fact that recorded them.
 *
 * Two rules, both from CODING_STANDARDS §2:
 *
 *   - **no four-state badge here.** The four states answer "is this fact present and trustworthy";
 *     "the answer was no" is a decision made *from* them, and a badge on the decision invites a
 *     reader to file a legitimate rejection as a malformed artifact. The phase path above already
 *     carries the state word at the phase it was decided at.
 *   - **the words are verbatim.** A `<pre>`, unwrapped and unparaphrased: this is the message a future
 *     reader will compare against the artifact, so it is quoted, not summarised.
 *
 * The footer names the fact — clock time, event type and `#seq` — because "why did it stop" is only
 * half an answer without "which record says so".
 */
function renderRejection(rejection, verdictStep) {
  const block = el('section', { class: 'rejection' })
  block.append(
    el('h3', {
      class: 'rejection-title',
      text: rejection.phase === null || rejection.phase === undefined ? 'why it stopped' : `why it stopped at ${rejection.phase}`,
    }),
  )
  block.append(
    rejection.message === null || rejection.message === undefined || rejection.message === ''
      ? el('p', { class: 'dim', text: 'no message was recorded with this decision' })
      : el('pre', { class: 'rejection-words', text: rejection.message }),
  )
  if (rejection.reason !== undefined && rejection.reason !== rejection.message) {
    block.append(
      el('p', { class: 'rejection-reason' }, [
        el('span', { class: 'dim', text: 'the decision recorded: ' }),
        el('span', { text: rejection.reason }),
      ]),
    )
  }
  block.append(
    el('p', {
      class: 'rejection-when dim',
      text: `recorded ${clock(rejection.atMs)} · event ${rejection.eventType} ${seqStamp(rejection.seq)}`,
    }),
  )
  // The gate said something too, and it is a different fact from the decision: the schema error, the
  // missing artifact, the two numbers that disagree. Both are printed, each with its own seq, because
  // "which fact says what" is the question a reader comparing this page with the artifact store has.
  if (verdictStep !== undefined && typeof verdictStep.message === 'string' && verdictStep.message !== '') {
    block.append(
      el('p', { class: 'rejection-reason dim' }, [
        el('span', { text: `the gate at ${verdictStep.phase} said ` }),
        el('span', { text: `${seqStamp(verdictStep.seq)} ${clock(verdictStep.atMs)}` }),
        el('span', { text: ` (${verdictStep.eventType})` }),
      ]),
      el('pre', { class: 'rejection-words', text: verdictStep.message }),
    )
  }
  // The verdict and the decision that followed it are two facts; when they are different events the
  // second one is named too, or the reader takes the gate's message for the whole decision.
  if (rejection.terminal !== undefined) {
    block.append(
      el('p', {
        class: 'rejection-when dim',
        text: `decided ${clock(rejection.terminal.atMs)} · event ${rejection.terminal.eventType} ${seqStamp(rejection.terminal.seq)}`,
      }),
    )
  }
  return block
}

/**
 * Ticket 29's gate chain, step by step: passed / failed / missing, where missing is not failed.
 *
 * Kept as it was — the chain answers a different question from the phase path ("did the gate actually
 * look at this?") — but drawn under the path and the rejection, because it is evidence for them
 * rather than the first thing a reader should meet.
 */
function renderPhaseChain(detail) {
  const chain = detail.gateChain
  if (chain === undefined || chain.chain.length === 0) return null

  const rows = chain.chain.map((step) =>
    el('li', {}, [
      el('span', { class: 'badge', dataset: { state: step.status }, text: step.status }),
      el('span', { text: ` ${step.name}${step.detail === '' ? '' : ` — ${step.detail}`}` }),
    ]),
  )
  const block = el('section', { class: 'inspector-section' }, [el('h3', { text: 'gate chain' }), el('ul', {}, rows)])
  if (chain.attempts.length > 0) {
    block.append(
      el('p', {
        class: 'dim',
        text: `attempts: ${chain.attempts
          .map((attempt) => `${attempt.attempt} ${attempt.passed === true ? 'passed' : 'failed'}${attempt.review === null ? '' : ` (review: ${attempt.review.verdict})`}`)
          .join(' · ')}`,
      }),
    )
  }
  return block
}

/** The facts that got it here: time, type, summary and `#seq`, newest first. */
function renderTimeline(timeline) {
  const recent = (timeline ?? []).slice(-9).reverse()
  if (recent.length === 0) return el('span')
  const list = el('ol', { class: 'timeline' })
  for (const event of recent) {
    list.append(
      el('li', {}, [
        el('span', { class: 'timeline-time', text: clock(event.atMs) }),
        el('span', { class: 'timeline-type', text: event.eventType }),
        el('span', { class: 'timeline-summary', text: event.summary === '' ? EM_DASH : event.summary }),
        el('span', { class: 'timeline-stamp', text: seqStamp(event.seq) }),
      ]),
    )
  }
  return el('section', { class: 'inspector-section' }, [
    el('h3', { text: `the last ${number(recent.length)} facts` }),
    list,
  ])
}

/**
 * Everything else the fact plane recorded about this candidate, collapsed.
 *
 * The frontier position, the identity bindings and the artifact names are reference material: a
 * reader checking a claim opens them, a reader deciding whether to believe the run does not. They
 * stay on the page — removing them would make this inspector weaker than the `dump` it mirrors —
 * but they do not cost a screen by default.
 */
function renderCandidateAside(detail) {
  const body = el('div', { class: 'inspector-aside-body' })
  body.append(
    el('p', {
      text:
        detail.frontier.position === 'frontier'
          ? 'on the frontier'
          : `frontier position: ${String(detail.frontier.position)}`,
    }),
    el('p', { class: 'dim', text: `vector ${JSON.stringify(detail.frontier.vector)}` }),
    el('p', {
      class: 'dim',
      text:
        detail.frontier.best === undefined
          ? 'best: no comparable result yet'
          : `best ${measurement(detail.frontier.best.candidate_id, detail.frontier.best.metric, detail.frontier.best.value)}`,
    }),
  )
  const bindingKinds = Object.keys(detail.bindings).sort()
  if (bindingKinds.length > 0) {
    body.append(
      el('h3', { text: 'identity bindings' }),
      el('pre', { text: bindingKinds.map((kind) => `${kind} ${JSON.stringify(detail.bindings[kind])}`).join('\n') }),
    )
  }
  if (detail.artifacts.length > 0) {
    body.append(el('h3', { text: 'referenced artifacts' }), el('pre', { text: detail.artifacts.join('\n') }))
  }
  return el('details', { class: 'inspector-aside' }, [
    el('summary', { text: 'the facts behind this candidate' }),
    body,
  ])
}

/**
 * The candidate inspector: identity, the path it walked, why it stopped, the gate chain, and the
 * facts that got it there.
 *
 * The order is the order a reader asks the questions in — who is this, where did it get to, why did
 * it stop, can I check — and each answer says which fact it came from. Nothing here decides anything:
 * the path, the shape word, the four-state marks and the rejection text all arrive from the
 * projection, and the page decides only how to lay them out.
 */
function renderCandidate(answer) {
  const root = document.getElementById('candidate')
  root.replaceChildren(el('h2', { text: state.selected === null ? 'Candidate' : `Candidate ${state.selected}` }))

  if (state.selected === null) {
    root.append(el('p', { class: 'empty', text: 'choose a candidate from a round.' }))
    return
  }
  if (answer?.data === null || answer?.data === undefined) {
    root.append(el('p', { class: 'empty', text: answer?.reason ?? 'no facts recorded for this candidate' }))
    return
  }

  const detail = answer.data
  root.append(renderIdentity(detail), renderPhasePath(detail.phasePath ?? [], detail.status))
  if (detail.rejection !== undefined) {
    // The gate's words for the phase the candidate stopped at, when they are not the words of the
    // decision — both are quotes, and the reader is owed both.
    const verdictStep = (detail.phasePath ?? []).find(
      (step) => step.phase === detail.rejection.phase && step.message !== null && step.message !== detail.rejection.message,
    )
    root.append(renderRejection(detail.rejection, verdictStep))
  }
  const chain = renderPhaseChain(detail)
  if (chain !== null) root.append(chain)
  root.append(renderTimeline(detail.timeline), renderCandidateAside(detail))
}

/**
 * The sentence under the big number: what we measured, what against, and how much — in words.
 *
 * Three claims, and the wording keeps them apart:
 *
 *   - *which result* — the candidate and the round it came from;
 *   - *against what* — `group.kind` decides. A frozen baseline and the previous best are two
 *     different claims, and "＋2.79%" means something different in each: the first says the run beat
 *     the thing it was chartered to beat, the second only that it improved on itself;
 *   - *how much* — `changePercent`, which the projection divided once. The page does no arithmetic.
 *
 * "Worse than the baseline" is not one of the four states (CODING_STANDARDS §2): it is this sentence,
 * with a word for the direction and no colour anywhere. When the comparison is behind, the sentence
 * says so plainly; when there is no group at all, it says that instead of printing a dash.
 */
function conclusionSentence(comparison) {
  const measured = comparison.measured
  const group = comparison.group
  const where = `The best result came from ${measured.candidate_id} in round ${number(measured.round)}`

  if (group === null || group === undefined) {
    return (
      `${where}, but this run recorded no comparable baseline and no earlier round produced a number to ` +
      `measure it against — so there is no percentage to report.`
    )
  }

  const against =
    group.kind === 'baseline'
      ? `the frozen baseline ${number(group.value)}`
      : `the previous best (${group.candidate_id ?? 'no candidate'}, ${number(group.value)})`

  if (typeof comparison.changePercent !== 'number') {
    // A group of 0 has no relative change — saying "＋∞%" or "＋0.00%" would both be inventions.
    return `${where}: ${change(comparison.change)} on ${against}, which is a change of no percentage.`
  }

  const verdict = comparison.better === false ? ' This run is behind what it is measured against, not ahead of it.' : ''
  return `${where}: ${percent(comparison.changePercent, { sign: true })} against ${against}.${verdict}`
}

/**
 * The conclusion line — the first thing on the page, because it is the one thing the page is for:
 * is this result worth believing, and by how much did it win.
 *
 * Every number here comes from the projection's comparison block. The page adds no subtraction, no
 * division and no opinion about which number is better; it decides only how to *say* what it was
 * given, including the two states where it cannot say anything (`spec §6.9`):
 *
 *   - nothing comparable (`measured === null`) → "No conclusion yet", plus where to look next;
 *   - a result with nothing to compare it against (`group === null`) → the number, and the reason
 *     there is no percentage beside it.
 */
function renderHeadline(answer) {
  const root = document.getElementById('headline')
  root.replaceChildren()

  const data = answer?.data
  const comparison = data?.comparison
  if (comparison === null || comparison === undefined) {
    // No facts at all. A blank headline reads as "nothing to say"; this says what the workspace is
    // waiting for and where it will appear, which is the difference between an empty state and a bug.
    const why = answer?.reason
    root.append(
      el('p', { class: 'headline-empty', text: 'No conclusion yet.' }),
      ...(why === undefined || why === null ? [] : [el('p', { class: 'dim', text: why })]),
      el('p', {
        class: 'dim',
        text:
          'The loop has not ticked here yet: once it does, the first round appears below and the conclusion line ' +
          'fills in as soon as a candidate reaches a metric.',
      }),
    )
    return
  }

  const measured = comparison.measured
  if (measured === null || measured === undefined) {
    root.append(
      el('p', { class: 'headline-empty', text: 'No conclusion yet.' }),
      el('p', {
        class: 'dim',
        text:
          `No candidate has produced a comparable ${comparison.metric ?? 'result'} yet: every candidate was stopped at a gate, ` +
          'or none has reached the step that reports the number. The candidate inspector below says what each one stopped at.',
      }),
    )
    return
  }

  root.append(
    el('p', { class: 'headline-value' }, [
      el('span', { class: 'headline-number', text: number(measured.value) }),
      el('span', { class: 'headline-unit', text: comparison.metric ?? '' }),
    ]),
    el('p', { class: 'headline-sentence', text: conclusionSentence(comparison) }),
    ...comparisonFacts(data),
  )
}

/** One cell of the facts row under the conclusion sentence: a label and its value. */
function fact(label, value) {
  return el('div', { class: 'fact' }, [el('dt', { text: label }), el('dd', { text: value })])
}

/**
 * The three facts the sentence cannot carry, in the projection's numbers.
 *
 * The sentence says "＋3.69% against the frozen baseline 0.706981" — a percentage and a denominator.
 * What it cannot say is *how much metric that is* (the absolute change), whether a number the domain
 * published is anywhere near ours (the pack's table, and our distance from it), and which direction
 * each objective runs (without which neither of those numbers is readable as good or bad news).
 *
 * All three came off the retired `Measured / published` card. They are the page's only answer to
 * "should I trust the model's number", so they moved into the conclusion region rather than being
 * dropped: the card was the furniture, not the facts.
 *
 * The difference against the published number is `comparison.publishedChange` — the projection's
 * subtraction, not this page's (constraint 2). When the contract publishes nothing, the card's reason
 * arrives as `publishedAbsent` and is printed as a sentence; when it does, the source file is named,
 * because a number with no provenance is a number a reader has to take on faith.
 */
function comparisonFacts(data) {
  const comparison = data.comparison
  const published = comparison.published
  const rows = []

  const facts = el('dl', { class: 'facts' }, [
    fact(
      'change',
      comparison.change === null || comparison.change === undefined
        ? 'no comparison group'
        : `${change(comparison.change)}${comparison.metric === null ? '' : ` ${comparison.metric}`}`,
    ),
    published === null
      ? fact('they published', 'nothing published')
      : fact('they published', `${published.method} ${measurement(null, published.metric, published.value)}`),
    published === null
      ? null
      : fact('difference', `${change(comparison.publishedChange)}${comparison.metric === null ? '' : ` ${comparison.metric}`}`),
    fact(
      'objectives',
      data.objectives.length === 0
        ? EM_DASH
        : data.objectives
            .map((objective) => `${objective.name} (${objective.direction}${objective.kind === 'primary' ? ', primary' : ''})`)
            .join(' · '),
    ),
  ])
  rows.push(facts)

  if (published === null) {
    if (comparison.publishedAbsent !== null && comparison.publishedAbsent !== undefined) {
      rows.push(el('p', { class: 'dim', text: comparison.publishedAbsent }))
    }
  } else if (published.source?.file !== undefined) {
    rows.push(
      el('p', {
        class: 'dim',
        text: `published numbers: ${published.source.file}${published.dataset === null ? '' : ` (${published.dataset})`}`,
      }),
    )
  }
  return rows
}

/**
 * The audit: every judgement the run asked a model for, folded into one line until asked.
 *
 * The audit answers "what did it ask the model, and what came back", which is the same kind of thing
 * as the fact stream beside it — and it is also the thing nobody reads while skimming. So it costs
 * one line: `model calls 12`. Opening it lists the call sites and the `ref` of each call; opening one
 * call asks the server for that record (`/api/reprise/call?ref=…`) instead of carrying a hundred
 * prompts in the list, and draws the prompt and the response verbatim.
 *
 * The `<details>` state is kept in `state.auditOpen` because this panel is redrawn on every poll: an
 * open audit that snapped shut every five seconds would be worse than one that never opened.
 */
function renderAudit() {
  const root = document.getElementById('audit')
  const answer = state.audit
  const data = answer?.data

  const details = el('details', { class: 'audit' })
  details.open = state.auditOpen === true
  details.addEventListener('toggle', () => {
    state.auditOpen = details.open
  })
  details.append(
    el('summary', { class: 'audit-line' }, [
      el('span', { text: 'model calls' }),
      el('span', { class: 'audit-count', text: number(data?.calls?.length ?? 0) }),
    ]),
  )

  if (data === undefined || data === null || data.calls.length === 0) {
    details.append(el('p', { class: 'empty', text: answer?.reason ?? data?.reason ?? 'no judgement has asked a model yet.' }))
    root.replaceChildren(details)
    return
  }

  // Call sites first, because the interesting question is usually "was the gate asked anything".
  const sorted = [...data.calls].sort((left, right) => {
    const where = String(left.call_site ?? '').localeCompare(String(right.call_site ?? ''))
    return where !== 0 ? where : String(left.ref).localeCompare(String(right.ref))
  })
  const list = el('ul', { class: 'calls' })
  for (const call of sorted) {
    list.append(
      el('li', {}, [
        el('span', { class: 'call-site', text: call.call_site ?? '?' }),
        el('button', {
          type: 'button',
          class: 'call-ref',
          text: call.ref,
          'aria-pressed': state.openCall === call.ref ? 'true' : 'false',
          onclick: () => openCall(call.ref),
        }),
        el('span', { class: 'dim', text: call.status ?? '' }),
      ]),
    )
  }
  details.append(list)

  const opened = state.openCallRecord
  if (opened !== undefined && opened !== null) {
    if (opened.reason !== undefined) {
      details.append(el('p', { class: 'note', text: opened.reason }))
    } else {
      details.append(
        el('h3', { text: opened.ref }),
        el('p', {
          class: 'dim',
          text: `${opened.call_site ?? '?'} · ${opened.status}${opened.error_class === null ? '' : ` (${opened.error_class})`}`,
        }),
        opened.message === null ? el('span') : el('p', { class: 'note', text: opened.message }),
        el('h3', { text: 'prompt' }),
        el('pre', { text: opened.prompt }),
        el('h3', { text: 'response' }),
        el('pre', { text: opened.response === '' ? '(an empty response)' : opened.response }),
      )
    }
  }
  root.replaceChildren(details)
}

/** Open one judgement: one more read, and the panel redraws. */
async function openCall(ref) {
  state.openCall = ref
  state.openCallRecord = null
  renderAudit()
  try {
    state.openCallRecord = (await readOnce('call', { ref }))?.data ?? { reason: 'that call is no longer recorded' }
  } catch (error) {
    state.openCallRecord = { reason: error instanceof Error ? error.message : String(error) }
  }
  renderAudit()
}

/**
 * The fact stream: what just happened, newest first, one row per fact.
 *
 * Each row is two lines — `22:14:40 gate_result r6-g1 #9` over the one-line summary — because a
 * reader scanning the right column is looking for a time, an event and a candidate, and only then for
 * the detail. `#seq` is on every row: it is the stamp a reader quotes when they say "that fact",
 * and the same stamp the inspector prints beside a phase.
 *
 * The summary is one line with the whole of it in `title`: the column is narrow on purpose, and a
 * wrapped summary would push the rows a reader is looking for off the top.
 */
function renderStream() {
  const root = document.getElementById('stream')
  const recent = state.events.slice(-12).reverse()

  root.replaceChildren(
    el('div', { class: 'card-head' }, [
      el('h2', { text: 'Facts' }),
      el('span', { class: 'dim', text: `${number(state.factTotal)} read` }),
    ]),
  )

  if (recent.length === 0) {
    root.append(el('p', { class: 'empty', text: 'nothing yet.' }))
    return
  }

  const list = el('ol', { class: 'stream' })
  for (const event of recent) {
    list.append(
      el('li', { class: 'stream-row' }, [
        el('span', { class: 'stream-head' }, [
          el('span', { class: 'stream-time', text: clock(event.wall_clock_ms) }),
          el('span', { class: 'stream-type', text: event.event_type }),
          el('span', { class: 'stream-candidate', text: event.candidate_id }),
          el('span', { class: 'stream-seq', text: seqStamp(event.local_seq) }),
        ]),
        el('span', {
          class: 'stream-summary',
          title: event.summary === '' ? event.event_type : event.summary,
          text: event.summary === '' ? EM_DASH : event.summary,
        }),
      ]),
    )
  }
  root.append(list)
}

// ---------------------------------------------------------------------- wiring

/** One stamp in the masthead: a label and a value, and the label is not optional. */
const stamp = (id, text) => {
  document.getElementById(id).textContent = text
}

/**
 * The stamps beside the workspace: when *this page* last read, when the *run* last moved, and the
 * cursor the last answer handed back.
 *
 * They are different instants and the page used to print one of them with no label at all — a reader
 * could not tell "17:15:30" from "22:24:40" without knowing which question each answered (spec §6.1).
 * `read at` is this browser's successful poll; `last fact` is the newest fact *in the workspace*, and
 * it is the envelope's own `cursor` rendered two ways — the instant here, the order key beside it. It
 * is deliberately not a running maximum over the facts this page has read: the page sees a window and
 * the Web UI panel sees another, so a tally in each renderer would print two different instants for
 * one run (and did).
 */
const stamps = (answer) => {
  const workspace = answer?.workspace
  // The last three segments, with the whole path on the element: a masthead is a place for a name,
  // not for a scrollbar, and `title` keeps the address recoverable (spec §6.1).
  stamp('workspace', pathTail(workspace))
  document.getElementById('workspace').title = typeof workspace === 'string' ? workspace : ''
  stamp('read-at', clock(state.readAt))
  stamp('last-fact', clock(cursorAt(answer?.cursor)))
  stamp('cursor', answer?.cursor === undefined || answer?.cursor === null ? '' : cursor(answer.cursor))
}

async function select(candidateId) {
  state.selected = candidateId
  await refresh()
}

/** One poll: the increment for every view, then the page is redrawn from what the facts say. */
async function refresh() {
  try {
    const [overview, rounds, conclusion, audit] = await Promise.all([
      read('overview'),
      read('rounds'),
      read('conclusion'),
      read('calls'),
    ])
    state.audit = audit
    state.lastError = null
    state.readAt = Date.now()

    // The masthead first: which phase it is in, and the two instants a reader orients by.
    renderPhase(overview)
    // Which workspace this page watches. Two windows open on two workspaces must be distinguishable
    // without reading the URL.
    stamps(overview)
    // The loud facts a reader owes themselves before believing anything: warnings, notes, and a
    // metric contract that cannot rank.
    renderStrips(overview)
    // The conclusion line next: the rest of the page is evidence for it.
    renderHeadline(conclusion)
    // Then the questions a reader asks next: will it end on its own, what did it find, what has it cost.
    renderStop(overview)
    renderLadder(rounds, conclusion)
    renderReadings(overview)
    renderAudit()

    if (state.selected !== null) renderCandidate(await read('candidate', { candidate: state.selected }))

    renderStream()
  } catch (error) {
    // A dashboard that dies on one failed poll leaves the last good page on screen and says what
    // broke — in the strip, beside the other facts the run owes a reader (spec §6.9's 500 row).
    state.lastError = error
    // The capsule keeps whatever it last knew: a failed read is not evidence that the run has no
    // phase. But a page that has *never* read anything must not keep saying `connecting…`.
    if (state.readAt === null) renderPhaseUnread()
    renderStrips(null)
  }
}

state.selected = requestedCandidate()
await refresh()
setInterval(refresh, POLL_MS)