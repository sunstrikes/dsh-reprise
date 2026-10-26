# AGENTS.md

A model-structure exploration loop as a DeepSeek Harness plugin. Pointers only — each line names
the file that answers the question, so this page stays cheap enough to load on every turn.

| When you are | Read |
|---|---|
| running it, or wiring it into the host | [README.md](README.md) |
| unsure what a word means (fact, view, injection packet, candidate, frontier) | [CONTEXT.md](CONTEXT.md) |
| adding an executor or an artifact kind | [docs/extending.md](docs/extending.md) |
| turning a run's metrics into per-window samples, or comparing two runs window by window | [docs/windowed-samples.md](docs/windowed-samples.md) |
| reviewing a diff | [CODING_STANDARDS.md](CODING_STANDARDS.md) |

## Before claiming a ticket done

`npm test` runs `scripts/check.mjs` first, then the suite. Both must be green. The check exists
because the suite cannot see manifests, export targets, or modules no test imports — that gap let one
broken export survive five separate tickets.

## Shared files

`package.json` files and integrations are shared between everyone working in this repository. Change
them in the same commit as the code that needs them, and run the check before handing over — a
manifest that disagrees with the code is what `scripts/check.mjs` fails on.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.