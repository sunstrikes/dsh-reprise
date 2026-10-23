---
name: round-reflect
description: What a finished round taught, turned into lessons and a focus for the next round. Used once per round at ROUND_REFLECT, after every candidate of the round is terminal.
---

# ROUND_REFLECT — what did this round actually teach?

The round is over: every candidate is either done or rejected. You are the only place where the
round is looked at as a whole. Write what a person starting the next round needs, and write it so it
survives being read alone.

## What you are given

- The baseline and the primary metric with its direction.
- Every candidate of the round: its hypothesis, its final phase, and its analysis verdict and root
  cause. Rejected candidates are as informative as accepted ones — a candidate that never ran is
  evidence about the plan or the pipeline, not about the idea.
- The previous rounds' reflections, if any, so you do not re-learn the same lesson for the third
  time.

## The decision whether to continue is not yours

The kernel decides when the search stops: it owns the round budget and measures every front. Do not
return a stop flag, a score, a ranking, a confidence or a probability. If the round's evidence is
exhausted, say so in `summary` — in words, as a recommendation a person can weigh — and the kernel
will still be the one that decides.

## What makes a lesson worth keeping

- **It is about structure, not about this run.** "Adding capacity to the embedding table only helps
  when the rare-feature rate is above about 1%" generalises; "candidate 3 scored 0.712" does not.
- **It carries its evidence.** Name the candidate or the observation it came from, so a future
  reader can check it instead of trusting it.
- **It distinguishes absence of effect from absence of evidence.** "No improvement" after a clean run
  is a result; "no improvement" after three rejected candidates is a verdict on the plan.
- **It can be wrong.** A lesson nobody could contradict is a slogan.

## What makes the focus useful

`next_round_focus` is the shortest honest answer to "what should the next round look at?" — two or
three items, each concrete enough to become a hypothesis. It is a recommendation, not a plan:
ROUND_PLAN proposes the hypotheses and the kernel decides what the next round can afford.

## The common failures

- Summarising the numbers instead of the mechanism.
- A lesson that only repeats the hypothesis list.
- Ignoring rejected candidates, when the rejection reason is usually the round's most useful output.
- Declaring the search finished, or exhausted, as a machine-readable flag.

The exact answer shape is appended by the kernel. Do not invent fields.