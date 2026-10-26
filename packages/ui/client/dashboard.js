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

import { EM_DASH, change, clock, cursor, fixed, number, percent, stamp } from './format.js'

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

/** The card count, or the word for "we could not ask". */
const cardsInUse = (cluster) => (cluster === undefined ? EM_DASH : cluster.cards.inUse === null ? 'unknown' : number(cluster.cards.inUse))

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
 * because the one thing the old page got wrong in three places at once was assembling that string by
 * hand next to a raw value — which is how `undefined=0.7211` reached a reader's screen.
 */
const measurement = (candidateId, metric, value) =>
  `${candidateId === null || candidateId === undefined || candidateId === '' ? '' : `${candidateId} `}` +
  `${metric ?? EM_DASH}=${number(value)}`

/** The state of the page: one cursor per answer, one dedupe set, one bounded stream. */
const state = {
  cursors: new Map(),
  seen: new Set(),
  events: [],
  selected: null,
  lastError: null,
  /** The audit list as last read, and the one call the reader opened (if any). */
  audit: null,
  openCall: null,
  openCallRecord: null,
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
  }
  if (state.events.length > STREAM_LIMIT) state.events.splice(0, state.events.length - STREAM_LIMIT)
  return answer
}

// ------------------------------------------------------------------ rendering

function stat(label, value) {
  return el('div', { class: 'stat' }, [el('dt', { text: label }), el('dd', { text: value ?? EM_DASH })])
}

function renderOverview(answer) {
  const root = document.getElementById('overview')
  root.replaceChildren(el('h2', { text: 'Overview' }))

  if (answer?.data === null || answer?.data === undefined) {
    root.append(el('p', { class: 'empty', text: answer?.reason ?? 'no facts recorded yet' }))
    return
  }
  const data = answer.data
  const stop = data.stop?.stopped ? `stopped: ${data.stop.rule}` : 'running'
  root.append(
    el('dl', { class: 'stats' }, [
      stat('phase', data.workspace.phase ?? EM_DASH),
      stat('state', stop),
      stat('rounds', `${number(data.rounds.completed)}/${number(data.rounds.total)}`),
      stat('in flight', number(data.candidates.inFlight.length)),
      stat('rejected', number(data.candidates.rejected)),
      stat(
        'best',
        data.best === undefined ? 'no comparable result yet' : measurement(data.best.candidate_id, data.best.metric, data.best.value),
      ),
      stat('GPU h settled', number(data.spend.settledGpuHours)),
      stat('GPU h in flight', number(data.spend.inFlightGpuHours)),
      stat('GPU h limit', data.spend.limitGpuHours === 0 ? 'unlimited' : number(data.spend.limitGpuHours)),
      stat('tokens', number(data.spend.tokens)),
      stat('cards in use', cardsInUse(data.cluster)),
      stat('cards / job', number(data.cluster?.cards?.perJob)),
      stat('ledger floor', number(data.cluster?.cards?.floor)),
      stat('waiting', number(data.cluster?.queue?.count)),
    ]),
  )

  // The card figures above are only knowable when the cluster answered; a page that cannot ask says
  // so, and never draws the unknown as 0 — "0 cards" is the answer somebody acts on.
  if (data.cluster !== undefined && data.cluster.read === false) {
    root.append(
      el('p', {
        class: 'note',
        text:
          `the cluster listing was not read — ${data.cluster.reason}; ` +
          `${number(data.cluster.cards.floor)} card(s) is what our own ledger supports, not what is running`,
      }),
    )
  }
  for (const entry of data.cluster?.queue?.waiting ?? []) {
    root.append(el('p', { class: 'dim', text: `waiting: ${entry.candidate_id} — ${entry.reason ?? 'not yet dispatched'}` }))
  }

  for (const warning of data.warnings ?? []) {
    root.append(el('p', { class: warning.severity === 'warning' ? 'warning' : 'note', text: warning.label ?? warning.code }))
  }

  if (data.metricContract?.ok !== true) {
    root.append(el('p', { class: 'note', text: `nothing can be ranked — ${data.metricContract?.error ?? 'no metric contract'}` }))
  }
  for (const note of answer.notes ?? []) root.append(el('p', { class: 'note', text: note }))

  const inFlight = data.candidates.inFlight
  if (inFlight.length > 0) {
    root.append(el('h3', { text: 'in flight' }), el('p', { class: 'dim', text: inFlight.join(', ') }))
  }
  if (data.stop?.stopped) {
    root.append(
      el('h3', { text: 'why it ended' }),
      el('p', { text: `${data.stop.rule} — ${data.stop.message}` }),
      el('p', { class: 'dim', text: `limit ${number(data.stop.limit)}, observed ${number(data.stop.observed)}` }),
    )
  }
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

/** The names a shape goes by. A shape nobody can name is a decoration, not a datum. */
const SHAPE_WORDS = {
  done: 'completed',
  frontier: 'completed, on the frontier',
  rejected: 'rejected',
  'in-flight': 'in flight',
  invalid: 'invalid artifact',
}

/** The words a round's verdict goes by — the projection decides which one applies. */
const VERDICT_WORDS = { raised: 'raised', held: 'held', empty: 'empty round' }

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
  root.append(
    el('dl', { class: 'stats' }, [
      stat('phase', detail.phase ?? '—'),
      stat('status', detail.status),
      stat('round', detail.round ?? '—'),
      stat('events', detail.lag.maxSeq),
      stat('unfolded', detail.lag.pending),
      stat('position', detail.frontier.position),
    ]),
  )
  if (detail.lag.pending > 0) {
    root.append(
      el('p', { class: 'note', text: `${detail.lag.pending} event(s) recorded but not yet folded into state — this page shows the facts, the kernel will catch up` }),
    )
  }

  if (detail.rejection !== undefined) {
    const rejection = detail.rejection
    root.append(
      el('h3', { text: 'why it stopped' }),
      el('p', {}, [
        el('span', { class: 'badge', dataset: { state: rejection.status ?? 'missing' }, text: rejection.status ?? 'no verdict' }),
        el('span', { text: ` at ${rejection.phase ?? EM_DASH}` }),
      ]),
      rejection.message ? el('pre', { text: rejection.message }) : el('p', { class: 'dim', text: '(no message recorded)' }),
      el('p', { class: 'dim', text: `recorded ${stamp(rejection.atMs)} (event ${rejection.seq} ${rejection.eventType})` }),
    )
  }

  if (detail.gates.length > 0) {
    root.append(
      el('h3', { text: 'gate verdicts' }),
      el(
        'ul',
        {},
        detail.gates.map((gate) =>
          el('li', {}, [
            el('span', { class: 'badge', dataset: { state: gate.status }, text: gate.status }),
            el('span', { text: ` ${gate.phase ?? EM_DASH} (event ${gate.seq})` }),
            gate.message ? el('pre', { text: gate.message }) : null,
          ]),
        ),
      ),
    )
  }

  const chain = detail.gateChain
  if (chain !== undefined && chain.chain.length > 0) {
    const rows = chain.chain.map((step) =>
      el('li', {}, [
        el('span', { class: 'badge', dataset: { state: step.status }, text: step.status }),
        el('span', { text: ` ${step.name}${step.detail === '' ? '' : ` — ${step.detail}`}` }),
      ]),
    )
    root.append(el('h3', { text: 'gate chain' }), el('ul', {}, rows))
    if (chain.attempts.length > 0) {
      root.append(
        el(
          'p',
          { class: 'dim', text: `attempts: ${chain.attempts.map((attempt) => `${attempt.attempt} ${attempt.passed === true ? 'passed' : 'failed'}${attempt.review === null ? '' : ` (review: ${attempt.review.verdict})`}`).join(' · ')}` },
        ),
      )
    }
  }

  root.append(
    el('h3', { text: 'timeline' }),
    el(
      'ol',
      { class: 'timeline' },
      detail.timeline.map((event) =>
        el('li', {}, [
          el('span', { class: 'seq', text: `${event.seq} · ${clock(event.atMs)}` }),
          el('span', { text: `${event.eventType}${event.summary === '' ? '' : ` — ${event.summary}`}` }),
        ]),
      ),
    ),
  )

  root.append(
    el('h3', { text: 'frontier position' }),
    el('p', { text: detail.frontier.position === 'frontier' ? 'on the frontier' : String(detail.frontier.position) }),
    el('p', { class: 'dim', text: `vector ${JSON.stringify(detail.frontier.vector)}` }),
    el(
      'p',
      {
        class: 'dim',
        text:
          detail.frontier.best === undefined
            ? 'best: no comparable result yet'
            : `best ${measurement(detail.frontier.best.candidate_id, detail.frontier.best.metric, detail.frontier.best.value)}`,
      },
    ),
  )

  if (detail.job !== null) {
    root.append(
      el('h3', { text: 'job' }),
      el('p', { class: 'dim', text: `${detail.job.job_id} state=${detail.job.state} attempts=${detail.job.attempts}${detail.job.error_class ? ` error_class=${detail.job.error_class}` : ''}` }),
    )
  }

  if (detail.artifacts.length > 0) {
    root.append(el('h3', { text: 'referenced artifacts' }), el('pre', { text: detail.artifacts.join('\n') }))
  }

  const bindingKinds = Object.keys(detail.bindings).sort()
  if (bindingKinds.length > 0) {
    root.append(
      el('h3', { text: 'identity bindings' }),
      el('pre', { text: bindingKinds.map((kind) => `${kind} ${JSON.stringify(detail.bindings[kind])}`).join('\n') }),
    )
  }
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
  )
}

function renderConclusion(answer) {
  const root = document.getElementById('conclusion')
  root.replaceChildren(el('h2', { text: 'Measured / published' }))

  if (answer?.data === null || answer?.data === undefined) {
    root.append(el('p', { class: 'empty', text: answer?.reason ?? 'no facts recorded yet' }))
    return
  }

  const data = answer.data
  const comparison = data.comparison
  if (comparison?.measured !== null && comparison?.measured !== undefined) {
    root.append(
      el('dl', { class: 'stats' }, [
        stat('we measured', measurement(comparison.measured.candidate_id, comparison.metric, comparison.measured.value)),
        stat(
          'against',
          comparison.group === null
            ? 'no comparable baseline'
            : `${comparison.group.kind} ${number(comparison.group.value)}`,
        ),
        stat('change', change(comparison.change)),
        stat('change %', percent(comparison.changePercent, { sign: true })),
        stat(
          'they published',
          comparison.published === null
            ? 'nothing published'
            : `${comparison.published.method} ${measurement(null, comparison.published.metric, comparison.published.value)}`,
        ),
        stat('difference', change(comparison.publishedChange)),
      ]),
    )
    if (comparison.published === null) {
      root.append(el('p', { class: 'note', text: comparison.publishedAbsent }))
    } else if (comparison.published.source?.file !== undefined) {
      root.append(
        el('p', {
          class: 'dim',
          text: `published numbers: ${comparison.published.source.file}${comparison.published.dataset === null ? '' : ` (${comparison.published.dataset})`}`,
        }),
      )
    }
  } else {
    root.append(el('p', { class: 'empty', text: 'nothing has been measured yet — the conclusion line above says what is missing.' }))
  }

  root.append(el('p', { class: 'dim', text: `rounds ${number(data.rounds)} · frontier ${number(data.frontier.size)}` }))
  const objectives = data.objectives.map((objective) => `${objective.name} (${objective.direction})`)
  root.append(el('p', { class: 'dim', text: `objectives ${objectives.length === 0 ? EM_DASH : objectives.join(', ')}` }))

  if (data.stopped?.stopped) {
    root.append(
      el('h3', { text: 'stop decision' }),
      el('p', { text: `${data.stopped.rule} — ${data.stopped.message}` }),
      el('p', { class: 'dim', text: `limit ${number(data.stopped.limit)}, observed ${number(data.stopped.observed)}` }),
    )
  }
}

/**
 * The audit panel: every judgement the run asked a model for, and — on click — the one that was
 * opened, prompt and response word for word.
 *
 * Clicking a call asks the server for that record (`/api/reprise/call?ref=…`) instead of carrying
 * every prompt in the list: a run with a hundred judgements would otherwise ship a megabyte of
 * prose on every poll.
 */
function renderAudit() {
  const root = document.getElementById('audit')
  const answer = state.audit
  root.replaceChildren(el('h2', { text: 'Model calls' }))

  const data = answer?.data
  if (data === undefined || data === null || data.calls.length === 0) {
    root.append(el('p', { class: 'empty', text: answer?.reason ?? data?.reason ?? 'no judgement has asked a model yet.' }))
    return
  }

  const list = el('ul', { class: 'calls' })
  for (const call of data.calls) {
    const label = `${call.call_site ?? '?'} ${call.subject ?? ''}`.trim()
    list.append(
      el('li', {}, [
        el('button', {
          type: 'button',
          text: call.status === 'answered' ? label : `${label} (${call.status})`,
          'aria-pressed': state.openCall === call.ref ? 'true' : 'false',
          onclick: () => openCall(call.ref),
        }),
        el('span', { class: 'dim', text: ` ${call.ref}` }),
      ]),
    )
  }
  root.append(el('p', { class: 'dim', text: `${data.count} call(s)` }), list)

  const opened = state.openCallRecord
  if (opened === undefined || opened === null) return
  if (opened.reason !== undefined) {
    root.append(el('p', { class: 'note', text: opened.reason }))
    return
  }
  root.append(
    el('h3', { text: opened.ref }),
    el('p', { class: 'dim', text: `${opened.call_site ?? '?'} · ${opened.status}${opened.error_class === null ? '' : ` (${opened.error_class})`}` }),
    opened.message === null ? el('span') : el('p', { class: 'note', text: opened.message }),
    el('h3', { text: 'prompt' }),
    el('pre', { text: opened.prompt }),
    el('h3', { text: 'response' }),
    el('pre', { text: opened.response === '' ? '(an empty response)' : opened.response }),
  )
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

function renderStream() {
  const root = document.getElementById('stream')
  root.replaceChildren(el('h2', { text: 'New facts' }))
  if (state.events.length === 0) {
    root.append(el('p', { class: 'empty', text: 'nothing yet.' }))
    return
  }
  const recent = state.events.slice(-20).reverse()
  root.append(
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['time', 'candidate', 'type', 'summary'].map((label) => el('th', { text: label })))]),
      el(
        'tbody',
        {},
        recent.map((event) =>
          el('tr', {}, [
            el('td', { text: clock(event.wall_clock_ms) }),
            el('td', { text: event.candidate_id }),
            el('td', { text: event.event_type }),
            el('td', { text: event.summary }),
          ]),
        ),
      ),
    ]),
  )
}

// ---------------------------------------------------------------------- wiring

const status = (text) => {
  document.getElementById('status').textContent = text
}

const cursorLine = () => {
  const latest = [...state.cursors.values()].at(-1)
  document.getElementById('cursor').textContent =
    latest === undefined ? '' : `cursor ${cursor(latest)}`
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
    // The conclusion line first: the rest of the page is evidence for it.
    renderHeadline(conclusion)
    renderOverview(overview)
    renderLadder(rounds, conclusion)
    renderConclusion(conclusion)
    renderAudit()

    if (state.selected !== null) renderCandidate(await read('candidate', { candidate: state.selected }))

    renderStream()
    cursorLine()
    // Which workspace this page watches. Two windows open on two workspaces must be distinguishable
    // without reading the URL.
    document.getElementById('workspace').textContent = overview.workspace ?? ''
    state.lastError = null
    status(`read-only · refreshed ${clock(Date.now())}`)
  } catch (error) {
    // A dashboard that dies on one failed poll leaves the last good page on screen and says what broke.
    state.lastError = error
    status(`read-only · ${error instanceof Error ? error.message : String(error)} · last good read kept`)
  }
}

await refresh()
setInterval(refresh, POLL_MS)