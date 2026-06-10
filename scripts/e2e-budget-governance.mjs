import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-budget-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_BUDGET_PORT || 4200 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_RUNNER: "simulated",
    PATCHPILOT_SIMULATION_DELAY_FACTOR: "0",
    PATCHPILOT_BUDGET_RUN_USD: "0.2"
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
      rawInput: "验证预算治理会暂停超预算 run，审批后继续执行同一个 run。",
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const approval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const pausedRun = await requestJson(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "simulated" })
  });
  assertEqual(pausedRun.status, "needs_approval", "over-budget run should pause for approval");
  assertEqual(pausedRun.budgetUsd, 0.2, "run should record the effective budget");
  assert(pausedRun.budgetApprovalId, "paused run should link to a budget approval");

  const pausedSnapshot = await requestJson("/api/snapshot");
  const budgetApproval = pausedSnapshot.approvals.find((item) => item.id === pausedRun.budgetApprovalId);
  const pausedWorkItem = pausedSnapshot.workItems.find((item) => item.id === workItem.id);
  assertEqual(pausedWorkItem.status, "blocked", "work item should be blocked while waiting for approval");
  assertEqual(budgetApproval.kind, "budget_exceeded", "approval should be a budget gate");
  assertEqual(budgetApproval.status, "pending", "budget approval should start pending");
  assert(
    pausedSnapshot.auditEvents.some((event) => event.action === "budget.hard_threshold_exceeded"),
    "audit should record the hard budget threshold"
  );

  const approved = await requestJson(`/api/approvals/${budgetApproval.id}/approve`, {
    method: "POST",
    body: JSON.stringify({
      decidedBy: "e2e-budget-owner",
      decisionReason: "Budget governance E2E approves the overrun"
    })
  });
  assertEqual(approved.status, "approved", "budget approval should be approved");

  const completed = await poll(async () => {
    const snapshot = await requestJson("/api/snapshot");
    const run = snapshot.agentRuns.find((item) => item.id === pausedRun.id);
    const item = snapshot.workItems.find((candidate) => candidate.id === workItem.id);
    const actions = snapshot.auditEvents.map((event) => event.action);
    if (run?.status !== "succeeded") return undefined;
    if (item?.status !== "review") return undefined;
    if (!actions.includes("agent_run.resumed")) return undefined;
    if (!actions.includes("agent_run.succeeded")) return undefined;
    return { run, item, actions };
  }, 15000);
  assertEqual(completed.run.id, pausedRun.id, "approval should resume the original run");

  console.log("PatchPilot budget governance E2E passed");
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
