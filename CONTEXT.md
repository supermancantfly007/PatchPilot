# PatchPilot Context

PatchPilot is an agent delivery control platform. Its job is to turn a user request or bug report into a traceable software delivery workflow that Codex-powered agents can execute safely.

## Domain Glossary

### Requirement

An initial user request, idea, document, customer report, or bug report before it has been clarified and accepted.

### PRD

A versioned product requirements document that captures the confirmed problem, solution, user stories, acceptance criteria, implementation decisions, testing decisions, out-of-scope items, and unresolved notes.

### Work Item

A unit of planned work derived from a PRD. Work items may be epics, stories, tasks, bugs, or subtasks. Work items should be vertical slices when possible, not broad frontend-only or backend-only buckets.

### Interface Contract

A machine-readable contract at a system seam. HTTP contracts should use OpenAPI. Event contracts should use AsyncAPI or an equivalent schema. Shared data contracts should be versioned and testable.

### Agent Run

One execution attempt by an agent. An agent run records the prompt, model, tool calls, workspace, branch, worktree, diff, logs, test results, cost, status, and failure reason.

### Workspace Run

The isolated execution environment for one work item or bug fix. A workspace run should use a Git worktree and an isolated container or equivalent sandbox.

### Defect

A confirmed failure found by a user, test run, reviewer, or agent. A defect should include reproduction evidence before being assigned for a fix whenever feasible.

### Test Case

A reusable verification asset tied to a requirement, acceptance criterion, interface contract, work item, or defect.

### Test Run

One execution of a test case or test suite against a specific commit, branch, PR, or workspace run.

### Approval

A recorded human or policy decision that allows a workflow to pass a gate such as PRD approval, breaking contract approval, release approval, or dangerous operation approval.

### Audit Event

An append-only record of a meaningful action in the platform. Audit events should include actor, target, action, timestamp, trace ID, before/after data where relevant, and the related agent run or approval.

### Simple Mode

The ordinary-user product mode. Simple Mode hides engineering terms and presents the workflow as idea intake, requirement confirmation, progress, result preview, and acceptance.

### Professional Mode

The engineering product mode. Professional Mode exposes PRDs, work items, interface contracts, agent runs, workspace runs, pull requests, tests, costs, approvals, and audit events.

### Quality Gate

A required verification point before workflow progress. Quality gates include PR checks, contract checks, bug reproduction, final acceptance, budget checks, and dangerous-operation approvals.

### CodexRunner

The platform adapter that starts, resumes, cancels, streams, and collects artifacts from Codex execution. It hides whether a run uses the Codex SDK, `codex exec --json`, or Codex MCP server.

### Capability Manifest

A per-run permission manifest that defines which repository paths, tools, network destinations, credentials, and actions an agent run may use.

## Product Direction

PatchPilot should be a delivery control plane, not a chat-only multi-agent demo and not a full replacement for Jira or Linear.

The platform should own agent-specific delivery facts: PRD versions, contracts, agent runs, workspaces, test results, defects, approvals, traces, audit events, and cost.

External systems such as GitHub Issues, GitHub Pull Requests, Linear, or Jira can be integration surfaces. They should not be the only source of truth for agent execution state.
