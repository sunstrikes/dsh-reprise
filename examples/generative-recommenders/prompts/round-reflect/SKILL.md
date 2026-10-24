---
name: round-reflect
description: What a finished round on the generative-recommenders structure taught, turned into lessons and a focus for the next round. Used once per round at ROUND_REFLECT, after every candidate of the round is terminal.
---

# ROUND_REFLECT — what did this round actually teach?

The round is over: every candidate is either done or rejected. You are the only place where the round
is looked at as a whole. Write what a person starting the next round needs, and write it so it
survives being read alone.

## What you are given

- The baseline and the metric contract: HR@10 as the primary (higher is better), NDCG@10 as the
  guardrail, and the minimum effective magnitude the contract declares.
- Every candidate of the round: its hypothesis, its final phase, its analysis verdict and root cause,
  and — for rejected candidates — the phase and gate that rejected it.
- The previous rounds' reflections, so you do not re-learn the same lesson for the third time.

## The decision whether to continue is not yours

The kernel decides when the search stops: it owns the round budget and measures every front. Do not
return a stop flag, a score, a ranking, a confidence or a probability. If the round's evidence is
exhausted, say so in `summary` — in words, as a recommendation a person can weigh — and the kernel
will still be the one that decides.

## What makes a lesson worth keeping

- **It is about this model's structure, not about this run.** "Halving the per-head width to double
  the number of heads at constant embedding width costs about as much as it gains on ML-1M"
  generalises; "candidate r1-h2 scored 0.3120" does not.
- **It carries its evidence.** Name the candidate or the observation it came from, so a future reader
  can check it instead of trusting it.
- **It distinguishes absence of effect from absence of evidence.** "No improvement" after a clean run
  with a full eval is a result; "no improvement" after three rejected candidates is a verdict on the
  plan or on the surface, not on the idea.
- **It respects the measurement's limits.** A delta below the contract's minimum effective magnitude
  is not a lesson about the structure. A number that came from a truncated eval, or from a run that
  stopped after one epoch, is not a number to learn from at all — say that, and say which round member
  produced it.
- **It can be wrong.** A lesson nobody could contradict is a slogan.

## What makes the focus useful

`next_round_focus` is the shortest honest answer to "what should the next round look at?" — two or
three items, each concrete enough to become a hypothesis with a whitelisted file, a gin key and a
falsifiable expectation. It is a recommendation, not a plan: ROUND_PLAN proposes the hypotheses and
the kernel decides what the next round can afford. Focus items that need a file outside the adjustable
surface are not action items; they are notes for a human.

## The common failures

- Summarising the numbers instead of the mechanism.
- A lesson that only repeats the hypothesis list.
- Ignoring rejected candidates, when the rejection reason (an out-of-bounds path, an unbound gin key,
  a crash at construction) is usually the round's most useful output — it says what the surface will
  not let anyone learn.
- Treating a re-ranking (HR@10 up, NDCG@10 down) as a win, or a within-noise delta as a discovery.
- Declaring the search finished, or exhausted, as a machine-readable flag.

## Diff exit — what must be true when you stop

Every candidate in this round was a diff, and the round's lessons are lessons *about diffs*. Before a
lesson goes into the answer, apply the exit test: could a diff inside the adjustable surface have
produced the effect it claims? If the answer is no — the effect came from the loader, the schedule, the
log window, or a candidate that never ran — then the lesson is about the pipeline and must be written
as one. A lesson the next round cannot act on as a diff is a note for a human, which is fine, but it
must not be dressed as a structural finding: the round after next will re-propose it and learn the same
nothing.

The exact answer shape is appended by the kernel. Do not invent fields.