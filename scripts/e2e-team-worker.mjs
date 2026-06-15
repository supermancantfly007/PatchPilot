import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const externalApiBaseUrl = process.env.PATCHPILOT_E2E_API_BASE_URL;
const apiPort = Number(process.env.PATCHPILOT_E2E_TEAM_PORT || 4200 + (process.pid % 1000));
const apiBaseUrl = externalApiBaseUrl || `http://localhost:${apiPort}`;
const expectedRoles = ["backend", "frontend", "test", "ops"];
const expectedGeneratedContractTests = 16;
const expectedContractRegistryTests = 3;
const expectedProviderConsumerContractTests = 13;
const e2eAuthHeaders = {
  "x-patchpilot-user": "e2e-maintainer",
  "x-patchpilot-role": "maintainer"
};

await withApiServer(async () => {
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
  const testCases = snapshot.testCases.filter((testCase) => testCase.prdId === prd.id);
  const testRuns = snapshot.testRuns.filter((test) => test.prdId === prd.id);
  const contractDiffTestRuns = testRuns.filter((test) => test.runner === "patchpilot-contract-registry");
  const contractValidationTestRuns = testRuns.filter((test) => test.runner === "patchpilot-contract-tests");
  const executionOnlyTestRuns = testRuns.filter((test) =>
    test.runner !== "patchpilot-contract-registry" && test.runner !== "patchpilot-contract-tests"
  );
  const generatedContractTestCases = testCases.filter((testCase) => testCase.id.startsWith("tc_contract_"));
  const executionTestCases = testCases.filter((testCase) => !testCase.id.startsWith("tc_contract_"));
  const artifacts = snapshot.artifacts.filter((artifact) => artifact.prdId === prd.id);
  const pullRequests = snapshot.pullRequests.filter((pullRequest) => pullRequest.prdId === prd.id);
  const reviewRecords = snapshot.reviewRecords.filter((review) => review.prdId === prd.id);
  const auditEvents = snapshot.auditEvents.filter((event) => event.prdId === prd.id);
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  if (runs.length < expectedRoles.length) return undefined;
  if (!runs.every((run) => run.status === "succeeded")) return undefined;
  if (!runs.every((run) =>
    run.artifactIds?.length >= 3 && run.artifactIds.every((artifactId) => artifactIds.has(artifactId))
  )) return undefined;
  if (!workItems.every((item) => item.status === "review")) return undefined;
  if (workspaceRuns.length < expectedRoles.length) return undefined;
  if (!workspaceRuns.every((workspace) => workspace.status === "archived")) return undefined;
  if (testCases.length < expectedRoles.length + expectedGeneratedContractTests) return undefined;
  if (!testCases.every((testCase) => testCase.status === "passed")) return undefined;
  if (!executionTestCases.every((testCase) => testCase.lastRunId && testCase.lastTestRunId)) return undefined;
  if (!generatedContractTestCases.every((testCase) => !testCase.lastRunId && testCase.lastTestRunId)) return undefined;
  if (!testCases.every((testCase) => testCase.flaky === false)) return undefined;
  if (contractDiffTestRuns.length < expectedContractRegistryTests) return undefined;
  if (contractValidationTestRuns.length < expectedProviderConsumerContractTests) return undefined;
  if (executionOnlyTestRuns.length < expectedRoles.length) return undefined;
  if (!testRuns.every((test) => test.status === "passed")) return undefined;
  if (!testRuns.every((test) => test.testCaseId)) return undefined;
  if (!executionOnlyTestRuns.every((test) =>
    test.artifactIds?.length >= 2 && test.artifactIds.every((artifactId) => artifactIds.has(artifactId))
  )) return undefined;
  if (artifacts.filter((artifact) => artifact.kind === "log").length < expectedRoles.length) return undefined;
  if (artifacts.filter((artifact) => artifact.kind === "test_report").length < expectedRoles.length) return undefined;
  if (artifacts.filter((artifact) => artifact.kind === "trace").length < expectedRoles.length) return undefined;
  if (artifacts.filter((artifact) => artifact.kind === "diff").length < expectedRoles.length) return undefined;
  if (artifacts.filter((artifact) => artifact.kind === "preview_metadata").length < expectedRoles.length) return undefined;
  if (pullRequests.length < expectedRoles.length) return undefined;
  if (!pullRequests.every((pullRequest) => pullRequest.status === "ready_for_review")) return undefined;
  if (reviewRecords.length < expectedRoles.length) return undefined;
  if (!reviewRecords.every((review) => review.status === "approved")) return undefined;
  if (!auditEvents.some((event) => event.action === "agent_run.succeeded")) return undefined;
  if (!auditEvents.some((event) => event.action === "pull_request.ready_for_review")) return undefined;
  if (!auditEvents.some((event) => event.action === "review.approved")) return undefined;
  return {
    runs,
    workItems,
    workspaceRuns,
    testCases,
    generatedContractTestCases,
    executionTestCases,
    testRuns,
    contractDiffTestRuns,
    contractValidationTestRuns,
    executionOnlyTestRuns,
    artifacts,
    pullRequests,
    reviewRecords,
    auditEvents
  };
}, 15000);

assertEqual(completed.runs.length, expectedRoles.length, "worker should start one run per team work item");
assertEqual(
  JSON.stringify(completed.workItems.map((item) => item.role).sort()),
  JSON.stringify([...expectedRoles].sort()),
  "completed work item roles should match team roles"
);
assertEqual(completed.workspaceRuns.length, expectedRoles.length, "worker should archive workspace evidence per run");
assertEqual(
  completed.testCases.length,
  expectedRoles.length + expectedGeneratedContractTests,
  "worker should keep execution and generated contract TestCases"
);
assertEqual(completed.executionTestCases.length, expectedRoles.length, "worker should create one execution TestCase per work item");
assertEqual(completed.generatedContractTestCases.length, expectedGeneratedContractTests, "contract registry should generate TestCases per requirement");
assertEqual(completed.executionOnlyTestRuns.length, expectedRoles.length, "worker should record test evidence per run");
assertEqual(completed.contractDiffTestRuns.length, expectedContractRegistryTests, "contract registry should record one diff TestRun per artifact");
assertEqual(
  completed.contractValidationTestRuns.length,
  expectedProviderConsumerContractTests,
  "provider and consumer contract checks should pass per generated requirement"
);
assertEqual(completed.artifacts.length, expectedRoles.length * 5 + 3, "worker plus registry should record run and contract artifacts");
assertEqual(completed.pullRequests.length, expectedRoles.length, "worker should create one PR record per run");
assertEqual(completed.reviewRecords.length, expectedRoles.length, "worker should create one review record per run");
assertEqual(
  completed.auditEvents.every((event) =>
    event.actorType && event.actorId && event.hash && Object.hasOwn(event, "previousHash") &&
    Object.hasOwn(event, "beforeJson") && Object.hasOwn(event, "afterJson") && Object.hasOwn(event, "metadataJson")
  ),
  true,
  "audit events should expose formal actor, before/after, metadata, and hash fields"
);
await assertAuditChainValid();

const firstRunIds = new Set(completed.runs.map((run) => run.id));
const rejection = await requestJson(`/api/prds/${prd.id}/acceptance`, {
  method: "POST",
  body: JSON.stringify({
    status: "rejected",
    reason: "验收要求修改后，agent team 应自动重新领取返工任务。"
  })
});
assertEqual(rejection.decisions.length, expectedRoles.length, "team rejection should create one decision per run");

const queuedRework = await poll(async () => {
  const snapshot = await requestJson("/api/snapshot");
  const workItems = snapshot.workItems.filter((item) => item.prdId === prd.id);
  const auditEvents = snapshot.auditEvents.filter((event) => event.prdId === prd.id);
  if (!workItems.every((item) => item.status === "ready")) return undefined;
  if (!workItems.every((item) => item.reworkCount === 1)) return undefined;
  if (!workItems.every((item) => !item.assignedAgentId)) return undefined;
  if (!auditEvents.some((event) => event.action === "work_item.rework_requested")) return undefined;
  return { workItems, auditEvents };
}, 15000);

assertEqual(queuedRework.workItems.length, expectedRoles.length, "rejected work items should return to the ready queue");

await runWorkerOnce();

const reworked = await poll(async () => {
  const snapshot = await requestJson("/api/snapshot");
  const workItems = snapshot.workItems.filter((item) => item.prdId === prd.id);
  const runs = snapshot.agentRuns.filter((run) => run.prdId === prd.id);
  const latestRuns = latestRunsByWorkItem(runs);
  const testRuns = snapshot.testRuns.filter((test) => test.prdId === prd.id);
  const contractTestRuns = testRuns.filter((test) =>
    test.runner === "patchpilot-contract-registry" || test.runner === "patchpilot-contract-tests"
  );
  const executionOnlyTestRuns = testRuns.filter((test) =>
    test.runner !== "patchpilot-contract-registry" && test.runner !== "patchpilot-contract-tests"
  );
  const pullRequests = snapshot.pullRequests.filter((pullRequest) => pullRequest.prdId === prd.id);
  const reviewRecords = snapshot.reviewRecords.filter((review) => review.prdId === prd.id);
  if (runs.length < expectedRoles.length * 2) return undefined;
  if (latestRuns.length !== expectedRoles.length) return undefined;
  if (!latestRuns.every((run) => run.status === "succeeded")) return undefined;
  if (latestRuns.some((run) => firstRunIds.has(run.id))) return undefined;
  if (!workItems.every((item) => item.status === "review")) return undefined;
  if (!workItems.every((item) => item.reworkCount === 1)) return undefined;
  if (contractTestRuns.length < expectedGeneratedContractTests) return undefined;
  if (executionOnlyTestRuns.length < expectedRoles.length * 2) return undefined;
  if (!testRuns.every((test) => test.status === "passed")) return undefined;
  if (pullRequests.length < expectedRoles.length * 2) return undefined;
  if (reviewRecords.length < expectedRoles.length * 2) return undefined;
  return { runs, latestRuns, workItems, testRuns, contractTestRuns, executionOnlyTestRuns, pullRequests, reviewRecords };
}, 15000);

assertEqual(reworked.runs.length, expectedRoles.length * 2, "rework should create a fresh run per team work item");
assertEqual(reworked.latestRuns.length, expectedRoles.length, "latest team run set should still have one run per work item");
assertEqual(reworked.contractTestRuns.length, expectedGeneratedContractTests, "contract TestRuns should remain attached through rework");
assertEqual(reworked.executionOnlyTestRuns.length, expectedRoles.length * 2, "rework should add execution TestRuns without duplicating contract checks");
await assertAuditChainValid();

console.log("PatchPilot team worker E2E passed");
});

async function withApiServer(run) {
  if (externalApiBaseUrl) {
    await run();
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-team-e2e-"));
  const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(apiPort),
      PATCHPILOT_DATA_DIR: dataDir,
      PATCHPILOT_RUNNER: "codex",
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
    await waitForHealth(api, () => apiOutput);
    await run();
  } finally {
    api.kill("SIGTERM");
    await waitForExit(api);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForHealth(api, readApiOutput) {
  await poll(async () => {
    if (api.exitCode !== null) {
      throw new Error(`API exited before health check\n${readApiOutput()}`);
    }
    try {
      const health = await requestJson("/health");
      return health.ok ? health : undefined;
    } catch (_error) {
      return undefined;
    }
  }, 20000);
}

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
  for (const [key, value] of Object.entries(e2eAuthHeaders)) headers.set(key, value);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function assertAuditChainValid() {
  const verification = await requestJson("/api/audit/verify");
  assertEqual(verification.valid, true, `audit chain should verify (${verification.errors?.join("; ") || "no errors"})`);
  if (!verification.checkedEvents || !verification.headHash) {
    throw new Error("audit verifier should report checked events and head hash");
  }
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

function latestRunsByWorkItem(runs) {
  const byWorkItem = new Map();
  for (const run of runs) {
    const current = byWorkItem.get(run.workItemId);
    if (!current || run.startedAt > current.startedAt) byWorkItem.set(run.workItemId, run);
  }
  return [...byWorkItem.values()];
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}
