# Windowed samples

How a run reports its numbers: **one row per window**, so a candidate and a baseline can be compared
over the same intervals instead of by one number each. The shape is the contract
(`@dsh-reprise/contract`, artifact kind `window_series`); reading whatever medium produced it is the
executor adapter's job (`@dsh-reprise/exec/windows`). The kernel never learns how to read a
tensorboard file, and the parser never decides what a window means.

Why it exists: a single final metric cannot tell an improvement from a run that evaluated at different
steps, and the cluster's nodes have **no shared filesystem** — a run's numbers come back through the
driver log, if they come back at all. Both facts push the same way: the samples have to be a document
with a fixed shape, produced by an adapter, and validated before anything compares them.

```json
{
  "schema_version": 1,
  "unit": "step",
  "windows": [
    { "index": 0, "start": 0,  "end": 10, "metrics": { "metric_one": 0.28, "train_loss": 1.0 } },
    { "index": 1, "start": 10, "end": 20, "metrics": { "metric_one": 0.284, "train_loss": 0.5 } }
  ]
}
```

| field | type | meaning |
|---|---|---|
| `unit` | non-empty string | the progress unit the bounds are counted in (`"step"`, `"epoch"`, `"second"`). Two series in different units cannot be paired, and pairing says so instead of comparing 10 to 10. |
| `windows[].index` | non-negative integer | the window's ordinal in the run, strictly increasing. Gaps are allowed; a repeat is not. |
| `windows[].start` | non-negative integer | the first unit **inside** the window |
| `windows[].end` | non-negative integer | the first unit **after** the window. A window is the half-open interval `[start, end)`, so it has a length and `end > start`. |
| `windows[].metrics` | object of finite numbers | what that window measured, keyed by the metric's own name |

Nothing in the shape names a specific metric. Which metric is primary, and whether a run is read as
the mean of its windows or as its last window, belong to the metric contract — `window_mode` — and are
resolved in one place, `packages/core/lib/metric-contract.js` (`resolveMetricContract`, `readMetric`);
the shape only guarantees that such a rule can be applied to both sides of a comparison.

`schema_version` is the document's own, not the database's: the samples get carried away by git and
read by tools outside this process, exactly like every other artifact.

## The four states

`validateArtifact('window_series', series)` returns the same four states as every other artifact:

| state | when |
|---|---|
| `ok` | at least one window, every window has an ordinal, a length and a metrics table of finite numbers |
| `missing` | `unit` or `windows` is absent, or a window has no `index` / `start` / `end` / `metrics` |
| `invalid` | a window breaks the shape: an empty `windows` list, an ordinal that does not increase, `end <= start`, an empty or non-finite metrics table, or the same window repeated with identical numbers |
| `conflict` | the same bounds claim **different** numbers — two accounts of one interval, which is the fact plane disagreeing with itself rather than a malformed document |

An empty `windows` list is `invalid` on purpose: a run that produced no window produced no
measurement, and "no measurement" must never be scored as "no difference".

## The adapters

Both live in `packages/exec/lib/window-samples.js` and return either `{ ok: true, series }` or
`{ ok: false, error_class: 'data', reason }`. The failure class is the platform port's: a payload that
is missing, clipped or unreadable is `data`, never a candidate defect and never an empty success.

### A tensorboard event file

```js
import { readFileSync } from 'node:fs'
import { parseEventFile } from '@dsh-reprise/exec/windows'

const parsed = parseEventFile(readFileSync('run.tfevents'), { window_steps: 10 })
if (parsed.ok !== true) throw new Error(parsed.reason) // error_class: 'data'
// parsed.series is the document above
```

The parser reads TFRecord framing (length + length checksum + payload + payload checksum, both
CRC-32C) and the protobuf fields a scalar summary lives in — by hand, because this repository has no
runtime dependencies and because the *failures* are the point: a file clipped mid-record is reported
at the byte offset, a record whose bytes changed is reported as a checksum failure, and a file holding
only its `file_version` record is reported as "no finite scalar point" instead of parsing to an empty
series. `simple_value` scalars are read; tensor-valued scalars are skipped rather than guessed at.

`window_steps` is required. A window is a choice about the experiment, not something a file can
discover, so the adapter forces the caller to state it. The rule is arithmetic:

- window *n* covers `[n·window_steps, (n+1)·window_steps)`;
- each metric's value in a window is the **mean of the finite points recorded inside it**;
- a non-finite point (a `nan` loss spike, an `inf` gradient) is not a measurement: it is left out of
  the mean, and a metric with no finite point in a window is absent from that window's table.

The same bytes always parse to byte-identical samples: no clock, no randomness, metrics written in
name-sorted order, windows in window order.

### The driver log

This is the only channel back from a cluster whose nodes share no filesystem. The job prints **one**
line holding the whole series:

```
REPRISE_WINDOWS {"schema_version":1,"unit":"step","windows":[…]}
```

```js
import { parseWindowLog } from '@dsh-reprise/exec/windows'
const parsed = parseWindowLog(driverLogText)
```

One line rather than one per window, because a log is truncated at its end: a whole-series line either
survived intact or is visibly broken, while per-window lines would leave a half series that looks
complete. A repeated identical line is the same series printed twice (a resumed job) and is accepted;
two lines that disagree are two accounts of one run, reported as a `data` failure. A log with no marker
line, a marker line that is not JSON, and a payload that holds no window are each a `data` failure with
a reason that counts what it read.

### From a shell

```
node packages/exec/lib/cli/windows.js --event-file run.tfevents --window-steps 10 > a.json
node packages/exec/lib/cli/windows.js --event-file run.tfevents --window-steps 10 > b.json
diff a.json b.json && echo "same window, same samples"

node packages/exec/lib/cli/windows.js --log driver.log > series.json
```

A refusal exits `2` with the reason on stderr and **nothing** on stdout, so a shell pipeline can never
read an empty series as a successful one. A caller mistake (no `--window-steps`, nothing to parse)
exits `1` with the usage.

## Where the samples land

The kernel records a series through one path for both subjects (`packages/core/lib/samples.js`), and
the reason is pairing: a candidate's samples and its baseline's are compared window by window, so two
different shapes would make the comparison impossible rather than merely awkward.

- **The document** is the artifact `<subject>/window_samples.json` — the `window_series` above, byte
  for byte, written atomically like every other artifact.
- **The fact** is the event `window_samples`, on the subject's own id (`r1-h2`, or the reserved
  `_baseline`), carrying the artifact reference, its sha256, the unit, the window count and the metric
  names. An artifact with no fact is a file nobody can tell was collected; a fact with no artifact is a
  claim with no evidence.
- **The series is found** from the executor's answer: a parsed `window_series` document if the adapter
  already produced one, otherwise the driver log (the `REPRISE_WINDOWS` line) read by the exec
  adapter — the kernel decides which artifact to hand the parser, never how to parse it.
- **A candidate without samples still finishes**: its metric is enough to rank it. **The baseline
  cannot**: BASELINE is the denominator, so a job that failed, a run that reported no metric, a run
  that reported no window, a series the contract calls `invalid` and one it calls `conflict` each stop
  the workspace with that reason named — never with an empty denominator, which would make every later
  comparison a win.

## Pairing: the intersection rule

`pairWindows(candidate, baseline)` returns a `Validation`-shaped answer (`status` / `message`, so
`isBlocking()` applies) plus the pairs it made. It is a rule, not a helper: the comparison, the metric
roles and the stop decision all read it.

1. **Windows pair by their bounds, never by their position.** Candidate windows `[2,3,4]` and baseline
   windows `[1,2,3]` pair 2 with 2 and 3 with 3; the candidate's 4 and the baseline's 1 appear in
   `dropped.candidate` / `dropped.baseline`. Pairing "window 3 with window 3" across two runs that
   evaluated at different steps compares two different amounts of training and would call the
   difference an improvement.
2. **No window in common is `missing`, not `invalid` and not an equal result.** The comparable window
   was never produced by the other run — nothing is malformed, nothing is compared. A caller reports
   it as a `data` failure; treating it as "no difference" is how a run that measured nothing wins.
3. **Two different units are `conflict`.** Each series is well-formed in its own terms and they
   disagree about what a window covers, so nothing may be paired.
4. **The metric table is per window.** A metric one side measured and the other did not is reported,
   never silently dropped: each pair carries `comparable_metrics`, `candidate_only_metrics` and
   `baseline_only_metrics`, and the series-level `metrics` carries the same distinction across all
   windows. A run that measured one objective must not look like a run that measured three.
5. **`ok` means at least one paired window shares at least one metric.** Bounds that line up while
   every metric was renamed are still no comparison.

## A real run on the cluster

The "one real run produces a series of window samples" check, end to end. The measured facts this
follows (Ray 2.59.0 at `http://10.92.7.207:8258/`, per-node containers with a prebuilt torch and no
internet, no cross-node mount, results readable only from the driver log) are in the run notes that
accompanied this ticket; nothing below assumes a shared filesystem.

**1. The job package.** `run_tb.py` trains briefly, writes real tensorboard events, and prints the
event file as base64 (so the *shipped* parser is what reads it) plus the marker payload (so the log
channel is exercised too):

```python
# run_tb.py — expects ./vendor/*.whl (tensorboard, absl-py, gin-config, protobuf, werkzeug,
# setuptools) beside it: the node venv has torch but not tensorboard, and there is no pip index.
import base64, json, os, sys, zipfile
site = os.path.join(os.getcwd(), 'site'); os.makedirs(site, exist_ok=True)
for wheel in sorted(os.listdir('vendor')):
    zipfile.ZipFile(os.path.join('vendor', wheel)).extractall(site)
sys.path.insert(0, site)

from torch.utils.tensorboard import SummaryWriter
from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

logdir = os.path.join(os.getcwd(), 'tb')
writer = SummaryWriter(logdir)
for step in range(0, 40, 10):
    writer.add_scalar('eval/metric_one', 0.28 + step / 1000, step)
    writer.add_scalar('eval/metric_two', 0.16 + step / 2000, step)
    writer.add_scalar('train/loss', 1.0 / (1 + step / 10), step)
writer.close()

path = os.path.join(logdir, os.listdir(logdir)[0])
print('REPRISE_EVENTS ' + base64.b64encode(open(path, 'rb').read()).decode())

# The same windowing rule as windowsFromPoints(): window_steps = 10, mean of the finite points.
acc = EventAccumulator(logdir, size_guidance={'scalars': 0}); acc.Reload()
buckets = {}
for tag in acc.Tags()['scalars']:
    for event in acc.Scalars(tag):
        buckets.setdefault(event.step // 10, {}).setdefault(tag, []).append(event.value)
series = {'schema_version': 1, 'unit': 'step', 'windows': [
    {'index': index, 'start': index * 10, 'end': (index + 1) * 10,
     'metrics': {tag: sum(values) / len(values) for tag, values in sorted(bucket.items())}}
    for index, bucket in sorted(buckets.items())]}
print('REPRISE_WINDOWS ' + json.dumps(series))
```

If that Python shim and `windowsFromPoints` ever disagree, the JavaScript parser is the authority and
the shim is wrong — it exists to show the log channel works on the cluster, not to define the rule.

**2. Upload and submit** (the package store is the cluster's only shared, content-addressed store):

```
zip -q -r tb-samples.zip run_tb.py vendor/
curl -sS -X PUT --data-binary @tb-samples.zip http://10.92.7.207:8258/api/packages/gcs/tb-samples.zip
curl -sS -X POST http://10.92.7.207:8258/api/jobs/ -H 'content-type: application/json' -d '{
  "entrypoint": "python3 run_tb.py",
  "runtime_env": {"working_dir": "gcs://tb-samples.zip"},
  "entrypoint_num_gpus": 1,
  "metadata": {"candidate_id": "windows-probe"}
}'
```

**3. Read the payload out of the driver log, then parse it twice:**

```
curl -sS http://10.92.7.207:8258/api/jobs/<job_id>/logs > job.log
python3 - <<'PY'
import base64, json
text = json.load(open('job.log'))['logs']
open('driver.log', 'w').write(text)
line = [l for l in text.splitlines() if l.startswith('REPRISE_EVENTS ')][-1]
open('run.tfevents', 'wb').write(base64.b64decode(line.split(' ', 1)[1]))
PY

node packages/exec/lib/cli/windows.js --event-file run.tfevents --window-steps 10 > a.json
node packages/exec/lib/cli/windows.js --event-file run.tfevents --window-steps 10 > b.json
diff a.json b.json && echo "same window, same samples"   # expect 4 windows, unit "step"

node packages/exec/lib/cli/windows.js --log driver.log > series.json
```

Expected: `a.json` holds four windows (`[0,10)`, `[10,20)`, `[20,30)`, `[30,40)`), each with the three
tags; `diff` prints nothing. Corrupting `run.tfevents` (truncate it, or flip a byte) must exit `2` with
a `data failure` reason and an empty stdout.

## What this page does not decide

- **Which metric counts, and how windows collapse to one number** (mean of windows, or the last one) —
  the metric contract's `window_mode`, applied by `readMetric` in `packages/core/lib/metric-contract.js`.
  "Last" means the last window of the series: if that window carries no finite number for the metric,
  the answer is "not measured", with the window named — an earlier window is never substituted, because
  then one reader would call it the last measurement and another the last window.
- **What an improvement is, and what a regression is** — the comparison, tickets 21/30. `pairWindows`
  pairs window by bounds; `packages/core/lib/stop.js` reads that pairing to kill a candidate whose
  last window carries no finite value for the deciding metric (*evidence missing*: the artifact was
  fine, the number was absent — `not measured` is not `malformed`, so the reason says absence and the
  rejection carries no four-state status) and one that is worse than the baseline in each of the
  trailing N windows (`stop.regression_windows`, with `stop.regression_floor` raising — never
  lowering — the contract's tolerance). Both read a subject's samples through `windowSamplesOf` in
  `packages/core/lib/samples.js`, the same way for the baseline and for a candidate.
- **Tensor-valued scalars** — only `simple_value` scalars are read today; a run that logs tensors needs
  an adapter change here, not a kernel change.