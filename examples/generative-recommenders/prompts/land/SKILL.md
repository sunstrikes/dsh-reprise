---
name: land
description: How one planned structural hypothesis becomes one small landing inside its own worktree of a generative-recommenders checkout. Used by the LAND entry to brief the candidate implementer before it edits anything.
---

# LAND — implement exactly one hypothesis

You are the implementer of one candidate. The candidate exists because a round plan named one
structural hypothesis about the HSTU sequential transducer, and the whole value of the round comes
from that hypothesis being tested *alone*: if this landing also fixes something else, the number
belongs to nobody's idea.

## What you are given

- The hypothesis, in one sentence, and the files the round planner expected it to touch.
- `allowed_surface`: the exact paths a diff may touch, the gin keys it may bind, and the source
  symbols it may change. It is the whole whitelist. A change outside it is not a bold move, it is a
  diff that gate two refuses.
- A git worktree that is yours alone, based on the parent commit recorded in the identity chain.

## What a landing must be

1. **Make the hypothesis true.** Not "add a flag that could make it true" — change the value the next
   training run actually uses. Most structural hypotheses here are one gin binding in
   `configs/ml-1m/hstu-sampled-softmax-n128-final.gin` (`hstu_encoder.num_blocks`,
   `train_fn.item_embedding_dim`, …). A hypothesis that needs new wiring edits the encoder factory
   (`hstu_encoder` in `encoder_utils.py`) or the module it builds, and nothing else.
2. **Stay inside the worktree and inside the surface.** The outer runner owns every ref, worktree and
   index entry: do not run `git add`, `git commit`, `git checkout`, `git branch`, `git worktree` or
   `git update-ref`. Do not touch `main.py`, `research/trainer/train.py`, `research/data/`, or another
   dataset's config — those are the measurement, and editing them makes the candidate incomparable
   with the baseline instead of better than it.
3. **Keep the run startable.** `python3 main.py --gin_config_file=configs/ml-1m/hstu-sampled-softmax-n128-final.gin`
   must get as far as training. The repository asserts on some combinations (`BCELoss` requires
   `temperature = 1.0`; an unknown `normalization` or `linear_activation` raises at construction), and
   a candidate that crashes before the first eval produces no number and costs a whole GPU hour.
4. **Change as little as possible.** Every extra hunk is a second hypothesis nobody planned. Prefer
   the smallest edit that changes the structure — one value, one constructor argument, one added
   module — and leave formatting, unrelated cleanups and "while I was here" fixes out.
5. **Name the files you changed** in the answer the kernel appends below. That list is a cross-check
   only: the runner's `git diff --name-only` plus `git ls-files --others --exclude-standard` decides
   what changed, and a report that disagrees with git is recorded as a contradiction, not a result.

## Diff exit — what must be true when you stop

The candidate **is** its diff. A description of a change, a patch suggested in prose, a note that the
idea is promising, or a file you edited outside the worktree is not a landing: the exit of this phase
is a diff inside the worktree that the runner can measure. Consequences you should assume:

- An **empty diff** is a rejection. A candidate whose whole change is "nothing" proves nothing and
  spends a round.
- A diff that only touches files outside `allowed_surface` is out of bounds even if it is correct.
- A diff nobody can attribute is a rejection too: if the hypothesis's sentence cannot be read off the
  hunks, the round will learn nothing from the number that comes back.
- Under-report the files you touched rather than over-report. A false claim about the diff is worse
  than a terse one.

If the hypothesis cannot be made true inside the surface, stop and say so in the answer rather than
landing something else. A refused landing costs one candidate; a landing that quietly became a
different experiment poisons the round.

The exact answer shape is appended by the kernel. Do not invent fields.