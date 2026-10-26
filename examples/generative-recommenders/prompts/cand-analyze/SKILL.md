---
name: cand-analyze
description: Root-cause analysis of one finished candidate in the generative-recommenders domain, based on the metrics the monitor collected. Used once per candidate at CAND_ANALYZE; the kernel, not the model, computes the verdict and every number.
---

# CAND_ANALYZE — why did this candidate end where it did?

One candidate finished. Its metrics are frozen, its diff is closed, and it will never run again. You
are writing the sentence the next round will reason from — and, with equal weight, the sentence that
says *this was not worth learning from*.

## What you are given

- `observed`: the primary metric the contract names (HR@10), with the metric name, and `baseline`:
  the frozen value it is compared against.
- `reported_metrics`: everything the job's log yielded — HR@50, NDCG@50, MRR, the epoch the number
  came from, and how many epochs were full evals versus truncated.
- `verdict`: `improved` / `regressed` / `inconclusive`, already computed by the kernel's strict
  comparison. It is a fact in the artifact.
- The hypothesis and the review that admitted it.

## The numbers are not yours

Do **not** restate the metrics as if you had computed them, argue with the verdict, or return a score,
a confidence, a percentage improvement or a ranking — those are discarded, and a run that trusted them
would be a run whose conclusions came from a language model's arithmetic. Your one number-free job is
`root_cause`: the mechanism, in the language of the model structure.

The contract also declares a **minimum effective magnitude** (0.005 for HR@10, 0.004 for NDCG@10) and
a **guardrail** (NDCG@10). Read `metric_contract` in the facts for the numbers; do not compute them.
Two consequences for your prose: a difference smaller than that magnitude is not evidence either way,
even when the strict comparison calls it `improved`; and HR@10 up while NDCG@10 is down by more than
its magnitude is a re-ranking — one or two newly hit targets pushed other hits down the list — not a
better model. Say so in words when the facts show it.

## What a useful root cause says

- **Names a mechanism, not a metric.** "Eight blocks let the relative-attention bias reach the whole
  200-step history instead of collapsing onto the last few positions, so the target's co-occurrence
  pattern is actually represented" — not "HR@10 went up because capacity increased".
- **Speaks this repository's language.** The mechanisms available here are the ones the surface
  exposes: depth (blocks), head geometry (heads against per-head width at a fixed embedding width),
  the position signal (bucketed relative bias, learnable positional embedding), the pointwise
  nonlinearity, regularisation, and the geometry of the retrieval space (l2-normalised embeddings,
  output norm, temperature).
- **Is falsifiable.** Someone reading it knows what the next candidate should change and what result
  would prove the explanation wrong.
- **Distinguishes the three ways a run ends.** A worse number from a clean run is a real negative
  result; the same number from a broken run is no evidence at all; a submission that never trained is
  not a result. `reported_metrics` tells you which: a truncated-only eval, a single epoch, or an
  absent MRR are the shapes of a run that did not finish its schedule.
- **Admits ignorance when the evidence is thin.** "The change was within the contract's minimum
  effective magnitude, so the mechanism is unproven" is a useful lesson. A confident story about a
  0.004 delta is not.

## What loses the analysis

- Restating the metrics or the verdict instead of explaining them.
- Explaining a regression by its symptom ("it got worse because the loss was higher").
- A root cause that would be equally true of every candidate in the round, or that names no symbol of
  this model.
- Proposing the next hypothesis in detail — that is ROUND_PLAN's job, and duplicating it here creates
  two sources of truth for what to try next.

## Diff exit — what must be true when you stop

The number you are explaining came from exactly one thing: the candidate's diff. So the exit of this
analysis is a mechanism that the **diff can explain**. Name the file and the symbol whose change
produced the behaviour you are describing (the block stack, the bias module, the loss, the embedding
geometry). If no hunk in the diff can account for what the numbers did, then the cause is the pipeline
— a truncated eval, a run that stopped early, a data failure — and you must say that instead of
inventing a structural story. A lesson whose mechanism cannot be pointed at in the diff will not
survive the next round's review, and the round after that will re-run the same idea.

The exact answer shape is appended by the kernel. Do not invent fields.