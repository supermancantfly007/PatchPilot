# ADR-0008: AgentRun and AuditEvent Event Model, Retention, and Redaction

Status: accepted

Date: 2026-06-11

## Context

PatchPilot owns agent delivery state rather than delegating that state to Codex, Temporal, GitHub, logs, or an external issue tracker. The current product model already includes Agent Runs, Workspace Runs, Test Runs, Pull Request records, Review records, Approvals, Audit Events, artifacts, budgets, and defects.

The current runnable MVP stores product state in `PatchPilotStore` and exposes it through `/api/snapshot`. `TD-122` added formal Audit Events with actor, target, before/after JSON, metadata JSON, `hash`, and `previousHash`. The domain package can compute canonical SHA-256 hashes and verify the newest-first hash chain. `TD-220` added OpenTelemetry traces, metrics, and logs linked to Requirement, Work Item, Agent Run, Test Run, and Audit Event identifiers.

ADR-0001 assigns durable workflow execution history to Temporal. ADR-0002 assigns production product state to Postgres and artifact metadata to the repository layer. ADR-0003 requires Codex execution evidence to pass through `CodexRunner`. ADR-0004 requires worktree and sandbox evidence for real runs. ADR-0006 requires Audit Events around contract registry decisions.

Those decisions still leave several policy questions open:

- which event source is canonical when Agent Run events, Audit Events, Codex JSONL, command logs, artifacts, workflow history, SSE, and OpenTelemetry all describe the same delivery flow;
- where the boundary sits between user-facing run progress and tamper-evident audit evidence;
- how Audit Events relate to raw artifacts and their checksums;
- how long run logs, traces, screenshots, diffs, telemetry, and immutable audit facts should be retained;
- when redaction happens, and what happens if sensitive content reaches an event or artifact;
- what administrators can export for a PRD, Work Item, Agent Run, or audit review.

## Decision Drivers

- Operators, reviewers, and customers need a trustworthy record of who or what changed delivery state, which policy gates fired, which artifacts support the decision, and whether the record was altered.
- Product UI needs concise progress events and summaries without turning every token, command byte, or trace span into product state.
- Raw logs, provider streams, screenshots, prompts, and test output may contain secrets, credentials, personal data, repository internals, or customer content.
- Audit integrity requires append-only semantics and stable hashes, while privacy and security require minimization, retention limits, and redaction before broad access.
- OpenTelemetry must help operate the platform, but sampling, collector retention, or vendor outages must not affect audit completeness.
- Future enterprise deployments need exportable audit packages without making object storage or an observability backend the only evidence source.

## Decision

Use three separate but linked evidence layers:

1. `AgentRun` is the canonical product-state record for one execution attempt and its user-facing progress.
2. `AuditEvent` is the canonical append-only, tamper-evident record for meaningful product, policy, approval, security, and external-side-effect decisions.
3. `ArtifactRecord` plus object storage is the canonical evidence store for large or high-volume bytes such as logs, traces, diffs, screenshots, previews, test reports, and raw provider event streams.

Temporal workflow history, Codex provider history, Git history, command logs, SSE events, OpenTelemetry signals, and external tracker events are not PatchPilot's product-state authority. They may be sources for ingestion, recovery, debugging, or integrations, but PatchPilot must normalize durable facts into Agent Runs, Audit Events, Test Runs, Approvals, and Artifact records through the repository layer.

Audit Events must be written transactionally with the product-state mutation they describe whenever both are controlled by the repository layer. If an external side effect happens before the repository write, the activity must retry idempotently or record a compensating failure Audit Event that names the external id, artifact id, or provider handle.

## Canonical Event Sources

Use the following source-of-truth rules:

| Source | Canonical for | Not canonical for |
| --- | --- | --- |
| `AgentRun` | Execution attempt status, current step, concise timeline, normalized run events, result summary, cost, failure classification, artifact ids | Tamper-evident audit, raw logs, workflow durability |
| `AuditEvent` | Meaningful state changes, approvals, policy decisions, security-sensitive actions, external side effects, retention/export/redaction actions | High-volume progress, raw tool output, full prompts, screenshots, command stdout |
| `ArtifactRecord` and object storage | Large evidence bytes, checksums, storage URI, content type, artifact relationships, retention metadata | Current product state, audit chain ordering |
| `TestRun` | Executed test command, result, retry/flaky data, log/report artifact ids | All Agent Run progress or audit decisions |
| `ApprovalRecord` | Human or policy gate request and decision state | The immutable explanation that the decision occurred; that is also an Audit Event |
| Temporal history | Workflow replay, durable timers, signals, activity attempts | Product state, audit export, long-term customer evidence |
| Codex provider history and JSONL | Provider-specific debugging and runner normalization input | PatchPilot state unless captured as artifacts and summaries |
| OpenTelemetry | Operational traces, metrics, logs, correlation, alerting | Audit completeness, legal export, retention authority |
| SSE/API events | Client delivery of current state and progress | Persistence or audit authority |

## AgentRun Boundary

An Agent Run represents one execution attempt by an agent for one Work Item. It should answer "what is this run doing, what did it produce, and why did it end this way?"

`AgentRun` should contain:

- stable links to Requirement, PRD version, Work Item, Workspace Run, runner provider, and responsible agent;
- status, current step, timeline, and normalized `AgentRunEvent` entries suitable for Simple Mode and Professional Mode progress;
- result summary, risk level, changed files, test evidence, review summary, cost, failure type, failure summary, and artifact ids;
- provider-neutral run identity such as Codex thread id, session id, base/head commits, branch, workspace identity, and retry or resume metadata where available.

`AgentRunEvent` is a concise progress event stream for the run. It should record lifecycle and user-visible milestones such as workspace created, Codex started, tests started, tests passed, tests failed, diff created, review completed, waiting for acceptance, approval needed, and run failed. It may include short messages and references to artifacts.

`AgentRunEvent` must not become a raw transcript. Long agent messages, reasoning summaries, command output, stdout/stderr, provider JSONL, screenshots, traces, and full prompts belong in redacted artifacts with checksums and retention metadata. Agent Run state may store summaries and artifact ids for those materials.

Agent Run event ordering is scoped to the run. It does not need the global append-only semantics or hash-chain guarantees of Audit Events. Mutating an Agent Run during execution is acceptable when the repository transition is fenced and the meaningful transition also emits an Audit Event where required.

## AuditEvent Boundary

An Audit Event records a meaningful action that PatchPilot must be able to explain later. It should answer "who or what did this, to which target, under which trace, what changed, and how can we verify the record?"

Create an Audit Event for:

- Requirement submission, clarification completion, PRD creation, PRD approval or rejection;
- Work Item creation, claim, release, stale-claim recovery, rework request, cancellation, and terminal state changes;
- Agent Run start, pause for approval, resume, cancellation, success, failure, retry exhaustion, and failure classification;
- Workspace Run creation, sandbox policy decision, cleanup, archive, and cleanup failure;
- CodexRunner provider start/resume/cancel identity capture when it creates or reuses an external provider handle;
- TestRun result recording when it affects a gate or defect decision;
- Pull Request record creation, review decision, acceptance decision, and merge or close record when GitHub integration lands;
- Approval request, approval decision, expiration, and accepted exception;
- contract registry proposal, diff, breaking-change approval request, baseline promotion, deprecation, or rollback;
- budget threshold crossing, hard budget stop, cost finalization, network policy denial, secret grant, dangerous operation request, production data access, and capability manifest activation or revocation;
- artifact export, retention purge, legal hold, redaction, audit verification failure, and audit package export.

Do not create an Audit Event for every token, line of stdout, low-level trace span, repeated heartbeat, UI poll, or SSE delivery. Those belong in Agent Run progress, operational telemetry, or artifacts unless they cause a product, policy, approval, security, or external-side-effect decision.

Audit Event actions should use a stable dotted vocabulary such as `agent_run.started`, `approval.decided`, `policy.network_denied`, `artifact.redacted`, or `audit.exported`. The schema may keep `action` as a string, but producers must treat action names as contract-like values and add compatibility tests when changing them.

## Hash Chain And Artifact Relationship

Audit Events are hash chained within a project or tenant stream. The verifier must read one chain boundary at a time, order events from oldest to newest, validate each event's `previousHash`, recompute the canonical hash, and report the head hash.

The canonical hash input must be a stable JSON representation of the audit fields that define the event:

- event id, trace id, actor type/id, action, target type/id, message, before/after JSON, metadata JSON, previous hash, entity links, and created timestamp;
- project or tenant scope either as part of the hash input or as the chain partition;
- no display-only, derived, or storage-transport fields such as actor display labels, API response decoration, or the `hash` field itself.

The repository must not rewrite an Audit Event after hashing it. If an earlier event needs clarification, correction, redaction metadata, or an exception record, append a new Audit Event that points at the earlier event id and hash.

Audit Events should store summaries and references, not large evidence. When an audit fact depends on a log, trace, diff, screenshot, test report, provider stream, or export package, the Audit Event metadata should include artifact ids, artifact kind, SHA-256 checksum, content type, size, retention tier, and redaction status where available. The raw bytes stay in the artifact store.

Artifact deletion must not break the audit chain. When retention purges an artifact, the system must keep a tombstone or metadata record with artifact id, kind, checksum, original size, deletion time, retention reason, and the Audit Event that authorized deletion. Audit packages can then prove that an artifact existed and was purged under policy even if the bytes are gone.

For regulated deployments, `TD-308` should add optional WORM or object-lock storage for audit exports, head-hash anchors, and long-retention artifact manifests. WORM storage is an export and preservation layer, not a replacement for the product-state Audit Event table.

## Retention Tiers

Use retention tiers instead of one global log lifetime. Defaults may be shortened or extended by organization policy, legal hold, or customer contract, but a stricter policy must still preserve audit chain verifiability.

### Tier 0: Audit Ledger And Tombstones

Content:

- Audit Events, approval decisions, hash-chain head checkpoints, retention/redaction/export events, artifact tombstones, and minimal relationship identifiers.

Default retention:

- retain for the life of the project plus the configured contractual audit period;
- do not purge while a legal hold, unresolved incident, open approval investigation, or active customer export request exists.

Access:

- Professional Mode audit views, admins, auditors, and support roles with explicit authorization.

### Tier 1: Product Evidence Summaries

Content:

- AgentRun summaries, AgentRunEvents, WorkspaceRun metadata, TestRun summaries, Pull Request records, Review records, Acceptance decisions, Defect links, cost summaries, and artifact metadata.

Default retention:

- retain for the life of the PRD or project, with a minimum of 1 year after final acceptance or cancellation.

Access:

- normal product roles that can view the related Requirement, PRD, Work Item, or run.

### Tier 2: Decision Evidence Artifacts

Content:

- redacted diffs, test reports, final run messages, preview metadata, selected screenshots, contract diffs, egress audit excerpts, and failure summaries used by quality gates or customer acceptance.

Default retention:

- retain at least 1 year after final acceptance or cancellation, or longer when referenced by a defect, approval, contract baseline, legal hold, or export package.

Access:

- same as Tier 1 unless the artifact is marked restricted.

### Tier 3: Raw Run Artifacts

Content:

- raw or near-raw Codex JSONL, command stdout/stderr, full test logs, full traces, temporary screenshots, debug bundles, and provider transcripts after redaction.

Default retention:

- retain 90 days after the Agent Run reaches a terminal state;
- shorten to 30 days for high-volume debug artifacts when a redacted summary and checksum remain;
- extend only by explicit legal hold, incident, defect reproduction, or admin retention policy.

Access:

- restricted to maintainers, reviewers, support, or auditors with a need to inspect raw evidence.

### Tier 4: Operational Telemetry

Content:

- OpenTelemetry spans, metrics, logs, collector-exported records, Prometheus samples, and alerting backend data.

Default retention:

- traces and logs: 14 days in hot storage;
- metrics: 90 days at useful resolution, with aggregate product metrics allowed for longer retention when they do not include prompts, secrets, personal data, or raw repository content.

Access:

- operators and support roles. Telemetry access does not imply access to raw artifacts or audit exports.

### Tier 5: Ephemeral Execution State

Content:

- live worktrees, container filesystems, temp directories, package caches, process logs before capture, and sandbox-local state.

Default retention:

- delete or archive immediately after evidence capture and terminal run handling;
- destroy within 24 hours by default if normal cleanup fails, after recording cleanup failure evidence;
- keep longer only under explicit quarantine, incident, or legal hold.

Access:

- runner and operator break-glass paths only.

## Redaction Strategy

Redact before persistence, export, and telemetry whenever possible. The ingestion boundary is the right place to remove sensitive data:

- CodexRunner must redact provider events before storing AgentRunEvents, telemetry logs, or raw provider artifacts.
- Command and test wrappers must redact stdout/stderr before writing artifacts or OpenTelemetry logs.
- Secret Broker and Capability Manifest implementations must inject secrets through short-lived grants and must never place plaintext secret values in Audit Events, Agent Run messages, span attributes, command strings, or artifact metadata.
- API handlers must validate and redact user-supplied intake content before copying it into audit metadata or telemetry. Full intake attachments belong in artifacts with access controls.
- Export jobs must run a final redaction pass even when source artifacts were already redacted.

Redaction must cover at least:

- API keys, tokens, passwords, private keys, cookies, authorization headers, SSH material, cloud credentials, database URLs, webhook secrets, and package registry tokens;
- environment variable values for names that look secret-bearing;
- URLs with embedded credentials or sensitive query parameters;
- production customer data, personal data, email addresses, phone numbers, and account identifiers when not required for the audit purpose;
- host home paths, local usernames, private network addresses, and infrastructure metadata endpoints when they are not needed to explain policy decisions;
- full prompts, chain-of-thought-like reasoning, and provider-private debug fields unless explicitly classified as exportable evidence.

Redaction replacements should preserve operational usefulness without exposing the value. Use typed markers such as `[REDACTED:secret]`, `[REDACTED:email]`, or `[REDACTED:token:fingerprint=<sha256-prefix>]`. Fingerprints must be non-reversible and based on a deployment-scoped salt when correlation is needed.

The audit hash chain hashes the redacted Audit Event, not the unredacted source. Product state should never rely on secret-bearing content being present in an Audit Event. If sensitive content is found after persistence:

1. Treat it as a security incident or privacy incident.
2. Restrict access to the affected event or artifact immediately.
3. Append an `artifact.redacted`, `audit.redaction_recorded`, or equivalent Audit Event that names the affected event or artifact id and the prior hash or checksum.
4. Replace raw artifact bytes with a sanitized artifact version where policy allows, preserving the original checksum in a restricted tombstone.
5. If a law or contract requires overwriting a hashed Audit Event itself, record an approved audit-chain break package before mutation, anchor the old head hash in restricted storage, and start a new chain segment with an Audit Event explaining the break. This is a last-resort exception, not normal redaction.

## Exportability

Administrators must be able to export a versioned audit package for a Requirement, PRD, Work Item, Agent Run, Approval, Defect, or time-bounded project audit.

The default export is redacted and should include:

- export manifest with format version, created timestamp, actor, scope, filters, redaction policy version, retention policy version, and export Audit Event id;
- Audit Events as JSONL in chain order plus a verification manifest with first hash, head hash, event count, and verification result;
- AgentRun, WorkspaceRun, TestRun, Pull Request, Review, Approval, Defect, and Artifact metadata needed to understand the scope;
- selected redacted artifacts or signed artifact manifests with ids, kinds, checksums, sizes, content types, retention tier, redaction status, and tombstone data;
- policy evidence such as capability manifest ids, sandbox settings, egress decisions, budget decisions, and approval links when in scope;
- README or schema file explaining how to verify hashes and artifact checksums offline.

Unredacted or restricted export requires an Approval record with a high or critical risk level, explicit scope, expiration, recipient, reason, and Audit Events for request, decision, package creation, and package access. Export packages themselves are artifacts and must have retention, access control, checksum, and purge behavior.

Exports must not depend on the observability backend. They may include trace ids and log artifact ids, but the audit package should remain understandable from product records, Audit Events, artifact manifests, and included redacted artifacts.

## Observability And Log Handling

OpenTelemetry traces, metrics, and logs are operational signals derived from product-state events and runner activity. They must follow these rules:

- include correlation attributes for Requirement, PRD, Work Item, Agent Run, Test Run, Audit Event, trace id, and workflow id where available;
- do not put raw prompts, secret values, command output, user documents, screenshots, diffs, or provider JSONL in span names, metric labels, log bodies, or high-cardinality attributes;
- use artifact ids, failure categories, status values, counts, durations, and stable action names instead of raw content;
- sampling and collector failure must not drop Audit Events or product-state writes;
- telemetry logs may duplicate Audit Event messages for operations, but the Audit Event table remains the audit authority;
- telemetry retention is shorter than audit retention and must be documented separately from product evidence retention;
- telemetry exporters and collectors require the same redaction library or an equivalent policy gate before data leaves the PatchPilot control plane.

Production alerts should be driven from both product state and telemetry. For example, audit hash verification failure, retention job failure, redaction job failure, artifact purge failure, unexpected unredacted secret detection, and missing artifact checksum should create operator-visible alerts and Audit Events.

## Alternatives Considered

### Use Audit Events For All Logs

This would put every progress event, token, command line, stdout chunk, trace span, and provider event into one append-only table.

Rejected because it would make the audit ledger too large, too sensitive, and too noisy to review. It would also make privacy deletion and retention policy harder without improving the explanation of meaningful state changes.

### Use OpenTelemetry As The Event Source Of Truth

OpenTelemetry already provides traces, logs, metrics, exporters, and correlation.

Rejected because observability systems are allowed to sample, aggregate, evict, transform, and vendor-route data. PatchPilot audit completeness and exportability must not depend on collector retention or external telemetry availability.

### Keep Raw Logs Forever For Reproducibility

Long retention can help deep investigations and model behavior analysis.

Rejected as the default because raw logs and screenshots are the most likely place to capture secrets, personal data, customer content, and provider-private material. PatchPilot should retain summaries, checksums, manifests, and selected decision artifacts longer than raw debug streams.

### Redact Only At Export Time

Export-time redaction is simple to add after data has already been collected.

Rejected because sensitive values would still sit in product state, artifacts, telemetry backends, backups, and support tools. Export-time redaction remains a defense in depth step, not the primary control.

### Allow Mutable Audit Events For Privacy Fixes

Overwriting Audit Events makes deletion straightforward.

Rejected as normal behavior because it destroys tamper-evidence. The default model is redact before write, append correction/redaction events, purge artifacts through tombstones, and reserve audit-chain breaks for approved legal exceptions.

## Consequences

- Product implementation must keep Agent Run progress, Audit Events, artifacts, and telemetry as separate surfaces with explicit links.
- Audit Event producers need a stable action vocabulary and tests so event names do not drift silently.
- Raw provider streams and command/test logs require redaction before artifact storage and telemetry export.
- Retention jobs must understand artifact kinds, tiers, terminal run state, acceptance state, legal holds, and tombstone preservation.
- Audit export becomes a first-class product capability under `TD-308`, not an ad hoc database dump or observability query.
- The current MVP hash-chain implementation remains directionally correct, but production repository work must verify chains per project or tenant and define chain checkpoints.
- Some debug workflows will lose raw bytes after Tier 3 expiry. Operators must rely on retained summaries, checksums, manifests, and selected decision artifacts after that point.
- Legal erasure and incident response need explicit procedures because immutable audit records and privacy obligations can conflict.

## Production Enforcement Exit Criteria

Treat this ADR as production-enforced only when all of the following are true:

1. The Postgres repository writes Agent Run transitions and Audit Events transactionally where feasible, with idempotency keys for retried external side effects.
2. Audit Events are verified per project or tenant, have stable action-name tests, and expose a head-hash verification endpoint or job result.
3. AgentRunEvent producers store concise progress events and move raw provider, command, test, screenshot, trace, and prompt bytes into artifacts with checksums.
4. Artifact metadata includes retention tier, redaction status, checksum, size, content type, relationship ids, and tombstone fields after purge.
5. A shared redaction library or service is used by CodexRunner, command/test wrappers, API ingestion, artifact storage, telemetry emission, and export jobs.
6. Secret Broker and Capability Manifest implementations prove that plaintext secret values are not written into Audit Events, AgentRunEvents, telemetry, or artifact metadata.
7. Retention jobs enforce the tier defaults, preserve tombstones, honor legal holds, and write Audit Events for purge, hold, export, and redaction actions.
8. Administrators can export a redacted audit package for a PRD or Agent Run, verify the Audit Event chain offline, and verify included artifact checksums.
9. Unredacted export, production data access, legal hold, and audit-chain break operations require Approval records and produce Audit Events.
10. OpenTelemetry configuration documents shorter retention, redaction guarantees, correlation attributes, and the fact that telemetry is not the audit authority.
11. Regression tests cover hash-chain tamper detection, redaction before artifact persistence, retention tombstones, export manifest verification, telemetry redaction, and incident-style post-persistence redaction handling.
12. At least one E2E path completes a real or simulated Work Item and verifies AgentRunEvents, AuditEvents, artifact metadata, telemetry correlation, retention tier assignment, and export package creation.

## Non-Goals

- This ADR does not implement retention jobs, export jobs, redaction libraries, or schema changes.
- This ADR does not change the current JSON-backed MVP store behavior.
- This ADR does not decide detailed Secret Broker, MCP tool, network, or dangerous-operation approval policy; see ADR-0009.
- This ADR does not decide production workflow durability; see ADR-0001.
- This ADR does not decide the product-state source of truth; see ADR-0002.
- This ADR does not decide contract registry enforcement; see ADR-0006.
