# ADR-0010: Test and Contract Validation Strategy

Status: accepted

Date: 2026-06-11

## Context

PatchPilot is an agent delivery control platform, so tests are not only CI commands. They are product-state evidence used by planning, execution, review, contract approval, acceptance, retrospective, and defect workflows.

The current runnable MVP already has reusable `TestCase` records, `TestRun` evidence, configurable project test commands, failed-run classification, failure Defect creation for failed TestRuns, and acceptance quality gates that block on failed TestCases, unresolved Defects, flaky signals, incompatible InterfaceContracts, missing PR evidence, and invalid audit integrity. `@patchpilot/testing` runs configured commands with timeout, retry, output parsing, git metadata, artifacts, and flaky signals. `@patchpilot/contracts` publishes generated HTTP, event, and shared-state artifacts, and ADR-0006 defines the durable InterfaceContract registry and breaking-change strategy.

The technical design distinguishes targeted tests, full or smoke tests, contract tests, regression tests, and bug reproduction evidence. The PRD also requires that failed tests become traceable failure records linked to commit, Work Item, Agent Run, and Defect when appropriate.

This ADR records the durable strategy for when PatchPilot runs targeted tests, when it escalates to full suites, how contract validation participates in gates, and when failures must be persisted as Defects. It does not implement a new test runner, contract registry, or workflow behavior in this docs-only task.

## Decision Drivers

- Agents need fast feedback while editing, but acceptance and merge decisions need broader evidence.
- Test evidence must be linked to the exact commit, branch, workspace, PR, Work Item, PRD, Agent Run, TestCase, contract revision, and artifact set it validates.
- Contract changes require provider and consumer evidence, not only ordinary unit tests.
- A failed test should not disappear as command output. Durable failures need triage state, ownership, reproduction evidence, and acceptance-gate impact.
- Flaky, skipped, blocked, stale, and retried tests must be visible rather than treated as silent success.
- Docs-only and low-risk changes may use a reduced gate set, but the reduction must be explicit and auditable.
- The strategy must fit ADR-0006 contract registry decisions, ADR-0007 PR/merge gates, and ADR-0008 evidence retention boundaries.

## Decision

Use a staged evidence strategy:

1. Run targeted tests first for the Work Item's changed surface and acceptance criteria.
2. Run contract validation whenever generated contracts, public API behavior, event streams, shared schemas, SDKs, or consumer mappings may change.
3. Run smoke or E2E checks for user-visible, workflow, runner, integration, or operational surfaces.
4. Run full repository validation before PRD acceptance, merge-queue admission, release approval, or any high-risk override.
5. Persist every gate-affecting result as a `TestRun` linked to the relevant `TestCase`, Agent Run, Work Item, PRD, commit, branch, workspace, PR, artifacts, and contract revision where applicable.
6. Convert confirmed test failures into `Defect` records when they survive the allowed retry or repair policy, indicate a product or repository regression, or block acceptance.

Targeted tests are the default inner loop. Full validation is the outer gate. Contract validation is first-class quality-gate evidence, not a subsection of ordinary unit tests.

## Test Suite Taxonomy

PatchPilot recognizes these test and validation classes:

- **Static and docs sanity**: `git diff --check`, Markdown/path/link checks, generated artifact drift checks, schema checks, lint, and typecheck where applicable.
- **Targeted tests**: the smallest command set expected to validate one Work Item's acceptance criteria and touched code path, such as a package test, API integration test, component test, or focused regression test.
- **Contract tests**: provider validation, consumer compatibility checks, generated artifact drift checks, registry diff checks, and migration/deprecation checks for InterfaceContracts.
- **Smoke tests**: low-cost happy-path checks proving the app, CLI, API, worker, or user-facing flow still starts and reaches an expected milestone.
- **E2E tests**: end-to-end product flows across UI/API/worker/workflow boundaries, including bug, team, acceptance, approvals, metrics, egress, or Temporal scenarios.
- **Full repository validation**: the configured full lint, typecheck, unit, build, generated-artifact, and required E2E or smoke commands for the target repository.
- **Regression and reproduction tests**: tests tied to a Defect or bug report that prove the failure before the fix and pass after the fix.

Every executable class should produce `TestRun` evidence. Non-executable sanity checks may be represented as `TestRun` evidence when they gate acceptance, or as Audit Events/artifacts when they are part of review-only evidence.

## Changed-Surface Mapping

PatchPilot must choose tests from a changed-surface map rather than from agent preference alone.

The map should consider:

- changed file paths, package ownership, and Work Item role;
- PRD acceptance criteria and generated `TestCase` steps;
- public HTTP API routes and OpenAPI artifacts;
- event stream payloads, terminal statuses, ordering, and reconnect behavior;
- shared domain schemas and generated schema artifacts;
- UI pages, components, and browser workflows;
- worker, CodexRunner, Workspace Manager, sandbox, network, secret, policy, or command wrapper surfaces;
- database schema, migrations, data access, and rollback or compensation paths;
- docs-only surfaces and whether they reference code, commands, ADRs, links, or configuration;
- previously linked Defects, flaky tests, skipped tests, and accepted exceptions.

The scheduler or reviewer may start with a conservative static mapping. Production enforcement should evolve toward a repository-owned test manifest that maps paths and contract identities to target, smoke, E2E, and full commands.

## Targeted Test Policy

Targeted tests are required for every code-producing Agent Run unless an explicit test exception is recorded.

A targeted TestRun must:

- execute after the agent's candidate changes are present in the isolated Workspace Run;
- validate the Work Item's acceptance criteria or the Defect's reproduction/regression criteria;
- link to the relevant `TestCase`;
- record command, status, duration, retry metadata, flaky signal, runner, environment image, workspace path, commit, branch, log artifact, and failure summary when available;
- be stale if it was not run against the candidate commit or a proven identical tree.

Targeted tests may be enough for local repair feedback and low-risk docs-only review. They are not enough by themselves for merge, release, breaking contract approval, or final PRD acceptance unless the changed-surface map explicitly says no broader gate is relevant.

When a targeted test fails, the agent may get the configured repair attempts. Each attempt must preserve the previous TestRun evidence or retry metadata. A later passing attempt marks `flakySignal=true` when an earlier attempt failed without a code or environment explanation.

## Full Validation Policy

Full repository validation is required before these decisions:

- PRD-level final acceptance when one or more Work Items changed code;
- merge-queue admission or equivalent production-branch readiness;
- release approval or rollback approval;
- high-risk PR review approval;
- accepting a change after flaky, skipped, blocked, or previously failed targeted evidence;
- accepting cross-cutting changes that touch shared domain types, config, runner behavior, workflow behavior, database schema, security policy, sandboxing, network egress, secret handling, generated artifacts, or dependency lockfiles.

Full validation should include the repository's configured lint, typecheck, unit test, build, generated artifact checks, and required smoke/E2E checks. For this repo today, the normal baseline includes commands such as `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm openapi:check`, and `pnpm events:check`, with E2E commands selected by changed surface.

Docs-only changes may use a reduced full gate, but the evidence must say why. The minimum docs-only gate is:

- path and link sanity for referenced docs;
- `git diff --check`;
- the repository's normal lint and test checks when feasible.

Skipping full validation requires an accepted exception with owner, reason, scope, expiration, residual risk, and follow-up TestCase or Defect when appropriate.

## Contract Validation Policy

ADR-0006 owns the Contract Registry, compatibility diffing, provider/consumer ownership, breaking-change approval, and contract TestRun expectations. This ADR defines when those checks become part of the testing strategy.

Run contract validation when a change touches or may alter:

- OpenAPI, event schema, shared-state schema, generated client, generated SDK, or contract artifact source;
- API route, method, operation id, request or response shape, auth, permission, idempotency, pagination, or error semantics;
- AgentRun event stream payloads, terminal statuses, ordering, reconnect behavior, or fallback rules;
- shared domain types used by frontend, backend, worker, CLI, test, ops, reviewer, or integration adapters;
- provider/consumer mapping or contract registry data;
- contract-related approvals, quality gates, or generated artifact drift checks.

Required contract evidence includes:

- generated artifact drift checks such as OpenAPI and event schema checks;
- registry diff against the latest approved baseline;
- provider-side validation of the generated artifact;
- consumer-side compatibility checks for every impacted consumer role;
- breaking-contract Approval evidence for any breaking diff;
- migration, deprecation, or fallback checks when a breaking change is approved.

Contract TestRuns use `TestCaseKind=contract` and must be linked to the relevant PRD, Work Item, Agent Run, commit or branch, contract identity, proposed revision, diff artifact, provider role, and impacted consumer roles. A compatible diff can pass with provider validation plus impacted consumer checks. A breaking diff cannot pass until the Approval record is approved and unexpired, required TestRuns pass, and accepted exceptions are explicit.

A stale contract baseline blocks acceptance and merge even if ordinary unit tests pass.

## Smoke And E2E Escalation

Smoke or E2E checks are required when targeted tests cannot prove the behavior at the product boundary.

Escalate to smoke or E2E when a change affects:

- requirement intake, PRD approval, Work Item planning, scheduler dispatch, worker execution, acceptance, rework, or bug workflow;
- Web UI pages, responsive layouts, browser-only behavior, or user-facing flows;
- CLI flows, API/worker integration, SSE streaming, telemetry, metrics, artifact collection, or audit verification;
- CodexRunner, Workspace Manager, sandbox, network egress, secret broker, command wrapper, or policy enforcement;
- database persistence, migrations, workflow orchestration, or provider adapters.

The selected E2E suite should match the changed surface. Running every E2E on every small change is not the default inner loop, but acceptance evidence must explain why omitted E2E suites were not relevant.

## Failure To Defect Rules

A failed TestRun becomes a Defect when all of these are true:

- the failure is linked to an Agent Run, Work Item, PRD, and candidate commit or branch;
- the failure is deterministic or classified as `test_failed`, or it is flaky enough to threaten acceptance;
- configured retries and repair attempts are exhausted, or the failure blocks an immediate review, acceptance, or merge decision;
- the failure is not solely an infrastructure outage, missing dependency, denied policy, budget stop, or operator-cancelled run.

The Defect must include:

- title and summary of the failed Work Item or behavior;
- reproduction steps with TestRun id, command, workspace, commit, branch, and artifact ids when available;
- expected and actual behavior;
- severity derived from failure type, affected surface, and user/business impact;
- status starting at `reported` or `needs_repro`;
- reporter as `system`, `test-runner`, reviewer, user, or integration source;
- links to Requirement, PRD, Work Item, Agent Run, TestRun, commit, branch, Pull Request, contract revision, and artifacts where available.

PatchPilot should deduplicate Defects by source run and TestRun first, then by stable failure signature when the same failing test recurs across attempts or rebases. Repeated flaky failures should create or update a flaky Defect rather than being hidden behind eventual success.

Do not create a product Defect for a pure environment failure unless a reproduction or reviewer confirms it represents a repository or platform bug. Environment failures should still produce AgentRun failure evidence, Audit Events, and possibly an ops Work Item. Policy denials and budget exhaustion should route to Approval or failed terminal state, not Defect, unless they expose a confirmed policy or product bug.

Unresolved Defects block acceptance when they are linked to the PRD, Work Item, run, contract, or candidate PR and are not `closed` or `unreproducible`. Closing a Defect requires regression evidence: the previous failure is reproducible or sufficiently explained, and the fix has a passing TestRun for the same behavior.

## Skips, Blocks, Flakes, And Exceptions

`skipped` and `blocked` TestRuns are not passing evidence.

A skipped or blocked required test must record:

- reason;
- owner;
- affected TestCase or contract identity;
- expiration or follow-up date;
- accepted exception Approval or reviewer decision when it affects acceptance;
- residual risk and replacement evidence, if any.

Flaky tests are quality signals. A passing final attempt with earlier failures can unblock the local repair loop, but it remains a blocker for final acceptance or merge unless a reviewer or policy accepts the exception and creates follow-up ownership.

Quarantine is allowed only when it is explicit, time-bounded, owned, and linked to a Defect or follow-up Work Item. Quarantine does not make the original risk disappear from PR, acceptance, or retrospective evidence.

## Quality Gates

Use these gate rules:

- **Agent repair gate**: targeted tests may drive automatic repair until the configured attempt limit. Failed attempts remain evidence.
- **PR review gate**: targeted tests, changed-surface contract checks, relevant smoke/E2E, generated artifact drift checks, and review evidence must be current for the PR head.
- **Contract gate**: any contract-changing PR must pass ADR-0006 registry diff, provider validation, impacted consumer checks, and required breaking-change Approval.
- **Acceptance gate**: all required TestCases pass for the accepted scope, unresolved Defects are closed or marked unreproducible, contract baselines are approved, flaky/skipped/blocked tests have accepted exceptions or are resolved, PR evidence is ready, and audit integrity is valid.
- **Merge gate**: all acceptance-relevant checks plus repository CI/full validation must pass against the candidate head or merge-queue integration commit.
- **Release or rollback gate**: merge evidence plus release-specific smoke/E2E, migration, rollback, approval, and incident/Defect evidence must pass.

Any gate decision that accepts less evidence than the changed-surface map requires an Approval, Review override, or equivalent policy exception with Audit Events.

## Audit And Retention

Test and contract gate decisions must write Audit Events when they affect product state, approval, review, acceptance, merge, defect, or policy decisions. Required actions include:

- `test_run.passed`, `test_run.failed`, `test_run.blocked`, `test_run.skipped`, or equivalent stable actions for gate-affecting results;
- `defect.created`, `defect.updated`, `defect.reproduced`, `defect.closed`, or equivalent actions for Defect lifecycle changes;
- contract registry proposal, diff, approval request, decision, baseline promotion, deprecation, rollback, and stale-baseline decisions from ADR-0006;
- accepted exceptions for skipped, blocked, stale, or flaky evidence.

Raw logs, screenshots, full test reports, traces, and contract diffs belong in artifacts with checksums and retention metadata. `TestRun`, `Defect`, `Approval`, `ReviewRecord`, and `AuditEvent` records should store summaries and artifact ids, not unbounded command output.

## Relationship To Existing And Future Tasks

`TD-107` already provides the current `@patchpilot/testing` command runner. Future work should extend it or wrap it rather than bypassing `TestRun` evidence.

`TD-216` should implement the registry, diff, provider/consumer mapping, breaking-change Approval, and contract gate state required by ADR-0006 and used by this ADR.

`TD-217` should implement executable provider and consumer contract tests, contract TestCase generation, changed-surface mapping for contract consumers, and fixtures proving compatible, warning, breaking, skipped, stale, and approved-breaking scenarios.

`TD-209` should implement Defect reproduction workflow behavior that consumes Defects created from failed TestRuns and proves the fix with regression evidence.

`TD-215`, ADR-0007 merge queue work, and future CI provider adapters should import external check results as TestRuns or check evidence tied to the exact candidate commit.

`TD-218` and `TD-219` should enforce that all test commands, generated artifact commands, and contract checks run through the Capability Manifest and command wrapper.

## Alternatives Considered

### Always Run The Full Suite First

This is simple and conservative.

Rejected as the only strategy because it makes the agent repair loop slow, expensive, and noisy. Full validation remains required for outer gates, but targeted tests are the correct inner-loop feedback.

### Only Run Targeted Tests

This keeps agents fast and focuses on the assigned Work Item.

Rejected because agents can miss cross-package, contract, integration, generated artifact, and acceptance regressions. Targeted tests are necessary but not sufficient for acceptance or merge.

### Treat Contract Checks As Ordinary Unit Tests

Contract checks could live inside `pnpm test`.

Rejected as the full strategy because PatchPilot needs contract-specific revision, diff, provider/consumer, approval, and compatibility evidence. Ordinary unit tests may execute some checks, but the product-state evidence must remain first-class.

### Let Failed Runs Stay As Logs

Failed command output and run summaries can explain many failures.

Rejected because logs are not triage state. Confirmed failures need Defect ownership, reproduction steps, severity, status, links to evidence, and acceptance-gate impact.

### Automatically Create Defects For Every Failed Command

This maximizes traceability.

Rejected because environment failures, policy denials, budget stops, cancelled runs, and transient infrastructure issues are not always product Defects. They still need evidence and audit records, but Defect creation should be tied to confirmed product, repository, contract, or flaky test failures.

### Allow Skips To Pass With A Comment

This matches some lightweight CI setups.

Rejected because PatchPilot coordinates autonomous agents. A skipped required check must have owner, reason, expiration, exception evidence, and residual-risk visibility.

## Consequences

- Test selection becomes a product policy decision, not only a command configured in `.patchpilot/config.yaml`.
- `TestRun` evidence must be commit-specific and stale-aware.
- Contract validation must be surfaced alongside ordinary test evidence in PR, review, acceptance, and merge gates.
- Failed TestRuns can create Defects that block acceptance until resolved or marked unreproducible.
- Flaky and skipped tests become explicit work rather than hidden green builds.
- Docs-only changes still need lightweight sanity and normal repo checks when feasible.
- Future scheduler, CI, contract registry, and merge queue work need a shared changed-surface map.

## Production Enforcement Exit Criteria

Treat this test and contract validation strategy as production-enforceable when all of the following are true:

1. Every Work Item has generated or imported TestCases linked to PRD acceptance criteria, Defects, and contract identities where applicable.
2. The scheduler or review gate can map changed surfaces to targeted, contract, smoke, E2E, and full validation commands.
3. TestRuns are persisted with commit, branch, PR, workspace, runner, environment, retry, flaky, artifact, and failure metadata.
4. TestRun staleness is detected when candidate head, base, contract revision, or changed-surface mapping changes.
5. Targeted tests run before automatic repair, and failed attempts remain visible as evidence.
6. Full validation is required before PRD acceptance, merge-queue admission, release approval, and high-risk overrides.
7. Contract-changing work runs registry diff, provider validation, impacted consumer tests, generated artifact drift checks, and breaking-change Approval checks.
8. Failed TestRuns create or update Defects according to the rules in this ADR, and unresolved Defects block acceptance.
9. Skipped, blocked, flaky, or stale required checks require explicit accepted exceptions with owner, expiration, and audit evidence.
10. External CI and provider check results can be imported or linked without losing PatchPilot product-state authority.
11. Audit Events and artifact records cover gate-affecting test results, contract decisions, Defect creation/resolution, and accepted exceptions.
12. E2E fixtures prove targeted pass, targeted fail to Defect, flaky signal, skipped required check, stale TestRun, contract compatible change, contract breaking change with denied approval, contract breaking change with approved migration, and full-suite gate failure.

## Non-Goals

- This ADR does not implement `TD-216`, `TD-217`, `TD-209`, `TD-215`, `TD-218`, or `TD-219`.
- This ADR does not replace ADR-0006's Contract Registry and breaking-change strategy.
- This ADR does not choose a specific external CI provider.
- This ADR does not require every inner-loop agent repair attempt to run the full suite.
- This ADR does not weaken ADR-0007 merge queue or ADR-0008 audit and retention requirements.
- This ADR does not change current public API routes, domain schemas, or generated contract artifacts.
