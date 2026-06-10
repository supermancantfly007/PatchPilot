# ADR-0004: Worktree and Container Sandbox Isolation Model

Status: accepted

Date: 2026-06-11

## Context

PatchPilot executes Work Items by giving Codex a real repository workspace, collecting evidence, running Quality Gates, and returning a Pull Request boundary for human review. That execution needs isolation because multiple Agent Runs may work against the same repository, the agent may install dependencies or run arbitrary project commands, and the platform must not let a Work Item mutate the main checkout, leak host credentials, reuse another run's state, or bypass audit and approval policy.

The current runnable MVP already uses `@patchpilot/workspace-manager` to create a Git worktree and task branch for real Codex runs. `@patchpilot/codex-runner` writes `PATCHPILOT_TASK.md`, runs `codex exec --json`, runs the configured test command, collects changed files and summary artifacts, and creates a local commit boundary before returning evidence to the API store.

`TD-211` added an opt-in rootless Docker or Podman sandbox around Codex and the configured test command. It runs as a non-root UID/GID, never passes `--privileged`, drops Linux capabilities, sets `no-new-privileges`, avoids Docker socket and host home mounts, mounts only the worktree at `/workspace` with write access, uses a read-only root filesystem with bounded tmpfs for `/tmp` and container home, applies CPU, memory, and process limits, enforces command timeouts, and checks workspace disk usage from the API process. Its integration test verifies that the sandbox can write `/workspace` while a denied host path and `/var/run/docker.sock` are inaccessible.

ADR-0001 decides that Git, workspace, container, test, artifact, and Codex execution happen in Temporal activities once production workflows land. ADR-0002 decides that Workspace Run, Agent Run, artifact, Capability Manifest, and audit facts belong in the product-state repository. ADR-0003 decides that Codex execution must go through `CodexRunner`, with explicit sandbox and approval settings, not through caller-specific Codex behavior.

This ADR records the durable isolation model those pieces should implement. It does not claim that the TD-211 rootless container is a complete multi-tenant security boundary by itself.

## Decision Drivers

- Each Agent Run must have a stable, inspectable code workspace without sharing uncommitted state with the main checkout or another run.
- The platform needs a branch and commit boundary for Pull Request records, Test Runs, Review records, artifacts, and final acceptance.
- Agent commands must not receive host home directories, Docker sockets, SSH agents, production secrets, or broad filesystem access by default.
- Codex and test execution need resource limits, timeouts, cleanup, and evidence capture that PatchPilot controls.
- Capability Manifest enforcement needs one run-scoped place to describe writable paths, allowed commands, network destinations, secret grants, runtime limits, and sandbox mode.
- Local development needs a path that works on a developer machine, while production needs a path that can evolve to stronger runtimes without changing the Work Item execution model.
- Isolation failures must be visible as Agent Run and Workspace Run evidence, not silent runner behavior.

## Decision

Use a two-layer isolation model for real PatchPilot execution:

1. A dedicated Git worktree is the repository and write-set boundary for each active Workspace Run.
2. A per-run container or equivalent sandbox is the process, dependency, filesystem, and resource boundary for Codex and test commands.

The Git worktree is mandatory for real Codex-backed Work Item execution. The platform creates it from the claimed base ref, creates a task branch, writes `PATCHPILOT_TASK.md`, runs the agent inside that workspace, collects changed files and artifacts from that workspace, and creates the local commit boundary from that workspace. Agent Runs must not directly write the main checkout, another Workspace Run, or a shared long-lived clone.

The container sandbox is mandatory for unattended production execution and for any run that can execute untrusted project commands. The current TD-211 rootless Docker/Podman sandbox is the minimum local/MVP implementation of that boundary. It is acceptable for local development, CI-style smoke coverage, and early single-tenant deployments when enabled and documented. A stronger production runtime such as gVisor, Kata, Firecracker, or a hardened Kubernetes worker runtime remains a separate decision under `TD-301`.

PatchPilot's own isolation and policy layer is the authority. Codex sandbox flags are defense in depth inside the Workspace Run; they are not the only trust boundary. Production adapters should use explicit Codex sandbox settings and should not rely on interactive Codex approvals. Dangerous operations, network changes, secret access, budget overruns, and breaking contracts are PatchPilot Approval records and Capability Manifest decisions.

The root filesystem visible to agent commands must be disposable. The only writable host bind mount is the current worktree at `/workspace`. Temporary directories and container home are bounded tmpfs mounts. Host home, SSH agent, cloud credential directories, Docker socket, host package caches, sibling worktrees, and repository parent directories are not mounted by default. Required caches may be added later only as explicit, read-only or scoped mounts covered by the Capability Manifest and audit evidence.

The sandbox image is part of the Workspace Run environment. It must already contain the tools required by the configured Codex and test commands, or the run should fail as an environment failure. PatchPilot should record the runtime, image, resource limits, base commit, task branch, workspace path or storage reference, and cleanup status as Workspace Run or Agent Run evidence.

## Execution Model

Workspace preparation:

- Claim the Work Item through the repository or workflow fence chosen by the Work Item lease ADR.
- Resolve the base ref and base commit.
- Create a dedicated task branch and Git worktree under the configured workspace root.
- Write the task file and any run-scoped configuration needed by CodexRunner.
- Record Workspace Run metadata before starting Codex.

Sandboxed execution:

- Run Codex through `CodexRunner` from the worktree path.
- When the container sandbox is enabled, run Codex and the configured test command inside the same sandbox boundary with `/workspace` as the working directory.
- Use explicit timeout, CPU, memory, process, tmpfs, and workspace disk limits.
- Sanitize inherited environment variables and inject only run-scoped values allowed by policy.
- Treat sandbox startup failure, timeout, disk quota breach, and policy denial as observable Agent Run failures with artifacts.

Evidence and completion:

- Collect normalized Codex events, command output, Test Run evidence, changed files, final message artifacts, and failure summaries.
- Commit only the changed worktree files that pass PatchPilot's internal ignore rules.
- Preserve base branch, base commit, task branch, head commit, test command, sandbox runtime/image, and artifact ids.
- Do not merge, publish, or deploy from the Workspace Run. Final merge and release remain repository and approval workflows.

Cleanup and retention:

- Stop sandbox processes at run completion, cancellation, timeout, or quota breach.
- Remove or archive the worktree according to retention policy after evidence is collected.
- Keep enough metadata and artifacts to reproduce the run outcome without keeping a live writable workspace indefinitely.
- If cleanup fails, record it as Workspace Run evidence and operator-visible risk.

## Policy Boundaries

Worktree isolation answers "where can code changes land?" It does not answer process isolation, network egress, command authorization, or secret access.

Container sandboxing answers "what host filesystem and resources can commands use?" It does not by itself decide which commands, network destinations, or credentials are allowed.

The Capability Manifest is the per-run policy document that connects those boundaries. It should eventually define:

- repository read, write, and deny paths;
- allowed and denied command families;
- sandbox runtime and resource limits;
- network egress allowlist and private-network denial;
- secret grants and injection method;
- artifact retention and redaction requirements;
- approvals required before relaxing any of the above.

Until `TD-212`, `TD-213`, `TD-218`, and ADR-0009 land, TD-211 must be treated as a host/process/resource improvement rather than a complete deny-by-default network and secret model. Production secrets must not be injected into general Work Item runs by default.

## Alternatives Considered

### Reuse The Main Checkout

This is simple and fast, but it lets an Agent Run mutate the operator's checkout, collide with unrelated work, leak uncommitted files into evidence, and make cleanup unsafe.

Rejected because PatchPilot needs per-run branches, reproducible base commits, isolated diffs, and safe parallelism.

### Git Worktree Only

A worktree gives PatchPilot an excellent Git boundary. It keeps branches, diffs, commits, and cleanup understandable, and it is already implemented in the MVP.

Rejected as the full isolation model because project commands still run on the host. A worktree alone does not prevent access to host home, credentials, Docker socket, sibling checkouts, local services, process table side effects, or resource exhaustion.

### Container Only Without Worktrees

A disposable container with a mounted clone can isolate processes and dependencies.

Rejected because PatchPilot still needs a first-class Git branch, base commit, diff, commit, artifact, and PR boundary for every Workspace Run. Container lifecycle should not be the source of Git truth.

### Privileged Docker Or Host Docker Socket Access

Giving the agent a Docker socket or privileged container would maximize compatibility for projects that build images or use compose.

Rejected by default because host Docker control is effectively host-level access. Future tasks that need image builds must use a separate builder strategy, explicit approval, or a tightly scoped remote build service.

### Codex Sandbox Flags As The Only Boundary

Codex sandbox settings are useful and should remain explicit.

Rejected as the only PatchPilot boundary because the platform must enforce workspace, process, resource, secret, network, artifact, and audit policy even if the Codex provider or adapter changes.

### MicroVM Or Hardened Runtime Immediately

gVisor, Kata, Firecracker, or hardened Kubernetes sandboxes are stronger choices for multi-tenant production.

Rejected as the immediate implementation requirement because PatchPilot first needs a stable workspace and runner contract. TD-211 provides a pragmatic rootless baseline; `TD-301` should decide the production-grade runtime after compatibility, cost, operations, and test evidence are available.

## Consequences

- Workspace Run creation remains a first-class step before Codex starts. Runner implementations should not create ad hoc clones or branches outside Workspace Manager.
- Rootless container sandboxing becomes the minimum acceptable unattended-production process boundary, but production hardening still depends on network, secret, policy, and stronger-runtime work.
- Tests and Codex run inside the same workspace boundary, which makes Test Run evidence line up with the diff and commit under review.
- Projects must provide or select sandbox images that contain the tools required by their configured commands. Missing tools are environment failures, not reasons to weaken isolation silently.
- Some workflows that need Docker, host services, SSH agents, local package caches, or privileged kernel features will need explicit future capabilities, alternate runners, or human approval.
- Workspace disk quota is enforced from the API process in TD-211, not by a filesystem quota. That is acceptable for MVP but should be replaced or supplemented by runtime-level storage limits in hardened production runners.
- Network egress is not solved by this ADR. TD-212 and ADR-0009 must define deny-by-default network behavior, metadata endpoint blocking, and approval for external access.
- Secret injection is not solved by this ADR. General Work Item runs remain no-production-secret by default until the Secret Broker and Capability Manifest enforcement exist.
- Artifact retention policy must balance reproducibility with sensitive-data exposure. Worktrees should not become permanent hidden state.

## Production Enforcement Exit Criteria

Treat the rootless container path as production-enforceable only when all of the following are true:

1. `CodexRunner` and the configured test runner both execute through the same sandbox boundary for real Codex-backed runs.
2. Workspace Run records store base ref, base commit, branch, workspace identity, sandbox runtime, image, resource limits, timeout, cleanup status, and artifact references.
3. Capability Manifest enforcement exists at scheduler, workspace setup, command execution, Codex config, network, and secret boundaries.
4. Network egress policy denies private networks and cloud metadata endpoints by default and allows only declared destinations.
5. Production secrets are available only through a Secret Broker with short-lived grants, redaction, and Audit Events.
6. Integration tests prove writable `/workspace`, denied host home and sibling paths, no Docker socket, non-root execution, timeout handling, disk quota handling, and cleanup behavior.
7. Failure paths record observable Agent Run or Workspace Run evidence for sandbox unavailable, policy denied, timeout, quota exceeded, cleanup failed, and environment missing-tool cases.
8. At least one E2E Work Item path runs with the container sandbox enabled and verifies Agent Run evidence, Test Run evidence, artifact capture, Pull Request record data, and final acceptance behavior.
9. TD-301 has either selected a stronger production runtime or explicitly accepted rootless Docker/Podman for the target deployment tier with documented residual risk.

## Non-Goals

- This ADR does not implement new sandbox behavior beyond TD-211.
- This ADR does not decide the production-grade sandbox runtime; see `TD-301`.
- This ADR does not decide network egress allowlists; see `TD-212` and ADR-0009.
- This ADR does not decide Secret Broker behavior; see `TD-213` and ADR-0009.
- This ADR does not decide Work Item lease, fencing, or branch conflict behavior; see ADR-0005 and ADR-0007.
- This ADR does not change current local MVP defaults or require container sandboxing for purely simulated runs.
