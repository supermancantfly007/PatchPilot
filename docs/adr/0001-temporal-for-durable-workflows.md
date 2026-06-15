# ADR-0001: Temporal for Durable Workflows

Status: accepted

Date: 2026-06-10

## Context

PatchPilot is a delivery control plane. A single Requirement can become a PRD, multiple Work Items, Interface Contracts, Agent Runs, Workspace Runs, Test Cases, Test Runs, Pull Request records, Review records, Approvals, Audit Events, Defects, and final acceptance decisions.

The current runnable MVP uses a worker process that polls `/api/snapshot`, claims ready Work Items through the Control Plane API, and starts Agent Runs through `/api/work-items/:id/start`. The API process owns the run queue and executes the CodexRunner path. This is enough to prove the Simple Mode and Professional Mode loops, evidence records, local Pull Request records, TestRun capture, and acceptance/rework behavior.

That polling worker is not a durable production workflow engine. It depends on repeated snapshot reads, API-owned state transitions, and explicit retries around short-lived process behavior. It does not provide durable sleep, deterministic replay, built-in signal/query semantics, long-running approval waits, activity heartbeats, or first-class recovery after worker or API restarts.

## Decision Drivers

- Long-running Requirement, PRD, Work Item, Defect, Approval, and retrospective flows must survive API and worker restarts.
- Approval gates need a durable wait state that can resume from a human or policy signal.
- CodexRunner, Git, workspace, container, test, PR, artifact, and network operations need retry policies, heartbeats, cancellation, and idempotency keys.
- The platform needs queryable progress for Simple Mode and Professional Mode without making the UI responsible for orchestration.
- Audit Events, Test Runs, Pull Request records, and artifact references must remain traceable to a workflow attempt and Agent Run.
- The production stack should stay TypeScript-first so domain types, contracts, workers, and API adapters can share code.

## Decision

Use the Temporal TypeScript SDK as the production Workflow Engine.

Temporal will own durable workflow execution state. Product state and query projections for Requirements, PRDs, Work Items, Agent Runs, Workspace Runs, Test Cases, Test Runs, Approvals, Audit Events, Pull Request records, Defects, Capability Manifests, budgets, and artifacts remain outside Temporal in the repository layer chosen by the product-state ADR. The Control Plane API starts workflows, sends signals, serves workflow queries or projections, and exposes SSE or polling endpoints to clients.

Initial production workflows:

- `RequirementIntakeWorkflow`: Requirement intake, clarification turns, PRD draft creation, and confirmation wait.
- `WorkItemPlanningWorkflow`: PRD approval to vertical Work Items, testing suggestions, and Interface Contract baselines.
- `WorkItemExecutionWorkflow`: claim, Workspace Run creation, CodexRunner execution, TestRun capture, Pull Request record creation, Review record, and Quality Gate result.
- `ApprovalWorkflow`: human or policy Approval wait, approve/deny/expire signal handling, and audit linkage.
- `DefectReproductionWorkflow`: `/diagnose`-driven Defect reproduction, diagnosis, and fix-before evidence.
- `RetrospectiveWorkflow`: accepted PRD summary of cost, tests, risk, artifacts, and audit chain.

Temporal workflows must only perform deterministic state progression. LLM calls, Codex execution, Git, Docker/container work, shell commands, test execution, object storage, network calls, and database writes happen in activities. Every activity that can create or mutate external state must receive an idempotency key derived from workflow id, entity id, and attempt where appropriate.

The current polling worker remains an MVP/dev orchestration mechanism until the exit criteria below are met. It may remain as a local smoke-test path or CLI convenience after Temporal lands, but it must not be the production path for starting, retrying, pausing, resuming, or completing Work Item delivery.

## Alternatives Considered

### Keep API-Owned Snapshot Polling

This is the current MVP path. It is simple, debuggable, and does not require extra infrastructure. It works for proving the PRD-to-acceptance loop.

Rejected for production because durable waits, restart recovery, retry state, cancellation, and approval resume would have to be rebuilt as custom code around the API store and polling worker. That would make the platform's core delivery state harder to reason about as Agent Runs become longer and more expensive.

### PostgreSQL Queue With Leases Only

PostgreSQL row locks, leases, claim tokens, and unique constraints are still required for product state integrity and Work Item fencing.

Rejected as the only workflow engine because database leases solve concurrency control, not long-lived orchestration. PatchPilot would still need custom implementations for deterministic replay, signal/query, timer durability, retry histories, activity heartbeats, cancellation, and operator visibility.

### Redis/BullMQ-Style Job Queue

Redis-backed queues are good for short jobs, fan-out, and worker throughput. They are operationally familiar and easy to run locally.

Rejected because the central PatchPilot problem is not only queueing. It is durable, human-interruptible delivery orchestration with explicit Quality Gates, approvals, evidence capture, and recovery semantics.

### Kafka/NATS/Event Bus With Custom Consumers

An event bus can provide high-throughput messaging and loose coupling.

Rejected because it would still require a custom saga/workflow layer for each Requirement, Work Item, Approval, and Defect lifecycle. PatchPilot needs durable orchestration before it needs event-stream scale.

### CI/GitHub Actions As The Workflow Engine

CI systems are useful for tests, checks, and repository automation.

Rejected because PatchPilot workflow state includes product decisions, approvals, CodexRunner sessions, workspace lifecycle, artifact capture, budget checks, and acceptance/rework loops across API and UI surfaces. CI remains a downstream integration, not the control plane.

### Agent Framework As The Workflow Engine

Agent graphs are useful for LLM reasoning structure and may help inside a future activity.

Rejected as the production workflow engine because PatchPilot requires infrastructure-level durability, replay, signals, queries, retries, cancellation, and operations visibility around non-LLM activities.

## Consequences

- Temporal service availability becomes a production dependency. Local development needs a Temporal dev server or compose service for production-path workflow tests.
- Workflow definitions must be deterministic. Shared helpers used by workflows need review before import.
- External effects move behind activity boundaries with explicit retry policies, timeouts, cancellation handling, and idempotency keys.
- The API must separate workflow commands from product state projections. API endpoints should not directly orchestrate multi-step delivery in production mode.
- Agent Run, Workspace Run, Test Run, Approval, Audit Event, and artifact records need stable correlation IDs back to workflow id and activity attempt where useful.
- Tests need a Temporal test environment for workflow behavior plus existing API, domain, contract, worker, and E2E checks.
- Operational visibility improves: workflow history becomes the durable explanation for in-flight and failed delivery.
- The polling worker remains valuable for MVP development and local validation, but production features should not deepen its orchestration role once Temporal work starts.

## Polling MVP Exit Criteria

The MVP polling worker may remain the default only while PatchPilot is proving local delivery loops. Move the production default to Temporal when all of the following are true:

1. Product state has a transactional repository layer suitable for workflow activities, including Work Item claim fencing, Agent Run status transitions, Approval decisions, Audit Event writes, and TestRun/Pull Request evidence writes.
2. A local Temporal environment is documented and included in developer setup, and `TD-204` can run one Temporal TypeScript workflow from start to terminal state.
3. The Control Plane API can start a workflow, send approval and clarification signals, query current workflow progress, and expose the same Simple Mode and Professional Mode state through existing API/SSE surfaces.
4. `RequirementIntakeWorkflow`, `WorkItemPlanningWorkflow`, `WorkItemExecutionWorkflow`, and `ApprovalWorkflow` cover the existing happy path from Requirement submission through accepted Work Items.
5. `DefectReproductionWorkflow` covers the existing Defect reproduction-to-fix handoff before bug flows are advertised as production-capable.
6. Activities exist for CodexRunner start/resume/cancel, Workspace Run preparation, configured test execution, Pull Request record creation, Review record creation, artifact writes, and Audit Event writes.
7. Every externally mutating activity has an idempotency key and a regression test showing that activity retry does not duplicate Agent Runs, Workspace Runs, Test Runs, Pull Request records, Approvals, Audit Events, or artifacts.
8. Workflow tests cover worker restart/replay, API restart while a workflow is waiting, activity retry after transient failure, cancellation, approval approve/deny signal handling, and terminal failure recording.
9. At least one E2E path runs against Temporal, not the polling worker, and verifies Requirement -> PRD -> Work Items -> Agent Runs -> Test Runs -> Pull Request records -> Review records -> acceptance evidence.
10. Observability links workflow id, Work Item id, Agent Run id, TestRun id, trace id, and Audit Event trace id in logs or telemetry.
11. Operators can inspect and unblock stuck workflows without manually editing product state tables or JSON snapshots.
12. Documentation states that snapshot polling is only a UI fallback or local/dev compatibility path, not production orchestration.

After these criteria pass, new production workflow behavior must be implemented in Temporal workflows and activities first. The polling worker can keep a narrow compatibility role for local validation, CLI `worker-once`, or test fixtures, but it should call the same production command surface or be clearly marked as non-production.

## Non-Goals

- This ADR does not implement `TD-204` or add Temporal dependencies.
- This ADR does not decide the project fact source; see `ADR-0002`.
- This ADR does not decide the Codex integration main path; see `ADR-0003`.
- This ADR does not decide sandbox, network, secret, or PR provider strategy.
