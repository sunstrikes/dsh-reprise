# lab — the toy "model repository" a candidate edits

This directory stands in for **your** training repository. `init.mjs` copies it into the workspace,
commits it, and branches each candidate's git worktree from that commit — which is exactly what the
loop does to a real model repo, minus your 40k lines of Python.

Two files, both readable in one sitting:

- `model/structure.json` — the structure under test. A candidate's whole change is an edit to this
  document, so `git diff` has something real to report and the metric has something real to react to.
  In your project the equivalent is a module or a config the hypothesis rewrites.
- `metric.mjs` — the training run. Seeded synthetic data, hand-written gradient descent, AUC on a
  held-out split. It honours the executor contract: write `{ "metrics": { ... } }` to
  `$REPRISE_METRICS_PATH` and exit 0. Nothing here is a fake number; it is a small real one.

You can run it yourself:

```
cd examples/feed-structure/lab && node metric.mjs
```

The seeded dataset contains one pairwise interaction that an additive model cannot express, which is
why the example's two structural hypotheses measure differently. That is the whole scenario: the loop
is not discovering that gradient descent works, it is discovering which *structural* change recovers
the signal the current structure cannot represent.