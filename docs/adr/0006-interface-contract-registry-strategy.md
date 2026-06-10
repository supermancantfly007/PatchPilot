# ADR-0006: InterfaceContract Registry and Breaking Change Strategy

Status: accepted

Date: 2026-06-11

## Context

PatchPilot uses Interface Contracts as collaboration baselines between planning, implementation, test, review, and operations agents. The current runnable MVP already has `@patchpilot/contracts`, which defines the public HTTP API artifact, Agent Run SSE event artifact, and shared delivery-state schema artifact. It also generates OpenAPI, an equivalent event schema document, and `InterfaceContract` product-state records.

The current `InterfaceContract` shape records `kind`, `status`, `version`, `providerRole`, `consumerRoles`, `specMarkdown`, and `testSuggestions`. The current statuses are `draft`, `approved`, `breaking_change_pending`, and `deprecated`. `ApprovalRecord` already supports `breaking_contract`, and `TestCaseKind` already supports `contract`.

`TD-103` split contract artifacts into `packages/contracts`. `TD-104` and `TD-105` generate OpenAPI and event schema artifacts. The technical design says the Contract Registry must store OpenAPI files, event schema files, shared schema files, contract diffs, provider/consumer mappings, contract TestRuns, and breaking change approvals.

`TD-216` and `TD-217` are not implemented yet. This ADR records the durable policy they should implement without adding runtime behavior in this docs-only task.

## Decision Drivers

- Interface Contracts must be durable, versioned product-state facts, not only generated Markdown attached to a PRD.
- Providers and consumers need a shared baseline before independent agents can safely work in parallel.
- Compatible changes should not require the same human approval path as breaking changes.
- Breaking changes must be explicit, reviewable, auditable, and linked to impacted consumers before work can be accepted.
- Contract tests must prove both provider validity and consumer compatibility against the same registry revision.
- Generated artifacts must remain reproducible from source, but the registry must preserve the approved baseline used for each PRD, Work Item, Agent Run, and TestRun.

## Decision

Use a product-state backed Contract Registry as the authority for InterfaceContract baselines, proposed revisions, compatibility diffs, provider/consumer ownership, contract TestRun evidence, and breaking change approvals.

`@patchpilot/contracts` remains the source package for generated contract definitions. The registry stores immutable revisions of those generated artifacts, their normalized content hash, their provider/consumer ownership metadata, and the approval and test evidence around changes. `InterfaceContract` records are the product-facing projection of registered artifacts for UI, snapshots, PRD planning, acceptance gates, and worker prompts.

Each registered contract has a stable identity:

- repository or project scope;
- contract kind: `http`, `event`, or `schema`;
- artifact id, such as the HTTP API artifact, Agent Run event stream artifact, or delivery-state schema artifact;
- provider role;
- consumer roles.

The registry must keep the latest approved revision immutable. A new generated artifact becomes a proposed revision first. The registry compares that proposed revision to the latest approved revision for the same identity before it can become the new approved baseline.

## Versioning

Use per-artifact immutable revisions for compatibility decisions.

The existing `contractVersion` value, currently `patchpilot.mvp.v1`, identifies the generator and artifact-family format. It is not by itself the compatibility approval result. The `InterfaceContract.version` number and the registry revision number should increment when the artifact content for that identity changes.

Every registered revision must include:

- artifact identity and kind;
- generator version;
- artifact revision number;
- normalized content hash;
- source package or generated-file reference;
- provider role and consumer roles;
- status;
- creation actor and timestamp;
- approved baseline reference when applicable;
- diff artifact reference when compared to another revision.

Compatible additions can become a new approved baseline after required contract checks pass. Breaking changes must stay `breaking_change_pending` until the required Approval record is approved and required contract TestRuns pass. Deprecated contracts remain addressable so historical PRDs, Agent Runs, TestRuns, and Audit Events can still explain which baseline they used.

## Compatibility Diff Policy

The registry must diff normalized artifacts rather than raw Markdown. Generated OpenAPI, event schema, and shared schema files should be parsed into stable structures before comparison so formatting-only changes do not create false breakage.

A diff result must classify each change as `compatible`, `warning`, or `breaking`, and it must name the impacted provider and consumer roles.

HTTP contract changes are breaking when they remove or rename a route, method, operation id, request field used by consumers, response field used by consumers, response status, or error shape; make an optional request field required; narrow an accepted input type; narrow a response type; change pagination or idempotency semantics; or require stricter auth, permissions, approval, secret, or network capabilities. Adding a new route, response field, optional request field, or non-conflicting status is compatible by default unless a consumer mapping says otherwise.

Event contract changes are breaking when they remove or rename an event, required envelope field, payload field, terminal status, ordering guarantee, reconnect behavior, or stream close rule; make an optional field required; narrow a payload type; or change whether consumers can fall back to snapshot polling. Adding optional fields or new event kinds is compatible when consumers must ignore unknown fields.

Shared schema changes are breaking when they remove or rename a field, make an optional field required, narrow a type, remove an enum member, change identifier semantics, or change a relationship required by UI, worker, CLI, test, or review code. Adding optional fields or new enum members is compatible only when all consumers are documented to ignore unknown values or have an explicit fallback.

Warnings should cover changes that are technically additive but likely require consumer attention, such as new enum values without proven exhaustive handling, larger payloads, new optional fields carrying sensitive data, or a new test obligation.

## Provider And Consumer Ownership

The provider role owns correctness and publication of a contract revision. For current artifacts, the backend role is the provider for HTTP API, Agent Run event stream, and shared delivery-state schema.

Consumer roles own compatibility evidence for the code paths that depend on the contract. Current consumer roles include frontend, test, ops, and reviewer. CLI, worker, repository, and integration-adapter surfaces should be mapped through the owning role until the domain model grows a more granular consumer vocabulary.

Provider responsibilities:

- keep generated artifacts reproducible from source;
- publish proposed registry revisions when changing contract behavior;
- explain migration impact in the diff summary;
- supply provider-side validation tests;
- request breaking-contract approval when required.

Consumer responsibilities:

- map owned code paths to the contract identities they consume;
- run consumer-side contract tests for impacted revisions;
- report blocked or incompatible changes before approval;
- update consumer code or accept a migration plan before a breaking change becomes approved.

The provider/consumer mapping is registry data, not only documentation. Scheduler, reviewer, and approval workflows should use it to decide which agents need contract context, which tests are required, and who must review or approve a breaking change.

## Breaking Change Approval

A proposed revision with any breaking diff must create or reference an `ApprovalRecord` with:

- `kind=breaking_contract`;
- `targetType=interface_contract`;
- `targetId` pointing at the proposed contract revision or its `InterfaceContract` projection;
- `riskLevel` derived from impacted consumers and runtime surface;
- requester, reason, expiration, PRD, Work Item, Agent Run, and diff artifact references where available.

Approval must be recorded before the proposed revision can become the approved baseline. The approval request should include the compatibility diff, impacted providers and consumers, required migration steps, required contract TestRuns, and any rollout or deprecation plan.

Approving a breaking change does not waive contract tests. It only allows the platform to proceed with a deliberately breaking migration after the required evidence exists. Denied or expired approvals leave the proposed revision blocked, and acceptance gates must treat the related InterfaceContract as incompatible.

The registry must write Audit Events for proposed revision creation, diff completion, breaking approval request, approval decision, baseline promotion, deprecation, and rollback or supersession.

## Contract TestRun Expectations

Any Work Item or PR that changes a registered contract must produce contract TestRun evidence before acceptance.

Contract TestRuns should use `TestCaseKind=contract` and must be linked to the relevant PRD, Work Item, Agent Run, commit or branch, contract revision, and diff artifact. The current `TestRun` shape already supports the core evidence fields: command, status, summary, duration, commit, branch, pull request id, workspace path, runner, environment image, log artifact, artifact ids, retry metadata, and failure summary.

Required contract evidence includes:

- registry diff check against the latest approved baseline;
- provider validation for the generated OpenAPI, event schema, or shared schema artifact;
- consumer checks for each impacted consumer role;
- generated-artifact drift checks where generated files are committed;
- migration or deprecation checks for approved breaking changes.

A compatible change may pass with provider validation plus impacted consumer checks. A breaking change requires all of the above plus an approved breaking-contract Approval record. A skipped or blocked consumer contract TestRun must block baseline promotion unless the Approval record explicitly documents the accepted exception and follow-up owner.

Contract TestRuns are quality-gate evidence, not advisory logs. PRD acceptance and PR review should treat missing, failed, blocked, or stale contract TestRuns as blocking when the diff says contracts changed.

## Relationship To TD-216 And TD-217

`TD-216` should implement the registry and approval side of this ADR:

- persisted contract revisions and immutable baselines;
- normalized OpenAPI, event schema, and shared schema diffing;
- provider/consumer mapping;
- `breaking_change_pending` status transitions;
- breaking-contract Approval creation and decision handling;
- Audit Events and acceptance-gate integration for contract compatibility.

`TD-217` should implement the test side of this ADR:

- provider and consumer contract TestCase generation;
- contract TestRun commands and evidence capture;
- consumer mapping coverage for frontend, backend, worker, CLI, test, ops, and reviewer surfaces as applicable;
- PR and acceptance gates requiring passing contract TestRuns for changed contracts;
- fixtures proving compatible, warning, and breaking changes.

TD-216 may create the required test obligations, but TD-217 owns making those obligations executable and reliable. Neither task should replace the generated artifact source in `@patchpilot/contracts`; they should register, diff, approve, and test those artifacts through the product-state workflow.

## Alternatives Considered

### Generated Files Only

OpenAPI and event schema files can be generated and checked in, and drift checks can catch some accidental changes.

Rejected as the full strategy because generated files alone do not preserve PRD-specific baselines, provider/consumer ownership, approvals, TestRuns, or Audit Events.

### SemVer Only

Semantic version numbers are familiar and useful for package release communication.

Rejected as the compatibility authority because contract safety depends on structural diffs and consumer usage. A version number can summarize a decision after the fact, but it cannot prove whether a particular route, event field, enum value, or schema relationship breaks a consumer.

### Provider-Only Approval

Letting the provider decide whether a change is compatible is simple.

Rejected because PatchPilot exists to coordinate independent agents. Consumers must have explicit evidence and, for breaking changes, a reviewable migration path before the baseline changes.

### Always Require Human Approval For Every Contract Change

This is conservative and easy to explain.

Rejected because additive and mechanically compatible changes should flow through automated contract checks. Human approval should be reserved for breaking or high-risk changes so the approval queue remains meaningful.

### Treat Contract Tests As Ordinary Unit Tests

Contract checks could be folded into `pnpm test`.

Rejected as the only representation because PatchPilot needs first-class TestRun evidence linked to the contract revision, diff, PRD, Work Item, Agent Run, and approval gate.

## Consequences

- Contract Registry becomes the authority for approved InterfaceContract baselines while `@patchpilot/contracts` remains the source package for generated definitions.
- Registry diffing must parse OpenAPI, event schema, and shared schema artifacts into stable structures.
- Provider/consumer ownership becomes product data that scheduling, review, approval, and testing workflows can query.
- Breaking contract changes become explicit Approval records and cannot be hidden inside ordinary code review.
- Contract TestRuns become required evidence for contract-changing work, including docs for skipped or blocked consumers.
- Existing MVP `InterfaceContract` fields remain compatible with this strategy, but TD-216 will need more detailed registry entities or artifact references than the current projection stores.

## Production Enforcement Exit Criteria

Treat InterfaceContract registry enforcement as production-ready when all of the following are true:

1. Every generated OpenAPI, event schema, and shared schema artifact can be registered with identity, revision, hash, provider role, consumer roles, status, and baseline reference.
2. The registry can diff proposed revisions against the latest approved baseline and classify compatible, warning, and breaking changes.
3. Breaking diffs create or require pending `breaking_contract` Approval records and block baseline promotion until approved.
4. Contract TestCases and TestRuns are created for provider validation and all impacted consumers.
5. Acceptance and PR review gates fail when required contract TestRuns are missing, failed, blocked without accepted exception, or stale for the proposed revision.
6. Audit Events cover proposal, diff, approval request, decision, baseline promotion, deprecation, and rollback or supersession.
7. Historical PRDs, Work Items, Agent Runs, TestRuns, Pull Request records, and Review records can identify the contract revision they used.
8. Fixtures cover compatible additions, warning changes, breaking HTTP changes, breaking event changes, breaking shared schema changes, denied approval, expired approval, and approved breaking migration.

## Non-Goals

- This ADR does not implement `TD-216` or `TD-217`.
- This ADR does not change the current generated OpenAPI or event schema artifacts.
- This ADR does not change public API routes, SSE payloads, or shared domain types.
- This ADR does not decide GitHub PR, merge queue, or branch conflict policy; see ADR-0007.
- This ADR does not decide secret, network, MCP tool, or dangerous-operation approval policy in detail; see ADR-0009.
- This ADR does not decide long-term Audit Event retention or redaction policy; see ADR-0008.
