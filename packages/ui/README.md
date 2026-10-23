# `@dsh-reprise/ui` — read-only dashboard

A viewer of one workspace. It computes nothing of its own: the four views are the projections in
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
| `GET /api/reprise/overview` | phase, rounds, candidates, spend (settled / in flight / limit), best, frontier, stop decision |
| `GET /api/reprise/rounds` | each round: complete, empty, improving, best, its candidates |
| `GET /api/reprise/candidate?candidate=<id>` | timeline, every gate verdict, the failure text, frontier position, bindings, job, artifacts |
| `GET /api/reprise/conclusion` | the best candidate, its number, what it is compared against, the stop decision |
| `GET /api/reprise/page` | the page itself (plain ESM module next to it; no build step) |
| `GET /api/reprise/dashboard.js` | the page's module |

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

`client/index.html` and `client/dashboard.js` are plain ESM served from this package — nothing to
build. Colour comes from the host's `--dsw-alias-*` theme tokens with CSS system colours
(`Canvas`, `CanvasText`, `ButtonBorder`, `AccentColor`) as the fallback when the token sheet is not
loaded; there is no palette and no hard-coded colour. The four gate states are distinguished by name
and border weight rather than by hue.

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
   other, and the page stays readable with every conversation closed.