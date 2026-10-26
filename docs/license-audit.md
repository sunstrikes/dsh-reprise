# License audit

**Conclusion: this repository can be published under Apache-2.0 with no third-party runtime
dependency to review.** Its code imports `node:` built-ins and its own workspace packages, and nothing
else. The two host packages the test suite touches are MIT. The borrowed ideas are named below, and the
one family that is *not* usable — the AI-Scientist lineage — is called out as a hard red line.

This note is written for a reader who has to answer "may we ship this?" without reading the source. It
records what was checked, how, and what the audit does **not** cover.

## 1. What the shipped code imports

Taken from the actual import graph (`grep '^import'` over every `packages/*/lib`, `packages/*/test`,
`examples/`, `scripts/`):

| Source | Used by | License | Compatible |
|---|---|---|---|
| `node:*` (`fs`, `path`, `os`, `child_process`, `crypto`, `url`, `sqlite`, `test`, `assert`) | all packages | Node.js — MIT | yes |
| `@dsh-reprise/{contract,exec,memory,ui}` | `packages/core` and each other | this repository, Apache-2.0 | yes |
| `@deepseek-ai/cordis`, `@deepseek-ai/cordis-plugin-timer` | **tests only** (`packages/core/test/host-*.test.js`) | MIT (verified from each package's `LICENSE` and `package.json` in the host profile) | yes |

No bundler, no test framework, no assertion library, no ORM, no HTTP client, no date library, no CLI
arg parser. `node:test`, `node:assert/strict` and `node:sqlite` are the whole "stack", which is why the
suite runs offline and why there is very little here to audit.

`@deepseek-ai/cordis` is not vendored or installed by this repository: it is the plugin host, supplied
by the DeepSeek Harness profile the plugin runs inside, and it appears only in the two tests that prove
the plugin's host lifecycle. The packages are not modified.

**Python.** `packages/exec-python` is a manifest and nothing else in this checkout: no code, no
`torch` import, no dependency to audit. When the bridge is built, `torch` is BSD-3-Clause (permissive,
and compatible as an optional extra) — but nothing is shipped today, so nothing is claimed today.

## 2. Borrowed ideas (concepts, no code)

The specification for this repository is explicit that the loop's skeleton is commoditised and that the
contract layer is not. Ideas were read from the following, and **no code, no prompt text and no fixture
was copied**:

| Source | License | What was taken |
|---|---|---|
| OpenEvolve | Apache-2.0 | the shape of a candidate-generation loop; nothing else |
| ShinkaEvolve | Apache-2.0 | confirmation that the loop skeleton is commoditised, which is why this repository does not compete there |
| GEPA | MIT | the same, for prompt/behaviour search |
| Google ML Metadata (MLMD) | Apache-2.0 | the *closest prior art* for artifact lineage; this repository adds `conflict` and `missing` to its `ok`/`invalid` vocabulary |
| Python `eventsourcing` | BSD-3-Clause | the model only: append, version replay, snapshot, projection. The library is Python-only; this repository re-implements the model in TypeScript and does not depend on it |
| Ray | Apache-2.0 | documented HTTP API shapes only (`/api/v0/jobs`, `/api/v0/tasks`). No Ray code, no Ray client library |
| `@changfenhuang/dsh-genui` | MIT | intended for in-session reporting only, never on a critical path (per the spec; not installed here) |
| React | MIT | planned for the dashboard client (ticket 11). Not installed in this checkout |
| a closed-source predecessor (a Python monolith) | not public | behaviour, and in places the shape of the data — re-implemented from scratch in TypeScript. It is not a dependency of this repository, no file, function or prompt was copied from it, and nothing of it is published here |

`@deepseek-ai/cordis` deserves its own line for a different reason: it is **the platform**, MIT, and
this repository's plugin contract is written against its documented lifecycle. Nothing in cordis is
reworded or vendored here.

## 3. The AI-Scientist red line

The AI-Scientist family (Sakana AI et al.) changed license in **2025-12 from Apache-2.0 to a
Responsible-AI derived license carrying field-of-use restrictions**. A use-restricted license is not
Apache-2.0-compatible — it cannot be shipped under this repository's license, and "we only borrowed a
little" does not change that.

**The red line, as implemented here: concepts only, never code.**

- Nothing in this repository is derived from AI-Scientist source: no module, no function, no prompt
  template, no fixture, no file copied and edited.
- The *ideas* that a machine can propose experiments, implement them, evaluate them and reflect are
  general and pre-date that family; this repository implements them from its own specification, and its
  distinctive machinery (phase-level artifact contracts, the four-state vocabulary, the identity binding
  chain, code-owned frontier and stop rules) was designed for this codebase rather than adopted from a
  library.
- If a future contribution needs AI-Scientist code, the answer is no. Re-implement the concept from its
  paper and record it in the table above.

## 4. How to audit a new dependency

1. Look at the SPDX identifier in the package's `package.json` **and** its `LICENSE` file; neither alone
   is enough (a missing field is common, a wrong field is not rare).
2. Accept: MIT, BSD-2/3, ISC, Apache-2.0, 0BSD, Unlicense, MPL-2.0 (file-level copyleft — acceptable for
   a standalone dependency, not for patches inside our files). Ask: any use restriction
   ("non-commercial", "research only", "responsible AI", "no military") — **a restriction is a no**.
3. Reject for linking: GPL, AGPL, SSPL, and anything with a use restriction, however permissive the rest
   reads.
4. Record it in the table in §1 with the reason it is needed. A dependency that does not get a row is a
   dependency nobody agreed to.
5. Prefer deleting the dependency: every capability this repository needs from a library was small
   enough to write, and the audit stays cheap exactly as long as that remains true.

## 5. What this audit does not cover

- **The DeepSeek Harness distribution itself** (hundreds of packages under the profile's
  `node_modules`). This repository does not ship them; audit that distribution separately if it is
  redistributed.
- **The example's synthetic data and toy model.** Generated from a seeded PRNG in
  `examples/feed-structure/lab/metric.mjs`. No real dataset, no scraped content, no third-party weights.
- **A predecessor's dataset and checkpoints.** None exist in this repository, and the example needs
  none: it trains on a seeded synthetic dataset.
- **The generative-recommenders domain pack's upstream.** `examples/generative-recommenders` ships
  only our own JSON, markdown and a stdlib-only metric reader. It points at
  https://github.com/meta-recsys/generative-recommenders (Apache-2.0) and quotes its published numbers
  with the file and section they came from; no upstream source, dataset or checkpoint is copied in, and
  the pack's executor runs a checkout the operator supplies.

## 6. Trademark and naming

"DeepSeek", "DeepSeek Harness", "Ray" and "AI-Scientist" are used descriptively (interoperability and
prior art). No logos, no implied endorsement. The plugin package is `dsh-reprise` (the name the host resolves), and the internal
packages live under the `@dsh-reprise` scope.