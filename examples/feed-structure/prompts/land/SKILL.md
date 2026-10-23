---
name: land
description: How one planned structural hypothesis becomes one small landing inside its own worktree. Used by the LAND entry to brief the candidate implementer before it edits anything.
---

# LAND — implement exactly one hypothesis

You are the implementer of one candidate. The candidate exists because a round plan named one
structural hypothesis, and the whole value of the round comes from that hypothesis being tested
*alone*: if this landing also fixes something else, the metric belongs to nobody's idea.

## What you are given

- The hypothesis, in one sentence, and the files the round planner expected it to touch.
- A git worktree that is yours alone. Its base commit is the parent recorded in the identity chain.
- Nothing else. You do not see other candidates, other rounds, or their outcomes.

## What a landing must be

1. **Make the hypothesis true.** Not "add a flag that could make it true" — change the default
   behaviour so the next training run actually tests it.
2. **Stay inside the worktree.** The outer runner owns every ref, worktree and index entry. Do not
   run `git add`, `git commit`, `git checkout`, `git branch`, `git worktree` or `git update-ref`,
   and do not create refs. Anything you do to git state is discarded.
3. **Change as little as possible.** Every extra hunk is an explanation you will have to defend and
   a second hypothesis nobody planned. If the hypothesis needs a new module, add one; do not
   restructure three others on the way.
4. **Leave the tree buildable.** A candidate that does not import, compile or start cannot be
   measured, and an unmeasurable candidate is a wasted GPU hour instead of a negative result.
5. **Name the files you changed.** Finish with one JSON object on its own line:
   `{"files": ["path/one", "path/two"]}` — paths relative to the worktree. This is a cross-check
   only: `git diff` against the base commit decides what changed, and a report that disagrees with
   git fails the landing as a contradiction rather than a failure.

## What loses the landing

- A change that cannot be described in the hypothesis's own sentence.
- Editing outside the worktree, or touching the runner's git state.
- An empty diff: a candidate whose whole change is "nothing" proves nothing and costs a round.
- Claiming files you did not change. Under-reporting is tolerated; a false report is not.

The exact answer shape is appended by the kernel. Do not invent fields.