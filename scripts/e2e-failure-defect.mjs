import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-failure-defect-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_FAILURE_DEFECT_PORT || 4300 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_RUNNER: "simulated",
    PATCHPILOT_SIMULATION_DELAY_FACTOR: "0",
    PATCHPILOT_SIMULATED_FAILURE_TYPE: "test_failed"
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
      rawInput: "验证失败分类会把失败测试沉淀为 Defect。",
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
  assert(
    startedRun.status === "running" || startedRun.status === "failed",
    "simulated run should start or fail immediately"
  );

  const evidence = await poll(async () => {
    const snapshot = await requestJson("/api/snapshot");
    const run = snapshot.agentRuns.find((item) => item.id === startedRun.id);
    if (run?.status !== "failed") return undefined;
    const testRun = snapshot.testRuns.find((item) => item.runId === run.id);
    const defect = snapshot.bugs.find((item) => item.sourceRunId === run.id);
    const testCase = snapshot.testCases.find((item) => item.workItemId === workItem.id);
    const workspace = snapshot.workspaceRuns.find((item) => item.runId === run.id);
    const actions = snapshot.auditEvents.map((event) => event.action);
    if (!testRun || !defect || !testCase || !workspace) return undefined;
    return { run, testRun, defect, testCase, workspace, actions };
  }, 15000);

  assertEqual(evidence.run.failureType, "test_failed", "run should be classified as test_failed");
  assertEqual(evidence.testRun.status, "failed", "failed TestRun should be recorded");
  assertEqual(evidence.testRun.workItemId, workItem.id, "TestRun should link to the work item");
  assertEqual(evidence.testRun.runId, startedRun.id, "TestRun should link to the run");
  assert(evidence.testRun.commit, "TestRun should record a commit");
  assertEqual(evidence.testCase.status, "failed", "linked TestCase should be marked failed");
  assertEqual(evidence.testCase.lastTestRunId, evidence.testRun.id, "TestCase should link to the latest TestRun");
  assertEqual(evidence.workspace.status, "failed", "WorkspaceRun should be marked failed");
  assertEqual(evidence.defect.status, "reported", "Defect should start reported");
  assertEqual(evidence.defect.sourceFailureType, "test_failed", "Defect should store the failure type");
  assertEqual(evidence.defect.sourceRunId, startedRun.id, "Defect should link to the run");
  assertEqual(evidence.defect.sourceTestRunId, evidence.testRun.id, "Defect should link to the TestRun");
  assertEqual(evidence.defect.sourceCommit, evidence.testRun.commit, "Defect should link to the commit");
  assert(evidence.actions.includes("test_run.failed"), "audit should record the failed TestRun");
  assert(evidence.actions.includes("defect.created"), "audit should record Defect creation");
  assert(evidence.actions.includes("agent_run.failed"), "audit should record the failed run");

  console.log("PatchPilot failure defect E2E passed");
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
