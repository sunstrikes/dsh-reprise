# examples/generative-recommenders — a domain pack for a repository nobody here wrote

A complete, copyable pack for **the HSTU sequential transducer in
[meta-recsys/generative-recommenders](https://github.com/meta-recsys/generative-recommenders)**: what
"better" means on that repository, which knobs a structural hypothesis may move, what is already known
about them and where each claim came from, how a candidate is measured, and the five prompts each
model call is given.

It is **data and markdown only** — the kernel does not change for it. The one piece of code is
`run-metrics.py`, the job's own metric reader: `main.py` writes no metrics file, so one has to turn its
log into the number the contract names.

```
domain.json             the manifest: this directory is a pack, and these are its five parts
metric-contract.json    hr@10 primary / ndcg@10 guardrail, their tolerances, and the eval window
priors.json             the search space, the cited priors, the hypothesis classes, the anti-patterns
surface.json            the adjustable-surface whitelist (paths, gin keys, symbols) and the forbidden map
prompts/                the five call-site prompts, each ending in the diff exit convention
executor.json           how this domain is measured: `main.py` through run-metrics.py, in the worktree
run-metrics.py          the glue: run training, read the log, report the last full eval epoch
```

Unlike `examples/feed-structure`, this pack does **not** ship the model it points at: the domain
repository is a 7 MB clone of someone else's project, and `surface.files` / `surface.verified` name
paths inside *that* checkout, not inside this directory. `packages/core/test/generative-recommenders-pack.test.js`
re-checks every whitelisted key and symbol against a checkout when one is present
(`REPRISE_DOMAIN_REPO`, default `~/.reprise-lab/generative-recommenders`), and checks that each entry
at least records the file and evidence string that would prove it when one is not.

## What it says, in one paragraph each

**The metric.** HR@10 is primary: did the single held-out target appear in the top ten. NDCG@10 is the
guardrail: the same hit, weighted by rank, so a change that only reorders the list shows up there and
not in HR@10. Both are higher-better. The minimum effective magnitude is **0.005 HR@10** and **0.004
NDCG@10** — one quarter of the only structural gap this repository publishes end to end (HSTU →
HSTU-large on ML-1M: +0.0197 HR@10, +0.0173 NDCG@10), rounded to 1e-3. The number comes from **the last
epoch whose eval was not truncated**, because `train.py` truncates an epoch's eval to
`partial_eval_num_iters` batches unless `full_eval_every_n` divides it, and a truncated number is
measured on a different, shuffled subset.

**The surface.** The ML-1M gin config, the HSTU module and the five modules around it
(`encoder_utils.py`, `embedding_modules.py`, the two pre/post-processors, `autoregressive_losses.py`,
`losses/sampled_softmax.py`), 17 gin keys and 14 source symbols — each recorded with the file and the
exact evidence string that proves it exists. Out of bounds, with the reason written down per path and
per key: `main.py`, `research/trainer/train.py`, `research/data/*`, the other datasets' configs, and
every measurement knob (eval cadence, truncation, batch sizes), every benchmark change (dataset,
sequence length, negatives), and optimizer retuning.

**The priors.** Nine cited claims, each with `file` + `section` + the quoted numbers: the HSTU-vs-SASRec
gap on all three public datasets, the depth-for-width structure of the published large variants, the
gaps that calibrate the tolerances, the absence of any single-knob ablation in the repository, the
definitional relationship between HR@k and NDCG@k, the sampled-negatives caveat, the truncation rule,
the 24 GB sizing, and one claim the **paper** makes that this clone cannot verify. Seven hypothesis
classes, six constraints and six anti-patterns follow.

**The prompts.** Five, rewritten for this repository: what a landing must be and what an empty diff
means, what makes a review reject an out-of-bounds or goalpost-moving diff, what a mechanism has to
name, what a hypothesis must say about its class and its file, and what a lesson has to survive. Every
one of them ends in a **diff exit** section — the change has to land as a diff inside the surface, or
it is not a candidate.

## Running it

Point a run at this directory and at a checkout of the domain repository:

```json
{
  "domain": "examples/generative-recommenders",
  "workspace": ".workspace/gr",
  "runner": { "repo": "/path/to/generative-recommenders", "base_ref": "HEAD", "dir": "worktrees" }
}
```

Two things have to be true in that checkout before a job can report a number:

1. **`run-metrics.py` sits at its root.** The executor's `cwd` is the candidate worktree, so the reader
   has to be inside the tree — copy it from this pack, or commit it to your fork. Nothing else in the
   pack needs to reach into the worktree.
2. **The dataset is already prepared inside the job package.** `preprocess_public_data.py` downloads the
   raw archive (`urlretrieve`), and the training nodes have no internet and no shared filesystem, so
   `tmp/ml-1m/sasrec_format.csv` has to be produced once on a networked machine and shipped with the
   job. A missing dataset fails as a `data` failure, never as a number.

Then, on a machine with a GPU: `python3 main.py --gin_config_file=configs/ml-1m/hstu-sampled-softmax-n128-final.gin`.
Each job takes the whole of ML-1M on one card (the README asks for ≥24 GB of HBM), so the ledger's
per-candidate GPU-hour reservation is the real limit on a round.

## What is verified, and what is not

| Claim | Status |
|---|---|
| The pack loads through the real loader, and its parts agree with each other | tested (`packages/core/test/generative-recommenders-pack.test.js`) |
| Every whitelisted gin key / symbol exists in the checkout | tested against `REPRISE_DOMAIN_REPO` when present; the file + evidence string is required either way |
| The metric reader picks the last **full** eval epoch | tested against `packages/core/test/fixtures/generative-recommenders/train-log.txt` |
| All five prompts are non-empty and carry the diff exit convention | tested |
| A malformed tolerance / guardrail is refused at boot | tested (loader rule added with this pack) |
| `main.py` actually trains ML-1M on the cluster and reports HR@10 ≈ 0.31 | **not run here.** No GPU in this repository; the reader has only been exercised on the recorded log |
| The published numbers are reproduced end to end | **not run here.** They are quoted from the upstream README, not re-measured |

## Human review: what a person must check before this pack is trusted

The ticket asks for a human pass over the priors and the whitelist. These are the questions that pass
should answer; none of them can be settled by a test.

**Metric contract** (`metric-contract.json`)

1. Is HR@10 the right primary for the question being asked, or is NDCG@10 (the paper's headline in
   some tables) the one to optimise? Both are published, so the choice is about attribution, not
   availability.
2. Is a quarter of the published structural gap the right "worth a round" threshold — or should it be
   a half (fewer, cheaper rounds) or an eighth (more, noisier ones)? The number is a judgement; the
   derivation is written out in the file so it can be re-derived for another dataset.
3. Is `ndcg@10` acceptable as a guardrail given that the kernel does **not** consume it yet — today it
   is recorded and read by a human, not enforced by a gate?

**Priors** (`priors.json`)

4. Every prior but one cites `README.md` §section or a config/source file, with the numbers quoted.
   Open each and confirm the quote. The one that cannot be checked here is the **paper's ablation** of
   silu / rel_bias / relative attention bias, marked `unverified-in-this-clone`: it needs
   arXiv:2402.17152 (§4 and its tables) before a round may claim "changing this is neutral".
5. Are the seven hypothesis classes the right cut of the space — anything important missing
   (e.g. item-feature preprocessing), anything that should not be explored at all?
6. Are the six anti-patterns the ones that actually cost time on this repository, and are the six
   constraints (BCELoss temperature, single-valued `linear_config`, unknown-value crashes, the
   offline dataset rule) complete?

**Surface** (`surface.json`)

7. Is `research/trainer/train.py` correctly forbidden? It is the training loop and the eval cadence, so
   it protects the measurement — but it also means no hypothesis may add a new `train_fn` argument.
8. Is `train_fn.weight_decay` really structural, or is it optimizer tuning that belongs with
   `learning_rate` in the forbidden list?
9. Is excluding `train_fn.main_module` (the SASRec/HSTU family switch) right? The README's biggest
   published comparison is exactly that switch; the pack excludes it because it redefines the baseline.
10. Is `train_fn.max_sequence_length` correctly forbidden as a benchmark change, given the repository
    publishes an `ml-3b`/`seqlen500` pair?
11. Are the 17 gin keys and 14 symbols the right size of surface? Too wide and a diff cannot be
    attributed; too narrow and the hypotheses worth testing are out of bounds.
12. Is `tmp/ml-1m/sasrec_format.csv` the correct prepared artifact to require in the package (rather
    than the raw archive, or `tmp/processed/ml-1m/`)? `run-metrics.py` and the loader are agnostic;
    the packaging ticket is not.