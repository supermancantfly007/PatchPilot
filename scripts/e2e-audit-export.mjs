import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-audit-export-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_AUDIT_EXPORT_PORT || 4700 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

const rawEmail = "security.auditor@example.com";
const rawPhone = "+1 415-555-0199";
const rawAccount = "customer_EXPORT123456";

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_RUNNER: "simulated",
    PATCHPILOT_SIMULATION_DELAY_FACTOR: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let apiOutput = "";
api.stdout.on("data", (chunk) => {
  apiOutput += chunk.toString("utf8");
});
api.stderr.on("data", (chunk) => {
  apiOutput += chunk.toString("utf8");
});

try {
  await waitForHealth();

  const requirement = await requestJson("/api/requirements", {
    method: "POST",
    body: JSON.stringify({
      rawInput: `Export the full PRD audit package for ${rawEmail}, ${rawPhone}, and ${rawAccount}.`,
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const approval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const startedRun = await requestJson(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "simulated" })
  });
  const completedRun = await poll(async () => {
    const run = await requestJson(`/api/runs/${startedRun.id}`);
    return run.status === "succeeded" ? run : undefined;
  }, 15000);

  const auditPackage = await requestJson(`/api/prds/${prd.id}/audit-export`, {
    headers: {
      "x-patchpilot-admin-actor": "admin_e2e"
    }
  });
  const packageText = JSON.stringify(auditPackage);
  assert(!packageText.includes(rawEmail), "audit export should redact email PII");
  assert(!packageText.includes(rawPhone), "audit export should redact phone PII");
  assert(!packageText.includes(rawAccount), "audit export should redact customer account PII");
  assert(packageText.includes("[REDACTED:email]"), "audit export should include email redaction marker");
  assert(packageText.includes("[REDACTED:phone]"), "audit export should include phone redaction marker");
  assert(packageText.includes("[REDACTED:account-id]"), "audit export should include account redaction marker");
  assertEqual(auditPackage.manifest.formatVersion, "patchpilot.audit.prd.v1", "audit export format should be stable");
  assertEqual(auditPackage.manifest.scope.prdId, prd.id, "audit export should be scoped to the PRD");
  assertEqual(auditPackage.manifest.createdBy.actorId, "admin_e2e", "audit export should record admin intent");
  assertEqual(auditPackage.manifest.retention.policyVersion, "td-308-retention-v1", "retention policy should be versioned");
  assertEqual(auditPackage.manifest.retention.worm.mode, "metadata_only", "WORM semantics should be declared");
  assertEqual(auditPackage.verification.valid, true, "audit export chain verification should pass");
  assertEqual(auditPackage.verification.headHash, auditPackage.auditEvents.at(-1).hash, "head hash should match exported JSONL");
  assert(
    auditPackage.verification.scopeEventIds.includes(auditPackage.manifest.exportAuditEventId),
    "scope event ids should include the audit.exported event"
  );
  assert(
    auditPackage.records.agentRuns.some((run) => run.id === completedRun.id),
    "audit export should include the completed AgentRun"
  );
  assert(
    auditPackage.records.testRuns.some((testRun) => testRun.runId === completedRun.id),
    "audit export should include linked TestRun evidence"
  );
  assert(
    auditPackage.artifactManifest.length >= 5 &&
      auditPackage.artifactManifest.every((artifact) => artifact.checksumSha256 && artifact.retentionTier),
    "audit export should include artifact checksums and retention tiers"
  );

  const verification = await requestJson("/api/audit/verify");
  assertEqual(verification.valid, true, "global audit chain should still verify after export");
  assertEqual(verification.headHash, auditPackage.verification.headHash, "global head hash should match export package head");

  console.log("PatchPilot audit export E2E passed");
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await rm(dataDir, { recursive: true, force: true });
}

async function requestJson(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForHealth() {
  await poll(async () => {
    if (api.exitCode !== null) {
      throw new Error(`API exited before health check\n${apiOutput}`);
    }
    try {
      const health = await requestJson("/health");
      return health.ok ? health : undefined;
    } catch (_error) {
      return undefined;
    }
  }, 20000);
}

async function poll(read, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.on("exit", () => resolve(undefined));
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 5000);
  });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
