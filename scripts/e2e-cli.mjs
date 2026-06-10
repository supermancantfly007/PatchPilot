import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-cli-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_CLI_PORT || 4100 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;
const cliEnv = {
  ...process.env,
  PATCHPILOT_API_BASE_URL: apiBaseUrl
};

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

  const requirement = await runCliJson([
    "submit",
    "--input",
    "让 CLI 在没有 Web UI 的情况下提交需求、执行 agent team、验收并导出报告。",
    "--template",
    "feature",
    "--json"
  ]);
  assert(requirement.id, "submit should return a requirement id");

  const prdResponse = await runCliJson(["create-prd", "--requirement", requirement.id, "--json"]);
  assert(prdResponse.prd?.id, "create-prd should return a PRD id");

  const approval = await runCliJson(["approve-prd", "--prd", prdResponse.prd.id, "--json"]);
  assertEqual(approval.workItems.length, 4, "approve-prd should create team work items");

  const snapshotBeforeRun = await runCliJson(["snapshot", "--json"]);
  assertEqual(snapshotBeforeRun.prds.length, 1, "snapshot should include the approved PRD");

  const worker = await runCliJson(["worker-once", "--runner", "simulated", "--json"]);
  assertEqual(worker.planned, 4, "worker-once should plan all team work items");
  assertEqual(worker.dispatched, 4, "worker-once should dispatch all team work items");

  const completed = await poll(async () => {
    const snapshot = await requestJson("/api/snapshot");
    const runs = snapshot.agentRuns.filter((run) => run.prdId === prdResponse.prd.id);
    const workItems = snapshot.workItems.filter((item) => item.prdId === prdResponse.prd.id);
    const testRuns = snapshot.testRuns.filter((testRun) => testRun.prdId === prdResponse.prd.id);
    const reviews = snapshot.reviewRecords.filter((review) => review.prdId === prdResponse.prd.id);
    if (runs.length !== 4) return undefined;
    if (!runs.every((run) => run.status === "succeeded")) return undefined;
    if (!workItems.every((item) => item.status === "review")) return undefined;
    if (!testRuns.every((testRun) => testRun.status === "passed")) return undefined;
    if (reviews.length !== 4) return undefined;
    return { runs, workItems, testRuns, reviews };
  }, 15000);
  assertEqual(completed.runs.length, 4, "CLI worker path should complete all runs");

  const acceptance = await runCliJson(["accept-prd", "--prd", prdResponse.prd.id, "--status", "accepted", "--json"]);
  assertEqual(acceptance.decisions.length, 4, "accept-prd should accept one run per work item");

  const reportPath = join(dataDir, "delivery-report.md");
  await runCliJson(["report", "--prd", prdResponse.prd.id, "--out", reportPath, "--json"]);
  const report = await readFile(reportPath, "utf8");
  assert(report.includes("# PatchPilot Delivery Report"), "report should write markdown output");
  assert(report.includes("Accepted runs: 4/4"), "report should include acceptance evidence");
  assert(/Passed test runs: \d+\/\d+/.test(report), "report should include passed test run summary");
  assert(/Test runs: passed=\d+/.test(report), "report should include test evidence counts");

  const happyReportPath = join(dataDir, "happy-path-report.md");
  const happyPath = await runCliJson([
    "happy-path",
    "--input",
    "通过单条 CLI 命令完成需求到验收报告的 happy path。",
    "--template",
    "feature",
    "--runner",
    "simulated",
    "--out",
    happyReportPath,
    "--json"
  ]);
  assertEqual(happyPath.acceptance.decisions.length, 4, "happy-path should accept all team runs");
  const happyReport = await readFile(happyReportPath, "utf8");
  assert(happyReport.includes("Accepted runs: 4/4"), "happy-path should write an accepted report");

  console.log("PatchPilot CLI E2E passed");
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await rm(dataDir, { recursive: true, force: true });
}

async function runCliJson(args) {
  const { stdout } = await runProcess("pnpm", ["--silent", "cli", "--", ...args], {
    env: cliEnv
  });
  return JSON.parse(stdout);
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...options.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
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
