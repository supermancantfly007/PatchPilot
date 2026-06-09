# PatchPilot

PatchPilot is an agent delivery control platform. It turns a simple request into a confirmed PRD, generated work item, agent run, test evidence, review summary, and acceptance decision.

## Quick Start

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000/health

## What Works Now

- White-background Next.js workbench for simple requirement intake
- Three-question requirement confirmation and generated PRD
- Work item creation with scope, non-goals, acceptance criteria, and test suggestions
- Server-sent progress events for planning, developing, testing, review, and acceptance
- Local Codex runner in an isolated git worktree when `codex` and git are available
- Simulated runner fallback for demos and CI tests
- Test evidence, changed file list, risk summary, reviewer summary, and final acceptance
- JSON-backed local state for fast iteration

## Runner Modes

PatchPilot defaults to `PATCHPILOT_RUNNER=auto`.

- `auto`: use local Codex when the Codex CLI and git worktree are available; otherwise use simulated execution.
- `codex`: force real local Codex execution in `.patchpilot/worktrees/<runId>`.
- `simulated`: force the deterministic demo runner.

Useful environment variables:

```bash
PATCHPILOT_RUNNER=auto
PATCHPILOT_WORKSPACE_ROOT=.patchpilot/worktrees
PATCHPILOT_TEST_COMMAND="pnpm -r --if-present test"
PATCHPILOT_CODEX_TIMEOUT_MS=600000
PATCHPILOT_TEST_TIMEOUT_MS=120000
PATCHPILOT_MAX_REPAIR_ATTEMPTS=1
```

The Codex runner does not auto-merge or publish. It creates an isolated worktree, writes `PATCHPILOT_TASK.md`, runs `codex exec`, runs the configured test command, optionally asks Codex for one repair pass, then returns evidence to the UI.

## Quality Gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
