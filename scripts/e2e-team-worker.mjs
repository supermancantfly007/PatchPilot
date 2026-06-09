import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiBaseUrl = process.env.PATCHPILOT_E2E_API_BASE_URL || "http://localhost:4000";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedRoles = ["backend", "frontend", "test", "ops"];

const requirement = await requestJson("/api/requirements", {
  method: "POST",
  body: JSON.stringify({
    rawInput: "验证 agent team 可以自动领取前端、后端、测试和运维任务，并完成测试与审查。",
    template: "feature"
  })
});
const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
const approval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });

const roles = approval.workItems.map((item) => item.role).sort();
assertEqual(JSON.stringify(roles), JSON.stringify([...expectedRoles].sort()), "approved PRD should create team work items");

await runWorkerOnce();

const completed = await poll(async () => {
  const snapshot = await requestJson("/api/snapshot");
  const workItems = snapshot.workItems.filter((item) => item.prdId === prd.id);
  const runs = snapshot.agentRuns.filter((run) => run.prdId === prd.id);
  const workspaceRuns = snapshot.workspaceRuns.filter((workspace) => workspace.prdId === prd.id);
  const testRuns = snapshot.testRuns.filter((test) => test.prdId === prd.id);
  const pullRequests = snapshot.pullRequests.filter((pullRequest) => pullRequest.prdId === prd.id);
  const auditEvents = snapshot.auditEvents.filter((event) => event.prdId === prd.id);
  if (runs.length < expectedRoles.length) return undefined;
  if (!runs.every((run) => run.status === "succeeded")) return undefined;
  if (!workItems.every((item) => item.status === "review")) return undefined;
  if (workspaceRuns.length < expectedRoles.length) return undefined;
  if (!workspaceRuns.every((workspace) => workspace.status === "archived")) return undefined;
  if (testRuns.length < expectedRoles.length) return undefined;
  if (!testRuns.every((test) => test.status === "passed")) return undefined;
  if (pullRequests.length < expectedRoles.length) return undefined;
  if (!pullRequests.every((pullRequest) => pullRequest.status === "ready_for_review")) return undefined;
  if (!auditEvents.some((event) => event.action === "agent_run.succeeded")) return undefined;
  if (!auditEvents.some((event) => event.action === "pull_request.ready_for_review")) return undefined;
  return { runs, workItems, workspaceRuns, testRuns, pullRequests, auditEvents };
}, 15000);

assertEqual(completed.runs.length, expectedRoles.length, "worker should start one run per team work item");
assertEqual(
  JSON.stringify(completed.workItems.map((item) => item.role).sort()),
  JSON.stringify([...expectedRoles].sort()),
  "completed work item roles should match team roles"
);
assertEqual(completed.workspaceRuns.length, expectedRoles.length, "worker should archive workspace evidence per run");
assertEqual(completed.testRuns.length, expectedRoles.length, "worker should record test evidence per run");
assertEqual(completed.pullRequests.length, expectedRoles.length, "worker should create one PR record per run");

console.log("PatchPilot team worker E2E passed");

async function runWorkerOnce() {
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", "@patchpilot/worker", "start"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATCHPILOT_API_BASE_URL: apiBaseUrl,
        PATCHPILOT_WORKER_ONCE: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`worker exited ${code}\n${output}`));
    });
  });
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

async function poll(read, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
