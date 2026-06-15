import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "patchpilot-codex-simple-e2e-"));
const projectRoot = join(root, "tiny-project");
const dataDir = join(root, "data");
const apiPort = Number(process.env.PATCHPILOT_E2E_CODEX_PORT || 4300 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;
const authHeaders = {
  "x-patchpilot-user": "e2e-codex-maintainer",
  "x-patchpilot-role": "maintainer"
};

await assertCodexAvailable();
await createTinyProject(projectRoot);
await mkdir(dataDir, { recursive: true });

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_CONFIG_PATH: join(projectRoot, ".patchpilot", "config.yaml"),
    PATCHPILOT_RUNNER: "codex",
    PATCHPILOT_REPOSITORY_ROOT: projectRoot,
    PATCHPILOT_CODEX_TIMEOUT_MS: "240000",
    PATCHPILOT_TEST_TIMEOUT_MS: "240000",
    PATCHPILOT_MAX_REPAIR_ATTEMPTS: "1"
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

let failed = false;
try {
  await waitForHealth();

  const config = await requestJson("/api/config");
  assertEqual(config.activeRunner, "codex", "runtime config should select the real Codex runner");
  assertEqual(config.repositoryRoot, projectRoot, "runtime config should expose the target repository root");
  assert(config.gitWorkspaceAvailable, "target repository should support git worktrees");

  const requirement = await requestJson("/api/requirements", {
    method: "POST",
    body: JSON.stringify({
      rawInput:
        "In this tiny Node project, change src/status.txt from TODO to READY so `node test.mjs` passes. Do not implement anything else.",
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const approval = await requestJson(`/api/prds/${prd.id}/approve`, {
    method: "POST",
    headers: authHeaders
  });
  const workItem = approval.workItems.find((item) => item.role === "backend");
  assert(workItem, "approved PRD should create a backend work item");

  const run = await requestJson(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runner: "codex" })
  });
  assertEqual(run.runner, "codex", "started work item should use Codex");

  const completedRun = await pollRun(run.id, 300000);
  if (completedRun.status !== "succeeded") {
    throw new Error(`Codex run did not succeed:\n${summarizeRunFailure(completedRun)}`);
  }

  const snapshot = await requestJson("/api/snapshot");
  const latestRun = snapshot.agentRuns.find((item) => item.id === run.id);
  const testRuns = snapshot.testRuns.filter((testRun) => testRun.runId === run.id);
  const workspaceRun = snapshot.workspaceRuns.find((workspace) => workspace.runId === run.id);
  const pullRequest = snapshot.pullRequests.find((item) => item.runId === run.id);
  const review = snapshot.reviewRecords.find((item) => item.runId === run.id);
  const auditEvents = snapshot.auditEvents.filter((event) => event.runId === run.id);

  assert(latestRun?.result?.diffSummary?.hasChanges, "real Codex result should include a non-empty diff");
  assert(
    latestRun.result.changedFiles.includes("src/status.txt"),
    `real Codex result should change src/status.txt, got ${latestRun.result.changedFiles.join(", ")}`
  );
  assertEqual(workspaceRun?.isolation, "git_worktree", "workspace evidence should record git worktree isolation");
  assert(
    workspaceRun?.path?.startsWith(join(projectRoot, ".patchpilot", "worktrees")),
    `workspace should be created under the target project, got ${workspaceRun?.path}`
  );
  assert(testRuns.some((testRun) => testRun.status === "passed" && testRun.command === "node test.mjs"), "target test should pass");
  assertEqual(pullRequest?.status, "ready_for_review", "real run should create a local PR record");
  assertEqual(review?.status, "approved", "real run should create approved review evidence");
  assert(auditEvents.some((event) => event.action === "agent_run.succeeded"), "audit log should record run success");

  const branchStatus = await git(["show", `${latestRun.result.branchName}:src/status.txt`], projectRoot);
  assertEqual(branchStatus.stdout.trim(), "READY", "target repo delivery branch should contain the Codex change");
  assertEqual(
    (await readFile(join(projectRoot, "src", "status.txt"), "utf8")).trim(),
    "TODO",
    "target repo main worktree should remain unchanged until merge"
  );

  const acceptance = await requestJson(`/api/acceptance/${run.id}`, {
    method: "POST",
    body: JSON.stringify({ status: "accepted" })
  });
  assertEqual(acceptance.status, "accepted", "completed Codex run should be acceptable");

  console.log("PatchPilot real Codex simple project E2E passed");
} catch (error) {
  failed = true;
  console.error(`Fixture root kept for inspection: ${root}`);
  throw error;
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  if (!failed && process.env.PATCHPILOT_E2E_KEEP_TEMP !== "1") {
    await rm(root, { recursive: true, force: true });
  }
}

async function createTinyProject(directory) {
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, ".patchpilot"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "patchpilot-tiny-project",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      test: "node test.mjs"
    }
  }, null, 2)}\n`);
  await writeFile(join(directory, "src", "status.txt"), "TODO\n");
  await writeFile(join(directory, "test.mjs"), [
    "import { readFileSync } from 'node:fs';",
    "",
    "const status = readFileSync(new URL('./src/status.txt', import.meta.url), 'utf8').trim();",
    "if (status !== 'READY') {",
    "  throw new Error(`Expected src/status.txt to contain READY, got ${status}`);",
    "}",
    "console.log('tiny project test passed');",
    ""
  ].join("\n"));
  await writeFile(join(directory, ".patchpilot", "config.yaml"), [
    "test:",
    "  command: node test.mjs",
    "  timeoutMs: 240000",
    "  maxRepairAttempts: 1",
    "dev:",
    "  runner: codex",
    "  repositoryRoot: .",
    "  workspaceRoot: .patchpilot/worktrees",
    "  previewUrl: http://localhost:3000",
    "security:",
    "  egressPolicy:",
    "    enabled: false",
    "  secretBroker:",
    "    enabled: false",
    "budget:",
    "  codexTimeoutMs: 240000",
    ""
  ].join("\n"));
  await git(["init", "--initial-branch=main"], directory);
  await git(["config", "user.email", "patchpilot-e2e@example.local"], directory);
  await git(["config", "user.name", "PatchPilot E2E"], directory);
  await git(["add", "."], directory);
  await git(["commit", "-m", "initial tiny project"], directory);
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
  }, 30000);
}

async function pollRun(runId, timeoutMs) {
  return poll(async () => {
    const run = await requestJson(`/api/runs/${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    return undefined;
  }, timeoutMs);
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function assertCodexAvailable() {
  const result = await runProcess("codex", ["--version"], { cwd: repoRoot });
  assertEqual(result.code, 0, `codex --version should succeed, stderr: ${result.stderr}`);
}

async function git(args, cwd) {
  const result = await runProcess("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

function summarizeRunFailure(run) {
  return [
    `status=${run.status}`,
    `failureType=${run.failureType || "none"}`,
    `failureReason=${run.failureReason || "none"}`,
    "events:",
    ...(run.events ?? []).slice(-12).map((event) => `- ${event.type}: ${event.message}`)
  ].join("\n");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
