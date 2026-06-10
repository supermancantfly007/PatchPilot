import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const overlayPath = resolve(repoRoot, "infra/k8s/worker-pool/nonprod");

const requiredFiles = [
  "infra/k8s/worker-pool/base/kustomization.yaml",
  "infra/k8s/worker-pool/base/namespace.yaml",
  "infra/k8s/worker-pool/base/resource-quota.yaml",
  "infra/k8s/worker-pool/base/network-policy.yaml",
  "infra/k8s/worker-pool/base/worker-deployment.yaml",
  "infra/k8s/worker-pool/run-template/service-account.yaml",
  "infra/k8s/worker-pool/run-template/job.yaml",
  "infra/k8s/worker-pool/nonprod/kustomization.yaml"
];

for (const relativePath of requiredFiles) {
  assert(existsSync(resolve(repoRoot, relativePath)), `Missing ${relativePath}`);
}

const rendered = run("kubectl", ["kustomize", overlayPath]);

const renderedChecks = [
  ["Namespace", "name: patchpilot-workers"],
  ["ResourceQuota", "kind: ResourceQuota"],
  ["LimitRange", "kind: LimitRange"],
  ["default-deny NetworkPolicy", "name: patchpilot-worker-default-deny"],
  ["DNS NetworkPolicy", "name: patchpilot-worker-allow-dns"],
  ["API egress NetworkPolicy", "name: patchpilot-worker-allow-control-plane-api"],
  ["external egress NetworkPolicy", "name: patchpilot-agent-run-allow-external-egress"],
  ["worker controller Deployment", "name: patchpilot-worker-controller"],
  ["worker controller ServiceAccount", "serviceAccountName: patchpilot-worker-controller"],
  ["per-run ServiceAccount", "name: patchpilot-run-example"],
  ["per-run Job", "name: patchpilot-agent-run-example"],
  ["per-run Job ServiceAccount", "serviceAccountName: patchpilot-run-example"],
  ["service account token disabled for runs", "automountServiceAccountToken: false"],
  ["worker node selector", "patchpilot.dev/node-pool: workers"],
  ["worker node taint toleration", "patchpilot.dev/workload"],
  ["run network profile", "patchpilot.dev/network-profile: agent-run"],
  ["restricted pod security", "pod-security.kubernetes.io/enforce: restricted"],
  ["quota jobs cap", "count/jobs.batch: \"20\""],
  ["public egress private range exclusion", "169.254.0.0/16"]
];

for (const [label, needle] of renderedChecks) {
  assert(rendered.includes(needle), `Rendered overlay is missing ${label}: ${needle}`);
}

console.log("Kubernetes worker pool manifests rendered and passed static checks");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}
