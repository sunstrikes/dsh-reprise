# Extending

Four extension points, one page each. All are designed so that adding something does not require
reading the phase machine, and each is held by a test rather than by a convention.

---

# Add a domain pack (one directory)

A **domain pack** is everything the kernel is not allowed to know about a model: what "better" means,
where a hypothesis may move, how a candidate is measured, and what the model is told at each of the
five call sites. None of it is code. A pack is a directory with a manifest that names five parts:

```json
// domain.json
{
  "schema_version": 1,
  "name": "my-domain",
  "metric_contract": "metric-contract.json",
  "priors": "priors.json",
  "surface": "surface.json",
  "prompts": "prompts",
  "executor": "executor.json"
}
```

| Part | What it must contain | Read by |
|---|---|---|
| `metric_contract` | `name`, `primary`, `direction` (`higher`/`lower`), `objectives` ({metric: `up`/`down`}); optional `role`, `minimum_effective_delta` ({metric: positive delta}), `guardrail` ({`metric`: a ranked metric other than the primary}) | the judge, the frontier, `rounds.metric` when the run does not restate it |
| `priors` | `search_space`, `priors[]`, `hypothesis_classes[]` (each with an `id`) | the round planner's facts; the injection packet's search space |
| `surface` | `files[]` (the path whitelist a candidate's diff is checked against), optional `keys[]` and `symbols[]` | the LAND/VERIFY facts as `allowed_surface`; gate two (ticket 24) |
| `prompts` | `prompts/{land,verify,cand-analyze,round-plan,round-reflect}/SKILL.md`, non-empty | every model call site, re-read per call |
| `executor` | what one job runs (`kind: local` + `command`) and where its output goes | `createPlatform`, and the frozen `executor` fact at INIT |

Rules the loader (`packages/core/lib/domain.js`) enforces, all of them loud:

1. **Nothing is inferred from filenames** — the manifest names each part, so the error can say which
   field pointed at which missing file.
2. **Nothing loads half-empty** — a missing or empty prompt, a missing `search_space`, or a contract
   whose `direction` contradicts its `objectives.<primary>` is refused at boot with the file and key
   named. The quiet version of that failure is a model prompted with nothing, which answers anyway.
3. **A pack is self-contained** — every part must resolve inside the pack directory, so copying the
   directory (into another repository, or an example) preserves its meaning.
4. **How much of a difference counts is the contract's answer, not the kernel's.** `judge.compareMetric`
   compares strictly on purpose, so a pack that wants a tolerance declares `minimum_effective_delta` —
   and the loader then refuses one that is zero, negative, or keyed by a metric the `objectives` do not
   rank, and a `guardrail` that restates the primary. A tolerance nobody ranks is a comment; a
   tolerance of zero says every difference counts.

Point a run at it with `domain: /path/to/the/directory`. Nothing in `packages/` changes; if a second
pack needs a kernel edit to work, the seam is leaking. `packages/core/test/fixtures/config-only-domain`
is a full pack that is only configuration, and `packages/core/test/domain.test.js` loads it to hold
that line.

`examples/generative-recommenders` is a second worked pack, and the harder case: its domain is someone
else's repository, so `surface.files` names paths inside *that* checkout and every whitelisted gin key
and source symbol carries a verified `file` + evidence string
(`packages/core/test/generative-recommenders-pack.test.js` re-checks them against a clone). Its README
also carries the list of decisions a human has to review — the priors and the whitelist are a domain
expert's call, and no test can make it.

---

# Add an executor (one page)

An executor is how an evaluation actually happens: a job leaves for some execution surface, gets
polled, and comes back as metrics or as a classified failure. It crosses a process boundary, so the
port is JSON in / JSON out and never calls back into the kernel.

## The methods

```js
platform.submit({ submissionId, candidateId, gpuHours }) → { job_id, state?, harness?, deadline_ms?, duplicate? }
platform.poll(jobId)                                    → { state, metrics?, error_class?, error_detail?, timing? }
platform.collect(jobId)                                 → { state, metrics?, error_class?, artifacts[] }
platform.find(candidateId)                              → { job_id, state, harness?, submitted_at_ms?, deadline_ms? } | undefined
platform.cancel(jobId)                                  → { accepted, state_after }
```

`submit` / `poll` / `collect` are the job's life. `find` is what makes a restart continue instead of
resubmitting; `cancel` is what makes a timeout stop the spend. `assertPlatform(impl)` refuses an
implementation missing any of the five — call it at construction, so a typo is a startup log line and
not a candidate stuck at `SUBMIT`.

`submit().deadline_ms` is a **duration**; `find().deadline_ms` is **absolute**. That asymmetry is
load-bearing and documented in `packages/exec/README.md`.

## The vocabulary is closed

| `state` | meaning | terminal |
|---|---|---|
| `running` | accepted, not finished | no |
| `succeeded` | finished **and** produced its metrics | yes |
| `failed` | finished unsuccessfully; `error_class` says how | yes |
| `lost` | the platform says it does not exist (404, record gone) | yes |
| `unknown` | we could not find out (dashboard down, unreadable status) | **no** |

`error_class ∈ {oom, code, data, canceled}`. `canceled` never collapses into `failed`: a run we
stopped says nothing about the candidate. `lost` and `unknown` are not severities of `failed` either —
`lost` is a conclusion, `unknown` is the absence of one and must be polled again. Inventing a sixth
state is not possible: `pollJob()` throws at the seam rather than letting a caller treat `"stopped"`
as "still running" and hang a candidate for a night.

## The invariants a conformance run will check

1. **Submit → poll → collect carries the job's own metric back**, and `collect` agrees with `poll`.
2. **Each failure class survives to the caller** — a job that OOMed is `oom`, not "failed".
3. **`unknown` when the platform cannot answer**, without an `error_class` (no evidence, no blame).
4. **`lost` on a 404**, not a retry loop.
5. **Cancel reports `canceled`.**
6. **`submissionId` is the idempotency key**: a duplicate submission returns the *same* `job_id` with
   `duplicate: true`; the caller goes straight to polling and never lands on a second cluster.
7. **`find` answers for submitted candidates and `undefined` for strangers**, with a real
   `submitted_at_ms` and an absolute deadline.
8. **`collect` never invents metrics for an unfinished job.**
9. **Wall-clock and idle limits are enforced by the poller** (the port does not decide timeouts), and a
   timed-out job is actually cancelled.
10. **A healthy job inside its limits is left alone.**

## What you write

```js
import { assertPlatform, runPlatformConformance } from '@dsh-reprise/exec'

export function createMyPlatform(options) {
  const platform = { submit, poll, collect, find, cancel }   // your five methods
  return assertPlatform(platform)
}
```

Then a test that runs **the same suite we run**, with your own glue for "make this job fail as OOM":

```js
import test from 'node:test'
import { runPlatformConformance } from '@dsh-reprise/exec'

test('my executor passes the job-executor conformance suite', async (t) => {
  await runPlatformConformance(t, {
    name: 'my-executor',
    fresh: async () => ({ platform, script(id, spec) { /* your test glue */ }, close() { /* cleanup */ } }),
  })
})
```

`script()` is yours and stays yours: the port has no "pretend to fail" hook, because a bug hiding
behind a fake is exactly what the suite exists to catch. `packages/exec/lib/platform-local.js` is the
model to copy — it is a real subprocess with a real exit code, and its supervisor writes facts
(`exit_code`, `signal`, `canceled`) rather than interpretations, so classification can improve without
rewriting the records of jobs that already ran.

## Wiring it into a run

One branch, in one place: `packages/core/lib/ports.js` → `createPlatform()`. Add `kind: "my-executor"`
to `executor.kind` — in the run configuration, or in the domain pack's `executor` entry when it is the
domain's default — and pass whatever it needs (`base_url`, a directory, its own options) from the same
object. Nothing else in the kernel changes; the phase machine only ever
sees the port.

## What we have not verified

There is no real cluster in this repository. Ray is tested by replaying recorded response shapes through
an injected `fetch`, and the one thing to check first on a real deployment is the metrics mount: if the
shared directory is not shared, every job fails as `data` rather than reporting a fabricated number.
That is the safe failure, and it is also the most confusing one to debug, so check it before anything
else.

---

# Reach a model (one page)

The loop consults a model at exactly five call sites — LAND's briefing, VERIFY's adversarial review,
CAND_ANALYZE, ROUND_PLAN, ROUND_REFLECT — and every one of them goes through
`packages/exec/lib/model.js`. There is no second way in: a phase does not own a parser, and nothing in
the kernel spawns a process.

## The wire

One question in, one answer out.

```js
// what the adapter runs (model.command, or model.kind: 'dsh' | 'claude')
{ protocol: 'dsh-reprise/model-question@1',
  call_site: 'verify', subject: 'r1-h2', ref: 'a2',
  prompt: '<the rendered skill + facts + answer shape>',
  facts: { /* frozen evidence, JSON */ },
  answer_schema: '{"verdict": "accept" | "reject", ...}',
  question_id: '<sha256 of the content above>' }
```

A `kind: 'command'` wrapper receives that object on stdin and must print **one JSON object** on stdout.
`kind: 'dsh'` and `kind: 'claude'` invoke the shipped CLIs (`dsh --profile headless --json -`,
`claude -p --output-format stream-json`) with the *prompt* as their task; the adapter reads the answer
out of the final stream event, tolerating a fenced block or prose around it.

`question_id` is a digest of the question's content — not a clock, not a counter — which is what makes
"the same question asked twice" the same question.

## The four ways to get no answer, and the one class they become

`binary_missing`, `exit_non_zero`, `timeout`, `unparseable_answer` — plus `crash`,
`stream_overflow`, `resource_exhausted` and `port_error` — are all `model_unavailable` with a `cause`
for the operator. That is the whole contract a caller needs: `isModelUnavailable(error)` is true, no
artifact was written, no candidate was rejected, and `packages/core/lib/model-failure.js` records one
`model_unavailable` row in the ops log (`store.ops()`) and retries the phase on a backoff. A phase never
waits for a model without a deadline (`model.timeout_ms`, default ten minutes).

If you need a sixth engine, add a `kind` to `KINDS` in `packages/exec/lib/model.js` — an argv and a
stdin renderer — and a case to `packages/exec/test/model.test.js`. Nothing in the kernel changes.

## Where the call is kept

`<workspace>/artifacts/model_call/<call site>/<subject>[/<ref>].json`:

```json
{ "schema_version": 1, "protocol": "dsh-reprise/model-question@1",
  "question_id": "…", "call_site": "verify", "subject": "r1-h2", "ref": "a2",
  "prompt": "…", "facts": { }, "answer_schema": "…",
  "status": "answered" | "unavailable", "answer": { }, "response": "the model's own words",
  "error_class": null, "cause": null, "message": null }
```

No timestamp and no sequence number: the record's identity is the question, so a repeat rewrites the
same bytes instead of appending a second history. The audit panel (ticket 29) reads these files with
the workspace directory and nothing else.

---

# Add an artifact kind (one page)

An artifact kind is a document a phase worker produces and a validator must accept before the phase
may advance. The validator and its fixtures *are* the contract: this repository deliberately does not
restate field-level schemas in prose, because prose drifts and fixtures fail.

## The seam

```js
import { defineArtifact } from '@dsh-reprise/contract'

defineArtifact({
  kind: 'my_artifact',
  description: 'one sentence a reader of the fact plane needs',
  schemaVersion: 1,
  check(value) {
    return { missing: [], invalid: [], conflict: [] }   // three lists, never a boolean
  },
})
```

Why three lists: `missing` (it is not there), `invalid` (it is there and breaks the contract) and
`conflict` (two facts that must agree do not) are recovered from differently, so the validator's job is
to *report findings*, not to decide. Precedence (missing → invalid → conflict) is decided in one place,
`fromFindings()` in `packages/contract/lib/status.js`. `validateArtifact(kind, value)` then gives the
caller one of the four states plus a message.

Rules that are not optional:

- **Never throw on a bad value.** A model that returns `"true"` for a boolean is the normal case, and a
  validator that throws turns a refused artifact into a crashed tick.
- **Never merge `conflict` into `invalid`.** The whole four-state vocabulary exists for that distinction;
  see `CONTEXT.md` §7.
- **Use the shared predicates** — `checkField`, `isNonEmptyString`, `isMilliseconds`, `isCount`,
  `isPlainObject` — so "is this a timestamp" is answered once. `isMilliseconds` rejects nanoseconds
  (`node:sqlite` throws reading them back) *and* seconds (a unit error that silently lands in 1970).
- **`schema_version` is the artifact's, not the database's.** They evolve independently: artifacts get
  carried away by git and read by other tools; the database stays on this machine.

## Fixtures are the contract

Put `packages/contract/fixtures/<kind>/cases.json` on disk:

```json
[
  { "note": "a clean pass", "expect": "ok", "artifact": { "...": "..." } },
  { "note": "the review contradicts a failed check", "expect": "conflict", "artifact": { "...": "..." } },
  { "note": "passed as the string \"true\"", "expect": "invalid", "artifact": { "...": "..." } },
  { "note": "no verdict at all", "expect": "missing", "artifact": { "...": "..." } }
]
```

`packages/contract/test/artifacts.test.js` sweeps every registered kind, requires **at least one case
per state**, requires that all four states are covered, and requires every non-`ok` case to explain
itself. It also asserts that the set of fixture directories equals the set of registered kinds — so a
kind added to the contract package without fixtures fails the suite immediately. Each `note` is the
specification; write it as the reason the case matters, not as a description of the JSON.

## Checklist

1. `defineArtifact` with a `check()` that pushes messages into three lists.
2. `packages/contract/fixtures/<kind>/cases.json` with ≥1 `ok`, `invalid`, `conflict`, `missing` case.
3. If more than one module might register the kind, guard it (`artifactKinds().includes(kind)`), as
   `packages/core/lib/artifact-kinds.js` does — a second `defineArtifact` for the same kind throws.
4. If the artifact's numbers or comparisons could influence the run: they must not. Numbers come from
   the executor and the comparison comes from the metric contract (`judge.js`); a validator accepts a
   document, it does not compute with one.

## Where the fixture sweep does not reach

A kind registered **outside** `packages/contract` — `round_reflect` and `land_hypothesis`, added by the
round workflow in `packages/core/lib/artifact-kinds.js` — is not covered by that sweep, because the
contract package cannot see a registry entry that only exists once another package is imported. Those
two were added against a frozen contract package and are asserted through their call sites instead
(`workspace-tick.test.js`). If you add a kind to the kernel rather than to the contract, add fixtures
next to it and run them the same way; if you add it to the contract, the sweep is automatic.