# Context — the ten words this code depends on

These are not synonyms for ordinary words. Each one names a distinction the implementation relies on,
and each entry says where the distinction is enforced and what goes wrong when it is blurred. If you
are reading this repository for the first time, read this before the source; if you are changing it,
these are the words a review will use.

---

## 1. Fact (事实)

**An append-only row in `events`, identified by the pair `(candidate_id, local_seq)`.**

`wall_clock_ms` orders facts but does not identify them: two facts in the same millisecond are
different facts. Facts are written **before** the state they justify, in their own transaction, so a
crash leaves a detectable lag (`max(local_seq) > applied_seq`) rather than a silent divergence. A
replay of a fact with the same payload is a `duplicate` and is ignored; the same identity with a
different payload is a `conflict` and is refused — never collapsed into "ignore".

Enforced in `packages/core/lib/store.js` (`appendEvent`), and in the `events` table's primary key.
The reserved subject `_workspace` carries workspace-level conclusions, because the identity pair has
no room for "no candidate".

*Blurred with:* a derived view (see 2), an artifact (a file the fact points at), or a model's claim. A
model opinion only becomes a fact after a validator accepts the artifact it lives in.

## 2. View (视图)

**Anything computed from facts, never a source of truth.**

The ranking and the frontier (see 11), the round history, a candidate's position, the dashboard's four
pages, and everything `dump` prints are views. A materialised view is a cache stamped with the sequence number it
folded (`stamped_seq`), and it must be reproducible: `dump --rebuild` replays the entire event stream
and refuses to agree with a view that no longer follows from the facts. A view may be deleted and
rebuilt at any time; deleting a fact is not an operation this system has.

Enforced in `packages/core/lib/frontier.js` (`deriveRow`, `frontier`, `rebuildFrontier`) and
`packages/core/lib/projection.js` (read-only: `persist: false`, works on a read-only handle).

*Blurred with:* facts. A projection change that alters history without bumping `DERIVED_VERSION` is
the mistake this split exists to make visible.

## 3. Injection packet (注入包)

**The frozen material one judgement call may reason from, assembled once per call site.**

Three parts, with different owners: `guardrails` (forbidden directions, anti-patterns), `singletons`
(the global best, the search space) and the current frontier are given **directly, hard-quota, never
ranked or trimmed**; `recipes` and `candidate_experiences` are handed to the memory source's strategy
to project eagerly or to route on demand. The packet carries facts, never a recommendation and never
the model's own previous prose.

*Status:* built in `packages/memory` — `packet.js` (facts → packet, hard quota verbatim, ranked half
delegated to a strategy), `source.js` (the packet as a read-only mnemon Source), `strategy.js` (the
port that owns ranked admission and budget), `register.js` (`inject: ['mnemonMemory']`). Its manifest
declares `dsh.bundle.patch` (row `reprise-memory`), so a host that installs that bundle mounts the
packet by name; nothing in `packages/core` imports it, which is the boundary working as intended.
Where the kernel already does the same job for
one call site, it stays: `skills.js` renders a prompt from a markdown skill plus JSON facts, and
`judge.js` passes facts as JSON rather than as paraphrase.

*Blurred with:* the fact plane. The fact plane is the source of truth; the packet is a projection of it
for one call. Deleting a packet loses nothing.

## 4. Dashboard projection (看板投影)

**The read-only JSON the dashboard and `dump` both render — computed host-side, in one module.**

Four pages (`overview`, `rounds`, `candidateDetail`, `conclusion`), no clock, no randomness, no model:
the same facts read twice produce equal objects. This is why the GPU-hours warning lives here and not in
a component — a warning computed in a renderer can disagree with the warning in a log line, and then
nobody knows which one the run believed. It also carries `warnings[]`, which is where
`no_gpu_hours_limit` appears for a real executor.

Enforced in `packages/core/lib/projection.js` and `packages/core/lib/warnings.js`.

*Status:* built — `packages/core/lib/projection.js` computes the four pages, `packages/ui` owns the
routes and a plain-ESM client, and `packages/core/lib/dashboard.js` mounts them as a **separate child
plugin** declaring `inject: ['connection']` (so a headless host loses the dashboard and not the loop).
The kernel hands the UI a connection service and a workspace directory; it never learns a route.

*Blurred with:* a view (a projection *is* a view, but a projection is specifically the one the display
layer reads; it must never grow a write path). v1 has no write endpoints.

## 5. Candidate (候选)

**A structural hypothesis plus the batch of changes it needs to land — with an identity the kernel
owns.**

Not a hyperparameter value, not a run, not a model conversation. Identity is assigned by the kernel as
`r<round>-<hypothesis id>` (`r1-h2`), because identity must survive a restart and a model must not be
able to name its own candidate. Nine phases, one step per tick, two terminal states (`DONE`,
`REJECTED`); the hypothesis is frozen before any worktree is touched, so a candidate that finishes can
be explained by what it set out to do.

Enforced in `packages/core/lib/loop.js` (`createCandidate`, `stepFor`) and `rounds.js`
(`candidateIdFor`).

*Blurred with:* a job (a candidate may dispatch several jobs across retries; the job ledger is keyed by
`job_id`), or a worktree (one implementation of one candidate, owned by the runner).

## 6. Identity binding chain (身份绑定链)

**`parent_binding → verify_gate.candidate_tree → fold_state.parent_commit`, insert-only, enforced by
the database.**

Each binding is a row in `candidate_bindings` with `kind ∈ {parent_binding, verify_gate, fold_state}`,
and SQLite triggers `BEFORE UPDATE/DELETE → RAISE(ABORT)`: "who is the parent, what was verified, what
was folded into what" is not something the code can revise, because the code cannot revise it. The
boundary rule is strict: a phase may *ask for* a binding only when its position is **beyond** that
binding (`isBeyond`, strictly greater), while a phase asks whether it has **reached** a boundary with
`isPast` (`>=`). Using one operator for both makes a phase demand the binding it is about to create —
the vertical slice did exactly that and rejected every candidate on its first tick.

Enforced in `packages/core/lib/store.js` (migrations, `freezeBinding`) and
`packages/contract/lib/order.js` (`isPast`, `isBeyond`).

*Blurred with:* a state field. A state field can be rewritten; a binding cannot. That is the point.

## 7. Four states (四态)

**`ok` / `missing` / `conflict` / `invalid`, and `conflict` is never merged into `invalid`.**

`missing` = the artifact or binding is not there. `invalid` = it is there and does not satisfy the
contract. `conflict` = two facts that must agree do not: a harness reports one file list and git shows
another; an adversarial review accepts while a deterministic check failed. `invalid` is a candidate
that produced something unusable; `conflict` is the fact plane disagreeing with itself, and recovery
treats them differently (one candidate is rejected, the other is a finding a human needs). A validator
returns all three lists and one place decides precedence.

Enforced in `packages/contract/lib/artifact.js` (`check`, `isBlocking`) and its fixtures; consumed in
`packages/core/lib/loop.js` (`reject`) and `judge.js`.

*Blurred with:* "failed". A candidate can legitimately fail its gate with no four-state status at all —
"your verify did not pass" and "your verify is malformed" are different events.

## 8. Judgment right vs write right (判断权与写权)

**The model holds judgement. Code holds every write, and every number.**

Five call sites consult a model (LAND's briefing, VERIFY's adversarial review, CAND_ANALYZE,
ROUND_PLAN, ROUND_REFLECT). Each one's exit is an artifact that a validator must accept before a phase
may advance: a model can influence the run only by producing something the contract accepts. Metrics
come from the executor, comparisons from the metric contract, the frontier and the stop decision from
arithmetic in code. There is deliberately **no code path** from a model-supplied number into an
artifact field, the frontier, or a stop rule — stronger than asking the model not to score.

Enforced in `packages/core/lib/judge.js` (the five entrances, `compareMetric`, `pickMetric`) and
`skills.js` (the skill is judgement, the facts are evidence, the answer shape is the wire format).

*Blurred with:* "the model decides". A review that says `accept` over a failed check does not decide
anything — it produces a `conflict` and the candidate stops.

## 9. Wake (唤醒)

**`ctx.interval` on the host: a tick with no session, no turn, and no model call.**

The loop is not driven by a conversation, a cron job, a delivered prompt, or a session-start edge. A
tick advances at most one step per candidate; phases that need no model produce zero model calls, and a
three-day wait is thousands of ticks rather than thousands of inferences. After a restart, the first
thing that happens is **reconcile** — ask the platform what is really running — and only then does a
tick advance anything. Tickets are therefore not "wakeups": a scheduled reminder delivered into a
session is an agent turn, which is the wrong shape for a five-second heartbeat.

Enforced in `packages/core/lib/host.js` (`mountTick`: one interval, one tick in flight, dispose stops
both), `tick.js` (`inject: ['timer']`, reconcile before mounting), and `loop.js` (`reconcile`).

*Blurred with:* a session. "No turn is running" does not mean "no session exists" — the host restores
sessions at boot; the wake mechanism must not care either way.

## 10. Thin state (薄状态)

**Plugin-owned state that can be lost and rebuilt, and nothing else.**

Workspace pointer, UI preferences, subscription cursors, the last tick time, the memory source
registration — that list, and no additions. Stop verdicts, budget balances, bindings and candidate
states live in the workspace's fact plane and must never be mirrored into host storage, because a
copy that can drift is a second account of the run.

Enforced by absence: no module in this repository imports a host storage service. `packages/core`'s
durable state is the workspace directory, and everything it writes there is either a fact (SQLite), an
artifact (a file the fact references), or a human intent (a file the human wrote). Delete the plugin's
host-level state and the run is unaffected; delete the workspace and the run is gone — which is the
correct amount of either.

*Blurred with:* "cache". A cache is derived and disposable (see 2); thin state is not derived — it is
the pointer without which the plugin does not know *which* fact plane it is supposed to serve.

## 11. Frontier vs ranking (非支配集与排行榜)

**The frontier is the Pareto set: the candidates no other candidate dominates. The ranking is every
candidate with its numbers, plus the one `best`.**

They answer different questions and must not share a name. The frontier can be **empty**, can hold
several candidates that trade one objective against another, and always holds the baseline; parent
selection reads it — top_k on each objective axis, then rotate. The ranking answers "what are the
numbers, and who is ahead"; it is what the rounds page and `dump` print, and `best` belongs to it
(chosen on the primary metric, ties broken by round then id).

*Status:* not built. Today's `frontier.js` folds one ranked row per candidate and calls the result
`frontier`; the rename to a ranking and the non-dominated set itself arrive with parent selection.

*Blurred with:* the injected "current frontier" (see 3), which means the non-dominated set and not the
ranking; and with `best`, which is one row of the ranking rather than a verdict about the set.