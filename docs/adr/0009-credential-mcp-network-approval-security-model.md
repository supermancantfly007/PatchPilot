# ADR-0009: Credential, MCP Tool, Network Access, and Approval Gate Security Model

Status: accepted

Date: 2026-06-11

## Context

PatchPilot executes Work Items by preparing a Workspace Run, giving Codex a task, running project commands, collecting evidence, and producing reviewable Pull Request records. That makes PatchPilot responsible for the security boundary around credentials, network access, external tools, and operations that should require human or policy approval.

Several earlier decisions define the surrounding boundaries:

- ADR-0002 makes Postgres the production product-state authority for Agent Runs, Workspace Runs, Approvals, Audit Events, artifacts, Capability Manifests, and budgets.
- ADR-0003 makes `CodexRunner` the only internal Codex execution boundary, requires platform-owned Codex configuration, and keeps Codex MCP as an interoperability path rather than the internal production path.
- ADR-0004 decides that every real run uses a dedicated Git worktree plus a container or equivalent sandbox, and that Codex sandbox flags are defense in depth rather than the platform trust boundary.
- ADR-0008 separates user-facing Agent Run progress, tamper-evident Audit Events, and large artifacts with retention and redaction rules.
- ADR-0011 chooses gVisor as the default production sandbox runtime and keeps the rootless Docker or Podman sandbox as the local and fallback runtime.

The current implementation already has partial security controls:

- `TD-212` adds a network egress policy for container-sandboxed commands, with an audited proxy sidecar, allowlisted Git/package/OpenAI destinations, private-network denial, metadata endpoint denial, and summarized evidence.
- `TD-213` adds the Secret Broker MVP. It injects no secrets by default, allows only explicit `secret:<id>` Work Item requests, supports configured development or CI environment tokens, denies production secrets, and records redacted evidence.
- The product model already includes `ApprovalRecord` kinds for PRD approval, budget exceeded, dangerous operation, breaking contract, network allowlist change, secret grant, and production data access.
- The production database schema already includes `capability_manifests` with allowed paths, denied paths, allowed commands, denied commands, allowed network, secret refs, max cost, and max runtime fields.

Those controls need one durable security model so future work does not treat Codex approvals, MCP configuration, environment variables, network proxies, or operator procedures as separate authorities.

## Decision Drivers

- Unattended agents must not inherit an operator's personal credentials, host environment, SSH agent, `$CODEX_HOME`, MCP config, browser session, Docker socket, cloud metadata token, or production network access.
- Work Item runs still need controlled access to ordinary delivery dependencies such as Git remotes, package registries, Codex/OpenAI endpoints, test fixtures, and selected integration APIs.
- MCP tools can read or mutate external systems, execute local programs, and use their own credentials. They require the same per-run policy, secret, network, evidence, and approval boundaries as shell commands.
- Network and credential policy must be enforceable before Codex or a tool acts, not reconstructed only from logs after the run.
- Dangerous operations need product Approval records and Audit Events. PatchPilot must not rely on interactive Codex approval prompts during unattended production execution.
- Policy exceptions must be narrow, expiring, linked to a run or manifest version, and visible to reviewers and auditors.
- Denials and missing policy must fail closed and produce useful Agent Run failure evidence rather than weakening the sandbox silently.

## Decision

Use the Capability Manifest as the run-scoped security authority for credentials, MCP tools, network access, command capabilities, repository write scope, runtime selection, budgets, and approval-linked exceptions.

Use Approval records as the only product approval mechanism for relaxing or exercising high-risk capabilities. Codex approval settings remain explicit and non-interactive for production runs. PatchPilot creates Approval records, pauses or blocks the run when needed, and resumes through workflow or runner state after approval.

Default security posture:

- no production credentials are injected into general Work Item runs;
- no secret is injected unless the active Capability Manifest names a secret ref and the Secret Broker authorizes it;
- no MCP server or MCP tool is available unless the active Capability Manifest and platform-owned Codex configuration allow it;
- no network egress is allowed except declared destinations, derived Git remotes when allowed, package registries, Codex/OpenAI endpoints, and explicitly approved external APIs;
- private networks, loopback service discovery, link-local ranges, and cloud metadata endpoints are denied by default;
- dangerous operations, broad write scopes, privileged runtimes, Docker socket access, host mounts, production data access, and policy fallback require Approval records;
- policy denials, missing approvals, missing secrets, expired grants, blocked egress, and disallowed MCP tools fail the run or pause it at `needs_approval` without bypassing evidence capture.

The MVP implementation may enforce this model in stages. TD-212 and TD-213 already enforce parts of the network and secret model in the rootless container path. TD-218 and TD-219 must turn the Capability Manifest and command wrapper into the common policy enforcement path for scheduler dispatch, workspace setup, Codex configuration, shell commands, tests, MCP tools, network, and secret grants.

## Capability Manifest Authority

Every real Agent Run must have an active Capability Manifest before Codex starts. The manifest is a versioned, immutable policy document once activated. Changing permissions creates a new manifest version and, where required, links to an Approval record. Revoking or expiring a manifest prevents new starts and resumes from using it.

The manifest should define:

- repository read, write, and deny paths;
- allowed and denied command families and command wrappers;
- sandbox runtime family, image, resource limits, timeout, process limits, and fallback policy;
- network destinations, whether Git remotes may be added automatically, and whether private networks and metadata endpoints are denied;
- MCP server ids, allowed tool names, transport, package/image version or digest, network destinations, secret refs, writable paths, and risk classification;
- secret refs by id, target environment variable name or tool input binding, scope, expiration, and provider class;
- max runtime, max cost, and budget approval id when required;
- artifact retention tier, redaction requirements, and evidence expectations for high-risk capabilities;
- approval ids that authorize exceptions, including expiry and accepted risk.

The manifest is not a suggestion to the agent. It is consumed by PatchPilot enforcement points before and during execution. Any capability not present in the active manifest is denied.

## Credential And Secret Model

All run credentials go through the Secret Broker. Credentials must not be provided through prompts, task files, committed config, inherited environment variables, host home mounts, SSH agent forwarding, cloud credential directories, browser sessions, personal `$CODEX_HOME`, or unmanaged MCP server config.

Secret refs are named by stable ids, not by plaintext values. Product state, config files, Audit Events, Agent Run events, telemetry, artifact metadata, and PR bodies may store secret ids, target env var names, provider names, scopes, expirations, and non-reversible fingerprints. They must not store secret values.

Secret grant flow:

1. The Work Item or policy planner requests a secret capability such as `secret:github-ci-token`.
2. The Capability Manifest records the requested secret ref, scope, target binding, expiry, and required approval if any.
3. The Approval service creates and resolves a `secret_grant` Approval when the secret is high-risk, production-scoped, long-lived, or broader than an existing policy.
4. The Secret Broker resolves the ref at run time, verifies the manifest and unexpired approval, obtains a short-lived value when the provider supports it, and injects it only into the exact command, test process, Codex config, or MCP server binding that needs it.
5. The runner records redacted Secret Broker evidence and Audit Events before using the value.
6. Cleanup removes temporary config, environment files, and any provider session when the run completes, fails, is cancelled, or the grant expires.

The current MVP supports only explicit development and CI environment-token grants. Production secret providers, rotation, revocation, and cloud/Vault adapters remain TD-303 work. Until that work is complete, production secrets are denied by default even when a Work Item asks for them.

## MCP Tool Model

PatchPilot recognizes two different MCP directions:

- Codex-as-MCP is an interoperability surface for external orchestrators. If PatchPilot wraps it, it still goes through `CodexRunner` and the same workspace, policy, artifact, and audit boundaries.
- Codex-consuming MCP servers are tools made available to Codex for a specific Agent Run. These are governed by the active Capability Manifest and platform-owned Codex configuration.

No production run may inherit MCP servers from an operator's personal Codex config. PatchPilot must generate run-scoped Codex config that contains only the MCP servers and tools allowed for that run.

An allowed MCP server entry must record:

- server id and owner;
- transport type such as stdio, HTTP, or SSE;
- package, image, binary path, or remote URL plus version or digest where applicable;
- allowed tool names, argument constraints where feasible, and risk classification;
- required secret refs and the exact binding method;
- required network destinations;
- filesystem read/write scope;
- whether the server runs inside the same sandbox, a sidecar, or a remote trusted service;
- audit and artifact expectations for tool calls and results.

Stdio MCP servers that execute local programs must run inside the same run sandbox or an equivalent sidecar with the same filesystem, environment, resource, and network policy. Remote MCP servers must be reachable only through approved egress destinations and must use Secret Broker credentials, not embedded tokens.

MCP tool calls must be normalized into Agent Run events or artifacts and must create Audit Events when they request or perform meaningful state changes, external side effects, credential access, policy decisions, production data access, or dangerous operations. A tool response is not enough evidence for a policy decision by itself.

MCP servers may not approve their own capabilities, mutate the active Capability Manifest, bypass the egress proxy, access host credentials, or request interactive Codex approvals as a substitute for PatchPilot Approval records.

Adding a new production MCP server, expanding allowed tools, changing a server binary/image, granting write-capable external APIs, or allowing an MCP tool to use production credentials requires review and an Approval record. Low-risk read-only tools may be pre-approved by project policy when they are already in the manifest and have bounded network and secret scopes.

## Network Access Model

Network egress is deny by default and allowlisted per run. The active Capability Manifest is the policy source; the egress proxy, Kubernetes network policy, sandbox runtime, and command wrapper are enforcement layers.

Default allowed destination classes are:

- the repository's configured Git remotes when `allowGitRemotes` is enabled;
- package registries needed by the configured project ecosystem;
- Codex/OpenAI endpoints needed by the selected Codex adapter;
- explicitly approved external APIs required by the Work Item.

Default denied destination classes are:

- RFC1918, loopback, link-local, carrier-grade NAT, unique-local IPv6, and other private network ranges;
- cloud metadata endpoints such as `169.254.169.254` and provider metadata hostnames;
- internal control-plane services, databases, object stores, and observability collectors unless a specific sidecar or controller path is approved;
- broad wildcard destinations such as all public HTTP(S);
- peer Workspace Runs, sibling worktrees, host services, Docker sockets, and Kubernetes API tokens for run Pods.

The local rootless container path enforces egress through the TD-212 audited proxy sidecar when container sandboxing is enabled. The task container runs on an internal network, receives proxy settings, and writes no raw egress audit file into the writable workspace. Raw decisions stay in a private host path and are reduced to redacted evidence and Audit Events.

Production Kubernetes worker pools must combine the Capability Manifest with default-deny NetworkPolicies, a DNS-aware egress policy or proxy, blocked metadata endpoints, and runtime evidence. A missing production network policy is an environment failure, not a reason to run with broad public egress.

Network allowlist expansion requires `network_allowlist_change` Approval when it adds a new external service, broadens a wildcard, enables private network access, changes proxy behavior, or creates a long-lived exception. Private network and metadata endpoint access is critical risk and should normally be denied; exceptions require break-glass approval and incident-style evidence.

## Approval Gate Model

PatchPilot Approval records are the authority for human or policy decisions. Codex interactive approvals are disabled for unattended production runs because they are provider-local pauses, not product-state decisions with PatchPilot audit semantics.

An approval request must include requester, reason, target type/id, risk level, expiration, requested capability diff, related manifest version, related Work Item or Agent Run, and evidence needed for the decision. Approval decisions must include approving or denying actor, reason, timestamp, expiry, accepted residual risk, and Audit Events.

Required approval gates include:

| Capability or action | Default risk | Required approval kind |
| --- | --- | --- |
| PRD approval | low to medium | `prd_approval` |
| Budget soft-limit override or hard-limit continuation | medium to high | `budget_exceeded` |
| New external network destination or broader wildcard | high | `network_allowlist_change` |
| Private network or metadata endpoint access | critical | `network_allowlist_change` plus break-glass evidence |
| Development or CI secret beyond pre-approved policy | medium to high | `secret_grant` |
| Production secret or production data access | high to critical | `secret_grant` or `production_data_access` |
| New write-capable MCP tool or changed MCP server binary/image | high | `dangerous_operation` or `secret_grant` when credentials are involved |
| Privileged container, Docker socket, host home, SSH agent, or broad host mount | critical | `dangerous_operation`; denied by default |
| Runtime fallback from gVisor to runc/rootless Docker in production | high | `dangerous_operation` |
| Breaking interface contract | high | `breaking_contract` |
| Direct base-branch push, force-push, deploy, release, or rollback | high to critical | `dangerous_operation` plus repository policy evidence |

Approvals are scoped and expiring. A valid approval may authorize only the manifest version, run, target, and capability diff named in the request. It must not become a reusable blanket exception unless an administrator creates a separate policy artifact and Audit Event for that broader policy.

When a run reaches a capability that needs approval, PatchPilot should pause the Agent Run at `needs_approval` where resume is feasible. If the provider, command, or tool cannot safely pause before the action, PatchPilot must deny before execution and require a new resume or rerun after approval.

## Evidence And Audit

Security decisions must be visible in the same evidence layers defined by ADR-0008:

- `AgentRun` stores concise progress and failure status, including `needs_approval`, `policy_denied`, blocked egress summaries, and redacted secret/MCP evidence references.
- `ApprovalRecord` stores the mutable request and decision state for an approval gate.
- `AuditEvent` stores append-only facts for manifest activation/revocation, approval request/decision/expiration, secret grant/denial, network policy enforcement and denial, MCP tool allow/deny decisions with external side effects, dangerous operation requests, production data access, and break-glass exceptions.
- `ArtifactRecord` stores large redacted evidence such as raw provider streams, command logs, egress audit excerpts, MCP transcripts, test logs, and export packages with checksums and retention tiers.
- OpenTelemetry stores operational signals only. It must use ids, counts, durations, statuses, and failure categories rather than plaintext prompts, secret values, full tool output, or raw network payloads.

Security artifacts must follow ADR-0008 redaction and retention rules. If a credential, personal data, or production data appears in a prompt, log, diff, provider stream, MCP transcript, test artifact, or telemetry payload, PatchPilot treats it as an incident, restricts access, appends redaction Audit Events, and preserves checksums or tombstones as required.

## Implementation Rules

- Fail closed when policy cannot be loaded, a manifest is missing, a manifest is expired or revoked, an approval is missing or expired, a secret provider is unavailable, the egress proxy cannot start, or an MCP server is not in the active manifest.
- Generate run-scoped Codex config and exclude personal `$CODEX_HOME` behavior for unattended production runs.
- Pass only sanitized environment variables into the sandbox. Host `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`, cloud credential variables, SSH agent variables, and unrelated operator environment should not cross the boundary.
- Keep the worktree as the only writable repository mount. Secret temp files, MCP config, provider tokens, and proxy logs should be stored outside the task's writable workspace unless the manifest explicitly allows a redacted artifact.
- Enforce the same manifest for Codex, tests, command wrappers, MCP servers, network egress, and Secret Broker grants. A tool must not gain broader rights because it is invoked through a different adapter.
- Do not silently downgrade sandbox runtime, disable egress policy, disable Secret Broker, widen network, or bypass MCP restrictions to improve compatibility.
- Record policy denials as `policy_denied` or a more specific failure summary, with enough redacted evidence for the operator to understand the blocked capability.
- Treat break-glass actions as exceptional. They require critical-risk approval, narrow scope, short expiry, explicit actor identity, and follow-up audit or incident review.

## Alternatives Considered

### Inherit Operator Credentials And Codex Config

This is convenient for local demos because Codex, Git, package managers, and MCP tools can reuse whatever the developer already configured.

Rejected for production because it leaks personal credentials, makes runs non-reproducible, bypasses product approvals, hides MCP tool access, and prevents reliable audit export. Local development may use personal setup to authenticate Codex itself, but unattended production uses platform-owned configuration and brokered credentials.

### Use Codex Interactive Approvals As The Approval System

Codex approval prompts can block dangerous tool calls in an interactive session.

Rejected as PatchPilot's approval authority because they are provider-local, not durable product records. They do not carry PatchPilot risk classification, expiry, manifest diffs, RBAC, audit hash-chain evidence, or workflow resume semantics. Codex approval settings remain explicit defense in depth.

### Allow All Public Internet And Block Only Private Networks

This reduces package-install friction while still blocking obvious metadata and local-network targets.

Rejected because public SaaS APIs, paste sites, package registries, webhooks, and remote MCP endpoints can still exfiltrate prompts, diffs, credentials, customer data, or repository content. Public egress must be purpose-specific and auditable.

### Trust Each MCP Server To Enforce Its Own Policy

Some MCP servers already implement authentication, authorization, and logging.

Rejected because PatchPilot must own the run-level explanation of which tools were available, what credentials they received, which external side effects they caused, and why those actions were approved. MCP server policy can be an additional control, not the platform authority.

### Put Secret Values Directly In Capability Manifests Or Config Files

This makes configuration simple and avoids a broker dependency.

Rejected because manifests, config, snapshots, artifacts, PR bodies, and audit exports are designed to be inspectable. They must contain ids, scopes, and fingerprints, not plaintext credentials.

### Treat Network, Secrets, MCP, And Approvals As Separate Features

Separate feature-specific checks are easier to implement incrementally.

Rejected as the durable model because the risky cases overlap. An MCP tool may need a secret and network access; a production-data request may need an approval, secret, and restricted artifact handling; a runtime fallback may change network and filesystem exposure. The Capability Manifest ties those decisions together.

## Consequences

- Capability Manifest work must cover MCP tools, Secret Broker refs, network destinations, runtime selection, budgets, and approval-linked exceptions, not only shell commands and path writes.
- Command wrapper work must become the common interception point for Codex-created commands, test commands, setup commands, and future tool adapters.
- Secret Broker production work must support short-lived provider credentials, revocation, rotation, redaction, and audit evidence before production secrets are allowed.
- MCP configuration becomes platform-owned run data. Operators need tooling to review, approve, version, and test allowed MCP servers and tools.
- Some Work Items will pause or fail until approvals are resolved. That is intentional; compatibility failures and missing permissions should be visible rather than silently broadening access.
- Network allowlists need maintenance for ordinary package ecosystems and Codex endpoints, but broad egress remains an explicit exception.
- Reviewer and acceptance flows must show enough security evidence to evaluate high-risk runs without exposing raw credentials or unnecessary raw logs.

## Production Enforcement Exit Criteria

Treat this ADR as production-enforced only when all of the following are true:

1. `TD-218` provides a Capability Manifest package that validates repository paths, commands, sandbox runtime, MCP servers/tools, network destinations, secret refs, budgets, expiry, and approval-linked exceptions.
2. `TD-219` routes Codex commands, setup commands, test commands, and shell execution through a command wrapper that enforces the active manifest and records policy denials.
3. `CodexRunner` generates platform-owned run-scoped Codex config, excludes personal `$CODEX_HOME`, and exposes only manifest-approved MCP servers and tools.
4. Secret Broker production adapters issue short-lived credentials from Vault or cloud secret managers, support revocation and expiry, and prove plaintext values are absent from product state, artifacts, telemetry, and audit metadata.
5. TD-212 style egress enforcement is active for all unattended run runtimes, including Kubernetes worker pools, and denies private networks plus cloud metadata endpoints by default.
6. Approval workflows persist request, decision, expiry, risk, target, manifest version, and evidence; expired or denied approvals block start and resume paths.
7. RBAC/auth work restricts who may approve secret grants, production data access, network allowlist changes, dangerous operations, and break-glass runtime fallback.
8. Audit Events exist for manifest activation/revocation, approval lifecycle, secret grant/denial, network enforcement/denial, MCP tool side effects, dangerous operation requests, production data access, and break-glass actions.
9. Redaction and artifact scanning cover prompts, logs, diffs, provider JSONL, MCP transcripts, test artifacts, egress evidence, and export packages.
10. E2E tests prove allowed package/Codex egress, denied metadata egress, denied unlisted MCP tool, allowed read-only MCP tool, denied and approved secret grants, approval pause/resume, denied dangerous operation, and audit/export evidence.
11. Runtime evidence records sandbox runtime, fallback reason, network policy mode, secret grant summary, MCP tool summary, approval ids, and cleanup result for every real Agent Run.
12. Break-glass procedures are documented, tested, time-limited, and produce critical-risk Approval records plus follow-up Audit Events.

## Non-Goals

- This ADR does not implement `TD-218`, `TD-219`, `TD-222`, `TD-303`, or new runtime behavior.
- This ADR does not choose a specific Vault or cloud secret manager provider.
- This ADR does not change the existing local JSON-backed store or current `.patchpilot/config.yaml` defaults.
- This ADR does not decide the production sandbox runtime; see ADR-0011.
- This ADR does not decide the broader test strategy; that remains a separate pending ADR task.
- This ADR does not allow production secrets, private-network access, or broad MCP tool access in the current MVP.
