# Acceptance is a reproduced public experiment, not a business replacement

This repository was extracted from a Python monolith that runs an internal feed-model structure
search, and the reason it exists is to replace that monolith. The acceptance we settled on is
neither "feature parity with the predecessor" nor "shippable open source", but: **the loop must drive
a foreign public repository to a result an outsider can check** — `meta-recsys/generative-recommenders`,
reproducing its published HSTU numbers on MovieLens-1M (HR@10 0.3097 within ±3%, with NDCG@10 as
corroboration), with the baseline measured by us rather than quoted, plus at least one genuine
structural exploration landing through LAND and VERIFY.

## Considered options

- **Behavioural parity with the predecessor.** Rejected: unbounded. The predecessor's own decision
  records carry dead gates, dead fields and one acknowledged bug; matching it behaviour for behaviour
  would import them. Its domain half (priors, tunable surface, cost objective, structural diff) is
  bound to a private model that this repository cannot run.
- **Shippability — a stranger clones and sees a metric.** Rejected as *the* criterion: the five-minute
  path already demonstrates it, and it says nothing about whether the loop survives a real job.
- **Mechanism replacement on a public experiment.** Chosen. It has an external source of truth, it
  costs real GPU time, and it can be checked by someone who has never seen either repository.

## Consequences

- The domain half of the predecessor does not migrate. Domain material (metric contract, priors,
  tunable surface, the five prompts) is written for generative-recommenders and lives in a domain
  pack; the kernel stays ignorant of any domain, because a second one (the internal model) is planned.
- The numbers that judge a run are the ones **we** measured. Published numbers are a cross-check that
  never enters the fact plane — a fact is something this system observed.
- A candidate's code reaches the cluster as an archive carried by the job; only the dataset is staged
  on shared storage. This is the one place where "candidate" and "job" are coupled by transport.
- This is a **mechanism** claim, not a business claim: nothing here says the loop is as good at the
  internal model's problem, only that the machinery works on a problem with a public answer.