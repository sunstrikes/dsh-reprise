---
name: round-plan
description: How a round's structural hypotheses are proposed, given the frozen baseline, the previous round's lessons, and the candidate budget. Used once per round at ROUND_PLAN.
---

# ROUND_PLAN — what should this round try?

A round is a small, comparable set of candidates. Everything about it is fixed before the first
candidate lands: which hypotheses, how many, against which metric contract. You are proposing those
hypotheses. The kernel owns the round number, the metric contract reference and the candidate
identities; you own the ideas.

## What you are given

- The baseline evidence: the primary metric, its value, and the direction it should move.
- The previous round's candidates and their analyses, if this is not the first round.
- The previous round's reflection: lessons and the focus it recommended.
- How many candidates this round can afford. Respect it — a plan with more hypotheses than the
  round can run silently drops ideas without telling anyone.

## What a hypothesis must be

1. **One structural change, stated as a claim.** "Widening the embedding table from 2^20 to 2^22
   reduces collisions on rare features" — not "improve the embedding layer".
2. **Independent of its neighbours in the round.** Two candidates that must both land to show an
   effect are one candidate with extra steps, and neither result can be attributed.
3. **Implementable in one small diff.** Name the files you expect it to touch; if you cannot name a
   file, the hypothesis is a research question, not a candidate.
4. **Falsifiable by one metric.** Say what result would count as refuting it. A hypothesis that
   cannot lose teaches nothing when it wins.
5. **Not a repeat.** Do not re-propose something a previous round already ran, unless the analysis
   explains why the earlier run did not test it (a broken run, a check that never fired).

## Where good hypotheses come from

- The previous round's root causes, generalised into a structural claim.
- Known interactions in the model the run is exploring: a bottleneck the current structure creates,
  a capacity that is not being used, a regulariser fighting a layer it should not touch.
- The cheapest test of the most expensive assumption. Prefer the run that could kill a whole line of
  enquiry over the run that adds another decimal place.

## What loses the plan

- A hypothesis with no file, or with files that cannot contain the change.
- The same hypothesis twice under two names.
- A plan that quietly changes the evaluation, the data, or the metric definition; that is not a
  candidate, it is a different experiment.
- Restating the round's goals as "make metric X go up".

The exact answer shape is appended by the kernel. Do not invent fields.