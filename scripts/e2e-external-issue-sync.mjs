import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-external-issue-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_EXTERNAL_ISSUE_PORT || 4400 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

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
      rawInput: "验证 Linear issue 状态可以阻塞并重新触发 PatchPilot WorkItem。",
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const approval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const link = await requestJson("/api/integrations/issues/link", {
    method: "POST",
    body: JSON.stringify({
      provider: "linear",
      entityType: "work_item",
      entityId: workItem.id,
      externalIssueId: "LIN-E2E-305",
      externalKey: "LIN-E2E-305",
      externalUrl: "https://linear.app/patchpilot/issue/LIN-E2E-305",
      statusName: "Todo"
    })
  });
  assertEqual(link.evidence.direction, "patchpilot_to_external", "link should mirror PatchPilot state outbound");
  assertEqual(link.link.statusCategory, "ready", "outbound mirror should use PatchPilot WorkItem status");

  const blocked = await requestJson("/api/integrations/issues/status", {
    method: "POST",
    body: JSON.stringify({
      provider: "linear",
      externalIssueId: "LIN-E2E-305",
      statusName: "Blocked",
      actor: "linear-webhook",
      idempotencyKey: "linear-e2e-blocked"
    })
  });
  assertEqual(blocked.evidence.action, "blocked", "external blocked status should create a PatchPilot blocker");
  assertEqual(blocked.workItem.status, "blocked", "external issue should block the WorkItem");

  const blockedStart = await requestRaw(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "simulated" })
  });
  assertEqual(blockedStart.status, 409, "blocked WorkItem should not start");

  const ready = await requestJson("/api/integrations/issues/status", {
    method: "POST",
    body: JSON.stringify({
      provider: "linear",
      externalIssueId: "LIN-E2E-305",
      statusName: "Ready",
      actor: "linear-webhook",
      idempotencyKey: "linear-e2e-ready"
    })
  });
  assertEqual(ready.evidence.action, "triggered", "external ready status should trigger local work");
  assertEqual(ready.workItem.status, "ready", "triggered WorkItem should return to ready");

  const startedRun = await requestJson(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "simulated" })
  });
  assertEqual(startedRun.status, "running", "triggered WorkItem should start after external unblock");

  const completed = await poll(async () => {
    const snapshot = await requestJson("/api/snapshot");
    const run = snapshot.agentRuns.find((item) => item.id === startedRun.id);
    const item = snapshot.workItems.find((candidate) => candidate.id === workItem.id);
    const actions = snapshot.auditEvents.map((event) => event.action);
    if (run?.status !== "succeeded") return undefined;
    if (item?.status !== "review") return undefined;
    if (!actions.includes("external_issue.linked")) return undefined;
    if (!actions.includes("external_issue.status_observed")) return undefined;
    if (!item.externalIssueSyncEvidence.some((evidence) => evidence.action === "triggered")) return undefined;
    return { run, item, actions };
  }, 15000);
  assertEqual(completed.run.workItemId, workItem.id, "completed run should belong to the triggered WorkItem");

  console.log("PatchPilot external issue sync E2E passed");
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await rm(dataDir, { recursive: true, force: true });
}

async function requestJson(path, init = {}) {
  const response = await requestRaw(path, init);
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function requestRaw(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${apiBaseUrl}${path}`, { ...init, headers });
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

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}
