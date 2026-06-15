import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const authHeaders = {
  "x-patchpilot-user": "e2e-pi-maintainer",
  "x-patchpilot-role": "maintainer"
};

export async function createTinyProject(directory, options = {}) {
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, ".patchpilot"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: options.name ?? "patchpilot-pi-tiny-project",
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
    "  maxRepairAttempts: 0",
    "dev:",
    "  runner: pi",
    "  repositoryRoot: .",
    "  workspaceRoot: .patchpilot/worktrees",
    "  previewUrl: http://localhost:3000",
    "budget:",
    "  codexTimeoutMs: 240000",
    "  maxCostUsd: 10",
    "  workItemUsd: 10",
    "  runUsd: 10",
    "pi:",
    `  provider: ${options.provider ?? "fake"}`,
    "  timeoutMs: 240000",
    ""
  ].join("\n"));
  await git(["init", "--initial-branch=main"], directory);
  await git(["config", "user.email", "patchpilot-e2e@example.local"], directory);
  await git(["config", "user.name", "PatchPilot E2E"], directory);
  await git(["add", "."], directory);
  await git(["commit", "-m", "initial tiny project"], directory);
}

export async function seedWorkItemSnapshot(dataDir, input = {}) {
  await mkdir(dataDir, { recursive: true });
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const requirementId = input.requirementId ?? "req_pi_e2e";
  const prdId = input.prdId ?? "prd_pi_e2e";
  const workItemId = input.workItemId ?? "wi_pi_e2e";
  const title = input.title ?? "Pi runner E2E work item";
  const snapshot = {
    repositories: [],
    githubInstallations: [],
    requirements: [
      {
        id: requirementId,
        title,
        rawInput: "Change src/status.txt from TODO to READY and keep the project test passing.",
        template: "feature",
        status: "approved",
        simpleSummary: title,
        clarificationQuestions: [],
        clarificationTurns: [],
        createdAt: now,
        updatedAt: now
      }
    ],
    prds: [
      {
        id: prdId,
        requirementId,
        version: 1,
        status: "approved",
        title,
        bodyMarkdown: [
          "# Pi runner E2E",
          "",
          "Change `src/status.txt` from `TODO` to `READY`.",
          "The only acceptance test is `node test.mjs`."
        ].join("\n"),
        acceptanceCriteria: ["`node test.mjs` passes", "`src/status.txt` contains `READY`"],
        approvedAt: now
      }
    ],
    workItems: [
      {
        id: workItemId,
        prdId,
        title,
        status: "ready",
        role: "backend",
        scope: "Update src/status.txt from TODO to READY and do not change unrelated files.",
        nonGoals: ["Do not modify package metadata", "Do not call external services for the fake E2E"],
        acceptanceCriteria: ["`node test.mjs` passes", "`src/status.txt` contains `READY`"],
        testSuggestions: ["node test.mjs"],
        ...(input.requiredCapabilities?.length ? { requiredCapabilities: input.requiredCapabilities } : {}),
        version: 1,
        createdAt: now,
        updatedAt: now
      }
    ],
    interfaceContracts: [],
    agentRuns: [],
    workspaceRuns: [],
    testCases: [],
    testRuns: [],
    artifacts: [],
    pullRequests: [],
    reviewRecords: [],
    auditEvents: [],
    acceptances: [],
    approvals: [],
    releaseGates: [],
    bugs: [],
    agents: []
  };
  await writeFile(join(dataDir, "patchpilot-store.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  return { requirementId, prdId, workItemId };
}

export async function writeFakePiExecutable(path) {
  await writeFile(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("0.79.3");
  process.exit(0);
}

const prompt = argv.at(-1) || "";
mkdirSync(join(process.cwd(), "src"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
writeFileSync(join(process.cwd(), "src", "status.txt"), "READY\\n");
writeFileSync(join(process.env.PI_CODING_AGENT_SESSION_DIR, "observation.json"), JSON.stringify({
  argv,
  cwd: process.cwd(),
  prompt,
  env: {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
    PI_TELEMETRY: process.env.PI_TELEMETRY,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  }
}, null, 2));
console.log(JSON.stringify({ type: "session", sessionId: "pi-e2e-session", cwd: process.cwd(), version: "0.79.3" }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "message_update", role: "assistant", delta: "Fake Pi E2E is editing src/status.txt" }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-e2e", toolName: "bash", args: { command: "printf READY > src/status.txt" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-e2e", toolName: "bash", status: "success", result: { exitCode: 0 }, durationMs: 8 }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Fake Pi E2E summary" }] } }));
console.log(JSON.stringify({ type: "agent_end" }));
`, "utf8");
  await chmod(path, 0o755);
}

export function startApiServer(input) {
  const env = compactEnv({
    ...process.env,
    PORT: String(input.port),
    PATCHPILOT_DATA_DIR: input.dataDir,
    PATCHPILOT_CONFIG_PATH: input.configPath,
    PATCHPILOT_RUNNER: "pi",
    PATCHPILOT_REPOSITORY_ROOT: input.projectRoot,
    PATCHPILOT_WORKSPACE_ROOT: join(input.projectRoot, ".patchpilot", "worktrees"),
    PATCHPILOT_PI_STATE_ROOT: input.piStateRoot,
    PATCHPILOT_CODEX_TIMEOUT_MS: "240000",
    PATCHPILOT_TEST_TIMEOUT_MS: "240000",
    PATCHPILOT_MAX_REPAIR_ATTEMPTS: "0",
    PATCHPILOT_BUDGET_MAX_COST_USD: "10",
    PATCHPILOT_BUDGET_WORK_ITEM_USD: "10",
    PATCHPILOT_BUDGET_RUN_USD: "10",
    ...input.env
  });
  const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  api.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  api.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  return {
    api,
    output: () => output
  };
}

export async function waitForHealth(apiBaseUrl, apiProcess, getOutput) {
  await poll(async () => {
    if (apiProcess.exitCode !== null) {
      throw new Error(`API exited before health check\n${getOutput()}`);
    }
    try {
      const health = await requestJson(apiBaseUrl, "/health");
      return health.ok ? health : undefined;
    } catch (_error) {
      return undefined;
    }
  }, 30000);
}

export async function requestJson(apiBaseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function pollRun(apiBaseUrl, runId, timeoutMs) {
  return poll(async () => {
    const run = await requestJson(apiBaseUrl, `/api/runs/${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    return undefined;
  }, timeoutMs);
}

export async function poll(read, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

export async function git(args, cwd) {
  const result = await runProcess("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export async function runProcess(command, args, options = {}) {
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

export async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

export async function cleanupTemp(root, failed) {
  if (!failed && process.env.PATCHPILOT_E2E_KEEP_TEMP !== "1") {
    await rm(root, { recursive: true, force: true });
  }
}

export function summarizeRunFailure(run) {
  return [
    `status=${run.status}`,
    `failureType=${run.failureType || "none"}`,
    `failureSummary=${run.failureSummary || "none"}`,
    "events:",
    ...(run.events ?? []).slice(-12).map((event) => `- ${event.type}: ${event.message}`)
  ].join("\n");
}

export function splitList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function assert(value, message) {
  if (!value) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return 0;
  return parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch;
}

export function parseSemver(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function tempPrefix(name) {
  return join(tmpdir(), name);
}

function compactEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}
