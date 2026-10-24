---
name: round-plan
description: How a round's structural hypotheses about the HSTU transducer are proposed, given the frozen baseline, the previous round's lessons and the candidate budget. Used once per round at ROUND_PLAN.
---

# ROUND_PLAN — what should this round try?

A round is a small, comparable set of candidates. Everything about it is fixed before the first
candidate lands: which hypotheses, how many, against which metric contract. You are proposing those
hypotheses. The kernel owns the round number, the metric contract reference and the candidate
identities; you own the ideas.

## What you are given

- The baseline: HR@10 (the primary, higher is better), its frozen value from the metric contract,
  and the guardrail NDCG@10.
- `candidates_per_round`: how many candidates this round can afford. Respect it — a plan with more
  hypotheses than the round can run silently drops ideas without telling anyone, and the kernel
  refuses the whole plan rather than truncating it.
- The previous rounds' candidates, their verdicts and root causes, and the last reflection — if this
  is not the first round.
- The injection packet: the search space (which gin keys may move, and to which values), the declared
  hypothesis classes, the forbidden directions and the known anti-patterns.

## What a hypothesis must be

1. **One structural change, stated as a claim.** "Eight blocks, with the per-head width halved to keep
   the attention width at 50, let the relative bias reach the full 200-step history" — not "improve
   the encoder".
2. **Its class named in the sentence.** There is no field for the class: the reviewer reads the
   statement. Use a declared class — capacity, attention-geometry, position-signal, nonlinearity,
   regularisation, output-geometry, training-objective — and say which mechanism it is about, so a
   reviewer can check the claim against that class instead of guessing.
3. **Implementable as one diff inside the surface.** `expected_files` must be paths from
   `allowed_surface` (usually the ML-1M config, sometimes one encoder module). If you cannot name a
   file, the idea is a research question, not a candidate.
4. **Independent of its neighbours.** Two candidates that must both land to show an effect are one
   candidate with extra steps, and neither result can be attributed.
5. **Falsifiable by HR@10 at the contract's minimum effective magnitude.** Say what result would
   refute it. "HR@10 moves by less than 0.005" is a refutation, not a disappointment.
6. **Not a repeat.** Do not re-propose what a previous round already ran unless the analysis explains
   why that run did not test it (a broken run, a truncated eval, a change that never took effect).

## Where good hypotheses come from, in this repository

- **The published structural comparison.** HSTU → HSTU-large is the one change the README measures
  end to end: blocks 2→8, heads 1→2, per-head width 50→25 at a fixed embedding width of 50, worth
  +0.0197 HR@10 on ML-1M. Hypotheses that move *within* that axis (depth against head geometry at
  constant width) are the cheapest extrapolations the evidence supports.
- **The unmeasured knobs.** Nothing in this repository ablates the pointwise nonlinearity, the
  relative-attention-bias choice, the U·A concatenation, the output normalisation or dropout, because
  every published config keeps the defaults. A well-argued single-knob test there is genuine
  exploration and a negative result is worth as much as a positive one.
- **The previous round's root causes**, generalised into a structural claim about this model.
- **The cheapest test of the most expensive assumption.** Prefer the candidate that could kill a whole
  line of enquiry over the one that adds another decimal place.

## What loses the plan

- A hypothesis with no file, or with files that cannot contain the change (a knob the config never
  binds and the surface does not allow binding).
- A hypothesis that is really a benchmark change: another dataset, another sequence length, another
  negatives count, a moved eval cadence. The kernel refuses those keys, and the round must not spend
  a slot discovering that.
- The same hypothesis twice under two names, or one hypothesis split into two candidates.
- A plan whose candidates all move the same knob in the same direction: a sweep is not a round, and
  three points on one axis teach less than two independent axes.
- Restating the round's goal as "make HR@10 go up".

## Diff exit — what must be true when you stop

A hypothesis is only a candidate if it can **land as a diff**. Before you write one down, check the
exit: which whitelisted file would change, which gin key or symbol inside it, and what the hunk would
look like. If the answer is "it depends", "a new training loop", or "somewhere in the data pipeline",
it is not a candidate — it is a research question, and proposing it spends a GPU hour to answer
nothing. Every hypothesis you return must therefore name `expected_files` that the adjustable surface
permits; a hypothesis whose expected files fall outside it is out of bounds before it is even landed.

The exact answer shape is appended by the kernel. Do not invent fields.