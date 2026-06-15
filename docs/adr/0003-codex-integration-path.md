# ADR-0003: Codex Integration Path and Adapter Interface

Status: accepted

Date: 2026-06-11

## Context

PatchPilot is built around Codex-powered delivery, but the product must remain the control plane for delivery state. The platform owns Requirements, PRDs, Work Items, Workspace Runs, Agent Runs, Test Runs, Pull Request records, Approvals, Audit Events, artifacts, budgets, and final acceptance.

The current runnable MVP already has `@patchpilot/codex-runner` as the boundary between PatchPilot and Codex. Its local implementation creates an isolated Git worktree through `@patchpilot/workspace-manager`, writes `PATCHPILOT_TASK.md`, starts `codex exec --json` through a Node child process, parses JSONL progress events, runs the configured test command through `@patchpilot/testing`, optionally asks Codex for a repair turn, commits the worktree branch, and returns evidence to the API store.

ADR-0001 decides that Temporal will own durable workflow execution. ADR-0002 decides that Postgres will own production product state. That means the production `WorkItemExecutionWorkflow` needs a Codex boundary that can be called from Temporal activities, retried safely, cancelled, resumed after approvals or worker restarts, and observed without making Codex itself the source of truth for PatchPilot state.

Codex currently exposes several integration surfaces that solve different problems:

- The Codex SDK is the application integration surface for server-side code that needs to start and resume Codex threads as part of a workflow.
- `codex exec --json` is the stable non-interactive CLI surface for scripts, CI-style automation, explicit sandbox/approval settings, and machine-readable JSONL event capture.
- `codex mcp-server` exposes Codex as MCP tools to another MCP client or agent framework.
- Codex can also consume MCP servers configured in Codex config, which is a tool-access mechanism rather than a PatchPilot orchestration mechanism.

PatchPilot needs a durable decision about which surface is the main path, which surfaces remain compatibility or interoperability paths, and which adapter contract hides those differences from workflows, the API, and tests.

## Decision Drivers

- PatchPilot should have exactly one internal Codex integration boundary so SDK, CLI, and MCP changes do not leak into workflows, API routes, UI code, or repository state.
- Temporal activities need idempotent start, resume, cancel, stream, artifact collection, and failure summarization operations.
- The current local MVP must keep working without a flag-day migration away from `codex exec --json`.
- Agent Run evidence must stay machine-readable: thread/session ids, agent messages, reasoning summaries, command/tool calls, file changes, test output, failure classification, usage/cost data where available, and artifact ids.
- PatchPilot must own workspace creation, branch naming, capability manifests, approval gates, budget checks, secret brokering, network policy, test execution, artifact storage, and audit records.
- Production automation must not inherit an operator's personal Codex defaults accidentally. It needs platform-owned configuration, explicit sandbox and approval settings, and controlled MCP/tool access.
- External agent frameworks may need to call Codex through PatchPilot-adjacent workflows, but that should not force PatchPilot's internal execution path through MCP.

## Decision

Use `CodexRunner` as PatchPilot's only internal Codex integration boundary.

The production target is a Codex SDK adapter behind `CodexRunner`. The SDK is the preferred long-term application integration path because PatchPilot needs server-side thread ownership, resume semantics, cancellation, and workflow-managed turns.

Keep the existing `codex exec --json` adapter as the MVP, local development, CI-style, and fallback implementation. This path remains valuable because it is simple, debuggable, scriptable, and already produces JSONL event evidence that PatchPilot can normalize.

Do not make Codex MCP the internal production execution path. Use Codex-as-MCP for interoperability when an external orchestrator or agent framework needs to call Codex as a tool. If PatchPilot ever wraps that path, it still must go through `CodexRunner` and the same workspace, policy, evidence, and audit boundaries.

Codex-consuming MCP servers are allowed only as tools configured for a specific run through platform-owned Codex configuration and the run's Capability Manifest. MCP tool access is not a substitute for PatchPilot's policy, network, secret, approval, or audit layers.

## Adapter Contract

Production workflows and API code should depend on a runner contract with durable operations rather than on `LocalCodexRunner` process details:

```ts
export interface CodexRunner {
  start(input: CodexRunInput): Promise<CodexRunHandle>;
  resume(input: CodexResumeInput): Promise<CodexRunHandle>;
  cancel(input: CodexCancelInput): Promise<void>;
  streamEvents(input: CodexEventStreamInput): AsyncIterable<CodexRunEvent>;
  collectArtifacts(input: CodexArtifactInput): Promise<CodexArtifacts>;
  summarizeFailure(input: CodexFailureInput): Promise<FailureSummary>;
}
```

`CodexRunInput` must include:

- `runId`, `workItemId`, `workspaceRunId`, and an activity-level `idempotencyKey`.
- `workspacePath`, `taskFilePath`, `baseBranch`, `baseCommit`, and expected output branch.
- A short prompt that points at `PATCHPILOT_TASK.md` and names the required skill, such as `/tdd` or `/diagnose`.
- Explicit `sandbox`, `approvalPolicy`, `timeoutMs`, model/profile options when configured, and `capabilityManifestId`.
- A platform-owned Codex config or profile reference, including any allowed MCP servers and tool approval modes.

`CodexRunHandle` must preserve the provider-specific identity needed to resume or inspect the run:

- `provider`: `sdk`, `exec-json`, or `codex-mcp`.
- `threadId` or equivalent durable Codex thread identifier when available.
- `sessionId`, `turnId`, or process identity when the provider exposes them.
- `startedAt`, current status, and enough metadata for idempotent retry to return the existing handle rather than starting a duplicate run.

`CodexRunEvent` must normalize provider events into PatchPilot evidence:

- lifecycle events: thread/turn started, progress, completed, failed, cancelled.
- agent messages and reasoning summaries.
- tool calls, shell commands, MCP calls, file changes, approval requests, and policy denials.
- usage/cost data when available.
- artifact references for logs, final message, diff, trace, screenshots, and test reports.
- raw provider event references for debugging, stored as artifacts rather than as the product-state source of truth.

The current one-shot `run(context, emit, config)` interface can remain as an MVP convenience while the polling worker is the default local path. Temporal production work should introduce the durable contract above and adapt the existing CLI implementation to it rather than letting workflow code call a one-shot helper directly.

## Implementation Rules

- PatchPilot prepares the workspace before Codex starts. Codex receives a workspace path and task file; it does not choose the target repository, branch, or write scope.
- Prompts stay short. Detailed context lives in `PATCHPILOT_TASK.md`, `AGENTS.md`, Interface Contracts, TestCase suggestions, and Quality Gate configuration.
- Production adapters must use explicit sandbox and approval settings. The intended default is workspace write access for the isolated workspace and no interactive Codex approval pauses; PatchPilot creates its own Approval records for dangerous operations, network changes, secret access, budget overruns, and breaking contracts.
- Production adapters must not inherit personal `$CODEX_HOME` behavior. They should use platform-owned Codex config/profile data and an allowlisted set of MCP servers and tools for each run.
- `codex exec --json` implementations must parse JSONL into the normalized event stream and should use explicit CLI flags for working directory, sandbox, approval policy, final-message output, and timeout behavior.
- SDK implementations must persist the Codex thread id and map SDK turns to the same normalized event stream and artifact model.
- MCP implementations, if added, must treat MCP tool responses as a provider transport detail. They must not bypass `CodexRunner`, Workspace Manager, Capability Manifest enforcement, artifact storage, or Audit Event writes.
- Cancellation must be best-effort but observable. A cancelled run must record whether the provider acknowledged cancellation, whether a local process was terminated, and what workspace state remained.
- Resume must be explicit. Rework after failed tests, human follow-up after rejection, and approval continuation should call `resume` with a new prompt against the same provider thread when available; otherwise the adapter must record that it started a new provider session linked to the original Agent Run.

## Alternatives Considered

### Keep `codex exec --json` As The Permanent Main Path

The CLI path is already implemented, easy to run locally, and well suited to CI-like automation. JSONL output gives PatchPilot useful event capture with minimal dependencies.

Rejected as the permanent production main path because PatchPilot's durable workflow needs are broader than one-shot process execution. Resume semantics, thread ownership, cancellation, long-lived server control, and provider lifecycle metadata fit the SDK adapter better. The CLI remains the required compatibility and fallback adapter.

### Switch Immediately To The Codex SDK

The SDK matches PatchPilot's application shape and should become the production target.

Rejected as an immediate runtime change for this ADR because the current MVP already works through `codex exec --json`, and production durability still depends on TD-202 Postgres repository work and TD-204 Temporal integration. Introducing the SDK before those boundaries exist would create churn without solving workflow durability.

### Use Codex MCP Internally For All Runs

Codex-as-MCP is useful when another agent framework wants to call Codex as a tool. It also aligns with multi-agent orchestration validation.

Rejected as the internal production path because PatchPilot is itself the delivery control plane. Routing every Work Item through MCP would add an extra tool-call mediation layer while weakening direct ownership of workspace lifecycle, Temporal activity idempotency, artifact capture, cancellation, and audit semantics.

### Let Each Caller Pick A Codex Surface

The API, worker, Temporal activities, CLI, or future integrations could each choose SDK, CLI, or MCP directly.

Rejected because it would fragment evidence, failure handling, policy enforcement, and test fixtures. PatchPilot needs one internal runner contract with multiple provider adapters behind it.

### Call Lower-Level OpenAI APIs Instead Of Codex

PatchPilot could build its own coding agent on lower-level model APIs.

Rejected because PatchPilot's product is delivery control, not reimplementing Codex's coding-agent behavior. Lower-level APIs may be useful for planning, summarization, or policy checks, but Work Item implementation should use Codex through the runner boundary.

## Consequences

- `@patchpilot/codex-runner` remains the package boundary for Codex execution, but it needs a production contract that is broader than the current one-shot MVP helper.
- The current CLI runner remains valid for local validation, smoke tests, CI-style runs, and fallback behavior while Temporal and the repository layer mature.
- A future SDK runner must have contract tests that prove event normalization, artifact capture, failure classification, cancellation, resume, and idempotent retry behavior match the CLI runner where the provider surfaces overlap.
- Product state should store provider-neutral fields first, such as runner provider, thread/session ids, workspace path, branch, base/head commits, artifact ids, failure type, and cost/usage where available.
- Capability Manifest and Secret Broker work must include Codex config and MCP tool access, not only shell commands and network egress.
- The platform can expose Codex MCP interoperability later without changing the core Work Item execution workflow.
- Runtime implementation tasks should not deepen direct `codex exec` coupling outside `@patchpilot/codex-runner`.

## SDK Default Exit Criteria

PatchPilot should move the production default from the CLI adapter to the SDK adapter only when all of the following are true:

1. Temporal activities exist for `CodexRunner.start`, `resume`, `cancel`, event streaming, artifact collection, and failure summarization.
2. The Postgres repository stores provider-neutral Codex run identity, including provider, thread id, session id where available, workspace run id, base/head commits, and artifact ids.
3. SDK and CLI adapters pass the same runner contract tests for a successful run, failed run, timeout, cancellation, repair/resume prompt, artifact collection, and duplicate idempotency key retry.
4. A production-owned Codex config/profile path is used, with personal user config excluded from unattended runs.
5. Capability Manifest enforcement covers sandbox mode, writable paths, allowed commands, allowed MCP servers/tools, network destinations, and secret grants.
6. Approval behavior is explicit: Codex does not wait on interactive approvals in production; PatchPilot creates Approval records and resumes runs after approval decisions.
7. One E2E path runs a Work Item through the SDK adapter and verifies Agent Run events, TestRun evidence, artifact records, Pull Request records, Review records, Audit Events, cancellation behavior, and final acceptance.
8. The CLI adapter remains available as a local/fallback path and has a documented compatibility test.

## Non-Goals

- This ADR does not implement a Codex SDK adapter or add SDK dependencies.
- This ADR does not change the current `codex exec --json` runtime behavior.
- This ADR does not decide the worktree and container sandbox model; see `ADR-0004`.
- This ADR does not decide Work Item lease and fencing details; see `ADR-0005`.
- This ADR does not decide secret, network, MCP tool, or dangerous-operation approval policy in detail; see `ADR-0009`.
- This ADR does not decide GitHub PR creation, merge queue, or conflict handling; see `ADR-0007`.
