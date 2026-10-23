# @dsh-reprise/contract

The contract, and nothing else. No state machine, no executor, no storage. That boundary is the
point: a validator tangled up with the scheduler can never tell you whether it is enforcing the
contract or the scheduler's habits.

## The four states

| state | meaning | what recovery does |
|---|---|---|
| `ok` | the fact is present and self-consistent | continue |
| `missing` | a required fact was never produced | regenerate, or fail closed |
| `invalid` | an artifact exists but breaks its schema | reject; do not guess |
| `conflict` | two facts that must agree do not | re-derive, or ask a human |

They are not severities of one boolean. `conflict` and `invalid` must never be merged — one is the
fact plane disagreeing with itself, the other is a malformed artifact. Precedence is fixed at
**missing → invalid → conflict**, because you cannot judge agreement before you know everything
exists, and you cannot call two things contradictory when one is malformed.

## Adding an artifact kind

A kind is a `check()` returning three message lists plus fixtures. Nothing in the kernel changes.

```js
defineArtifact({
  kind: 'my_artifact',
  schemaVersion: 1,
  check(value) {
    const findings = { missing: [], invalid: [], conflict: [] }
    checkField(findings, value, 'candidate_id', isNonEmptyString, 'must be a non-empty string')
    // ... shape into invalid, internal disagreement into conflict
    return findings
  },
})
```

Then add `fixtures/my_artifact/cases.json` with at least one case per state. **The fixtures are the
contract's authority** — this file describes intent, the fixtures decide. `test/artifacts.test.js`
walks every registered kind and fails if a kind has no fixtures or does not cover all four states.

## Two things that are easy to get wrong

`isPast` vs `isBeyond`. A phase asking "what must already exist for me to run?" must use
`isBeyond` (strict). With the inclusive comparison, `VERIFY` demands the `verify_gate` that
`VERIFY` is about to create and every candidate dies on its first tick.

`isMilliseconds` is an *epoch* check, not just an integer check: nanoseconds overflow
`Number.MAX_SAFE_INTEGER` and blow up `node:sqlite`, and seconds silently put every timestamp in
1970. Durations are not timestamps — name them `*_seconds` and validate them as such.