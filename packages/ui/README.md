# `@dsh-reprise/ui` — read-only dashboard

A viewer of one workspace. It computes nothing of its own: the views are the projections in
`packages/core/lib/projection.js`, which `dump` renders too, so the page and the CLI cannot tell
different stories.

Two rules hold the package together:

- **No server.** The routes are registered on the host's existing connection service
  (`connection.fetch.register`) and leave with the plugin's fiber. No port, no launcher, no liveness
  probe, no separate process.
- **No write endpoint.** Every route is `GET`. Each request opens its own `readOnly` SQLite handle and
  closes it, so a view cannot change a fact, two windows cannot interfere, and the page works with
  every session closed — it needs the workspace directory and nothing else.

## Routes

| path | answer |
| --- | --- |
| `GET /api/reprise/overview` | phase, rounds, candidates, spend (settled / in flight / limit), best, frontier, stop decision, and the cluster block: cards per job, cards in use, our ledger's floor, what is queued |
| `GET /api/reprise/rounds` | each round: complete, empty, improving, best, its candidates |
| `GET /api/reprise/candidate?candidate=<id>` | timeline, every gate verdict, **the gate chain step by step (passed / failed / missing)**, the failure text, frontier position, bindings, job, artifacts |
| `GET /api/reprise/conclusion` | the best candidate, its number, what it is compared against, **the measured/published comparison**, the stop decision |
| `GET /api/reprise/calls?site=<call-site>` | every judgement a model was asked for: call site, subject, status, error class |
| `GET /api/reprise/call?ref=<model_call:site:subject[:ref]>` | one judgement, opened: the prompt it read, the facts, the raw response, the answer object |
| `GET /api/reprise/page` | the page itself (plain ESM module next to it; no build step) |
| `GET /api/reprise/dashboard.js` | the page's module |
| `GET /api/reprise/format.js` | the one formatting source both clients import: clock times, numbers, percentages, cursors |
| `GET /api/reprise/states.js` | the one candidate-state vocabulary both clients name a state with: shapes, round verdicts, phase marks |
| `GET /api/reprise/dashboard.css` | the one stylesheet both clients paint from: the `--reprise-*` token block and every component |

Two answers on the overview are deliberately `null` rather than `0`: `cards.inUse`, and the orphan /
foreign job lists. The page is session-free and has no platform port, so it has not read the
cluster's listing — `cluster.read: false` says so, `cluster.cards.floor` says how many cards our own
ledger supports, and the dump prints the same two facts. A dashboard that cannot ask must not answer
"0 cards", because that is the answer somebody acts on.

The gate chain's `missing` is a third answer beside passed and failed: a candidate that stopped before
VERIFY was never judged, and rendering that as "failed" would blame it for a check nobody performed.
The evidence is the attempt records the judge wrote (`verify_verdict:<id>:a<N>`) plus the
`gate_result` and rejection events; `dump --candidate` prints the same chain.

A bad query is a `400` with `{ "error": { "message": … } }`. An unknown candidate is a `200` with
`data: null` and `missing: true` — the same "nothing was recorded" answer `dump` gives.

## Increments

Every answer is one envelope:

```json
{
  "view": "overview",
  "cursor": "1761091200000:r2-c1:7",
  "after": "1761091130000:r1-c4:12",
  "more": true,
  "incremental": { "events": [ { "cursor": "…", "candidate_id": "r2-c1", "local_seq": 7, "event_type": "…", "summary": "…", "payload": {} } ] },
  "data": { }
}
```

`?after=<cursor>` returns only the facts recorded after that cursor; repeating a request is
idempotent (same facts, same bytes). The cursor is the store's own ordering key,
`<wall_clock_ms>:<candidate_id>:<local_seq>`, and not the bare `local_seq` — identity is the pair
`(candidate_id, local_seq)`, so a candidate created later restarts at `1` and a bare integer cursor
would silently skip its first facts.

`data` is always derived from **all** facts; only `incremental.events` is filtered. A stale or wrong
cursor therefore costs bandwidth, never correctness. The protocol can be upgraded to a stream by
pushing these same items, cursor and all.

**Cost, measured rather than assumed.** The increment saves transfer, not derivation: every answer
re-derives its page from the facts (the frontier itself is materialised, so that part is cheap) and
enumerates the event streams to name the head cursor. On a workspace with 10 000 events one answer
takes ≈ 26 ms, with or without a cursor — fine for a 5 s poll, and the reason there is no cached
cursor on the server (a cache would be state two windows could trip over). The reading order comes
from the store's own readers (`eventSubjects` + `eventsFor`) on purpose: a second hand-written SQL
order would be a second definition of "the facts, in order".

## Client

`client/index.html`, `client/dashboard.js`, `client/format.js`, `client/states.js` and
`client/dashboard.css` are served from this package — nothing to build. `format.js` imports nothing
and is imported by both clients (the page as `./format.js`, the Web UI panel by the route URL), and
`states.js` is served the same way, so one formatter and one vocabulary answer for both surfaces.
`dashboard.css` is the single stylesheet: the page links it, the panel injects the identical text, and
every rule is scoped under `.reprise` (the `:root` block declares `--reprise-*` properties only) so
injecting it cannot repaint the host document. Colour comes from the host's `--dsw-alias-*` theme
tokens with CSS system colours (`Canvas`, `CanvasText`, `ButtonBorder`, `AccentColor`) as the
fallback when the token sheet is not loaded; there is no palette and no hard-coded colour — the scan
in `test/client.test.js` walks every file under `packages/ui/client` *and* `packages/core/client`, so
the panel is covered by the same rule. The four gate states are distinguished by name and border
weight rather than by hue.

## What has not been verified

Everything here is tested against a `connection` double shaped exactly like the host's registry
(`test/support/fake-connection.js`). A real host has not run these routes, so a smoke test against
`dsh web` still has to check:

1. the plugin's `apply` declares `inject: ['connection']` and mounts on host boot (not on session
   creation), and unloading the plugin removes all six paths from the registry;
2. the browser cookie admits `GET /api/reprise/page` on a clean navigation, and the page's relative
   `./dashboard.js` resolves under the same `/api/reprise/` prefix;
3. `--dsw-alias-*` tokens are reachable from that page, or the fallback palette is what the user sees;
4. two browser windows on the same workspace poll with different cursors without disturbing each
   other, and the page stays readable with every conversation closed;
5. clicking a row in the audit panel fetches `GET /api/reprise/call?ref=…` and draws the prompt and
   response (the source-level assertions in `test/client.test.js` cover that the page consumes the
   fields; only a browser can show it painting).