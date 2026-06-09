# PatchPilot

PatchPilot is an agent delivery control platform. It turns a simple request into a confirmed PRD, generated work item, agent run, test evidence, review summary, and acceptance decision.

## Quick Start

```bash
pnpm install
pnpm dev:team
```

- Web: http://localhost:3000
- API: http://localhost:4000/health
- Worker: no separate port; it polls the API and dispatches ready work items.

`pnpm dev` is an alias for `pnpm dev:team`.

The defaults are enough for local boot. Use `.env.example` as a template when you need to export overrides, for example `PATCHPILOT_RUNNER=simulated pnpm dev:team` or `PATCHPILOT_RUNNER=codex pnpm dev:team`.

## Local Processes

Run the full local platform:

```bash
pnpm dev:team
```

Run each process separately:

```bash
pnpm dev:api
pnpm dev:web
pnpm dev:worker
```

The worker process polls the API snapshot, claims ready work items for idle agents, and starts runs through the API. The API process owns the run queue and executes the selected simulated or Codex runner after `/api/work-items/:id/start`.

## Optional Middleware

The app does not need Docker to run. Use compose only when you want local middleware for future integrations or manual experiments:

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis minio
docker compose -f infra/docker-compose.yml ps
```

Compose provides Postgres, Redis, and MinIO with health checks. It does not containerize the API, web app, or worker; keep using the pnpm scripts above for those processes.

## What Works Now

- White-background Next.js workbench for simple requirement intake
- Grill-me style one-question-at-a-time clarification and generated PRD
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

Simulated runner environment:

```bash
PATCHPILOT_RUNNER=simulated
PATCHPILOT_SIMULATION_DELAY_FACTOR=1
```

Worker environment:

```bash
PATCHPILOT_API_BASE_URL=http://localhost:4000
PATCHPILOT_WORKER_INTERVAL_MS=5000
PATCHPILOT_WORKER_ONCE=false
```

Codex runner environment:

```bash
PATCHPILOT_RUNNER=codex
PATCHPILOT_WORKSPACE_ROOT=.patchpilot/worktrees
PATCHPILOT_TEST_COMMAND="pnpm -r --if-present test"
PATCHPILOT_CODEX_TIMEOUT_MS=600000
PATCHPILOT_TEST_TIMEOUT_MS=120000
PATCHPILOT_MAX_REPAIR_ATTEMPTS=1
PATCHPILOT_CODEX_SANDBOX=workspace-write
PATCHPILOT_CODEX_BYPASS=false
PATCHPILOT_PREVIEW_URL=http://localhost:3000
```

The Codex runner requires a working `codex` CLI, an authenticated local Codex session, and a git worktree-capable checkout. Codex runner variables are read by the API process; worker variables are read by the worker process.

The Codex runner does not auto-merge or publish. It creates an isolated worktree, writes `PATCHPILOT_TASK.md`, runs `codex exec`, runs the configured test command, optionally asks Codex for one repair pass, then returns evidence to the UI.

## Quality Gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When the API is running, the local end-to-end checks are:

```bash
pnpm e2e:team
pnpm e2e:smoke
```
