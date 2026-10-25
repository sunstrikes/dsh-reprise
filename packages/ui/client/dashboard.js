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
 * build artefact to keep in sync), and the page loads it by a relative URL next to itself.
 *
 * All fact-derived text goes in through `textContent`, never `innerHTML`: candidate ids, verdict
 * messages and artifact paths come from the workspace, and a dashboard is not allowed to become an
 * injection surface for the thing it is watching.
 */

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
const cardsInUse = (cluster) => (cluster === undefined ? '—' : cluster.cards.inUse === null ? 'unknown' : cluster.cards.inUse)

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

const now = () => new Date().toLocaleTimeString()

const formatValue = (value) => (value === undefined || value === null ? '—' : String(value))

/** A change, signed, so "better" reads without knowing which direction the metric runs. */
const signedChange = (value) => (typeof value !== 'number' || !Number.isFinite(value) ? '—' : value > 0 ? `+${value}` : String(value))

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
  return el('div', { class: 'stat' }, [el('dt', { text: label }), el('dd', { text: formatValue(value) })])
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
      stat('phase', data.workspace.phase ?? '—'),
      stat('state', stop),
      stat('rounds', `${data.rounds.completed}/${data.rounds.total}`),
      stat('in flight', data.candidates.inFlight.length),
      stat('rejected', data.candidates.rejected),
      stat('best', data.best === undefined ? '—' : `${data.best.candidate_id} ${data.best.metric}=${data.best.value}`),
      stat('GPU h settled', data.spend.settledGpuHours),
      stat('GPU h in flight', data.spend.inFlightGpuHours),
      stat('GPU h limit', data.spend.limitGpuHours === 0 ? 'unlimited' : data.spend.limitGpuHours),
      stat('tokens', data.spend.tokens),
      stat('cards in use', cardsInUse(data.cluster)),
      stat('cards / job', formatValue(data.cluster?.cards?.perJob)),
      stat('ledger floor', formatValue(data.cluster?.cards?.floor)),
      stat('waiting', formatValue(data.cluster?.queue?.count)),
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
          `${formatValue(data.cluster.cards.floor)} card(s) is what our own ledger supports, not what is running`,
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
      el('p', { class: 'dim', text: `limit ${formatValue(data.stop.limit)}, observed ${formatValue(data.stop.observed)}` }),
    )
  }
}

function renderRounds(answer) {
  const root = document.getElementById('rounds')
  root.replaceChildren(el('h2', { text: 'Rounds' }))

  const rows = answer?.data
  if (!Array.isArray(rows) || rows.length === 0) {
    root.append(el('p', { class: 'empty', text: answer?.reason ?? 'no round has facts yet' }))
    return
  }

  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, ['round', 'improved', 'empty', 'best', 'candidates'].map((label) => el('th', { text: label }))),
    ]),
  ])
  const body = el('tbody')
  for (const entry of rows) {
    const cells = [
      el('td', { text: entry.round }),
      el('td', { text: entry.improving ? 'yes' : 'no' }),
      el('td', { text: entry.empty ? 'yes' : 'no' }),
      el('td', { text: entry.best === undefined ? '—' : `${entry.best.metric}=${entry.best.value}` }),
      el(
        'td',
        {},
        entry.candidates.map((candidate) =>
          el('button', {
            type: 'button',
            text: candidate.candidate_id,
            'aria-pressed': state.selected === candidate.candidate_id ? 'true' : 'false',
            onclick: () => select(candidate.candidate_id),
          }),
        ),
      ),
    ]
    body.append(el('tr', {}, cells))
  }
  table.append(body)
  root.append(table)
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
        el('span', { text: ` at ${formatValue(rejection.phase)}` }),
      ]),
      rejection.message ? el('pre', { text: rejection.message }) : el('p', { class: 'dim', text: '(no message recorded)' }),
      el('p', { class: 'dim', text: `recorded ${new Date(rejection.atMs).toISOString()} (event ${rejection.seq} ${rejection.eventType})` }),
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
            el('span', { text: ` ${formatValue(gate.phase)} (event ${gate.seq})` }),
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
          el('span', { class: 'seq', text: `${event.seq} · ${new Date(event.atMs).toISOString().slice(11, 19)}` }),
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
            ? 'best — (no comparable result yet)'
            : `best ${detail.frontier.best.candidate_id} ${detail.frontier.best.metric}=${detail.frontier.best.value}`,
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

function renderConclusion(answer) {
  const root = document.getElementById('conclusion')
  root.replaceChildren(el('h2', { text: 'Conclusion' }))

  if (answer?.data === null || answer?.data === undefined) {
    root.append(el('p', { class: 'empty', text: answer?.reason ?? 'no facts recorded yet' }))
    return
  }

  const data = answer.data
  if (data.best === undefined) {
    root.append(el('p', { class: 'empty', text: 'nothing has been established yet — no candidate has a comparable result' }))
  } else {
    root.append(
      el('p', {}, [
        el('strong', { text: data.best.candidate_id }),
        el('span', { text: ` ${data.best.metric}=${data.best.value} (round ${data.best.round})` }),
      ]),
      el(
        'p',
        {
          class: 'dim',
          text:
            data.against === undefined
              ? 'no comparison group'
              : `against ${formatValue(data.against.parent)}${
                  data.against.best === undefined ? '' : ` — previous best ${data.against.best.metric}=${data.against.best.value}`
                }`,
        },
      ),
    )
  }

  const comparison = data.comparison
  if (comparison?.measured !== null && comparison?.measured !== undefined) {
    root.append(
      el('h3', { text: 'measured / published' }),
      el('dl', { class: 'stats' }, [
        stat('we measured', `${comparison.measured.value} (${comparison.measured.candidate_id})`),
        stat('against', comparison.group === null ? '—' : `${comparison.group.kind} ${comparison.group.value}`),
        stat('change', signedChange(comparison.change)),
        stat(
          'they published',
          comparison.published === null
            ? '—'
            : `${comparison.published.method} ${comparison.published.metric}=${comparison.published.value}`,
        ),
        stat('difference', signedChange(comparison.publishedChange)),
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
  }

  root.append(el('p', { class: 'dim', text: `rounds ${data.rounds} · frontier ${data.frontier.size}` }))
  const objectives = data.objectives.map((objective) => `${objective.name} (${objective.direction})`)
  root.append(el('p', { class: 'dim', text: `objectives ${objectives.length === 0 ? '—' : objectives.join(', ')}` }))

  if (data.stopped?.stopped) {
    root.append(
      el('h3', { text: 'stop decision' }),
      el('p', { text: `${data.stopped.rule} — ${data.stopped.message}` }),
      el('p', { class: 'dim', text: `limit ${formatValue(data.stopped.limit)}, observed ${formatValue(data.stopped.observed)}` }),
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
      el('thead', {}, [el('tr', {}, ['event', 'candidate', 'type', 'summary'].map((label) => el('th', { text: label })))]),
      el(
        'tbody',
        {},
        recent.map((event) =>
          el('tr', {}, [
            el('td', { text: `${event.wall_clock_ms}` }),
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
  document.getElementById('cursor').textContent = latest === undefined ? '' : `cursor ${latest}`
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
    renderOverview(overview)
    renderRounds(rounds)
    renderConclusion(conclusion)
    renderAudit()

    if (state.selected !== null) renderCandidate(await read('candidate', { candidate: state.selected }))

    renderStream()
    cursorLine()
    // Which workspace this page watches. Two windows open on two workspaces must be distinguishable
    // without reading the URL.
    document.getElementById('workspace').textContent = overview.workspace ?? ''
    state.lastError = null
    status(`read-only · refreshed ${now()}`)
  } catch (error) {
    // A dashboard that dies on one failed poll leaves the last good page on screen and says what broke.
    state.lastError = error
    status(`read-only · ${error instanceof Error ? error.message : String(error)} · last good read kept`)
  }
}

await refresh()
setInterval(refresh, POLL_MS)