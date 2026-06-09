# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before Exploring, Read These

- `CONTEXT.md` at the repo root
- ADRs under `docs/adr/` that touch the area being changed

If any of these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront.

## File Structure

This is a single-context repo:

```text
/
├── CONTEXT.md
├── docs/adr/
└── .scratch/
```

## Use The Glossary's Vocabulary

When output names a domain concept in an issue title, refactor proposal, bug hypothesis, test name, or PRD section, use the term as defined in `CONTEXT.md`.

If the concept needed is not in the glossary yet, either avoid inventing new vocabulary or note the gap for a future documentation pass.

## Flag ADR Conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it.

Example:

> Contradicts ADR-0002 (Temporal as workflow engine), but worth reopening because...
