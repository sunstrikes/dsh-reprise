# CODING_STANDARDS.md

Read during review, not implementation. Three rules, all judgement calls: a machine can flag a
manifest that disagrees with its imports (and `scripts/check.mjs` does), but it cannot tell whether a
change kept faith with the plan. Each rule below earned its place by being broken in this repository
first.

## 1. The spec is the judge, not the draft

When the code and the spec disagree, change the code, or stop and ask. Editing the spec so the code
becomes correct moves the goalposts: the diff then passes review against a document that was rewritten
to flatter it, and the next reader inherits a decision nobody made.

Legitimate spec edits exist and are welcome: a fact discovered while building it that the spec could
not have known. They say so in the commit — "the spec was wrong about X, because Y" — and they are
reviewed as decisions rather than slipped in beside the code.

**How to spot it while reviewing:** a spec or ticket hunk in the same diff as the code it justifies,
where the hunk's effect is to make previously wrong code right.

## 2. The four states describe the facts, not the mood

`ok` / `missing` / `invalid` / `conflict` answer "is this fact present and trustworthy", not "did we
get good news". A candidate that legitimately failed its checks, a job the platform lost, a budget
that ran out — none of these is `invalid`. `invalid` means an artifact exists and breaks its schema.

Merging "the answer was no" into `invalid` sends the next reader hunting for a malformed artifact that
never existed, and it destroys the only distinction the contract exists to protect. When the news is
bad but nothing is malformed, reject with a message and no four-state status at all.

**How to spot it while reviewing:** a `status:` field attached to a rejection whose cause is a failed
comparison, an absent job, or an exhausted limit rather than a schema violation.

## 3. An acceptance criterion holds on the surface it names

If a criterion says the interface must show something, then the interface showing it is the
criterion — a value sitting in a JSON payload is not. Same for "the operator can see it" (a log line
counts; a field nobody renders does not) and "the dump explains why" (the rendered text counts; the
data it could have been rendered from does not).

This rule exists because a warning that nobody draws reads as done in every test that only inspects
the payload.

**How to spot it while reviewing:** a test asserting on data, for a criterion phrased in terms of what
a person sees.