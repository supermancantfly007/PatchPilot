import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-acceptance-gate-e2e-"));
const dataFile = join(dataDir, "patchpilot-store.json");
const apiPort = Number(process.env.PATCHPILOT_E2E_ACCEPTANCE_GATE_PORT || 4400 + (process.pid % 1000));
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

let api = startApi();

try {
  await waitForHealth();

  const requirement = await requestJson("/api/requirements", {
    method: "POST",
    body: JSON.stringify({
      rawInput: "验证验收质量门会阻止不完整证据被接受。",
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const approval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const run = await requestJson(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "simulated" })
  });

  const completed = await poll(async () => {
    const snapshot = await requestJson("/api/snapshot");
    const currentRun = snapshot.agentRuns.find((item) => item.id === run.id);
    const testCase = snapshot.testCases.find((item) => item.workItemId === workItem.id);
    const pullRequest = snapshot.pullRequests.find((item) => item.runId === run.id);
    const verification = await requestJson("/api/audit/verify");
    if (currentRun?.status !== "succeeded" || !testCase || !pullRequest || !verification.valid) return undefined;
    return { currentRun, testCase, pullRequest, verification };
  }, 15000);

  assertEqual(completed.testCase.status, "passed", "baseline TestCase should pass before fixture mutation");
  assertEqual(completed.pullRequest.status, "ready_for_review", "baseline PR should be ready for review");

  await stopApi();
  const store = JSON.parse(await readFile(dataFile, "utf8"));
  const storedTestCase = store.testCases.find((item) => item.id === completed.testCase.id);
  assert(storedTestCase, "store should persist the TestCase");
  storedTestCase.status = "failed";
  storedTestCase.flaky = true;
  await writeFile(dataFile, JSON.stringify(store, null, 2), "utf8");

  api = startApi();
  await waitForHealth();

  const blockedAcceptance = await request(`/api/acceptance/${run.id}`, {
    method: "POST",
    body: JSON.stringify({ status: "accepted" })
  });
  const blockedBody = await blockedAcceptance.text();
  assertEqual(blockedAcceptance.status, 409, "accepted decision should be rejected when the quality gate is unmet");
  assert(blockedBody.includes("Acceptance quality gate failed"), "blocked response should name the quality gate");
  assert(blockedBody.includes("TestCase"), "blocked response should include failed TestCase evidence");
  assert(blockedBody.includes("flaky"), "blocked response should include flaky evidence");

  const rejection = await requestJson(`/api/acceptance/${run.id}`, {
    method: "POST",
    body: JSON.stringify({ status: "rejected", reason: "质量门显示 TestCase 未通过且存在 flaky 信号。" })
  });
  assertEqual(rejection.status, "rejected", "rejection should still be allowed when the gate is unmet");

  const afterRejection = await requestJson("/api/snapshot");
  const reworkItem = afterRejection.workItems.find((item) => item.id === workItem.id);
  assertEqual(reworkItem.status, "ready", "rejected gated delivery should return to rework queue");
  assert(
    !afterRejection.acceptances.some((acceptance) => acceptance.runId === run.id && acceptance.status === "accepted"),
    "blocked acceptance should not write an accepted decision"
  );

  console.log("PatchPilot acceptance quality gate E2E passed");
} finally {
  await stopApi();
  await rm(dataDir, { recursive: true, force: true });
}

function startApi() {
  const child = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
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
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk.toString("utf8");
  });
  return child;
}

async function requestJson(path, init = {}) {
  const response = await request(path, init);
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${apiBaseUrl}${path}`, { ...init, headers });
}

async function waitForHealth() {
  await poll(async () => {
    if (api.exitCode !== null) {
      throw new Error(`API exited before health check\n${api.output}`);
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

async function stopApi() {
  if (!api || api.exitCode !== null) return;
  api.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
