import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiBaseUrl = process.env.PATCHPILOT_E2E_API_BASE_URL || "http://localhost:4000";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const { bug, workItem } = await requestJson("/api/bugs", {
  method: "POST",
  body: JSON.stringify({
    title: "验收按钮点击后没有返回工作台",
    description: "用户在验收页接受结果后仍停留在当前页面。",
    reproductionSteps: "提交需求，启动 agent team，进入验收页，点击接受结果。",
    expectedBehavior: "接受后返回工作台并保留验收记录。",
    actualBehavior: "页面停留不动。",
    severity: "high"
  })
});

assertEqual(workItem.role, "test", "bug should first create a test reproduction task");

await runWorkerOnce();

const afterRepro = await poll(async () => {
  const snapshot = await requestJson("/api/snapshot");
  const currentBug = snapshot.bugs.find((item) => item.id === bug.id);
  const fixWorkItem = snapshot.workItems.find((item) => item.sourceBugId === bug.id && item.role === "backend");
  const reproRun = snapshot.agentRuns.find((run) => run.workItemId === workItem.id);
  if (currentBug?.status !== "confirmed") return undefined;
  if (!fixWorkItem || fixWorkItem.status !== "ready") return undefined;
  if (reproRun?.status !== "succeeded") return undefined;
  return { currentBug, fixWorkItem, reproRun };
}, 15000);

await runWorkerOnce();

const afterFix = await poll(async () => {
  const snapshot = await requestJson("/api/snapshot");
  const currentBug = snapshot.bugs.find((item) => item.id === bug.id);
  const fixRun = snapshot.agentRuns.find((run) => run.workItemId === afterRepro.fixWorkItem.id);
  if (currentBug?.status !== "fixed") return undefined;
  if (fixRun?.status !== "succeeded") return undefined;
  return { currentBug, fixRun };
}, 15000);

assertEqual(afterFix.currentBug.status, "fixed", "developer fix task should close the bug");
console.log("PatchPilot bug worker E2E passed");

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
