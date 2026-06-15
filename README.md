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

The defaults are enough for local boot once the Codex CLI is installed and the target repository is a git workspace. Use `.env.example` as a template when you need to export overrides, for example `PATCHPILOT_RUNNER=codex pnpm dev:team`.

Product state is stored through `@patchpilot/db`. By default the API uses a file-backed PGlite database under `PATCHPILOT_DATA_DIR` so local boot still does not require Docker. Set `PATCHPILOT_DATABASE_URL` to use a real Postgres database. `patchpilot-store.json` is retained as a legacy JSON import/export fixture, not as the runtime source of truth.

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
  repositoryRoot: .
  workspaceRoot: .patchpilot/worktrees
  previewUrl: http://localhost:3000
pi:
  command: pi
  provider: ""
  model: ""
  thinking: ""
  stateRoot: .patchpilot/runner-state
  timeoutMs: 600000
  skipVersionCheck: true
  disableTelemetry: true
  offline: false
security:
  codexSandbox: workspace-write
  codexBypass: false
  containerSandbox:
    enabled: false
    runtime: auto
    image: node:24-alpine
    cpus: 2
    memoryMb: 4096
    workspaceDiskMb: 8192
    tmpfsMb: 256
    pidsLimit: 512
  egressPolicy:
    enabled: true
    allowedHosts:
      - github.com
      - api.github.com
      - codeload.github.com
      - objects.githubusercontent.com
      - raw.githubusercontent.com
      - github-releases.githubusercontent.com
      - npm.pkg.github.com
      - registry.npmjs.org
      - registry.yarnpkg.com
      - pypi.org
      - files.pythonhosted.org
      - rubygems.org
      - crates.io
      - index.crates.io
      - static.crates.io
      - proxy.golang.org
      - sum.golang.org
      - api.openai.com
      - auth.openai.com
      - chatgpt.com
      - "*.openai.com"
      - "*.oaistatic.com"
    allowGitRemotes: true
    proxyImage: node:24-alpine
    proxyPort: 3128
    auditLogPath: .patchpilot/egress-audit.jsonl # logical fallback for non-sandbox proxy tests; sandbox runs use a private sidecar-only host log
  secretBroker:
    enabled: true
    allowedSecrets: [] # default: no secrets injected; use secret:<id> work item capabilities for explicit grants
budget:
  codexTimeoutMs: 600000
  maxCostUsd: 0
  prdUsd: 0
  workItemUsd: 0
  runUsd: 0
  softThresholdRatio: 0.8
artifacts:
  provider: local_fs
  localRoot: .patchpilot/artifacts
  s3:
    endpoint: http://localhost:9000
    region: us-east-1
    bucket: patchpilot
    accessKeyId: patchpilot
    secretAccessKey: patchpilot123
    forcePathStyle: true
    prefix: patchpilot
pullRequest:
  provider: local # local or github
  github:
    owner: ""
    repo: ""
    remote: origin
    headOwner: "" # optional fork owner for source branches; blank uses owner
    tokenEnv: PATCHPILOT_GITHUB_TOKEN
    authMode: token # token or app
    appId: ""
    appPrivateKeyEnv: PATCHPILOT_GITHUB_APP_PRIVATE_KEY
    appPrivateKeyPath: ""
    webhookSecretEnv: PATCHPILOT_GITHUB_WEBHOOK_SECRET
    # installationId: 123456 # optional; webhook-ingested installation state can also provide this
    apiBaseUrl: "" # optional GitHub Enterprise REST API base URL
    pushTimeoutMs: 30000
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

The worker process polls the API snapshot, claims ready work items for idle agents, and starts runs through the API. The API process owns the run queue and executes the Codex runner after `/api/work-items/:id/start`.

## Local CLI

The CLI can operate the happy path without the Web UI as long as the API is running:

```bash
pnpm cli -- submit --input "Ship a CLI-controlled agent workflow" --template feature
pnpm cli -- snapshot
pnpm cli -- happy-path --input "Ship a CLI-controlled agent workflow" --runner codex --out report.md
```

Supported operations include requirement submission, PRD creation and approval, snapshot inspection, team start, one worker dispatch tick, PRD acceptance, and Markdown report export:

```bash
pnpm cli -- create-prd --requirement <requirement-id>
pnpm cli -- approve-prd --prd <prd-id>
pnpm cli -- start-team --prd <prd-id> --runner codex
pnpm cli -- worker-once --runner codex
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

To point the API at compose Postgres:

```bash
PATCHPILOT_DATABASE_URL=postgresql://patchpilot:patchpilot@localhost:5432/patchpilot pnpm dev:api
```

## Kubernetes Worker Pool Templates

Non-production Kubernetes worker pool manifests live in `infra/k8s/worker-pool`. They define an isolated worker namespace, worker-node scheduling rules, resource quota/default limits, default-deny NetworkPolicies, and the per-run ServiceAccount + Job pattern for AgentRun execution:

```bash
pnpm k8s:validate
kubectl apply -k infra/k8s/worker-pool/nonprod
```

The non-production overlay uses temporary infrastructure containers so the manifest shape can be deployed before a PatchPilot worker image is published.

## What Works Now

- White-background Next.js workbench for simple requirement intake
- Grill-me style one-question-at-a-time clarification and generated PRD
- Work item creation with scope, non-goals, acceptance criteria, and test suggestions
- TestCase records generated from approved work items, linked back to TestRun evidence
- Draft and approved interface contracts for HTTP APIs, AgentRun events, and shared delivery state
- Server-sent progress events for planning, developing, testing, review, and acceptance
- Local Codex runner in an isolated git worktree when `codex` and git are available
- WorkspaceRun, TestCase, TestRun, local PullRequest, ReviewRecord, AuditEvent evidence records plus changed file list, risk summary, reviewer summary, and final acceptance
- Rejected acceptance requeues the same work items as a new rework round, preserves the rejection reason, and creates fresh agent runs on the next team start
- Bug reports that first go to the test agent for reproduction, then create a backend fix task for the developer agent
- Failed agent runs are classified as transient, deterministic, test_failed, policy_denied, budget_exhausted, or environment_failed; failed TestRun evidence can be stored as a reported Defect linked to the run, work item, test run, and commit
- Postgres/PGlite-backed product state with JSON fixture import/export for local development and migrations

## Runner Modes

PatchPilot defaults to `PATCHPILOT_RUNNER=auto`, which resolves to Codex execution.

- `auto`: use local Codex execution and fail fast if the Codex CLI or git workspace is unavailable.
- `codex`: force real local Codex execution in `.patchpilot/worktrees/<runId>`.

Worker environment:

```bash
PATCHPILOT_API_BASE_URL=http://localhost:4000
PATCHPILOT_WORKER_INTERVAL_MS=5000
PATCHPILOT_WORKER_ONCE=false
```

## Temporal Workflow Engine

TD-204 adds the Temporal TypeScript SDK boundary without replacing the existing polling worker. The Temporal worker is a separate process that runs a canary workflow proving worker startup, activity execution, signal/query handlers, retry policy, and idempotency-key plumbing. TD-205 through TD-208 add `RequirementIntakeWorkflow`, `WorkItemPlanningWorkflow`, `WorkItemExecutionWorkflow`, and `ApprovalWorkflow` for requirement intake, work item planning, execution evidence, and approval-gated run resume. Defect and retrospective workflows remain separate follow-up tasks.

Start a local Temporal server through the optional compose middleware:

```bash
docker compose -f infra/docker-compose.yml up -d postgres temporal
```

Then run the Temporal acceptance E2E for the TD-204 canary and TD-205 through TD-208 production workflow slices:

```bash
pnpm e2e:temporal
```

Temporal environment:

```bash
PATCHPILOT_TEMPORAL_ADDRESS=localhost:7233
PATCHPILOT_TEMPORAL_NAMESPACE=default
PATCHPILOT_TEMPORAL_TASK_QUEUE=patchpilot-td-204
```

Run the Temporal worker directly when you want to connect it to another local script or manual Temporal client:

```bash
pnpm --filter @patchpilot/worker start:temporal
```

OpenTelemetry environment:

```bash
PATCHPILOT_OTEL_ENABLED=true
PATCHPILOT_OTEL_EXPORTER=otlp
PATCHPILOT_OTEL_SERVICE_NAME=patchpilot-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

When enabled, the API emits AgentRun traces, metrics, and logs with `patchpilot.requirement.id`, `patchpilot.prd.id`, `patchpilot.workflow.id`, `patchpilot.work_item.id`, `patchpilot.agent_run.id`, and `patchpilot.test_run.id` attributes where those IDs exist in the MVP. The worker emits dispatch/tick telemetry with WorkItem and PRD correlation. `pnpm e2e:otel` starts a lightweight local OTLP HTTP test collector and proves one Codex run exports telemetry without requiring Docker.

Prometheus/Grafana-compatible scrape endpoint:

```bash
curl http://localhost:4000/metrics
pnpm e2e:metrics
```

`/metrics` returns Prometheus text format for run duration, failure type, WorkItem queue depth, run cost, TestRun pass rate, and acceptance rate. Metric names are stable `patchpilot_*` series with low-cardinality labels such as `runner`, `status`, `role`, and `failure_type`.

Runner environment:

```bash
PATCHPILOT_RUNNER=codex
PATCHPILOT_REPOSITORY_ROOT=/absolute/path/to/the/project-repo
PATCHPILOT_WORKSPACE_ROOT=.patchpilot/worktrees
PATCHPILOT_TEST_COMMAND="pnpm -r --if-present test"
PATCHPILOT_CODEX_TIMEOUT_MS=600000
PATCHPILOT_TEST_TIMEOUT_MS=120000
PATCHPILOT_MAX_REPAIR_ATTEMPTS=1
PATCHPILOT_CODEX_SANDBOX=workspace-write
PATCHPILOT_CODEX_BYPASS=false
PATCHPILOT_CONTAINER_SANDBOX_ENABLED=false
PATCHPILOT_CONTAINER_SANDBOX_RUNTIME=auto
PATCHPILOT_CONTAINER_SANDBOX_IMAGE=node:24-alpine
PATCHPILOT_CONTAINER_SANDBOX_CPUS=2
PATCHPILOT_CONTAINER_SANDBOX_MEMORY_MB=4096
PATCHPILOT_CONTAINER_SANDBOX_WORKSPACE_DISK_MB=8192
PATCHPILOT_CONTAINER_SANDBOX_TMPFS_MB=256
PATCHPILOT_CONTAINER_SANDBOX_PIDS_LIMIT=512
PATCHPILOT_PREVIEW_URL=http://localhost:3000
```

The Codex runner requires a working `codex` CLI, an authenticated local Codex session, and a git worktree-capable checkout. `auto` still defaults to Codex. Pi requires an explicit `PATCHPILOT_RUNNER=pi`, `.patchpilot/config.yaml` `dev.runner: pi`, or API start body `{ "runner": "pi" }`.

Pi runner variables:

```bash
PATCHPILOT_RUNNER=pi
PATCHPILOT_PI_COMMAND=pi
PATCHPILOT_PI_PROVIDER=fake # fake, openai, or anthropic
PATCHPILOT_PI_MODEL=
PATCHPILOT_PI_THINKING=
PATCHPILOT_PI_STATE_ROOT=.patchpilot/runner-state
PATCHPILOT_PI_TIMEOUT_MS=600000
PATCHPILOT_PI_SKIP_VERSION_CHECK=true
PATCHPILOT_PI_DISABLE_TELEMETRY=true
PATCHPILOT_PI_OFFLINE=false
```

Pi does not provide PatchPilot's sandbox boundary. Keep Pi's coding-agent capability intact; use PatchPilot worktrees, container sandbox, egress policy, Secret Broker, Capability Manifest, Audit Event, and artifact evidence as the control plane. See [docs/pi-runner.md](docs/pi-runner.md).

Runner variables are read by the API process; worker variables are read by the worker process.

`PATCHPILOT_REPOSITORY_ROOT` is the git checkout PatchPilot should develop. It defaults to the repo containing `.patchpilot/config.yaml`, or the API process cwd when no config file is present. `PATCHPILOT_WORKSPACE_ROOT` is only the directory where isolated run worktrees are created.

The Codex runner does not auto-merge or publish. It creates an isolated worktree from `PATCHPILOT_REPOSITORY_ROOT`, writes `PATCHPILOT_TASK.md`, runs `codex exec`, delegates the configured test command to `@patchpilot/testing`, optionally asks Codex for one repair pass, then returns evidence to the UI. TestRun evidence includes the command, workspace, runner/environment, timestamps, exit code, failure summary, log artifact id, retry count, and flaky signal.

Set `security.containerSandbox.enabled=true` to run Codex and the configured test command through a Docker or Podman container. The sandbox runs as a non-root UID/GID, never uses `--privileged`, drops Linux capabilities, sets `no-new-privileges`, does not mount the Docker socket or host home, mounts only the worktree at `/workspace` with write access, uses a read-only root filesystem, bounds `/tmp` and container home with tmpfs, applies CPU/memory/pid limits, and enforces the existing Codex/test timeout plus a workspace disk-usage limit from the API process. The container image must already include the tools your configured commands need.

When the container sandbox is enabled, `security.egressPolicy.enabled=true` adds the TD-212 network boundary. PatchPilot starts an audited egress proxy sidecar, runs the command container on an internal network, injects HTTP(S)/Git/npm proxy settings, allows only configured Git remote hosts, package registries, and OpenAI/Codex endpoint host patterns, and denies private networks plus cloud metadata endpoints. Raw egress decisions are written to a per-run private host path mounted only into the proxy sidecar, not into the task container's writable workspace; after collection, only summarized evidence is surfaced in run/test evidence and recorded as `network.egress_policy.enforced` plus `network.egress_denied` audit events when prohibited endpoints are blocked.

The Secret Broker MVP is deny-by-default. It injects nothing unless a work item explicitly requests `secret:<id>` in `requiredCapabilities` and `.patchpilot/config.yaml` maps that id to a non-production `dev` or `ci` token source:

```yaml
security:
  secretBroker:
    enabled: true
    allowedSecrets:
      - id: github-ci-token
        envVar: GITHUB_TOKEN
        sourceEnv: PATCHPILOT_CI_GITHUB_TOKEN
        environment: ci
```

The token value lives only in the API process environment named by `sourceEnv`; config, snapshots, artifacts, and audit events store only redacted ids/env var names. Production secret providers are intentionally out of scope for this MVP.

Codex prompts are intentionally short. PatchPilot sends the task title, task file path, required skill (`/tdd` or `/diagnose`), and safety boundary; detailed context lives in `PATCHPILOT_TASK.md`, `AGENTS.md`, and the repo tests.

## Pull Request Adapter

PatchPilot defaults to local pull request records. Local mode keeps the existing `local://pull-requests/:runId` URL shape and does not push branches or call GitHub:

```bash
PATCHPILOT_PR_PROVIDER=local
```

Set the provider to `github` when the API should push the completed run branch and create or update a real GitHub PR. The API process reads the token from the env var named by `PATCHPILOT_GITHUB_TOKEN_ENV`, which defaults to `PATCHPILOT_GITHUB_TOKEN`.

```bash
PATCHPILOT_PR_PROVIDER=github
PATCHPILOT_GITHUB_OWNER=your-org
PATCHPILOT_GITHUB_REPO=your-repo
PATCHPILOT_GITHUB_REMOTE=origin
PATCHPILOT_GITHUB_HEAD_OWNER=
PATCHPILOT_GITHUB_TOKEN_ENV=PATCHPILOT_GITHUB_TOKEN
PATCHPILOT_GITHUB_TOKEN=ghp_or_fine_grained_token
PATCHPILOT_GITHUB_AUTH_MODE=token
PATCHPILOT_GITHUB_API_BASE_URL=
PATCHPILOT_GITHUB_PUSH_TIMEOUT_MS=30000
```

`PATCHPILOT_GITHUB_HEAD_OWNER` is only needed when PR source branches live in a fork. `PATCHPILOT_GITHUB_API_BASE_URL` is only needed for GitHub Enterprise, for example `https://github.example.com/api/v3`.

For GitHub App mode, set `PATCHPILOT_GITHUB_AUTH_MODE=app` and provide the App ID plus a private key through `PATCHPILOT_GITHUB_APP_PRIVATE_KEY` or `PATCHPILOT_GITHUB_APP_PRIVATE_KEY_PATH`. `PATCHPILOT_GITHUB_INSTALLATION_ID` can seed repository listing before webhooks arrive; after a signed install webhook, PatchPilot can use the stored installation ID. Webhook verification reads the secret from the env var named by `PATCHPILOT_GITHUB_WEBHOOK_SECRET_ENV`, defaulting to `PATCHPILOT_GITHUB_WEBHOOK_SECRET`.

```bash
PATCHPILOT_PR_PROVIDER=github
PATCHPILOT_GITHUB_AUTH_MODE=app
PATCHPILOT_GITHUB_APP_ID=123456
PATCHPILOT_GITHUB_APP_PRIVATE_KEY_PATH=.patchpilot/github-app.pem
PATCHPILOT_GITHUB_INSTALLATION_ID=987654
PATCHPILOT_GITHUB_WEBHOOK_SECRET=github_webhook_secret
```

Maintainers, reviewers, and admins can list and select installation repositories through `GET /api/integrations/github/repositories` and `POST /api/integrations/github/repositories/select`. GitHub App webhooks post to `POST /api/integrations/github/webhook`; repository selections and webhook syncs are recorded in audit events.

The adapter unit suite includes a real fixture integration that is skipped by default. It creates a branch in the fixture workspace, pushes it, opens a PR, writes a reviewer comment, reads checks, then closes the PR and deletes the fixture branch:

```bash
PATCHPILOT_GITHUB_FIXTURE=1 \
PATCHPILOT_GITHUB_OWNER=your-org \
PATCHPILOT_GITHUB_REPO=fixture-repo \
PATCHPILOT_GITHUB_TOKEN=ghp_or_fine_grained_token \
PATCHPILOT_GITHUB_FIXTURE_WORKSPACE=/absolute/path/to/fixture-clone \
PATCHPILOT_GITHUB_REMOTE=origin \
PATCHPILOT_GITHUB_BASE_BRANCH=main \
pnpm --filter @patchpilot/pull-request-adapter test
```

Use a disposable fixture repository or branch namespace for that integration; regular CI and local test runs use the deterministic test adapter path and do not require GitHub credentials.

## Artifact Store

PatchPilot stores run evidence through `@patchpilot/artifacts`. The default local filesystem store writes content and metadata under `.patchpilot/artifacts`; `snapshot.artifacts` records the artifact ids referenced by `AgentRun`, `AgentRunResult`, and `TestRun`.

Use S3-compatible storage, including local MinIO, by setting `PATCHPILOT_ARTIFACT_STORE=s3` and the `PATCHPILOT_ARTIFACT_S3_*` variables from `.env.example`. The optional integration test expects the target bucket to already exist:

```bash
PATCHPILOT_ARTIFACT_S3_INTEGRATION=1 pnpm --filter @patchpilot/artifacts test
```

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
pnpm e2e:failure-defect
pnpm e2e:otel
pnpm e2e:metrics
pnpm e2e:pi-fake
pnpm e2e:pi-real-smoke # skips unless PATCHPILOT_PI_REAL_SMOKE=1
```
