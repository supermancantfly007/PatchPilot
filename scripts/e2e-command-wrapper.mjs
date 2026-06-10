import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";

const { executeCommand } = await import("../packages/command-executor/src/index.ts");
const { buildServer } = await import("../services/api/src/server.ts");
const { PatchPilotStore } = await import("../services/api/src/store.ts");

const workspace = await mkdtemp(join(tmpdir(), "patchpilot-command-wrapper-e2e-"));
const markerPath = join(workspace, "bypass-marker.txt");
let delegatedExecutorCalled = false;

const fakeCodexRunner = {
  isAvailable: async () => true,
  isGitWorkspaceAvailable: async () => true,
  run: async (_context, _emit, config) => {
    await executeCommand({
      kind: "test",
      command: "npm test",
      cwd: workspace,
      timeoutMs: 5000,
      capabilityManifest: config.policyManifest,
      executor: async () => {
        delegatedExecutorCalled = true;
        await writeBypassMarker();
        return {
          exitCode: 0,
          output: "bypassed",
          stdout: "bypassed",
          stderr: "",
          timedOut: false,
          durationMs: 1
        };
      }
    });
    throw new Error("Expected command wrapper policy denial before fake runner completion.");
  }
};

const app = await buildServer({
  store: new PatchPilotStore({
    codexRunner: fakeCodexRunner,
    dataFilePath: false,
    repository: false
  })
});

try {
  const workItem = await createApprovedWorkItem("Command wrapper E2E proves denied commands cannot bypass policy.");
  const start = await request("POST", `/api/work-items/${workItem.id}/start`, { runner: "codex" });
  assert(start.id, "start should return an agent run id");

  const failedRun = await pollRun(start.id);
  assertEqual(failedRun.status, "failed", "run should fail");
  assertEqual(failedRun.failureType, "policy_denied", "run should fail as policy_denied");
  assertEqual(delegatedExecutorCalled, false, "denied command executor must not run");
  await assertFileMissing(markerPath, "denied command must not write bypass marker");

  const snapshot = await injectJson("GET", "/api/snapshot");
  const deniedAudit = snapshot.auditEvents.find((event) =>
    event.action === "command.policy_denied" && event.runId === failedRun.id
  );
  assert(deniedAudit, "snapshot should include command.policy_denied audit event");
  assertEqual(deniedAudit.afterJson.command.command, "npm test", "audit should include denied command");
  assertEqual(
    deniedAudit.afterJson.command.policyDecision.reason,
    "command_not_allowlisted",
    "audit should include policy denial reason"
  );
  assertEqual(deniedAudit.metadataJson.outputBytes, 0, "denied command should have no captured output");

  console.log("PatchPilot command wrapper E2E passed");
} finally {
  await app.close();
  await rm(workspace, { recursive: true, force: true });
}

async function createApprovedWorkItem(rawInput) {
  const requirement = await request("POST", "/api/requirements", { rawInput, template: "feature" });
  const prdResponse = await request("POST", `/api/requirements/${requirement.id}/prd`);
  const approval = await request("POST", `/api/prds/${prdResponse.prd.id}/approve`);
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");
  return workItem;
}

async function request(method, url, body) {
  const response = await app.inject({
    method,
    url,
    ...(body ? { payload: body } : {})
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

async function injectJson(method, url) {
  return request(method, url);
}

async function pollRun(runId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const run = await injectJson("GET", `/api/runs/${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function writeBypassMarker() {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(markerPath, "bypassed", "utf8");
}

async function assertFileMissing(path, message) {
  try {
    await readFile(path, "utf8");
  } catch {
    return;
  }
  throw new Error(message);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
