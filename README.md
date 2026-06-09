# PatchPilot

PatchPilot is an agent delivery control platform prototype. The MVP turns a simple request into a confirmed requirement, generated work items, an agent run, test evidence, and an acceptance decision.

## Quick Start

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000/health

## Current Scope

- White-background simple user experience
- Requirement intake with templates
- Automatic PRD/work item generation
- Simulated agent run with progress events, tests, review, and acceptance
- File-backed local state for fast development

Real Codex execution, Temporal, Postgres, and GitHub PR creation are planned behind the same domain interfaces.
