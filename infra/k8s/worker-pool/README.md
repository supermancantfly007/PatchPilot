# Kubernetes Worker Pool Templates

This directory contains the TD-302 non-production Kubernetes worker pool template. It is intentionally isolated from runtime code: the manifests define scheduling, namespace quotas, network boundaries, and the per-run service account pattern that future scheduler/runtime work can target.

## Layout

- `base/`: shared worker namespace, controller service account/RBAC, quota, default limits, NetworkPolicies, and worker controller Deployment.
- `run-template/`: one concrete AgentRun Job plus its own ServiceAccount. A real scheduler should stamp one copy per `AgentRun` and replace the `example` id in names, labels, and env.
- `nonprod/`: deployable Kustomize overlay that renders `base` plus the example run. It swaps images to `busybox:1.36` so a cluster can smoke the manifest shape without a published PatchPilot worker image.

## Worker Node Isolation

Worker Pods are scheduled only onto nodes labeled for PatchPilot workers and tolerate a matching taint:

```bash
kubectl label node <node-name> patchpilot.dev/node-pool=workers
kubectl taint node <node-name> patchpilot.dev/workload=worker:NoSchedule
```

Do not label API/UI nodes with `patchpilot.dev/node-pool=workers`; the worker pool is expected to be an independent node group.

## Deploy Non-Production Overlay

Render and validate locally:

```bash
pnpm k8s:validate
kubectl kustomize infra/k8s/worker-pool/nonprod
```

Apply to a non-production cluster:

```bash
kubectl apply -k infra/k8s/worker-pool/nonprod
kubectl get deploy,job,sa,resourcequota,networkpolicy -n patchpilot-workers
```

The non-production overlay uses placeholder `busybox` containers. To run real workers, patch these images in your own overlay:

```yaml
images:
  - name: ghcr.io/patchpilot/worker
    newName: <your-registry>/patchpilot-worker
    newTag: <tag>
  - name: ghcr.io/patchpilot/agent-runner
    newName: <your-registry>/patchpilot-agent-runner
    newTag: <tag>
```

## Per-Run Service Account Pattern

Each AgentRun gets:

- a dedicated ServiceAccount named from the run id, for example `patchpilot-run-example`;
- a Job that uses only that ServiceAccount;
- `automountServiceAccountToken: false` by default for run Pods;
- labels carrying `patchpilot.dev/agent-run-id` for cleanup, telemetry, and audit joins.

Generated run manifests should be deleted after artifact collection, or allowed to expire through `ttlSecondsAfterFinished`.

## Network Policy

The namespace starts with default-deny ingress and egress. Explicit egress is allowed for:

- DNS in `kube-system`;
- worker controller traffic to a PatchPilot API Pod in a namespace labeled `patchpilot.dev/control-plane=true`;
- AgentRun telemetry to an OpenTelemetry collector in a namespace labeled `patchpilot.dev/observability=true`;
- AgentRun HTTP/HTTPS egress to public IP space while excluding RFC1918 and link-local ranges, including common cloud metadata endpoints.

This is a Kubernetes baseline, not the final TD-212 egress allowlist. FQDN-level allowlisting for Git remotes, package registries, and Codex/OpenAI endpoints needs a CNI or egress proxy that supports DNS-aware policy.

## Quota

`base/resource-quota.yaml` caps Pods, Jobs, ServiceAccounts, CPU, memory, and ephemeral storage for the worker namespace. `base/limit-range.yaml` supplies default requests/limits so ad hoc run Jobs cannot bypass quota by omitting resources.

## Production Notes

These templates are suitable for non-production deployment and shape validation. Before production use, add the TD-301 runtime decision, TD-212 audited egress allowlist, TD-213 secret broker integration, and cluster-specific API-server egress for any controller that creates Jobs directly through the Kubernetes API.
