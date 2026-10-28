# A run registry, not one workspace resolved at mount

The dashboard was built on one assumption that has to go: **the host runs one workspace, resolved once
at mount**. `config.workspace` is read in `config.js`, the seven view routes are registered against
that one string in `packages/ui/lib/routes.js`, and `tick.js` wires one `createWorkspace` to one
`ctx.interval`. That is right for an unattended single experiment and wrong for the way the operator
actually works: several exploration tasks at once, each in its own directory, all of them worth
watching from the same page. Today the only way to switch is to edit `cordis.patch.yml` and recompose
the host — a config edit per task, which is the thing this record deletes.

## Considered options

- **One profile per run.** Each task gets its own `dsh` profile with its own patch. Rejected: a
  profile carries a `node_modules` and a bundle list, and the panel would then exist once per profile
  with no way to see the others. It also makes "which run am I looking at" a question about which
  window you opened.
- **Keep one workspace, add a switcher that rewrites the patch.** Rejected: that is a config write
  behind a button. The mount-time resolution is the reason a reload is needed, so the switch would
  still cost a recompose and a phase of the run would be invisible while it happened.
- **A run registry under one `runs_root`.** Chosen. The plugin reads a directory of runs instead of a
  single path; a run is a subdirectory (or a configured extra path), identified by its basename, and
  each carries its own readable configuration. Everything below is that decision.

## The contracts

### Configuration (additive; the old shape keeps working)

| Key | Default | Meaning |
|---|---|---|
| `workspace` | — | unchanged: the one run this host ticks. It is also one entry of the registry, so an existing deployment sees exactly what it saw before, plus a picker with one option |
| `runs_root` | — | a directory whose subdirectories are runs. When set, the picker lists them |
| `runs` | `[]` | extra absolute run directories outside `runs_root` (a run already living in a checkout, e.g. `examples/…/.workspace/demo`) |
| `max_active_runs` | `2` | how many runs may tick at once. Accepted and validated in T1, enforced in T2 |

A run id is the directory's basename and must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Anything else is
skipped with a reason rather than renamed: renaming somebody's directory to fit a regex is a write
nobody asked for. The registry is the union of `workspace`, `runs`, and `runs_root/*`, deduplicated by
`realpath`, and every `/runs` answer reports which entries were skipped and why.

### Per-run configuration: `<run>/reprise.toml`

A run carries its own configuration file, read at most once per tick and never written by the kernel.
It is **TOML** because a person edits it: comments, no mandatory quotes, no trailing-comma traps. It
carries the keys a run needs that the host cannot know (`domain`, `runner`, `executor`, `candidate`,
`model`, `rounds`, `budget`, `metrics`, `stop`) — the same names the patch uses, because two names for
one setting is how the patch and the file start disagreeing.

The reader is a **strict subset** with named refusals (`packages/core/lib/toml.js`): bare/quoted/dotted
keys, `[table]` headers, arrays (multiline allowed), inline tables, basic and literal strings,
integers, floats, booleans, comments. Datetimes, `[[array tables]]`, multiline `"""` strings and
duplicate keys are refused by name — a config that reads as something else than what was typed is the
one failure this repository will not have. `config_file` keeps accepting JSON unchanged; a path ending
in `.toml` is read with the same reader, so the two surfaces cannot drift.

### Routes

All seven view routes gain an optional `?run=<id>`; absent means the **default run** — `workspace`
when it is configured, else the first entry in registry order. So every existing URL, bookmark and
test keeps meaning what it meant. An id that is not in the registry is `404` with a message naming it
(a `ViewError`), never a silent fall back to the default: a page that quietly shows another run is
worse than one that says it cannot find the one you asked for.

| Route | Method | Answer |
|---|---|---|
| `/api/reprise/runs` | GET | `{ ok, runs_root, default_run, runs: [...], skipped: [...] }` |
| `/api/reprise/{overview,rounds,candidate,tree,conclusion,calls,call}` | GET | unchanged shape, for the run `?run=` names |
| `/api/reprise/runs` | POST | create one run under `runs_root` — see below |
| `/api/reprise/intent` | POST | place one intent file through `intents.js` — see below |

`GET /runs` answers one row per run: `{ id, dir, has_facts, phase, stopped, started_at_ms, best,
config: { path, status, problems }, notice }`. `phase`, `stopped` and `best` come from the run's own
fact plane read-only, and are `null` for a run that has none yet — a created-but-never-ticked run is a
legitimate row, not an error.

`POST /runs` takes `{ id, mode: "clone" | "empty", repo?, domain, repo_dir?, max_rounds?,
candidates_per_round?, candidate_gpu_hours? }` — **flat, and named after the keys the file uses**: the
body is handed to `scaffoldRun` field for field, so there is no second nesting to keep in step with
`reprise.toml` (a `{ rounds: { max_rounds } }` body would make the handler translate between two
shapes of one setting, which is how they start to disagree):

- `id` must match the id rule and must not already exist;
- `mode: "clone"` copies `repo` (an absolute path to a git repository or a URL) into
  `<run>/<repo_dir ?? "repo">`; a local path is preferred and may use `--shared` so the object
  store is not duplicated per run;
- `mode: "empty"` only scaffolds the directory and the configuration file, for a run whose repository
  will be dropped in later;
- the answer is `{ ok: true, run: { id, dir, config } }`, with refusals as `400` and one sentence
  naming what was wrong. Writes stay inside `runs_root`; nothing outside it is created or touched.

`POST /intent` takes `{ run, intent }` and calls `placeIntent(runDir, intent)`. It is the **only**
write path a run's own state gets from the panel, and it is not a new protocol: an intent is the file
under `<run>/pending/` that the kernel already consumes, and the CLI already writes. A button that
pauses a run therefore produces the same bytes as `dsh-reprise intents place pause`, which is what
keeps "who decided this" answerable from the run directory alone.

### The panel

The masthead's workspace stamp stays (it is a fact about the run on screen); beside the title the
panel gains a run picker — a native `<select>` of the registry, plus a `＋` that opens the create form
(id, source repository, domain pack, rounds, GPU budget). The choice lives in `localStorage`
(`reprise.run`) and is applied to every route URL as `?run=`; the registry itself is re-read on mount,
after a create, and on a slower cadence than the five-second poll (a run list is not a live number).

## Consequences

- The single-workspace assumptions that remain are **explicit and temporary**: `tick.js` still ticks
  the default run only, and the overview's cluster listing (`platform`) is built from the default run's
  configuration, so a non-default run's page says "the cluster was not read" instead of showing another
  run's numbers. Both are closed by the second half of this work (T2: one worker per active run, capped
  by `max_active_runs`, with the platform built from that run's own configuration).
- Every read stays read-only: a route opens its own `readOnly` SQLite handle per request, and the two
  POSTs write a directory the operator named and files under `pending/`. No route can change a fact.
- The registry is a directory listing, so a run's identity is its path. Two runs sharing one directory
  are still one run — the existing "one workspace, one run" rule is unchanged, and the registry is how
  many of those a host may see.

## Tests

`packages/core/test/toml.test.js` (the reader's grammar and its refusals), `packages/core/test/runs.test.js`
(union, dedup, id rule, skipped entries), `packages/core/test/runs-config.test.js` (the three new keys and
the unchanged boot line), `packages/core/test/active-runs.test.js` (the activation set, the tick plan, the
round-robin beat), `packages/core/test/multi-run-tick.test.js` (**two real runs with real repositories and
real fact planes advancing on one interval**, and a third registered run that must not move),
`packages/ui/test/runs-routes.test.js` (`?run=` resolution, 404s, both POSTs' refusals and payloads,
activate/deactivate), and the panel's own tests for the picker, the create form and the start/stop
control.

**A created run is not started by creating it.** `POST /runs` writes a directory and a configuration and
answers; the row then appears in the list with `active: false` and the panel's own Start. That is the
same rule as the activation default, read from the other side: money is spent by a decision somebody
made, not by a form they submitted.
## Pinned while building the first half

Decisions taken during T1 that this record did not fix in advance. Each one was a choice between two
defensible behaviours; they live here so the next reader does not re-litigate them from the code.

**Ids.** The id rule is `^(?!\.\.?$)[A-Za-z0-9._-]+$`: a leading dot is legal, because `workspace: .run`
is an ordinary hidden workspace and a rule that made somebody's ticked run vanish from their own picker
would be about our convenience, not about safety. What stays refused is anything that could be a *path*:
empty, `.`, `..`, a slash, a space. Discovery is stricter than declaration in one respect only: a
dot-directory under `runs_root` is not listed at all (`.git`, `.cache` live there), while a declared
`workspace`/`runs[]` entry is listed whatever its name.

**`platform` and `notice` belong to the default run.** Both are the host's statements about *the run it
ticks*, so they are passed only when the request means that run — and naming the default explicitly
(`?run=<default id>`) counts as meaning it. Any other run's page reports the cluster as unread rather
than printing another run's cards.

**The `GET /runs` row** is `{ id, dir, source, has_facts, phase, stopped, started_at_ms, best, config:
{path, status, problems}, runnable: {ok, problem} }`. `stopped` is the projection's boolean (`false`
for a fact plane that never stopped, `null` when there is no fact plane). `runnable` is the same
question boot asks — `resolveConfig` with the run's directory as cwd — and for a missing or refused
`reprise.toml` it is the reader's own words, because a row that says only "not runnable" sends the
reader hunting for a fault nobody named. `resolveConfig` loads the domain pack, so a list read does one
pack load per run; that is cheap at a 30-second cadence and is the thing to cache when the ticking half
multiplies runs.

**`POST /runs` answers 200**, not 201: the body names the created resource, and nothing in this codebase
tells a client to branch on 201. A body that is not a JSON object, or cannot be read, is a 400 with a
different sentence than "not JSON", so a broken client learns which mistake it made.

**`repo_dir` is refused before anything is created** when it is absolute or climbs out of the run: the
ADR's "nothing outside `runs_root` is touched" is checked at the edge (`packages/ui/lib/runs.js`), not
left to the join inside `scaffoldRun`.

**`withStore` moved** from `packages/ui/lib/routes.js` to `packages/ui/lib/runs.js` (the registry routes
read many runs, so the one read-only opener belongs beside them) and is re-exported from `routes.js`, so
no caller's import changed.

**The panel.** The picker sits inside `.masthead-run`, after the title; the create form is a full-width
row inside the same `<header>`, so it cannot push the numbers around. `?run=` is built with
`URLSearchParams` (it must compose with `?candidate=`, `?ref=` and `?after=`), the choice is remembered
in `localStorage` under `reprise.run`, and the registry is re-read on mount, after a create and every
30 s — separate from the 5 s view poll, and a failed registry read keeps the last list, the selection and
the page. A selected run that has left the registry stays selected and says so rather than silently
swapping to the default. The form validates natively (id pattern, required fields) and prints the
Host's own sentence verbatim; `repo` is disabled in `empty` mode rather than hidden, so nothing typed
disappears.

## The second half: several runs actually advancing (T2)

The first half made runs visible; this half makes the host drive more than one. Three decisions, and
the first is the one that spends money.

**Which runs are driven is an operator's decision, recorded once beside the runs.** A registry can list
twenty runs; a machine may only be allowed to advance two, and a run's own fact plane has no place for
"nobody has started me yet" — that is not something that happened to it. So the active set lives in
`<runs_root>/.reprise-host.json` (`{v: 1, active: [...]}`, `core/lib/active-runs.js`). Three rules:

- **An absent file means "only the run the configuration ticks".** A directory appearing next to a run
  never starts spending on its own — the shipped default of every deployment that predates the registry.
- **A malformed file is reported, never defaulted.** Reading a corrupt set as "everything is active"
  starts jobs nobody asked for; reading it as "nothing is active" stops a night shift. The reader
  answers `problems` and the host logs them and falls back to the run it ticks.
- **Writing replaces the whole set through a temporary file**, so a crash mid-write leaves the previous
  decision intact. Activating twice is not an error (a button is a button), and an id that has left the
  registry is dropped from the answer but kept in the file, because a mount going missing must not
  silently forget a decision.

**Start and stop ride the intent path, with two destinations.** `POST /api/reprise/intent` still takes
`{run, intent}`. For `pause`/`resume`/`grant`/… it writes `<run>/pending/<id>.json` and answers
`scope: 'run'` — unchanged. For `activate`/`deactivate` it writes the host-level set and answers
`scope: 'host'` with the resulting `active` array. One path, one body, two destinations, and the answer
says which happened: a new endpoint per verb would have made "how does a human influence this run?"
three questions instead of one. A run-scoped `pause` still means what it always did — *watched but not
dispatching* — which is why stopping a run is not expressed as pausing it.

**The set is re-read every beat, so a switch is not a promise.** `mountTick` takes a *provider* when the
host has a registry: before each beat the provider re-reads the activation record and answers which runs
to advance, so a run started from the dashboard joins on the next beat and a run stopped leaves it —
neither needs a host restart. A run that leaves keeps its workspace open and every fact it had (closing a
store under a tick still in flight is how a decision to stop becomes a crash); a run whose configuration
cannot be resolved is logged once, not once per beat.

**One interval, a round-robin beat, a per-run in-flight guard.** `mountTick` now takes a list
(`host.js`): each beat advances up to `max_active_runs` runs that are not already ticking, starting at a
cursor so a run waiting on a long job poll cannot starve the others. The cap is per **beat**, not a cap
on how many runs may exist as workers: with five active runs and `max_active_runs: 2`, every run still
advances, two at a time, interleaved. The in-flight guard is per run — the thing that must never
overlap is one run's own tick (a doubled tick would submit the same job twice), and one run awaiting its
poll is exactly why the others get their turn. `tick.js` builds the worker list: with no `runs_root`,
one workspace from the resolved configuration (bit-for-bit the old behaviour, which is why
`host-tick.test.js` did not change); with a registry, one workspace per active run, each from its own
`reprise.toml` resolved **with the run directory as the cwd**.

**A run that is active but unusable is skipped by name, and every other run keeps ticking.** One log
line — `not ticking run <id>: <reason>`, the reason being `resolveConfig`'s own sentence — and the
list's row carries the same sentence in `runnable.problem`. `active` and `ticking` are two columns for
that reason: a switch that is on over a run that cannot move is a lie in one column, and the panel shows
both. `ticking` is `active && runnable.ok`.

**Known limits after T2.** The overview's cluster listing is still built from the configured run's
executor, so a non-default run's page reports the cluster as unread (the honest answer) rather than its
own cards; `status-tool` (`reprise_status`) still answers about the configured run; and `GET /runs`
still resolves each row's configuration on every read (one domain-pack load per run per 30 s), which is
the thing to cache when a deployment runs dozens of runs rather than a handful.
