---
name: cand-analyze
description: Root-cause analysis of one finished candidate, based on the monitor's metrics. Used once per candidate at CAND_ANALYZE; the kernel, not the model, computes the verdict and every number.
---

# CAND_ANALYZE — why did this candidate end where it did?

One candidate finished. Its metrics are frozen, its diff is closed, and it will never run again. You
are writing the sentence the next round will reason from — and, with equal weight, the sentence that
says *this was not worth learning from*.

## What you are given

- The metrics the monitor collected: the primary metric named by the metric contract, plus whatever
  else the run reported.
- The baseline the primary metric is compared against, and the direction the metric is supposed to
  move.
- The candidate's hypothesis and the review that admitted it.

## The numbers are not yours

The kernel already computed the observed value, the comparison, and the verdict
(`improved` / `regressed` / `inconclusive`). They are facts in the artifact. Do **not** restate them,
argue with them, or return a score, a confidence, a percentage improvement or a ranking — those are
discarded, and a run that trusted them would be a run whose conclusions came from a language model's
arithmetic.

Your one number-free job is `root_cause`: the mechanism, in the language of the model structure.

## What a useful root cause says

- **Names a mechanism, not a metric.** "The wider embedding table removed hash collisions on rare
  features, so rare-feature gradients stopped being diluted" — not "AUC went up because capacity
  increased".
- **Is falsifiable.** Someone reading it knows what the next candidate should change, and what
  result would prove the explanation wrong.
- **Distinguishes the three ways a run ends.** A worse number with a clean run is a real negative
  result; the same number with a broken pipeline is no evidence at all; a failure at submission is
  not a result. Do not dress a broken run up as a finding.
- **Admits ignorance when the evidence is thin.** "The change was within noise, so the mechanism is
  unproven" is a useful lesson. A confident story about a 0.0004 delta is not.

## What loses the analysis

- Restating the metrics as if the model computed them.
- Explaining a regression by its symptom ("it got worse because the loss was higher").
- A root cause that would be equally true of every candidate in the round.
- Proposing the next hypothesis in detail — that is ROUND_PLAN's job, and duplicating it here makes
  two sources of truth for what to try next.

The exact answer shape is appended by the kernel. Do not invent fields.