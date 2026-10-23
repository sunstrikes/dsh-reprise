# examples/feed-structure — a Sunday-afternoon structural exploration

A complete, copyable scenario: **a click-prediction ranker whose structure is wrong in one specific
way, two structural hypotheses about how to fix it, and a metric that says which one was right.** It
runs in about three seconds on a laptop.

Everything the kernel sees is here as data. The kernel does not know what AUC means, which direction is
better, or what a "capacity" hypothesis is — those live in three JSON files you own.

```
config.json             the wiring: executor, candidate implementer, model port, rounds, budget
metric-contract.json    what the metric is, its direction, and each metric's role
priors.json             the search space, the beliefs the run starts from, the hypothesis classes
hypotheses.json         this round's structural hypotheses and the change each one makes
metric-contract.json    (also) the contract_ref the frozen round config points at
recorded/judgement.json recorded model answers for VERIFY, CAND_ANALYZE and ROUND_REFLECT
recorded-model.mjs      the model port: replays the recording through the real wire format
apply-change.mjs        the candidate implementer: applies a hypothesis' change inside the worktree
init.mjs                builds a workspace: model repo + frozen priors + a measured baseline
inspect.mjs             prints the four files, with what to change in each
lab/                    the toy model repository candidates branch from (see lab/README.md)
```

## The scenario

`lab/metric.mjs` generates a seeded synthetic feed dataset whose label depends on per-category main
effects **plus one pairwise interaction** (a young user with a long session is worth more than either
alone). The baseline structure is additive, so it cannot represent that interaction: it measures
AUC ≈ 0.707 and stops improving.

Two hypotheses are planned for round 1:

| id | class | change | measured |
|---|---|---|---|
| `h1` | capacity | a 16-unit tanh hidden layer, 25 epochs | AUC ≈ 0.718 |
| `h2` | interaction | four crossed features of the first two fields | AUC ≈ 0.730 |
| `h3` | regularisation | the hidden layer plus l2 0.3 (not run by default) | AUC ≈ 0.707 |

`h2` wins, `h1` improves but is dominated, `h3` shows that regularisation was never a lever on a
ranking metric. Those numbers are reproducible: the dataset is seeded and training is deterministic, so
two candidates are always compared on identical data.

## What to change, and where

Everything below is a configuration or data edit. No source file changes.

| You want to… | Edit |
|---|---|
| flip the metric direction | `metric-contract.json` `direction` + `config.json` `rounds.metric.direction`, and `config.json` `metrics.objectives.auc` (`up`/`down`) — the projection warns if the two disagree |
| change what the run optimises | `config.json` `metrics.primary` + `objectives`, and `rounds.metric.name` |
| rename a metric's role | `metric-contract.json` `role` (human-facing; the kernel ranks `objectives`) |
| add a hypothesis class | `priors.json` `hypothesis_classes`, then use it in `hypotheses.json` — the recorded model refuses a plan whose class is not declared |
| run more hypotheses | `config.json` `rounds.candidates_per_round` (the catalogue ships three, two run) |
| run more rounds | `config.json` `rounds.max_rounds` **and** `stop.max_rounds` — both, because the round workflow and the stop rule each have one |
| cap the spend | `config.json` `budget.gpu_hours_limit` (0 = unlimited; setting it on a `ray` executor also silences the "no GPU-hours limit" warning) |
| cheap out | `config.json` `rounds.candidates_per_round: 1` and `stop.max_rounds: 1` |

## What is real, and what is not

Real: the phase machine, the four-state validators, the identity binding chain, the SQLite fact plane,
budget reservation and settlement, the git-diff authority for "which files changed", the local
executor's subprocess supervisor, the frontier, the stop rule, `dump`.

Not real, and labelled as such wherever it appears:

- **The model** (`recorded-model.mjs`) replays `recorded/judgement.json`. The four judgement phases are
  real code paths over recorded content. To use a live model, point `model.command` at a command that
  reads one JSON request on stdin and writes one JSON answer on stdout — a wrapper around
  `claude -p` or `dsh --profile headless`. **Unverified in this checkout**; treat the first real run
  as an integration exercise.
- **The coding harness** (`apply-change.mjs`) applies the hypothesis' own `change` mechanically. Swap
  `candidate.kind` to `claude` or `dsh` (with `candidate.options`) to let a real harness write the
  edit; the worktree, the `cwd`, the git diff and the self-report cross-check are already the production
  path. Also unverified against a real CLI.
- **The executor** is a local subprocess. `executor.kind: "ray"` plus `base_url` switches to the Ray
  adapter, which passes the same conformance suite against a fake dashboard and has never been run
  against a real cluster here.

## Things worth trying that the kernel will catch

- Change `h2`'s `change` to `{}` — the implementer refuses, LAND records `invalid`, and `dump` says
  so. A landing with no diff is not a candidate.
- Add a fourth hypothesis with `"class": "moonshot"` — `priors.json` does not declare that class, so
  the recorded model returns no plan, the phase refuses with *hypotheses must not be empty*, backs off
  three times, and pauses for a human (an automatic pause clears itself; this one does not). `run`
  exits 1 and `dump` shows the refusal.
- Name a hypothesis in `hypotheses.json` that `apply-change.mjs` cannot find, or give it an empty
  `change` — the implementer refuses with its reason on stderr, LAND records `invalid`, and `dump`
  prints the sentence verbatim.
- Set `metrics.objectives.auc` to `down` and leave `rounds.metric.direction` at `higher` — `run`
  prints the `metric_direction_mismatch` warning before the first tick, and `overview()` carries it
  for the dashboard.
- Set `budget.gpu_hours_limit` to `0.4` — the soft limit stops *new* dispatch while the in-flight
  candidate finishes; the hard limit pauses rather than finalises. `dump` shows the reservations.
- Kill `run` mid-round and start it again — the boot reconcile adopts the job the platform still
  knows about instead of submitting a second one.

## Running the whole thing

The five commands are in the repository [README](../../README.md); this directory is what they use.
The suite runs them too (`packages/core/test/five-minute-path.test.js`), in a temporary directory, so
this example cannot rot without a test going red.