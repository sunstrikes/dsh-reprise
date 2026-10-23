---
description: "A model-structure exploration loop as a DeepSeek Harness bundle: deterministic phases, a frozen baseline, a spend ledger, and a stop decision that only reads recorded facts."
kind: "package-bundle"
---

<p align="center">
  <img src="packages/core/icon.svg" alt="dsh-reprise" width="96" height="96">
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/sunstrikes/dsh-reprise/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sunstrikes/dsh-reprise/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-263146?style=flat-square"></a>
  <img alt="status: public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/sunstrikes/dsh-reprise/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/sunstrikes/dsh-reprise?style=flat-square&color=4b6fff"></a>
  <img alt="node &gt;= 22" src="https://img.shields.io/badge/node-%E2%89%A522-4b6fff?style=flat-square">
  <img alt="DeepSeek Harness bundle" src="https://img.shields.io/badge/DeepSeek%20Harness-bundle-4b6fff?style=flat-square">
</p>

<div align="center">

# dsh-reprise

**An exploration loop whose conclusions you can check.**
</div>

> A DeepSeek Harness bundle: reproduce a published number, then iterate on the reproduction under
> control — deterministic phases, a baseline frozen at INIT, a spend ledger that reserves before it
> spends, and a stop decision computed from recorded facts rather than remembered intent.

<a id="summary"></a>
## Summary

`dsh-reprise` reproduces a published experiment and then iterates on that reproduction under control:
deterministic phases, a baseline frozen at INIT, a budget that reserves before it spends, and a stop
decision computed from recorded facts instead of remembered intent.

A candidate is **a structural hypothesis plus the batch of code changes it needs to land** — not a
hyperparameter value. The loop is ordinary code; the model is consulted in exactly five places, and
what it says enters the fact plane only as an artifact a validator has accepted.

Mounting the bundle adds three surfaces and nothing else: a tick that advances the phase machine in a
workspace nobody has open, a `reprise_status` tool that reads the same projection from inside a
conversation, and a **Reprise** panel in the sidebar (backed by six read-only GET routes). It does
not touch your repository, does not open a port, and does not call a model unless you name one in
`model.command`.

Do not reach for it if what you want is prompt search, a hyperparameter sweep, or a dashboard you can
drive: v1 has no write endpoint at all, the browser half is read-only by construction, and the loop
optimises one declared metric per round rather than a population of prompts.

<a id="contents"></a>
## Table of Contents

- [When to use it](#when-to-use-it)
- [Install and mount](#install-and-mount)
- [Configure it](#configure-it)
- [What it adds](#what-it-adds)
- [The five-minute path](#the-five-minute-path)
- [Checks and local development](#checks-and-local-development)
- [Design](#design)
- [Source map](#source-map)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="when-to-use-it"></a>
## Use this package

### When to use it

You have a metric that can be measured twice, a baseline you are willing to freeze, and a belief that
the *structure* of a model — not its learning rate — is what is wrong with it. You want the answer to
"why did this candidate stop?" to come from a file rather than from whoever was watching the terminal.

`dsh-reprise` fits when the run must survive being unattended: a crash mid-phase is a detectable lag
in the fact plane, a paused budget is a recorded decision, and every number on the page is derivable
from facts alone (`dump --rebuild` proves it). It is a poor fit when the metric is a human judgement,
when the baseline cannot be made reproducible, or when you need several concurrent runs against one
workspace — one workspace belongs to one run.

### Install and mount

The repository is a pnpm workspace and the packages depend on each other through `workspace:*`, so
`packages/core` is not installable on its own. Clone the whole repository.

```sh
git clone https://github.com/sunstrikes/dsh-reprise.git
cd dsh-reprise
node scripts/link-workspace.mjs          # Node 22.5+; makes packages/* importable, idempotent
```

Then install the bundle into your Harness profile. Use the host's own tooling rather than hand-editing
the profile — `install_bundle` performs the dependency install, the link and the bundle selection in
one step, with `target` set to the **absolute path** of `<clone>/packages/core`:

```
plugin_manager { action: "install_bundle", target: "/absolute/path/to/dsh-reprise/packages/core" }
```

Then supply your own configuration. **The shipped patch has no `config` block at all**: a run cannot
start without a `workspace` and a `domain` pack, and every path a real config needs belongs to the
machine that owns the run. Add an entry that targets `reprise-core` by id and restate the whole config — a matching override
*replaces* `config` wholesale rather than deep-merging it. Put it in your profile's
`cordis.patch.yml` (or `$DSH_HOME/cordis.patch.yml`, which outranks the profile layer);
[`packages/core/cordis.example.yml`](packages/core/cordis.example.yml) is the filled-in version of the
shape below, including the two path rules that cost a debugging round each.

```yaml
- id: reprise-core
  name: dsh-reprise
  config:
    workspace: /absolute/path/to/my-run      # required; created facts live here
    domain: /absolute/path/to/my-domain-pack # required; the metric contract, priors, surface, prompts, executor
    interval_ms: 5000
    candidate:
      kind: command
      command: ['node', '/absolute/path/to/apply-change.mjs', '{candidate}']
    runner: { repo: model-repo, dir: worktrees }
    model: { command: ['node', '/absolute/path/to/my-model-port.mjs'] }
    rounds: { metric: { name: auc, direction: higher }, max_rounds: 3 }
    metrics: { primary: auc, objectives: { auc: up } }
    budget: { candidate_gpu_hours: 0.5, gpu_hours_limit: 0 }
```

Restart the host (bundle lists are read at startup; with HMR a patch edit alone applies live). You are
mounted when the log carries the boot half's `applied` line, then the tick half's `tick-applied`, the
sidebar shows **Reprise**, and `reprise_status` is available to the model.

Three absences degrade instead of failing, by design: no `timer` service means the ticking half is
*deferred*, not failed (cordis reports the two identically, which is why the package ships two entry
points); no `connection` service means no dashboard; a workspace that cannot be opened or a config that
cannot work is one log line and a host that keeps booting. **None of these three appear as an error.**

The `@dsh-reprise/memory` bundle is optional and separate (row `reprise-memory`); it adds the injection
packet as a `dsh-mnemon` Source. Nothing in `packages/core` imports it.

### Configure it

Everything domain-specific is data, and it lives in a **domain pack** — a directory whose
`domain.json` names its metric contract, its priors, its adjustable-surface whitelist, its five
prompts and its executor entry ([`examples/feed-structure`](examples/feed-structure) is a complete
one). The kernel does not know a metric name, a model repository or a prompt; it reads them from the
pack, and a pack missing a part is refused by name at boot instead of running half-configured.

| Field | Default | Meaning |
|---|---|---|
| `workspace` | **required** | directory the run owns; the fact plane is `workspace.db` inside it |
| `domain` | **required** | directory of the domain pack; no pack, no metric contract, no prompts |
| `interval_ms` | `5000` | tick cadence |
| `executor.kind` | the pack's | `local` (a subprocess) or `ray` (Job Submission REST) |
| `executor.command` | the pack's, **required for `local`** | argv of one job, resolved inside the candidate worktree |
| `executor.base_url` | **required for `ray`** | Ray dashboard URL |
| `executor.root_dir` / `metrics_required` | `'jobs'` / `true` | where job dirs live; a job without metrics is a failure |
| `candidate.kind` | `'command'` | `command`, `claude` or `dsh` — the LAND implementer |
| `candidate.command` | **required for `command`** | argv; `{candidate}` and `{worktree}` are substituted |
| `runner.repo` / `runner.dir` | **required with `candidate`** | repo inside the workspace; where worktrees are created |
| `runner.base_ref` | git default | the commit candidates branch from |
| `model.command` | **required if `rounds` is set** | every judgement phase reaches a model through this argv |
| `rounds.metric.name` / `.direction` | the pack's contract | the one metric the round gate optimises; restating it is how a run points at a different objective |
| `rounds.metric.contract_ref` | the contract's `name` | pointer to the frozen metric contract |
| `rounds.max_rounds` / `.candidates_per_round` | `3` / `2` | round workflow shape |
| `rounds.retry.base_ms` / `.max_ms` / `.max_attempts` | `60000` / `3600000` / `3` | backoff for a refused artifact, then a human |
| `stop.max_rounds` | `3` | `0` disables the rule |
| `stop.max_no_improvement_rounds` / `.consecutive_empty_rounds` | `0` (off) | opt-in stop rules |
| `budget.gpu_hours_limit` | `0` (unlimited) | hard cap; an uncapped remote executor is warned about, every read |
| `budget.soft_ratio` / `.candidate_gpu_hours` | `0.8` / `0.5` | stop dispatching at this fraction; what a dispatch reserves |
| `budget.max_runtime_hours` / `.judge_tokens` | `0` (unlimited) / `false` | wall-clock gate; tokens are recorded, never judged |
| `metrics.primary` / `.objectives` | the pack's contract | recorded at INIT; cross-checked against the round contract |
| `poll.base_ms` / `.max_ms` / `.grace_attempts` | `1000` / `60000` / `2` | job poll backoff |
| `limits.max_wall_ms` / `.max_idle_ms` | `3600000` / `1800000` | per-job wall-clock and silence deadlines |

Validation is `packages/core/lib/config.js` and it runs once at boot. The package exports no `Config`
object, so the host holds no schema for the row: a bad config is a log line, never a boot failure. Two
refusals are worth knowing before you hit them — `rounds` without `model.command`, and `candidate`
without `runner` — because the alternative is a run that stalls at the first round instead of at boot.
`metrics`, `stop`, `budget` and `executor` are copied into the workspace at INIT and read from there
afterwards, so editing the patch mid-run changes nothing the dashboard reports.

<a id="what-it-adds"></a>
### What it adds

| Surface | Identifier | What it does |
|---|---|---|
| Model tool | `reprise_status` | the run's progress as JSON, read-only, from the same projection the page draws |
| Sidebar panel | `sidebar.panellist` id `reprise`, order `25`, plus `main` key `reprise` | the **Reprise** button (zh: 复现) and the page it opens; labels follow the active language (`en`, `zh`) |
| HTTP routes | `GET /api/reprise/{overview,rounds,candidate,conclusion}` | the four views, each read through its own read-only handle |
| Static assets | `GET /api/reprise/page`, `/api/reprise/dashboard.js` | a standalone page for a host with no client slots |
| CLI | `node packages/core/lib/cli/run.js --workspace <dir> --config <file>` | the same wiring the host ticks, driven by a loop; exit 0 conclusion, 1 no comparable metric, 2 usage, 3 timeout |
| CLI | `node packages/core/lib/cli/dump.js --candidate <id>` | timeline, every gate verdict, identity bindings, frontier position, and why the run stopped |
| CLI | `node packages/core/lib/cli/intents.js place <kind>` / `list` | human intents (`proposal`, `grant`, `anchor`, `pause`, `resume`, `approval`, `experience`) written into `<workspace>/pending/` |
| Skills | `<domain>/prompts/{land,verify,cand-analyze,round-plan,round-reflect}/SKILL.md` | what the model is told at each of the five call sites; markdown on disk, part of the domain pack, read fresh on every call — **not** DSH skills and not registered as such |

The bundle provides no service and emits no event: it consumes `timer`, `connection` and `tools`.
Every route is `GET`; there is no write endpoint to reach for, including one that would let the page
change the run it is reporting on.

<a id="five-minute-path"></a>
## The five-minute path

A laptop, a clone, and nothing else: no GPU, no cluster, no model provider. The whole path is exercised
by `packages/core/test/five-minute-path.test.js` in a temporary directory — it runs the commands this
section prints, so these five lines are a contract, not an illustration.

### Step 1 — make the workspace packages importable

```
node scripts/link-workspace.mjs
```

It checks the Node version, links `packages/*` so the repository root can import them, and finishes by
actually importing the kernel: a clone that cannot import the kernel cannot do anything else either.
No network, no package manager, idempotent.

### Step 2 — build a workspace

```
node examples/feed-structure/init.mjs .workspace/feed
```

A real setup, not a fixture: it copies the toy model repository, commits it (candidates branch from that
commit), freezes a sha256 manifest of what the run starts from, and measures the baseline by running
`metric.mjs` through the actual local executor.

### Step 3 — look at the domain pack you own

```
node examples/feed-structure/inspect.mjs
```

The pack manifest, the metric contract (direction and role), the adjustable-surface whitelist, the
priors and hypothesis classes, this round's structural hypotheses, the executor entry and the wiring.
Changing any of them is a configuration change; the kernel knows nothing about AUC, clicks, or your
model.

### Step 4 — run the loop

```
node packages/core/lib/cli/run.js --workspace .workspace/feed --config examples/feed-structure/config.json
```

One line per phase step, then the winner, its metric, the baseline it beat, and the rule that ended the
run. This is the same wiring the host plugin uses — `workspace.js` and `tick()` — driven by a loop
instead of by the host's timer, so what you just watched is the plugin's behaviour.

### Step 5 — ask why

```
node packages/core/lib/cli/dump.js --candidate r1-h2 --workspace .workspace/feed
```

Timeline, every gate conclusion, the identity bindings, the frontier position, and why the run stopped —
from the fact plane alone. `r1-h2` is the winner the shipped example produces; use whatever step 4
printed. No `--config` is needed: the run records the metric contract and the stop rules into the
workspace at INIT, so a reader with only the directory gets the same answer. Add `--rebuild` to replay
the whole event stream and check the materialised view still follows from the facts.

What the example does not exercise: a live model (`recorded/judgement.json` replays four answers) and a
real coding harness (`apply-change.mjs` applies the hypothesis mechanically). Both are configuration —
`model.command` and `candidate.command`. [`examples/feed-structure/README.md`](examples/feed-structure/README.md)
says what to change and what stays unverified.

<a id="checks-and-local-development"></a>
## Checks and local development

```sh
npm test         # scripts/check.mjs, then the full suite
npm run check    # manifests, export targets, and a parse of every module under lib/
```

`scripts/check.mjs` covers what the suite cannot see: export targets that do not exist, exports
pointing at TypeScript the host cannot import, declared dependencies nothing imports, imports nothing
declares, and modules no test happens to load.

The packages resolve cordis from the host profile rather than installing a second copy, so link the
profile's module tree instead of running `pnpm install`:

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
```

Five tests in `packages/core/test/host-plugin.test.js` drive cordis's real lifecycle. cordis is the
plugin host (MIT, shipped with the Harness profile), not a dependency of this repository, so on a
machine without it those five report themselves **skipped** instead of failing to load. Wire the
pre-commit hook once per clone: `git config core.hooksPath .githooks`.

Nothing here may be imported as TypeScript by the host: every bundle exposes `main: lib/*.js`, and the
shipped code is plain ESM with no build step.

-----

<a id="design"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Two entry points, because a missing dependency defers a plugin rather than failing it.**
  `boot.js` declares nothing and reports; `tick.js` declares `inject: ['timer']` and ticks;
  `dashboard.js` declares `inject: ['connection']`. A merged plugin would make "the package never
  loaded" and "the timer never appeared" produce the same empty log.
- **Facts before state, always.** A fact is an append-only row identified by `(candidate_id,
  local_seq)`, written in its own transaction *before* the state it justifies, so a crash leaves a
  detectable lag instead of a silent divergence. Replaying a fact with the same payload is a
  `duplicate`; the same identity with a different payload is a `conflict` and is refused.
- **Views are derivable or they are wrong.** The frontier, the round history and the dashboard's four
  pages are all computed from facts. `dump --rebuild` refuses to agree with a view that no longer
  follows from them.
- **The model gets five call sites and no other.** `land`, `verify`, `cand_analyze`, `round_plan`,
  `round_reflect`. Each call is a separate process with a prompt rendered from a markdown skill plus
  facts as JSON; the answer shape lives in code next to its parser, so a markdown example cannot drift
  away from what the judge accepts.
- **Read-only is structural, not a promise.** Every read opens its own `readOnly` SQLite handle and
  closes it: the tool physically cannot record a fact, two browser windows cannot interfere, and the
  page works with every session closed — it needs the workspace directory and nothing else.
- **Reserve, then settle.** A dispatch reserves `budget.candidate_gpu_hours` before the job starts and
  settles the measured cost after, so a crash mid-job is charged rather than forgotten. Tokens are
  recorded and never judged, because harnesses report them too unevenly to use as a gate.
- **Say the dangerous default out loud.** An uncapped remote executor is legal, is the shipped default,
  and is warned about on every read — boot log, `run`'s banner, and `overview().warnings`, which both
  clients draw.

### Source map

| Path | Role |
|---|---|
| `packages/contract` | four-state validation, the identity binding chain, artifact schemas, metric contract |
| `packages/core` | phase machine, tick, fact store, derived views, stop policy, plugin wiring, CLI |
| `packages/exec` | candidate-implementer and external-job adapters (local, ray, claude, dsh) with conformance suites |
| `packages/memory` | the injection packet, exposed as a `dsh-mnemon` Source |
| `packages/ui` | read-only dashboard: host-side projections over routes, plus a plain-ESM client |
| `packages/exec-python` | optional proxy-metric bridge (needs torch) — manifest only, no code yet |
| `examples/feed-structure` | a complete domain pack and a worked scenario: `domain.json` plus the metric contract, priors, adjustable surface, five prompts, executor entry, structural hypotheses and a local metric |

Dependency direction is acyclic by package name: `contract` depends on nothing here; `exec` and
`memory` depend on `contract`; `core` depends on all three. One deliberate exception: `ui` reads
`core`'s store and projection modules by relative path, because the dashboard must not be able to open
a *write* handle to the fact plane, and a relative import of the read-only readers says exactly that.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [`CONTEXT.md`](CONTEXT.md) — the ten words the code depends on, with the precise meaning it assumes
- [`docs/extending.md`](docs/extending.md) — add an executor; add an artifact kind
- [`docs/license-audit.md`](docs/license-audit.md) — every dependency and borrowed idea, against Apache-2.0
- [`docs/adr/0001-acceptance-is-a-reproduced-public-experiment.md`](docs/adr/0001-acceptance-is-a-reproduced-public-experiment.md) — what "done" means for this project
- [`examples/feed-structure/README.md`](examples/feed-structure/README.md) — the worked scenario in detail
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) — how to review a diff here

<a id="model-experience"></a>
## Model Experience

#### What the model sees

Two ways, both read-only and neither on a critical path.

`reprise_status` is the only tool the bundle registers. Its input is `candidate` (an optional id, for
that candidate's page instead of the overview) and `events` (0–20, default 6). It answers with the
envelope the HTTP routes serve — `view`, `workspace`, `cursor`, `data`, an `incremental.events` list —
trimmed to six facts and ten frontier members; when a workspace has no facts yet it says so with
`data: null` and a reason instead of failing. Refusals carry `ok: false` and a `reason`. The whole fact
stream is never a tool result.

Inside the loop, the model is a subprocess: at each of the five call sites it reads one `SKILL.md` from
the domain pack plus JSON facts (candidate identity, L1 check results, the metrics the monitor reported), and
answers in a wire format the judge parses. It is never handed the fact plane, a session, or another
candidate's outcome.

#### Token effect

Small and bounded. A status answer is a single projection page trimmed to six events and ten frontier
members; the tool is called when someone asks how the run is doing, not on every turn. The five
judgement calls carry one markdown prompt each (the pack's `prompts/` are 246 lines in total) plus JSON,
and each is a fresh process, so nothing accumulates across a run.

#### KV Cache effect

None inside the conversation: the tool call sits in the normal tool-call sequence and adds no system
prefix. None across judgement calls either — they are separate processes started per call site, so
there is no shared prefix to cache and no cache to invalidate. Nothing in the plugin mutates the system
prompt.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits define when this is a poor fit — they are not a task list.

- **Verified offline only.** The phase machine, validators, identity chain, fact plane, ledger,
  frontier, stop rules, executor and harness ports, `dump`, and the five-command path all run in
  `npm test`. Not verified end to end here: a live model, a real coding harness, a real cluster, and a
  browser actually loading the page against a real host.
- **Not on npm.** Every package is `private`, versioned `0.0.0`, and depends on its siblings through
  `workspace:*`. Share the repository and link the profile; there is no publishable artifact yet.
- **The shipped bundle patch carries no config, on purpose.** The package cannot know where your
  workspace is, so it ships the row and nothing else; a `reprise-core` entry in your profile patch
  supplies everything, and `cordis.example.yml` beside the patch is a filled-in worked example. A
  run with no config is one log line, not a mount.
- **No host-side config schema.** The package exports no `Config`, so the Plugin Manager cannot render
  or validate the row; `config.js` is the only validator, and its verdict is a log line.
- **No write surface.** Pause, resume, grant and approvals arrive as files under `<workspace>/pending/`
  (`intents.js`), not as HTTP calls.
- **One workspace, one run.** Two runs in one directory are not a supported configuration; two
  workspaces are two independent dashboards.
- **`packages/exec-python` is a manifest.** No code, no `torch` import; the proxy-metric bridge is
  deferred.

### Dev Note

<details>
<summary>Non-authoritative maintainer context — click to expand</summary>

The repository is a pnpm workspace of six packages, tested on Node 24 (Node 22 works and warns, because
`node:sqlite` is experimental there). `npm test` is the whole gate; the pre-commit hook runs exactly it
with git's environment stripped, because the tests create their own temporary repositories and an
inherited `GIT_DIR` points them at this one.

Distinctive machinery worth not re-deriving during a review: phase-level artifact contracts, the
four-state verdict vocabulary (`ok` / `conflict` / `missing` / `invalid`), the identity binding chain,
and frontier and stop rules that are code rather than policy configuration. The code is the chain of
authority for a decision, and it is the record of what was accepted and what was refused.

Comments still cite things like `spec: 相位机` or `issue 06`. That is the shorthand this codebase was
built with, naming a design record kept outside the repository as the author's working notes. Every
claim in such a comment stands on its own — read the sentence, not the citation.

</details>

<a id="license"></a>
## License

Apache-2.0 — see [LICENSE](LICENSE).