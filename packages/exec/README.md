# @dsh-reprise/exec

The execution boundary. Two different things cross a process boundary here, and neither of them
gets to call back into the kernel:

- **`lib/harness*.js` — the candidate implementer** (ticket 07). One CLI coding harness, pinned to
  one candidate worktree, for the LAND phase. Documented below.
- **`lib/platform*.js` — the external job executor** (ticket 08). `submit / poll / collect` for the
  SUBMIT and MONITOR_POLL phases; its conformance suite lives in `lib/platform.js`.

The two ports share one principle: the port returns a *classified outcome*, the kernel decides what
that outcome means. Nothing here imports the host, the contract package, or a database.

## The candidate-harness port

```js
const harness = createClaudeHarness() // or createDshHarness()
const result = await harness.land({
  candidateId,      // whose landing this is — the kernel owns identity
  hypothesis,       // the structural hypothesis to implement, verbatim
  round,            // for the prompt only
  worktreeDir,      // the candidate's own git worktree; the child's cwd is this path
  baseRef,          // the commit the worktree branched from; the diff is taken against it
  parentId,         // the tree parent, as the kernel knows it; never guessed here
})
```

A landing **never** throws for anything the outside world did. It returns one discriminated result:

```js
{ ok: true,  error_class: 'ok', engine, parent_id, parent_commit, base_ref,
  files, files_changed, cross_check, usage, output, session_id, duration_ms, … }

{ ok: false, error_class: 'timeout' | 'crash' | …, message, retryable, conflict, … }
```

`assertLandResult(result)` is the conformance contract in code. A third engine is usable exactly
when it satisfies that function; `test/harness.test.js` runs the same assertions against both
adapters, which is what makes "add an engine, don't touch the kernel" checkable rather than a hope.

Caller mistakes — no `candidateId`, no `hypothesis`, a `worktreeDir` that does not exist, a
`baseRef` git cannot resolve — **do** throw a `TypeError`, before any process starts. Those are the
runner's bug; silently rejecting candidate after candidate would hide it for hours. Everything
attributable to the world outside — a crash, a timeout, a refusal, garbage output, a lying
self-report — comes back as `ok: false` with a class, because a phase machine that gets no answer is
the one state this system forbids.

### `cwd` is the worktree

The child process runs with `cwd = worktreeDir`. Not `--add-dir`, not "please only edit files under
…" in the prompt. The predecessor's whitelist-plus-convention meant the candidate actually ran in
the loop's own checkout; here the edit location is a property of the OS process.

The harness is also told, in the prompt, that it belongs to a worktree and that git state is off
limits — the port cannot un-write a `git commit` the model runs, and the runner cleans up after one.

### Git is the only authority on "what changed"

`files` is produced once, by the adapter, from `git diff --name-only <baseRef>` in the worktree,
unioned with `git ls-files --others --exclude-standard` so that a brand-new file counts. A plain
`git diff` against the base ref would silently omit every file the candidate *added* — a candidate
whose whole change is a new module would report zero files. The union is still git's answer about
the runner's base ref; `git add -A` would have been the other way to see new files, but it mutates
the runner-owned index, which this adapter must not do.

The adapter only ever runs `rev-parse`, `diff` and `ls-files` (see `READ_ONLY_GIT_SUBCOMMANDS`).
**The runner owns the worktree, the base ref and `refs/reprise/*`.** The adapter cannot create,
move or delete any of them, and the conformance test asserts nothing was touched.

### The self-report is a cross-check, not a second source

The prompt asks the harness to end with `{"files": ["…"]}`. That report is compared with git's list:

| cross-check | meaning | effect |
|---|---|---|
| `match` | same set of paths | landing succeeds |
| `not_reported` | the answer carried no report | landing succeeds; git alone decided |
| `mismatch` | the sets differ | landing **fails** as `cross_check_mismatch` |

A mismatch is the fact plane disagreeing with itself, i.e. the contract's **`conflict`** — not
`invalid`. The result carries `conflict: true` so the kernel can record the right of the four
states. Neither side is believed over the other: `files` still comes from git, and the disagreement
is the finding. Both directions are kept in `cross_check.missing` (git changed a file the harness
never mentioned — the dangerous one) and `cross_check.unexpected` (the harness claimed a file git
cannot see — an invented change).

### Failure taxonomy

| `error_class` | when | `retryable` |
|---|---|---|
| `ok` | exit 0, a result event, no contradiction | – |
| `timeout` | the adapter killed it at `timeoutMs` (SIGTERM, then SIGKILL on the process group) | no |
| `stream_overflow` | output exceeded `streamCapBytes`; the child was killed | no |
| `crash` | killed by a signal, or the spawn itself failed | no |
| `harness_unavailable` | the binary is not installed (`ENOENT`) | no |
| `credential` | non-zero exit with an auth-shaped stderr | no |
| `transient` | non-zero exit with a rate-limit/upstream-shaped stderr | **yes** |
| `refusal` | the engine reported `subtype: "refusal"` | no |
| `deterministic_fail` | non-zero exit, or an error subtype, with nothing more specific | no |
| `unparseable_output` | output that is not newline-delimited JSON events | no |
| `result_missing` | clean exit, no result event | no |
| `cross_check_mismatch` | the report contradicts git (`conflict: true`) | no |

Precedence is fixed, and documented in `classify()`: what *we* did to the process (timeout,
overflow) outranks anything the process said, because both the exit code and the stream are
meaningless once we killed it; a missing binary outranks a crash; a signal outranks the exit code; a
non-zero exit outranks "the stream ended early". `unparseable_output` and `result_missing` are
deliberately separate: one says the wire format broke, the other says the process stopped early.

`retryable` is a hint, not a decision — only `transient` carries it.

### What the kernel call site has to change

`packages/core/lib/loop.js` (`land()`) currently does:

```js
const result = harness.land({ candidateId, hypothesis: state.hypothesis, round: state.round })
```

Three small changes are needed, none of them behavioural in the fake-port tests:

1. **`await` it.** The port spawns a real process; making it synchronous would block the host's
   event loop for the length of a model run. `land` → `stepFor` → `tick` become `async` (or
   `land()` returns a promise the caller must settle).
2. **Pass the worktree and base ref.** The kernel has to carry `worktreeDir`, `baseRef` and
   `parentId` from the runner (the outer process that created them) into the call. `parent_id` is
   currently invented by the fake harness; the real port returns `parentId` verbatim with
   `parent_commit` resolved from git, and returns `null` when the kernel does not supply a parent.
3. **Handle `ok: false`.** On a classified failure the kernel must reject the candidate with the
   class in the event payload; on `error_class === 'cross_check_mismatch'` it must record the four
   states as `conflict`, not `invalid`. A thrown `TypeError` is a runner bug and must stay loud
   rather than becoming a per-candidate rejection.

`files_changed` keeps the shape the kernel already writes into `land_done` (a **count**); the list
itself is `files`.

### Adding a third engine

Write an argv builder and reuse `landWithCli` from `lib/harness.js`. Then add the adapter to
`ADAPTERS` in `test/harness.test.js` (or run `assertLandResult` from your own suite) and give it a
fake CLI. If the engine's event vocabulary needs new shapes, put the normalisation in `pickResult`
so the difference stays in one function.

### What is not verified here

- **Neither adapter has been run against a real CLI.** The conformance suite uses a fake CLI written
  into a temp directory, because a test that needs a model is not a test. Whether `claude -p
  --output-format stream-json` and `dsh --profile headless --json` produce exactly the event shapes
  assumed here is *unverified* in this checkout; `pickResult` accepts both a `type: "result"` event
  and a `final: true` event so the first real run only has to adjust one function.
- **`--dangerously-skip-permissions`** is the default for unattended operation. That is a policy
  choice for the host's sandbox, not a security boundary provided by this package.

## Running the tests

```bash
node --test packages/exec/test/harness.test.js packages/exec/test/harness-errors.test.js
```

No network, no model, no GPU. The rig creates a throwaway git repository plus a real linked worktree
per test (`test/support.js`), and the fake CLI records its `argv`, `cwd` and stdin so the assertions
are about what the child process actually saw.

## The job-executor port

`lib/platform*.js` is how an evaluation actually happens: a job leaves for an external execution
surface, gets polled, and comes back as metrics plus a classified failure when there is one. Two
implementations — a local subprocess and Ray OSS — pass one conformance suite, which is what makes
"switch executor" a package swap instead of a kernel change.

```js
const platform = createLocalPlatform({ rootDir, plan })          // no cluster, no GPU
const platform = createRayPlatform({ plan, baseUrl, metricsDir }) // transport: node:http, injectable as `request`

const submitted = await submitJob(platform, { submissionId, candidateId, gpuHours })
const polled = await pollWithLimits({ platform, job, now: clock.now(), limits })   // poll + timeout policy
const collected = await collectJob(platform, submitted.job_id)                     // metrics + artifacts
const found = await findJob(platform, candidateId)                                 // for recovery
const canceled = await cancelJob(platform, submitted.job_id)
```

| method | input | answer |
|---|---|---|
| `submit` | `{submissionId, candidateId, gpuHours}` | `{job_id, state?, harness?, deadline_ms?, duplicate?}` — `deadline_ms` is a **duration** |
| `poll` | `jobId` | `{state, metrics?, error_class?, error_detail?, timing?}` |
| `collect` | `jobId` | `{state, metrics?, error_class?, artifacts[]}` — `metrics` only for `succeeded` |
| `find` | `candidateId` | `{job_id, state, harness?, submitted_at_ms?, deadline_ms?}` or `undefined`; `deadline_ms` is **absolute** |
| `cancel` | `jobId` | `{accepted, state_after}` — idempotent, `accepted: false` when already terminal |

`submitJob` / `pollJob` / `collectJob` / `findJob` / `cancelJob` are thin awaited wrappers that also
**validate the answer** (`assertPlatform`, `assertPollResult`, … in `lib/platform.js`). Use them, not
the raw methods: a typo'd state is a log line at the seam and a stuck candidate at SUBMIT.

### The closed vocabulary

`state`:

| value | meaning | is it terminal |
|---|---|---|
| `running` | the platform accepted the job and has not finished it (Ray `PENDING`/`RUNNING`) | no |
| `succeeded` | finished successfully **and** produced its metrics | yes |
| `failed` | finished unsuccessfully; see `error_class` | yes |
| `lost` | the platform says the job does not exist (HTTP 404, job record gone) | yes |
| `unknown` | we could not find out: dashboard unreachable, status unreadable, status string unrecognised | **no** |

`lost` and `unknown` are not severities of `failed`. `lost` is a conclusion (retrying forever is how
one candidate blocks a whole round); `unknown` is the absence of one, and must be polled again —
collapsing it into `failed` kills a job that was running fine across a restart (user story 15).
There is deliberately no `pending` and no `stopped`: a second enumeration of "not done" forces every
caller to join them back together.

`error_class` — four values, and **`canceled` never collapses into `failed`**:

| value | evidence |
|---|---|
| `oom` | Ray task `OUT_OF_MEMORY`; local `SIGKILL` we did not send, or an OOM-shaped stderr |
| `code` | Ray task `TASK_EXECUTION_EXCEPTION`; a traceback on stderr |
| `data` | missing/unparseable input; Ray `RUNTIME_ENV_SETUP_FAILED`; or "exited 0 with no metrics" |
| `canceled` | we stopped it (timeout, budget, operator), or Ray reports `STOPPED` |
| *(omitted)* | failed with no usable evidence — `NODE_DIED`, `WORKER_DIED`, `TASK_UNSCHEDULABLE_ERROR`, a bare non-zero exit with an empty log. Handed to `CAND_ANALYZE`, because inventing `code` here makes the next round debug code that never ran |

### Timeouts are a conclusion, not a hang

Neither backend decides timeouts; the poller does. `judgeTimeout({job, now, limits})` is a pure
function over wall clock (`max_wall_ms` from `started_at_ms ?? submitted_at_ms`) and silence
(`max_idle_ms` from `last_progress_at_ms`), so the policy is reproducible without waiting.
`pollWithLimits()` then **calls `cancel()` itself** and returns

```js
{ state: 'failed', error_class: 'canceled',
  timeout: { kind: 'wall' | 'idle', elapsed_ms, limit_ms, canceled: true, state_after },
  error_detail: { message: '… the poller stopped the job' } }
```

Judging a job dead without stopping it bills GPU hours nobody is watching; reporting the timeout as a
plain `failed` lets a stop policy confuse "we gave up on it" with "the candidate is broken". A
`lost` job is never timed out — 404 is already a conclusion.

### `submission_id` is the idempotency key

`submit()` sends `submission_id` and nothing else as identity. Both real Ray answers — `400` with
`Job with submission_id … already exists` (from `put_info(overwrite=False)`) and a proxy's `409` —
resolve to `{duplicate: true, job_id: <the existing job>}`, and the caller goes straight to polling.
It never retries onto another cluster: that is how one candidate gets two GPU bills. The kernel
already records `duplicate` in the `submitted` event and moves to `MONITOR_POLL` either way.

### The submission body is text where Ray says text

`JobSubmitRequest.__post_init__` (`ray/dashboard/modules/job/common.py`) requires **every**
`metadata` value to be a `str`; anything else is a `TypeError: metadata values must be strings, got
<class 'float'>` and a `400` before a job exists — and `null` is not a string either. So `submit()`
normalises the whole object rather than one field (`stringMetadata()`):

| value | what goes on the wire |
|---|---|
| `string` | unchanged |
| number, boolean | `String(value)` — `gpu_hours: 0.1` travels as `"0.1"`, and the ledger and a human both read it |
| `undefined`, `null` | the **key is omitted**, because Ray accepts a missing key and refuses a `null` one |
| object, array | throws a `TypeError` naming `metadata.<key>` — there is no faithful text form, and inventing one (JSON in a string) would be a format nothing reads back |

`runtime_env.env_vars` is normalised the same way for the same reason. The fake dashboard implements
this check (`400 metadata values must be strings, got <class 'float'>`), so a regression cannot pass
the suite — the fake was looser than the cluster twice (the browser guard, then this), and the second
time cost a live run.

### The transport is `node:http`, not `fetch` — and that is not a preference

The dashboard has a CSRF / DNS-rebinding guard (`dashboard/optional_utils.py::is_browser_request`):
a request is **browser traffic** when its `User-Agent` starts with `Mozilla` **or when any
`Referer` / `Origin` / `Sec-Fetch-*` header is present**, and browser traffic may only `GET`. Node's
global `fetch` (undici) sends `sec-fetch-mode: cors` on every request, so it cannot write to this
dashboard at all — `PUT /api/packages/gcs/…` and `POST /api/jobs/` both answer
`405 '<METHOD>' method not allowed for browser traffic`. Measured on Ray 2.59 on 2026-10-24; the first
live acceptance run of ticket 15 died on it.

So every call goes over `lib/ray-http.js` — one transport for reads and writes, `node:http`/
`node:https`, no dependency — with a plain `user-agent` and `Referer`/`Origin`/`Sec-Fetch-*` dropped
even if a caller supplies them. It is a port: `createRayPlatform({ request })`, where

```js
request({ method, url, headers, body }) → { status, headers, text }
```

is what the fake dashboard implements in the tests (the fake also models the guard, so a browser-ish
header set gets the same 405 the cluster gives). A 405 is never swallowed: the submit throws
`ray rejected the submission: 405 … browser traffic …` (or the package equivalent) and no job is
created, so a fixed transport can simply try again. `test/ray-http.test.js` proves the header set on a
real localhost socket and runs a whole submission against a miniature dashboard that enforces the
guard.

### The candidate's code travels with the job (Ray)

The nodes have **no shared filesystem** with us and **no internet**, so there is no directory to point
a job at: the only inbound channel is the Job Submission API. A plan that names a worktree therefore
makes `submit()` do three things before it writes anything:

```js
plan: ({ candidateId }) => ({
  entrypoint: ['python3', 'train.py', '--config', 'config.py'],  // runs *inside* the package
  worktreeDir: runner.worktreeFor(candidateId),                  // the tree to ship
  baseRef: runner.baseRef,                                       // the runner's git authority
  numGpus: 1,                                                    // → entrypoint_num_gpus
})
```

1. **Pack** — `packCandidate()` (`lib/archive.js`) zips the whole worktree with the deterministic
   encoder in `lib/zip.js`, leaving out the plugin's own fact plane (`*.db`, `*.db-wal`, `*.db-shm`,
   `.mnemon/`, `.git`, `.reprise/` — the list is `FACT_PLANE_EXCLUSIONS`, data with a reason per
   entry, and it is the only thing that decides what is dropped).
2. **Upload** — `PUT /api/packages/gcs/<name>.zip`, where
   `name = reprise-<submission-id-slug>-<sha256 of the archive>.zip`. Flat (a name with a slash
   matches no route), `.zip` (Ray rejects anything else), content-addressed (two candidates never
   overwrite each other's package; an unchanged tree never leaves a second object).
3. **Submit** — `runtime_env.working_dir = "gcs://<name>.zip"` and the entrypoint
   `<verifier> && <training>`, so the job runs *in the unpacked package* and reads the configuration
   the candidate edited. `runtime_env.working_dir` belongs to the adapter: a plan that sets it is
   refused. A packaged job is **not** given `REPRISE_METRICS_PATH` (a laptop path it cannot write);
   it reports through `REPRISE_METRICS {json}` on the driver log.

**What changed** stays the runner's git answer: `git diff --name-only <baseRef>` plus
`git ls-files --others --exclude-standard`, run in the candidate worktree, neither touching the index
(see `collectInventory()`; a test asserts the exact two subcommands and that the index and refs are
unchanged). Untracked files are the *normal* shape of a structural candidate — a hypothesis that adds
a module — so they are shipped, named in the receipt (`submit().packaging.untracked`) and named again
in the manifest inside the package.

The inventory is checked on both sides of the upload, and a disagreement is the contract's
**`conflict`**, not `invalid`: nothing the candidate produced is malformed, two accounts of it simply
do not match.

| where | who compares | a mismatch means |
|---|---|---|
| before the upload | `compareInventories()` over the archive read back | the packer lost or mangled a path — `PackageRefusedError` with `conclusion: 'inventory_conflict'` |
| after the unpack (on the node) | `.reprise/verify_inventory.py`, shipped in the package, run by the entrypoint | the tree that arrived is not the tree that was packed — `poll()` returns `state: 'failed', conflict: true, error_class: 'data'`, and the training never started (`&&`) |
| never | — | an archive over `packaging.maxBytes` (default 64 MiB) or a path the archive cannot carry (a symlink) is `conclusion: 'archive_too_large'` / `'inventory_conflict'`, thrown **before** any upload and any job |

`PackageRefusedError` carries `retryable: false`, because a tree that is too large or disagrees with
its own diff does not get smaller by waiting. The kernel currently retries any thrown `submit()` with
backoff (it cannot tell "cluster down" from "this candidate cannot ship"), so the same conclusion is
re-raised every attempt — loud, but it is the kernel that should consume `retryable`.

**The verifier is a Python file in `packages/exec/lib/`,** because the check has to run *on the node*,
and `python3` is the one interpreter the measured cluster guarantees (`.scratch/notes/cluster-env.md`);
there is no `node` on those nodes and no way to get one. It is shipped *inside the package* (never
executed on the laptop) and invoked only by the entrypoint the adapter builds. The interpreter is
data: `packaging.verify = { command: ['python3'] }`, and `verify: false` ships a bare tree — the
in-process read-back in `packCandidate()` still runs, so a caller without a node-side interpreter
keeps every JS-side guarantee and loses only the post-unpack one. It is tested two ways: the marker
parser against scripted logs (`platform-package.test.js`), and — where a `python3` exists — by
unpacking a real package and running the shipped script, which must pass untouched and fail on an
altered file (the test skips, loudly, on a machine without the interpreter).

**One `submission_id` is one package and one job.** `submit()` first asks the cluster whether it
already owns that id (`GET /api/jobs/<submission_id>`, matching `metadata.candidate_id` so a slug
collision cannot adopt a stranger's run) and answers `{duplicate: true}` without packing, uploading or
POSTing. The old `409`/`400 already exists` path is kept for the race where the job exists but the
details route cannot see it yet. Tests count requests rather than read flags: one `POST`, one `PUT`,
`fake.jobs.size === 1`, `fake.packages.size === 1`.

Measured against the live cluster (Ray 2.59, 2026-10-24), so the read is not an assumption:

| request | answer |
|---|---|
| `GET /api/jobs/reprise-probe9-pkg` (finished job) | **200**, full details |
| `GET /api/jobs/no-such-submission-xyz` | **404** `Job … does not exist` — the pre-check misses, so the submit proceeds |
| `GET /api/jobs/<submission_id>/logs` | **200** `{"logs": …}` — the log read works by submission id too |
| `job_id` in a details document | may be **`null`** (42 of 129 listed rows): the submission id is then the id that resolves, so `submit()`/`find()` return it rather than a null |

That last row is why a duplicate can answer with the *submission id* instead of a `raysubmit_…` id:
it is the reference the dashboard, the logs route and the poller all accept.

#### A run against the measured cluster

```json
{
  "domain": "examples/feed-structure",
  "workspace": ".workspace/cluster",
  "runner": { "repo": "model-repo", "dir": "worktrees", "base_ref": "HEAD" },
  "executor": {
    "kind": "ray",
    "base_url": "http://10.92.7.207:8258",
    "command": ["python3", "train.py", "--config", "config.json"],
    "num_gpus": 1
  },
  "limits": { "max_wall_ms": 600000, "max_idle_ms": 600000 }
}
```

`train.py` must print `REPRISE_METRICS {"metrics":{"auc":0.71}}` — on a cluster with no shared mount,
the driver log is the return channel, and a job that exits 0 without a marker is a `data` failure.

### Ray: failure classification reads the task state

`JobDetails.error_type` is a `TODO` in OSS Ray and is **never populated** — a classifier built on it
always answers "unknown" while looking authoritative. So `lib/platform-ray.js` asks
`/api/v0/tasks?filter_keys=job_id&filter_values=<job_id>` for `TaskState.error_type` (populated), and
only falls back to the driver-log regex when no task carries a typed error. `test/platform-ray.test.js`
makes the fake *lie* in `JobDetails.error_type` to prove which source is trusted.

### The metrics contract

Ray has no progress or result API, and a subprocess has no exit-code side channel once the supervisor
is gone, so both implementations agree on one shape: the job writes

```json
{ "metrics": { "val_loss": 0.3125, "samples_per_s": 1234.5 } }
```

to `$REPRISE_METRICS_PATH` (`<jobDir>/metrics.json` locally; a path under `metricsDir` passed through
`runtime_env.env_vars` for Ray — a shared mount in a real deployment). A flat object of numbers is
also accepted, so a hand-written smoke script does not have to be wrapped. **Exit 0 without that file
is a `data` failure, not a success with empty metrics**: an empty metric set becomes a candidate
score, and a fabricated score is worse than a failed run. `metricsRequired: false` opts out.

### What the kernel call site has to change

`packages/core/lib/loop.js` uses `platform.submit()`, `platform.poll()` and `platform.find()`
synchronously, which is honest for the local executor and impossible for HTTP. Concretely:

1. **`await` them.** Use `submitJob` / `pollJob` / `findJob` (they accept sync or async
   implementations) and let `submit` → `monitor` → `reconcile` … become `async`. The local executor
   stays synchronous internally, so nothing about the fake-port tests changes.
2. **`monitor()` should call `pollWithLimits`** instead of `platform.poll`, passing the job row plus
   `limits`. Today nothing ever times a job out, so `cancel()` has no caller.
3. **Branch on `timeout !== null`** before the generic failed branch: emit a `job_timeout` event
   (kind, elapsed, limit, cancel accepted) and decide retry-vs-reject explicitly. Falling through
   gives the candidate `invalid` and the message "job failed: canceled", which is true but loses the
   distinction the ticket asks for.
4. **Wrap `submit()` in `try/catch`.** A rejected submission (cluster down, no resources, a plan with
   nothing to run) *throws* rather than inventing a job id. Hold the candidate at `SUBMIT` with a
   backoff; an uncaught throw currently escapes `tick()`.
5. **Call `collect()` at `CAND_ANALYZE`.** `poll` carries the metrics the kernel already records;
   `collect` additionally returns the artifacts (driver log, metrics file) and is the authoritative
   answer about a finished job.
6. Keep the asymmetry: `submit().deadline_ms` is a duration, `find().deadline_ms` is absolute.
   `started_at_ms` / `last_progress_at_ms` should reach `pollWithLimits` through the job row.
7. `unknown` is not terminal — the existing backoff path is right; do not add it to `isTerminal`.

### Adding a third executor

Implement the five methods, call `assertPlatform(impl)` at construction, then run
`runPlatformConformance(t, { name, fresh })`. `fresh()` returns `{platform, script(), close()}`, where
`script()` is your own test glue for "make this job fail as OOM"; the port itself has no such hook,
and adding one would let a bug hide behind the fake. The suite is in `lib/` because it is part of the
published contract, not our private tests.

### What is not verified here

- **No real Ray cluster.** The conformance run replays recorded response shapes through the injected
  transport (JobDetails field names, the state-API `{result, msg, data: {result: {result: [...]}}}`
  envelope, 404 bodies, `{stopped}`). Whether `TaskState.error_type` is actually written when the
  *driver* dies is unverified here as well — the predecessor's research flags it as `[未做]`, and it
  matters only for driver-level crashes; task-level OOM/traceback is the documented case.
- **The duplicate path was only exercised against the two shapes Ray documents**, not against a
  cluster; a third proxy shape would surface as a thrown submit (loudly, not silently).
- **Local `oom` from a bare `SIGKILL` is a heuristic**: SIGKILL that we did not send is treated as
  the kernel OOM killer, because the alternative is calling every OOM kill a code error. A job killed
  by an external operator's `kill -9` is reported `oom`.
- **Local liveness is a pid probe** (`process.kill(pid, 0)`), so pid reuse could make a dead job look
  alive; the wall-clock limit still reaps it.
- **The metrics mount is the real Ray weakness**: if the shared directory is not actually shared, every
  Ray job fails as `data` rather than reporting a fabricated number. That is the safe failure, but it
  is the first thing to check when wiring a cluster.
- **Ray `find()` relies on `submissionId === candidateId`** (the kernel's current convention) to
  recover by idempotency key after a crash. Change that convention and pass `submissionIdFor`.

## Running the job-executor tests

```bash
node --test packages/exec/test/platform.test.js        # conformance, both implementations
node --test packages/exec/test/platform-ray.test.js    # classification, duplicates, transient outage
node --test packages/exec/test/platform-local.test.js  # real subprocess, restart, cwd, cancel
```

No network, no cluster, no GPU: the Ray tests use a fake dashboard (`test/platform-fixtures/ray-fake.js`)
and the local tests spawn real `node` processes that compute a synthetic metric in milliseconds.