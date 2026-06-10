# ADR-0011: Production Sandbox Runtime

Status: accepted

Date: 2026-06-11

## Context

PatchPilot executes Work Items by preparing an isolated Git worktree, running Codex and project commands, collecting evidence, and returning a Pull Request boundary for review. ADR-0004 already decides the durable isolation model: every real Workspace Run uses a dedicated worktree plus a per-run container or equivalent sandbox. `TD-211` implements the local/MVP baseline with rootless Docker or Podman, non-root execution, dropped capabilities, no privileged mode, no Docker socket or host home mount, bounded tmpfs, resource limits, command timeouts, and workspace disk checks.

`TD-302` adds Kubernetes worker-pool templates for non-production shape validation. Those templates already model the production direction: independent worker nodes, one Job per Agent Run, a per-run ServiceAccount, disabled service-account token mounting for run Pods, default-deny NetworkPolicies, resource quota, ephemeral workspaces, non-root containers, dropped capabilities, read-only root filesystems, and runtime-default seccomp.

TD-211 is not a complete multi-tenant production boundary. It depends on the host container runtime and Linux kernel boundary used by Docker or Podman. PatchPilot still needs a production runtime decision that can fit the Kubernetes worker-pool model, improve kernel isolation for untrusted code execution, keep compatibility high enough for ordinary Node/TypeScript repository work, and leave clear exit criteria before unattended production execution is advertised.

## Decision Drivers

- Agent Run workloads execute untrusted repository scripts, package manager hooks, test commands, and Codex-created shell commands.
- The production runtime must fit the TD-302 per-run Kubernetes Job and `RuntimeClass` model without changing the Workspace Run, CodexRunner, TestRunner, artifact, or audit contracts.
- The default runtime should support ordinary build and test workloads with minimal image changes.
- Operators need a local fallback for development and a production fallback path for workloads that are incompatible with the hardened runtime.
- Runtime startup, image handling, observability, cleanup, resource limits, and egress policy must remain understandable to a small operations team.
- Compatibility failures must be observable environment failures, not silent downgrades to weaker isolation.

## Decision

Use gVisor (`runsc`) as PatchPilot's default production sandbox runtime for unattended Agent Run Pods.

Production worker clusters should install gVisor on the dedicated PatchPilot worker node pool and expose it through Kubernetes `RuntimeClass`, for example `runtimeClassName: patchpilot-gvisor`. The scheduler or run-template stamping layer should set that `RuntimeClass` on Agent Run Jobs when the Capability Manifest requests the default production sandbox.

Keep the TD-211 rootless Docker/Podman sandbox as the local, CI-style smoke, and single-tenant fallback runtime. It remains valuable for developer machines and for environments that cannot yet run a hardened Kubernetes worker pool. It is not the default multi-tenant production runtime after this ADR.

Do not use direct Firecracker orchestration as PatchPilot's default runtime. Firecracker is a strong microVM primitive, but PatchPilot would need to own or adopt a higher-level image, filesystem, networking, jailer, telemetry, and lifecycle integration before it can run Work Items safely. Firecracker can remain a future implementation detail behind Kata Containers or a purpose-built runner.

Do not make Kata Containers the default runtime now. Kata provides a stronger VM-style isolation boundary than gVisor for some threat models, and it should remain an approved high-isolation option for workloads that justify higher operating cost or need a VM boundary. It is not the default because it has heavier node requirements, more image/runtime operational surface, and higher expected cold-start/resource overhead than gVisor for ordinary PatchPilot repository work.

Runtime selection policy:

- `production-default`: Kubernetes Agent Run Job with `runtimeClassName: patchpilot-gvisor`.
- `local-default`: TD-211 rootless Docker/Podman sandbox.
- `compatibility-fallback`: TD-211 rootless Docker/Podman or a Kubernetes runc RuntimeClass only for single-tenant, explicitly approved, non-production, or break-glass execution.
- `high-isolation`: Kata Containers RuntimeClass for selected tenants or workloads after a separate cluster validation pass.
- `not-supported-default`: direct Firecracker VMM orchestration.

PatchPilot must record the selected runtime class, fallback reason, image, resource limits, base commit, task branch, workspace identity, command/test evidence, and cleanup status on Workspace Run or Agent Run evidence.

## Production Runtime Contract

A production Agent Run Job using the default runtime must satisfy the ADR-0004 boundary plus these runtime-specific requirements:

- The Pod uses a named RuntimeClass that resolves to gVisor on worker nodes.
- The Pod uses the TD-302 worker node selector and toleration so untrusted runs do not land on control-plane, API, UI, database, or general-purpose nodes.
- The container runs as a non-root UID/GID, drops all Linux capabilities, disables privilege escalation, uses a read-only root filesystem, mounts only an ephemeral workspace and bounded tmpfs, and does not mount host paths, Docker sockets, host home directories, kubeconfig files, SSH agents, or cloud credential directories.
- The worker namespace enforces resource quota, LimitRange defaults, and NetworkPolicies. TD-212 must replace broad public egress with audited destination allowlists before production use.
- Agent Run Pods keep `automountServiceAccountToken: false` unless a future task grants a narrowly scoped per-run token through the Capability Manifest and audit policy.
- Runtime fallback must be explicit in the Capability Manifest or operator approval. The scheduler must not silently replace gVisor with runc because a runtime is missing or incompatible.

## Runtime Evaluation

### gVisor

gVisor interposes a user-space kernel between the containerized process and the host kernel. It integrates with Kubernetes through containerd and RuntimeClass while preserving the ordinary container image workflow. That makes it the best fit for PatchPilot's current architecture: per-run Jobs, existing container images, and the same workspace/test contracts.

Strengths:

- Better kernel attack-surface reduction than plain runc while retaining container image ergonomics.
- Kubernetes RuntimeClass integration matches TD-302 with minimal template changes.
- Lower operational complexity than owning a microVM lifecycle directly.
- Good default compatibility for typical Node, pnpm, TypeScript, shell, git, and test workloads.

Costs and compatibility risks:

- Not a full hardware VM boundary.
- Some syscalls, privileged operations, low-level networking, tracing, FUSE, nested containers, and unusual filesystem behavior can be incompatible or slower.
- Performance overhead is workload-dependent and must be measured with PatchPilot's real target repos before hard SLOs are promised.

Decision: accepted as the production default.

### Kata Containers

Kata runs containers inside lightweight VMs and integrates with Kubernetes through RuntimeClass. This gives a stronger isolation story for tenants that require a VM boundary.

Strengths:

- Stronger guest-kernel or VM boundary than gVisor for some threat models.
- RuntimeClass integration can fit the TD-302 worker-pool model.
- Can be a good high-isolation tier for paid or regulated deployments.

Costs and compatibility risks:

- Higher node preparation complexity, virtualization requirements, image/runtime tuning, and expected cold-start/resource overhead.
- Nested virtualization may not be available or cost-effective in every cloud, CI, or developer environment.
- Operational debugging is more complex than gVisor for the default path.

Decision: keep as a future high-isolation option, not the default.

### Firecracker

Firecracker provides lightweight microVMs and a strong primitive for workload isolation. By itself it is not a complete PatchPilot runtime adapter.

Strengths:

- Strong microVM isolation primitive with a small virtual machine monitor.
- Good fit for platforms that can invest in custom image, network, storage, and lifecycle orchestration.

Costs and compatibility risks:

- Direct use requires PatchPilot to own kernel/rootfs preparation, jailer configuration, networking, block devices, logging, cleanup, and image compatibility.
- Kubernetes integration requires another layer such as Kata or firecracker-containerd, which becomes the real runtime surface to operate.
- Local developer machines and many CI environments cannot run the same path without nested virtualization support.

Decision: reject as the direct default. Reconsider only through a managed integration layer after gVisor production exit criteria are met.

### Rootless Docker Or Podman With runc

The TD-211 sandbox is the current implemented baseline.

Strengths:

- Already implemented and tested in this repo.
- Works on local developer machines and CI-style smoke environments.
- Enforces important process, filesystem, resource, and environment restrictions.

Costs and compatibility risks:

- Still relies on the host kernel boundary and container runtime configuration.
- Docker Desktop and local host behavior can differ from production Linux nodes.
- Not sufficient as the default multi-tenant production isolation boundary.

Decision: keep as local and explicitly approved fallback.

## Minimal PoC

`scripts/poc-sandbox-runtime.mjs` is the TD-301 reproducible PoC. It detects local hardened-runtime availability, writes a minimal work item into a temporary workspace, runs it inside the strongest locally available compatible runtime, and records JSON evidence at `docs/adr/artifacts/td-301-sandbox-runtime-poc.json`.

On this development host, `runsc`, `kata-runtime`, and `firecracker` are unavailable, and Docker exposes only the default runc runtime. The PoC therefore exercises the TD-211-compatible local substitute and records residual risk rather than pretending to prove gVisor production behavior.

The PoC passes when the minimal work item proves:

- the command runs as non-root;
- `HOME` is the sandbox home, not the host home;
- the Docker socket is not visible;
- an unmounted host path is not readable;
- the only write needed for the work item lands in `/workspace`;
- JSON evidence names the runtime family, whether it is the selected production runtime, and any residual risk.

## Production Exit Criteria

PatchPilot may advertise the gVisor runtime as production-enforceable only when all of the following are true:

1. A Kubernetes worker node pool has gVisor installed and exposes a stable `patchpilot-gvisor` RuntimeClass.
2. The Agent Run Job template or scheduler stamping layer sets `runtimeClassName: patchpilot-gvisor` for default production runs.
3. At least one real Work Item E2E path runs through the Kubernetes worker pool with gVisor, records Workspace Run and Agent Run evidence, runs the configured test command, stores artifacts, and reaches Pull Request/acceptance evidence.
4. Runtime evidence records runtime class, image digest or tag, resource limits, workspace storage limit, timeout, base commit, task branch, and cleanup result.
5. Compatibility tests cover representative Node/pnpm, git, test-runner, artifact upload, Codex CLI or SDK adapter, and failure-reporting workloads.
6. Failure tests cover runtime missing, incompatible syscall/tool failure, timeout, disk limit, memory limit, denied host path, missing Docker socket, blocked service-account token, and cleanup failure.
7. TD-212 network egress allowlists are enforced for Agent Run Pods, including cloud metadata and private-network denial.
8. TD-213 Secret Broker prevents production secret injection unless the Capability Manifest grants a short-lived audited secret.
9. TD-218/TD-219 Capability Manifest and command wrapper enforcement choose the runtime explicitly and prevent silent fallback.
10. Operators have documented fallback and escalation procedures for gVisor incompatibility, including when a run may use Kata or runc and how that approval is audited.
11. Cost and performance baselines exist for startup latency, CPU/memory overhead, ephemeral storage usage, and average Work Item run duration against representative repositories.

## Consequences

- TD-302 should grow a production overlay or scheduler stamping path that includes `runtimeClassName: patchpilot-gvisor`; the existing non-production template can remain runtime-neutral.
- Runtime selection becomes part of the Capability Manifest and Workspace Run evidence.
- Some project workflows that require Docker builds, privileged kernel features, FUSE, ptrace, unusual networking, or nested virtualization will need a separate approved runner path instead of weakening the default.
- Production clusters need dedicated worker nodes with gVisor installed, monitored, and upgraded separately from control-plane workloads.
- gVisor compatibility and performance are now explicit production-readiness work, not assumptions.
- Kata remains a strategic option for stronger isolation tiers, but it should not delay the default gVisor path.
- Direct Firecracker support is out of scope until PatchPilot has a concrete integration layer and operational model.

## Non-Goals

- This ADR does not implement Kubernetes scheduler/runtime stamping.
- This ADR does not change TD-211 rootless container runtime code.
- This ADR does not implement TD-212 network egress allowlists.
- This ADR does not implement TD-213 Secret Broker behavior.
- This ADR does not implement TD-218 Capability Manifest or TD-219 command wrapper enforcement.
- This ADR does not prove gVisor on this local host; the included PoC records local substitute evidence when hardened runtimes are unavailable.

## References

- Kubernetes RuntimeClass: https://kubernetes.io/docs/concepts/containers/runtime-class/
- gVisor containerd quick start: https://gvisor.dev/docs/user_guide/containerd/quick_start/
- gVisor compatibility notes: https://gvisor.dev/docs/user_guide/compatibility/
- Kata Containers documentation: https://katacontainers.io/docs/
- Firecracker project documentation: https://firecracker-microvm.github.io/
