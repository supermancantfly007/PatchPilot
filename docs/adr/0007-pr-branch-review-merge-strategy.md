# ADR-0007: PR Branch, Review, Merge Queue, and Conflict Strategy

Status: accepted

Date: 2026-06-11

## Context

PatchPilot turns Requirements into PRDs, Work Items, Agent Runs, Workspace Runs, Test Runs, Pull Request records, Review records, Approvals, Audit Events, and final acceptance decisions. The platform must therefore control not only how code is produced, but also how produced code becomes a reviewed and mergeable repository change.

The current runnable MVP records local Pull Request evidence after a successful Agent Run. `PullRequestRecord` already stores provider, status, branch name, base branch, base commit, head commit, URL, PR body, reviewer summary, and test summary. `ReviewRecord` stores review status, reviewer agent, findings, risk level, and links back to the Pull Request, Work Item, PRD, Requirement, and Agent Run.

ADR-0001 decides that Temporal will own durable delivery workflows. ADR-0003 decides that Codex execution must go through `CodexRunner`. ADR-0004 decides that every real Workspace Run uses a dedicated worktree and branch boundary. ADR-0005 decides Work Item claim and execution fencing. ADR-0006 decides that contract-changing work needs first-class compatibility and approval evidence.

This ADR records the production strategy for branch naming, PR ownership, review ownership, merge queue behavior, conflict handling, failed merge recovery, rollback, and audit evidence. It does not implement the GitHub adapter or merge queue in this docs-only task.

## Decision Drivers

- Every code-producing Agent Run needs an unambiguous branch, base commit, head commit, and PR record that can be traced to a Work Item and Workspace Run.
- Implementation agents must not merge their own work or bypass review, CI, contract, approval, or acceptance gates.
- Review must be owned by the role affected by the change, with maintainer override and audit evidence for production merges.
- Merge ordering must be deterministic enough to avoid agents racing to update the same base branch.
- Stale branches and conflicts must be resolved through explicit rerun, rebase, or human intervention paths rather than silent force pushes.
- CI, contract checks, security checks, and relevant E2E checks must be attached to the exact candidate commit that may merge.
- Failed queue entries, failed provider operations, and rollback decisions must leave product-state evidence instead of living only in Git provider logs.

## Decision

Use a platform-owned PR lifecycle with run-scoped source branches, role-owned review, and a serialized merge queue per target repository and base branch.

Implementation agents may create commits on their assigned Workspace Run branch and may update the linked PR branch while their Work Item ownership fence is valid. They must not merge, fast-forward, force-push another run's branch, close another run's PR, or publish production releases.

Reviewer agents and automated policy checks produce Review records, Test Runs, findings, and approval recommendations. They do not own the final merge decision. The merge owner is a human maintainer, a repository maintainer role, or a policy-controlled merge workflow acting on behalf of a maintainer after all required gates have passed.

The merge queue is the only production path from approved PR to target base branch. Direct pushes to protected base branches are break-glass operations and must be imported as Audit Events with the actor, reason, resulting commit, and follow-up risk review.

## Branch Naming

Production source branches use a PatchPilot namespace:

```text
patchpilot/<project-or-repo-slug>/<work-item-id>/<agent-run-id>
```

All segments are lowercase, ASCII, URL-safe Git ref segments. The platform must strip or replace whitespace, path traversal, leading dots, lock-file suffixes, and other invalid Git ref characters. The branch name must be deterministic from product-state ids, but unique per Agent Run so rework and retry attempts do not collide.

The branch record must preserve:

- repository id or remote URL;
- target base branch;
- base commit resolved before Workspace Run start;
- source branch name;
- creating Work Item, Workspace Run, and Agent Run;
- head commit after agent completion;
- current provider branch URL when available;
- branch update actor and idempotency key.

The current MVP fallback `patchpilot/<work-item-slug>` style remains acceptable for local Pull Request records until the GitHub PR adapter lands. Production adapters must use the run-scoped naming above.

## Pull Request Ownership

Use one active PR candidate per successful Agent Run. A Work Item may accumulate multiple PRs across rejected runs, rework, or conflict-resolution attempts, but only one PR for that Work Item may be active in the merge queue at a time.

The implementation agent owns the source branch until it marks the Agent Run complete. After completion, branch updates are allowed only through explicit rework, conflict-resolution, or maintainer-controlled queue operations. A stale process from an older Agent Run must fail fenced writes and branch updates under ADR-0005.

The Pull Request body must include or link to:

- Requirement and PRD identifiers;
- Work Item id, title, scope, and non-goals;
- Agent Run and Workspace Run identifiers;
- base branch, base commit, source branch, and head commit;
- changed-file summary and risk summary;
- Test Run evidence, including skipped or failed checks;
- contract diff and breaking-change Approval evidence when applicable;
- reviewer summary and open findings;
- audit trace id or evidence bundle reference.

Provider-specific PR ids and URLs are integration details. PatchPilot product state remains the authority for PR lifecycle status, gate state, queue state, and acceptance readiness.

## Review Ownership

Every PR must have a Review record before it can enter the merge queue.

Review ownership is role-based:

- Backend-owned changes require backend or reviewer-role review.
- Frontend-owned changes require frontend or reviewer-role review.
- Test infrastructure changes require test or reviewer-role review.
- Ops, sandbox, CI, release, network, secret, or deployment changes require ops or security-capable review.
- Contract-changing PRs require provider review plus impacted consumer-role evidence from ADR-0006.
- High-risk or policy-changing PRs require an Approval record in addition to ordinary review.

Automated reviewer agents may produce findings and a recommended status of `approved`, `changes_requested`, or `blocked`. A human maintainer or configured repository policy owns the final enqueue and merge decision for production branches. If a maintainer overrides a blocked or high-risk recommendation, the override must record the reason, actor, risk level, and accepted follow-up.

Self-review is not sufficient for production merge. The Agent Run that produced the branch may attach a self-check summary, but a distinct reviewer actor or policy gate must create the merge-eligible Review record.

## CI And Quality Gates

The merge queue may accept only PRs whose latest candidate head has passed all required gates for the changed surface.

Required baseline gates:

- repository lint, typecheck, unit tests, and build commands when configured;
- generated artifact drift checks such as OpenAPI and event schema checks when those artifacts exist;
- targeted Test Runs tied to the Work Item acceptance criteria;
- relevant E2E or smoke checks for user-facing, workflow, runner, or integration changes;
- contract Test Runs and breaking-contract Approval records for contract changes;
- migration validation for database schema changes;
- secret scanning and artifact redaction checks once ADR-0008 and ADR-0009 tasks land;
- Capability Manifest, sandbox, network, and command-policy checks once those production gates land.

Gate results must be linked to the exact head commit or merge-queue integration commit they validate. A check result from an older head commit, older base commit, or previous Agent Run is stale and cannot satisfy the gate unless the queue explicitly proves the tree is identical.

Docs-only PRs may use a reduced gate set, but the reduced set must be explicit in the PR evidence. At minimum it should include Markdown/path sanity checks, `git diff --check`, and the repository's standard lint/test checks when feasible.

## Merge Queue Behavior

Use one serialized merge queue per repository and target base branch. The queue owns ordering, integration testing, merge execution, and post-merge evidence.

Queue admission requires:

1. Pull Request status is `ready_for_review` or `approved`.
2. Required Review records are approved or have accepted exceptions.
3. Required Test Runs and CI checks are passing for the latest candidate.
4. Required Approval records are approved and unexpired.
5. The candidate has no unresolved blocker findings, active critical Defects, or stale contract baselines.
6. The source branch still points at the candidate head commit recorded by PatchPilot.

Initial production behavior should merge one PR at a time. The queue creates or asks the Git provider to create an integration candidate from the current base tip plus the PR head. It then runs required gates against that integration candidate. If the gates pass and the candidate is still current, the queue merges the PR and records the resulting base-branch commit.

Batching is allowed only after the queue can isolate a failing PR from a failing batch, preserve per-PR evidence, and rerun the surviving candidates without losing audit traceability. Until then, batching is a future optimization.

Default merge method is squash merge unless a repository policy selects merge commits. Squash commits must include PatchPilot trailers or equivalent metadata for Requirement, PRD, Work Item, Agent Run, Pull Request, Review, TestRun summary, and audit trace. Repositories that require linear history may use provider rebase/merge-queue support, but PatchPilot must still record the reviewed head, integration commit, and final base commit.

## Conflict And Rebase Policy

Base branch movement is normal. Conflict handling depends on whether the candidate can be integrated mechanically.

If the PR branch is behind but merges cleanly, the merge queue may test an integration candidate without rewriting the source branch. This preserves the reviewed head while proving the current base plus candidate tree. If repository policy requires the source branch itself to be rebased, only the merge workflow or branch owner may update it, and the previous head commit must remain recorded.

If the provider reports textual conflicts, missing files, deleted files, generated artifact drift, lockfile divergence, migration ordering conflicts, or contract baseline conflicts, the queue removes the PR from active position and marks it `changes_requested` or `blocked` with conflict evidence. PatchPilot then creates one of these follow-up paths:

- rework by the original Work Item role on a new Agent Run and branch;
- a dedicated conflict-resolution Work Item when multiple prior PRs are involved;
- human maintainer resolution on the same PR branch when the maintainer explicitly accepts ownership.

Automated conflict resolution is allowed only for mechanical changes covered by tests, such as regenerated artifacts or simple dependency lock refreshes. Semantic conflicts, contract conflicts, data migrations, deleted APIs, security policy changes, and production configuration conflicts require human review or an explicit Approval record before reenqueuing.

Force-pushing a source branch is not the default conflict path. If used, it must be done by the current branch owner or merge workflow, it must preserve the old head as evidence, and it must invalidate stale checks and reviews unless the queue can prove the reviewed diff is unchanged.

## Failed Merge And Rollback Handling

A failed queue entry must not block the queue indefinitely. The queue records the failure, removes or pauses the entry, updates the Pull Request status, and continues with the next eligible entry when safe.

Failure handling rules:

- Provider API failures are retried with idempotency keys before the PR is marked failed.
- Failed integration checks mark the PR `changes_requested` and attach failing TestRun or check evidence.
- Merge conflicts mark the PR `blocked` or `changes_requested` with conflict details.
- Missing approval, stale review, stale head, or stale base evidence pauses the PR until refreshed.
- A partial provider operation must be reconciled by reading the provider state before retrying or marking terminal failure.

Rollback is a new Pull Request or workflow action, not an untracked local reset. The default rollback path is a revert PR that links to the original merged PR, base commit, merge commit, Defect or incident, approval decision, Test Runs, and audit trace. Emergency direct reverts are allowed only for maintainer break-glass use and must be imported into PatchPilot with the same evidence shape after the fact.

If a post-merge regression is found, PatchPilot should create a Defect with reproduction evidence and link it to the merged Pull Request, TestRun, Work Item, and rollback candidate. The rollback PR must pass the same relevant quality gates unless an emergency approval documents why a reduced gate set was accepted.

## Audit Evidence

PatchPilot must write Audit Events for meaningful PR and queue actions:

- source branch created, pushed, rebased, force-pushed, archived, or deleted;
- Pull Request opened, updated, marked ready, closed, reopened, or superseded;
- review requested, completed, blocked, overridden, or invalidated;
- check suite started, completed, failed, skipped, or marked stale;
- queue entry admitted, ordered, paused, dequeued, integrated, failed, merged, or cancelled;
- conflict detected, conflict-resolution Work Item created, conflict resolved, or conflict waived;
- merge completed, provider reconciliation completed, rollback requested, rollback merged, or break-glass direct change imported.

Audit metadata should include actor, target repository, base branch, base commit, source branch, head commit, provider PR id, queue entry id, integration commit, final merge commit, related Requirement, PRD, Work Item, Agent Run, Workspace Run, TestRun ids, Review ids, Approval ids, trace id, and artifact ids where available.

Audit Events are the product-state explanation. Raw provider webhooks, CI logs, diffs, and screenshots belong in artifact storage with checksums and references from product state.

## Relationship To Implementation Tasks

`TD-215` should implement the GitHub PR adapter without weakening the lifecycle in this ADR. It should create or update provider PRs, push source branches, read provider checks, and write Pull Request and Review evidence through repository commands.

`TD-304` should implement GitHub App authentication, webhooks, and permissions so PatchPilot can enforce protected branch and merge queue behavior through installation-scoped credentials rather than personal tokens.

`WorkItemExecutionWorkflow` should stop at PR-ready evidence. Merge queue and rollback behavior should be separate repository workflows or activities so implementation retries do not accidentally merge code.

## Alternatives Considered

### Let Agents Push Directly To Main

This is fast and simple for local validation.

Rejected because it bypasses review, quality gates, branch protection, conflict ordering, rollback evidence, and human acceptance.

### One Long-Lived Branch Per Work Item

A stable Work Item branch is easy to find and can be reused across rework.

Rejected as the production default because multiple Agent Runs, rejected attempts, conflict resolution, and stale process recovery need run-level traceability. A Work Item may have many attempts, and each attempt needs its own head commit and evidence.

### Permanent Feature Branch Per PRD

Grouping all Work Items for a PRD into one branch can make final acceptance feel cohesive.

Rejected because it hides independent Work Item evidence, increases merge conflicts, blocks low-risk slices behind unrelated work, and makes targeted rollback harder.

### Provider-Only Merge Queue

GitHub or another provider may already offer merge queue behavior.

Rejected as the only authority because PatchPilot also owns PRD, Work Item, Agent Run, TestRun, contract, Approval, Defect, cost, and Audit Event state. Provider queues can be used as the execution backend, but PatchPilot must still store queue entries, eligibility decisions, evidence, and outcomes.

### Always Rebase Branches Before Review

This keeps branches current with the base branch.

Rejected as a blanket rule because frequent rebase and force-push churn invalidates reviews and makes audit harder. The queue should test the integration candidate first and rebase source branches only when policy or conflict resolution requires it.

### Batch Merge Everything After PRD Acceptance

Batching can reduce CI cost and ensure a PRD lands atomically.

Rejected as the initial strategy because one failing Work Item would block unrelated accepted slices and make failure attribution harder. Atomic PRD-level release remains a future release workflow decision, not the base PR merge strategy.

## Consequences

- Branch and PR records become durable product-state objects, not only Git provider side effects.
- The platform needs repository commands for branch creation, PR creation/update, review recording, queue admission, queue status transitions, merge completion, and rollback evidence.
- CI and TestRun evidence must be commit-specific. Stale checks become a first-class blocker.
- Merge queue implementation needs provider reconciliation because Git provider state, webhooks, and PatchPilot product state can temporarily diverge.
- Rework and conflict resolution may create additional Agent Runs and PRs for one Work Item, so UI and acceptance flows must show active vs superseded candidates clearly.
- Human maintainers remain in control of production merges until policy gates are mature enough for narrower automation.

## Production Enforcement Exit Criteria

Treat this PR and merge strategy as production-enforceable when all of the following are true:

1. Source branch creation uses the run-scoped `patchpilot/<project-or-repo-slug>/<work-item-id>/<agent-run-id>` convention and records base/head commits in product state.
2. GitHub or another provider adapter can push branches, create/update PRs, read PR status/checks, and reconcile provider webhooks idempotently.
3. Pull Request, Review, queue entry, conflict, merge, and rollback state are persisted in the product-state repository with Audit Events.
4. Branch protection prevents direct unapproved writes to production base branches by agent credentials.
5. Required Review records and Approval records are enforced before queue admission.
6. Required CI, TestRun, contract, migration, security, and E2E gates are mapped to changed surfaces and validated against the candidate commit or integration commit.
7. The merge queue serializes candidates per repository/base branch, handles stale heads and provider failures idempotently, and records final merge commits.
8. Conflict handling can distinguish clean integration, textual conflicts, generated-artifact drift, contract baseline conflicts, and migration ordering conflicts.
9. Rework, conflict-resolution, and superseded-PR flows preserve old PR/head evidence and prevent stale workers from updating product state.
10. Rollback creates linked revert PRs or imports emergency direct reverts with Defect, Approval, TestRun, and Audit Event evidence.
11. E2E coverage proves a Work Item can produce a provider PR, receive review, pass checks, enter the queue, merge, and produce an auditable final state.
12. Failure E2E coverage proves stale checks, merge conflict, failed CI, missing approval, provider retry, and rollback paths.

## Non-Goals

- This ADR does not implement `TD-215`, `TD-304`, or a merge queue service.
- This ADR does not change the current local `local://pull-requests/:runId` MVP behavior.
- This ADR does not decide long-term release and deployment approval; see `TD-307`.
- This ADR does not decide secret, MCP tool, network, or dangerous-operation approval policy in detail; see ADR-0009.
- This ADR does not decide Audit Event retention, redaction, or export policy; see ADR-0008.
- This ADR does not require agents to resolve every merge conflict automatically.
