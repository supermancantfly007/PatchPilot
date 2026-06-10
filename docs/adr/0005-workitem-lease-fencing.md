# ADR-0005: Work Item Lease and Claim Fencing

Status: accepted

Date: 2026-06-11

## Context

PatchPilot can have multiple schedulers, workers, API requests, workflow retries, or local agents trying to start the same Work Item. The platform must prevent duplicate execution while still recovering from a worker that claims work and then crashes before it creates a useful Agent Run.

The current Control Plane API exposes:

- `POST /api/work-items/:id/claim`, which accepts an `agentId` and optional `leaseDurationMs`, assigns the Work Item, generates a server-side `claimToken`, sets `claimedAt`, `leaseExpiresAt`, `heartbeatAt`, and `version`, and returns the token to the caller.
- `POST /api/work-items/:id/start`, which accepts an optional `claimToken`; if the Work Item is already actively claimed, the token must match before an Agent Run starts.
- `POST /api/work-items/:id/release`, which also uses the current token when a claimed item is released back to `ready`.

The polling worker already follows this protocol: it claims first, then passes the returned `claimToken` into `start`. The dispatcher treats expired `claimed` leases as dispatchable and counts active claims against concurrency limits.

`TD-112` added the current domain and API fields: `claimToken`, `leaseExpiresAt`, `heartbeatAt`, and `version`. `TD-113` added a separate `.scratch` Markdown prototype with file-lock based claims for import/export experiments. `TD-202` moved the Web/API/worker runtime to the Postgres repository layer, with local PGlite as the default development database. `TD-203` added database constraints and indexes for scheduling and fencing, including `work_items(status, lease_expires_at)`, active claim-token uniqueness, active agent-claim uniqueness, claim-field consistency checks, active Agent Run uniqueness, and Pull Request traceability constraints.

ADR-0001 chooses Temporal for durable workflow orchestration. ADR-0002 chooses Postgres for product state. ADR-0004 chooses per-run worktree and sandbox isolation. This ADR records the Work Item concurrency contract those decisions depend on.

## Decision Drivers

- Two schedulers or workers must not successfully claim the same Work Item at the same time.
- A stale worker must not start, update, release, complete, or fail a Work Item after another worker has reclaimed it.
- A worker crash after claim but before start must be recoverable without manual database edits.
- A long-running Work Item needs heartbeats and operator-visible stale-run handling without silently creating duplicate Agent Runs.
- Claim behavior must work through the Control Plane API, future Temporal activities, and repository tests with the same semantics.
- Product-state mutations and Audit Events should be transactional where feasible.
- `.scratch` Markdown mode must stay an explicit local/import-export surface, not a second live runtime authority.

## Decision

Use a repository-owned Work Item lease with claim-token fencing.

The Postgres repository is the authority for claim eligibility, token generation, lease expiration, heartbeat updates, release, start, terminal completion, and stale-claim recovery. The Control Plane API, polling worker, CLI, and future Temporal activities call repository commands; they do not implement their own locking rules around snapshots.

Active execution ownership is represented on the Work Item:

- `status` is `claimed` before an Agent Run has started, and `running` while execution is active.
- `assignedAgentId` identifies the current owning agent.
- `claimedAt` records when the current ownership began.
- `claimToken` is an opaque, server-generated, high-entropy fencing token.
- `leaseExpiresAt` is the repository's deadline for the current ownership heartbeat.
- `heartbeatAt` records the most recent successful owner heartbeat.
- `version` increments on every ownership or execution state transition.

For non-active Work Item states, repository commands clear `assignedAgentId`, `claimedAt`, `claimToken`, `leaseExpiresAt`, and `heartbeatAt`. Database checks must reject claimed or running rows without the required claim fields. Repository tests should also cover that ready, done, cancelled, review, and blocked transitions do not leave active claim ownership behind.

The claim token is a capability-like operational token. It is not caller-chosen, not stable across reclaims, and not a human workflow identifier. UI code should not depend on it except for developer/debug projections. Runtime callers that continue an active lease must present either the current `claimToken` or a run/workflow identity that the repository can resolve to the current token.

## Claim Protocol

The scheduler is a candidate selector, not the lock authority. It may query ready Work Items and expired claims using `work_items(status, lease_expires_at)`, then apply dependency, budget, capability, and concurrency policy before attempting a claim.

The repository claim command must run in one transaction and do all of the following:

1. Lock or conditionally update the target Work Item row.
2. Confirm the Work Item is claimable.
3. Confirm the selected agent can own the Work Item and is not already actively assigned elsewhere.
4. If the previous claim is expired and no non-terminal Agent Run owns the Work Item, release the previous agent assignment.
5. Generate a new `claimToken`.
6. Set `status=claimed`, `assignedAgentId`, `claimedAt`, `claimToken`, `leaseExpiresAt`, `heartbeatAt`, increment `version`, and update the agent state.
7. Write the `work_item.claimed` Audit Event in the same transaction when feasible.
8. Return the Work Item, agent, `claimToken`, and `leaseExpiresAt`.

If two claim attempts race, exactly one may commit. The other must receive a conflict or invalid-state response. This should be enforced by a conditional update or row lock plus the TD-203 partial unique indexes, not by in-process mutexes alone.

The current API allows a compatibility path where `start` can be called on a `ready` Work Item and assign an agent internally. Production workflow code should prefer explicit claim then start, because the claim response carries the token that fences later mutations.

## Start, Release, And Terminal Writes

Starting a claimed Work Item requires the current `claimToken` and an unexpired lease. A stale token must fail with a conflict. On success, the repository command transitions the Work Item to `running`, extends the lease, creates the Agent Run and Workspace Run records, and writes Audit Events in one transaction where feasible.

The repository must keep at most one non-terminal Agent Run per Work Item. TD-203's active Agent Run uniqueness constraint is the database backstop; repository commands should still perform explicit checks so callers get domain errors rather than raw constraint failures.

Releasing a claimed Work Item requires the current token, clears claim fields, returns the Work Item to `ready`, releases the agent, increments `version`, and writes `work_item.released`.

Terminal execution writes must also be fenced. A worker or workflow activity that records success, failure, cancellation, Test Runs, Pull Request records, Review records, cleanup, or final Work Item status must prove it is operating on the current active ownership. The preferred production shape is a repository command that takes `workItemId`, `agentRunId`, an idempotency key, and the current token or workflow-owned fence, then validates that the Agent Run is still the active run for the Work Item before mutating product state.

If a stale process resumes after its lease was reclaimed, its token no longer matches and all fenced writes must fail without changing the Work Item, Agent Run, Workspace Run, TestRun, Pull Request, Review, or Audit state.

## Heartbeat And Lease Extension

Claim leases are short operational fences, not a durable workflow engine. The current default lease is five minutes; callers may request shorter leases for tests, and public inputs cap `leaseDurationMs` at one hour.

Production runtime should add a repository heartbeat command with this behavior:

- Accept the Work Item id and current `claimToken` or equivalent workflow fence.
- Validate that the Work Item is still `claimed` or `running`, the token still matches, and the active Agent Run relationship is valid when a run exists.
- Set `heartbeatAt` to the database clock, extend `leaseExpiresAt`, increment `version`, and update the agent's `lastSeenAt`.
- Write an Audit Event only for material heartbeat state changes or recovery-relevant events, not for every noisy interval.

Worker heartbeat cadence should be shorter than half the lease duration. If heartbeat fails because the token is stale, the worker must stop mutating product state and let the new owner or workflow recovery path proceed.

Temporal activity heartbeats and Work Item lease heartbeats are separate. Temporal activity heartbeats tell Temporal that an activity worker is alive. Work Item lease heartbeats tell PatchPilot's repository that the current product-state owner is still valid. Production activities that run for longer than one lease interval must use both mechanisms where applicable.

## Stale Claim Recovery

An expired `claimed` Work Item with no active non-terminal Agent Run may be reclaimed directly by another eligible agent. The reclaim transaction invalidates the old token by writing a new token, releases the old agent assignment, increments `version`, and records recovery evidence in the `work_item.claimed` Audit Event metadata or a dedicated stale-claim Audit Event.

An expired `running` Work Item is different. It may indicate a dead worker, a stuck Codex process, a lost API process, or a delayed heartbeat. The platform must not silently start a second Agent Run for the same Work Item while a non-terminal Agent Run exists. Recovery must first reconcile the active Agent Run through Temporal, the runner, or an operator-visible failure/cancellation path, then move the Work Item to a claimable state in a fenced transaction.

Rejected acceptance and rework follow the same rule: preserve prior evidence, make the old Agent Run non-active, clear claim ownership, increment rework metadata, and return the Work Item to `ready` before another claim can start.

## Database And Repository Boundaries

TD-203 database constraints are required but not sufficient on their own. The runtime repository must expose narrow transactional commands for Work Item claim, heartbeat, start, release, terminal completion, cancellation, rework, and stale recovery.

Runtime code should not perform a read-modify-write of the entire product snapshot as the production concurrency mechanism. Snapshot import/export remains useful for fixtures, demos, compatibility, and `/api/snapshot` projections, but the production mutation path needs row-level transactions, conditional updates, version checks, constraints, and domain errors.

Repository commands should use the database clock for `claimedAt`, `heartbeatAt`, `leaseExpiresAt`, and stale checks. This avoids inconsistent lease behavior across API workers with different local clocks.

The `.scratch` Markdown store may keep using atomic directory locks for explicit local Markdown mode. That lock is only the authority for files under `.scratch/work-items/`; it is not the Web/API/worker runtime fence after TD-202.

## Workflow Boundaries

Temporal owns orchestration history, retries, timers, signals, queries, and activity scheduling. It does not own product-state locks.

`WorkItemExecutionWorkflow` should claim, heartbeat, start, release, fail, complete, and recover Work Items through activities that call the repository commands described here. Each externally mutating activity must use an idempotency key derived from workflow id, Work Item id, Agent Run id, and attempt where appropriate.

Workflow retry must be idempotent:

- Retrying the same claim activity with the same idempotency key should return the existing active claim when it is still valid for the same workflow/agent, or fail clearly when another owner has already reclaimed it.
- Retrying start after a transient failure must not create a duplicate Agent Run or Workspace Run.
- Retrying terminal evidence writes must not duplicate Test Runs, Pull Request records, Review records, Audit Events, or artifacts.

The Control Plane API remains a command facade. In production mode it may start or signal Temporal workflows, but product-state mutations still flow through the repository fence. The polling worker may remain a local/dev path, but it should call the same API or repository command semantics rather than deepening a separate scheduler-owned lock model.

## Alternatives Considered

### In-Process Mutex Around Claims

The current store has an in-process mutation queue that is useful for local MVP behavior and tests.

Rejected as the production authority because multiple API processes, workers, Temporal activities, and future deployments cannot share one process-local mutex.

### Agent Id As The Only Fence

Using `assignedAgentId` alone is simple and human-readable.

Rejected because a crashed worker and its replacement may use the same agent id, and an old process can resume after reclaim. A unique token per claim generation is required to distinguish current ownership from stale ownership.

### Long Database Lock For The Whole Run

Holding a row lock while Codex, tests, PR creation, and review run would prevent duplicate work.

Rejected because Work Item execution can take minutes or hours and crosses external systems. Long transactions would block scheduling, increase deadlock risk, and make failures harder to recover.

### Temporal Workflow Id As The Only Fence

Temporal gives strong orchestration identity and retry history.

Rejected as the only fence because product state is Postgres-owned, API and local paths still exist, and stale external workers need a database-visible token check before mutating Agent Run evidence or Work Item status.

### Advisory Locks

Postgres advisory locks could serialize claim attempts.

Rejected as the primary mechanism because leases, tokens, versions, statuses, Audit Events, and Agent Run uniqueness must persist and be inspectable after process death. Advisory locks may be an implementation optimization only if the row state remains the source of truth.

### `.scratch` File Locks For Runtime State

The scratch-store file lock is appropriate for the explicit local Markdown mode.

Rejected for the Web/API/worker runtime because ADR-0002 and TD-202 make Postgres the product-state authority.

## Consequences

- The claim token becomes part of the Work Item execution protocol. Worker, API, workflow, and repository tests must preserve token forwarding and stale-token rejection.
- The repository layer needs command-shaped mutations, not only snapshot replacement, for production concurrency.
- Heartbeat and recovery behavior must be observable. Operators need to know whether a Work Item is waiting, actively owned, stale-before-start, running-but-stale, cancelled, failed, or ready for reclaim.
- Product-state Audit Events should identify claim, release, stale reclaim, start, terminal completion, and forced recovery decisions.
- Tests need concurrent claim coverage, stale token coverage, expired claim reclaim coverage, running-run duplicate protection, heartbeat extension coverage, and idempotent retry coverage.
- Claim tokens should be treated as operationally sensitive. Logs, UI projections, and exported artifacts should avoid exposing them unless needed for local debugging.

## Production Enforcement Exit Criteria

Treat Work Item lease and fencing as production-enforceable when all of the following are true:

1. Repository commands exist for claim, heartbeat, start, release, terminal completion, cancellation, rework, and stale recovery.
2. Those commands run in transactions and write related Audit Events where feasible.
3. Claim and start use row-level locks or conditional updates plus TD-203 constraints, so concurrent callers cannot both succeed.
4. Stale tokens are rejected for start, release, heartbeat, terminal evidence writes, and cleanup-affecting state changes.
5. Active Agent Run uniqueness prevents duplicate running execution for one Work Item.
6. Expired `claimed` items can be reclaimed automatically, while expired `running` items require workflow/run reconciliation before new execution.
7. Temporal `WorkItemExecutionWorkflow` activities use the same fenced repository commands and idempotency keys.
8. The polling worker and Control Plane API keep passing the claim token through the same protocol.
9. Repository, API, worker, workflow, and E2E tests cover concurrent claim, heartbeat, reclaim, duplicate start prevention, workflow retry, and stale worker write rejection.
10. Documentation clearly separates Postgres runtime fencing from `.scratch` Markdown file locks.

## Non-Goals

- This ADR does not implement new repository methods or runtime behavior.
- This ADR does not change the current public API routes.
- This ADR does not decide branch naming, merge queue, Pull Request conflict handling, or final merge policy; see ADR-0007.
- This ADR does not decide network, secret, MCP tool, or dangerous-operation approval policy; see ADR-0009.
- This ADR does not define long-term Audit Event retention or redaction; see ADR-0008.
