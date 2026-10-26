# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the vocabulary already in active use here (fact, view,
  injection packet, candidate, frontier).
- **`GLOSSARY.md`** at the repo root, once it exists.
- **`docs/adr/`** — read the ADRs that touch the area you're about to work in.

This is a **single-context** repo: one glossary and one ADR directory for the whole codebase. The
packages under `packages/*` are a technical decomposition, not separate domains, so they get no
glossary of their own.

If `GLOSSARY.md` doesn't exist yet, **proceed silently** — don't flag its absence, and don't suggest
creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates it lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md      ← vocabulary in active use (exists today)
├── GLOSSARY.md     ← created lazily by /domain-modeling
├── docs/
│   ├── adr/
│   │   └── 0001-acceptance-is-a-reproduced-public-experiment.md
│   └── agents/     ← this directory
└── packages/
    ├── contract/
    ├── core/
    ├── exec/
    ├── exec-python/
    ├── memory/
    └── ui/
```

Package code lives in `packages/<name>/lib`, not `src/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly
avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (acceptance is a reproduced public experiment), but worth reopening because…_