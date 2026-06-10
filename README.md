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

PatchPilot also reads `.patchpilot/config.yaml` from the repo root. Environment variables still override config file values, and missing config values fall back to the same local defaults:

```yaml
setup:
  commands:
    - pnpm install
test:
  command: pnpm test
  timeoutMs: 120000
  maxRepairAttempts: 1
smoke:
  command: pnpm e2e:smoke
  previewUrl: http://localhost:3000
e2e:
  command: pnpm e2e:team && pnpm e2e:bug && pnpm e2e:smoke
  baseUrl: http://localhost:3000
dev:
  runner: auto
  workspaceRoot: .patchpilot/worktrees
  previewUrl: http://localhost:3000
  simulationDelayFactor: 1
security:
  codexSandbox: workspace-write
  codexBypass: false
budget:
  codexTimeoutMs: 600000
  maxCostUsd: 0
  prdUsd: 0
  workItemUsd: 0
  runUsd: 0
  softThresholdRatio: 0.8
```

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

## Local CLI

The CLI can operate the happy path without the Web UI as long as the API is running:

```bash
pnpm cli -- submit --input "Ship a CLI-controlled agent workflow" --template feature
pnpm cli -- snapshot
pnpm cli -- happy-path --input "Ship a CLI-controlled agent workflow" --runner simulated --out report.md
```

Supported operations include requirement submission, PRD creation and approval, snapshot inspection, team start, one worker dispatch tick, PRD acceptance, and Markdown report export:

```bash
pnpm cli -- create-prd --requirement <requirement-id>
pnpm cli -- approve-prd --prd <prd-id>
pnpm cli -- start-team --prd <prd-id> --runner simulated
pnpm cli -- worker-once --runner simulated
pnpm cli -- accept-prd --prd <prd-id> --status accepted
pnpm cli -- report --prd <prd-id> --out report.md
```

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
- TestCase records generated from approved work items, linked back to TestRun evidence
- Draft and approved interface contracts for HTTP APIs, AgentRun events, and shared delivery state
- Server-sent progress events for planning, developing, testing, review, and acceptance
- Local Codex runner in an isolated git worktree when `codex` and git are available
- Simulated runner fallback for demos and CI tests
- WorkspaceRun, TestCase, TestRun, local PullRequest, ReviewRecord, AuditEvent evidence records plus changed file list, risk summary, reviewer summary, and final acceptance
- Rejected acceptance requeues the same work items as a new rework round, preserves the rejection reason, and creates fresh agent runs on the next team start
- Bug reports that first go to the test agent for reproduction, then create a backend fix task for the developer agent
- Failed agent runs are classified as transient, deterministic, test_failed, policy_denied, budget_exhausted, or environment_failed; failed TestRun evidence can be stored as a reported Defect linked to the run, work item, test run, and commit
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
PATCHPILOT_SIMULATED_FAILURE_TYPE=test_failed # optional, for failure/defect E2E fixtures
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

The Codex runner does not auto-merge or publish. It creates an isolated worktree, writes `PATCHPILOT_TASK.md`, runs `codex exec`, delegates the configured test command to `@patchpilot/testing`, optionally asks Codex for one repair pass, then returns evidence to the UI. TestRun evidence includes the command, workspace, runner/environment, timestamps, exit code, failure summary, log artifact id, retry count, and flaky signal.

Codex prompts are intentionally short. PatchPilot sends the task title, task file path, required skill (`/tdd` or `/diagnose`), and safety boundary; detailed context lives in `PATCHPILOT_TASK.md`, `AGENTS.md`, and the repo tests.

## Quality Gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:check
pnpm events:check
```

When the API is running, the local end-to-end checks are:

```bash
pnpm e2e:team
pnpm e2e:bug
pnpm e2e:smoke
pnpm e2e:cli
pnpm e2e:budget
```
