process.env.NODE_ENV = "test";
process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0";

const { buildServer } = await import("../services/api/src/server.ts");
const { PatchPilotStore } = await import("../services/api/src/store.ts");

const maintainerAuth = authHeaders("maintainer", "e2e-release-maintainer");
const adminAuth = authHeaders("admin", "e2e-release-admin");
const app = await buildServer({
  store: new PatchPilotStore({ dataFilePath: false, repository: false })
});

try {
  const requirement = await injectJson("POST", "/api/requirements", {
    rawInput: "Validate manual approval gates for release and rollback.",
    template: "feature"
  });
  const { prd } = await injectJson("POST", `/api/requirements/${requirement.id}/prd`);

  const startTeam = await injectJson(
    "POST",
    `/api/prds/${prd.id}/start-team`,
    { runner: "simulated" },
    maintainerAuth
  );
  assertEqual(startTeam.runs.length, 4, "release E2E should start the full agent team");
  await pollPrdRuns(prd.id, 4);

  const blockedRelease = await inject("POST", `/api/prds/${prd.id}/release-approval`, {
    targetEnvironment: "production",
    requestedReason: "Attempt release before acceptance."
  }, maintainerAuth);
  assertEqual(blockedRelease.statusCode, 409, "release approval should be blocked before acceptance");
  assert(
    blockedRelease.json().message.includes("Release gate failed"),
    "blocked release response should explain quality gate failure"
  );

  const acceptance = await injectJson("POST", `/api/prds/${prd.id}/acceptance`, { status: "accepted" });
  assertEqual(acceptance.decisions.length, 4, "team acceptance should record every run decision");

  const release = await injectJson("POST", `/api/prds/${prd.id}/release-approval`, {
    targetEnvironment: "production",
    requestedReason: "Accepted validation evidence is complete."
  }, maintainerAuth);
  assertEqual(release.releaseGate.status, "approval_pending", "release gate should wait for approval");
  assertEqual(release.releaseGate.operation, "release", "release gate should record release operation");
  assertEqual(release.releaseGate.gatePassed, true, "release quality gate should pass after acceptance");
  assertEqual(release.approval.kind, "dangerous_operation", "release approval should be dangerous_operation");
  assertEqual(release.approval.targetType, "release_gate", "release approval should target release_gate");

  const maintainerDecision = await inject("POST", `/api/approvals/${release.approval.id}/approve`, {
    decidedBy: "e2e-release-maintainer",
    decisionReason: "Maintainer cannot approve dangerous operation."
  }, maintainerAuth);
  assertEqual(maintainerDecision.statusCode, 403, "dangerous operation release approval should be admin-only");

  await injectJson("POST", `/api/approvals/${release.approval.id}/approve`, {
    decidedBy: "e2e-release-admin",
    decisionReason: "Approved for manual release."
  }, adminAuth);

  let snapshot = await injectJson("GET", "/api/snapshot");
  const releaseGate = findGate(snapshot, release.releaseGate.id);
  assertEqual(releaseGate.status, "manual_action_required", "approved release gate should require manual action");
  assert(
    releaseGate.manualAction.includes("will not deploy automatically"),
    "release gate should state that PatchPilot does not deploy automatically"
  );
  assert(!("deploymentId" in releaseGate), "release gate should not create deployment execution evidence");
  assert(!("executedAt" in releaseGate), "release gate should not mark automatic execution");

  const pullRequest = snapshot.pullRequests.find((item) => item.prdId === prd.id);
  if (!pullRequest) throw new Error("Expected accepted PRD to retain pull request evidence");

  const rollback = await injectJson("POST", `/api/pull-requests/${encodeURIComponent(pullRequest.id)}/rollback-approval`, {
    targetEnvironment: "production",
    requestedReason: "Manual rollback authorization E2E.",
    rollbackPlan: "Create a revert PR, run validation, and attach operator evidence."
  }, maintainerAuth);
  assertEqual(rollback.releaseGate.status, "approval_pending", "rollback gate should wait for approval");
  assertEqual(rollback.releaseGate.operation, "rollback", "rollback gate should record rollback operation");
  assertEqual(rollback.releaseGate.riskLevel, "critical", "rollback approval should be critical risk");
  assertEqual(
    rollback.releaseGate.evidence.rollbackOfPullRequestId,
    pullRequest.id,
    "rollback evidence should identify the PR being reverted"
  );

  await injectJson("POST", `/api/approvals/${rollback.approval.id}/approve`, {
    decidedBy: "e2e-release-admin",
    decisionReason: "Approved for manual rollback."
  }, adminAuth);

  snapshot = await injectJson("GET", "/api/snapshot");
  const rollbackGate = findGate(snapshot, rollback.releaseGate.id);
  assertEqual(rollbackGate.status, "manual_action_required", "approved rollback gate should require manual action");
  assert(
    rollbackGate.manualAction.includes("will not revert or deploy automatically"),
    "rollback gate should state that PatchPilot does not revert automatically"
  );
  assert(!("revertRunId" in rollbackGate), "rollback gate should not start a revert run");
  assert(!("executedAt" in rollbackGate), "rollback gate should not mark automatic execution");

  const auditActions = snapshot.auditEvents.map((event) => event.action);
  for (const action of [
    "release.approval_requested",
    "release.approval_approved",
    "rollback.approval_requested",
    "rollback.approval_approved"
  ]) {
    assert(auditActions.includes(action), `audit log should include ${action}`);
  }

  console.log("PatchPilot release/rollback approval E2E passed");
} finally {
  await app.close();
}

async function inject(method, url, payload, headers) {
  return app.inject({
    method,
    url,
    headers: headers ?? {},
    ...(payload === undefined ? {} : { payload })
  });
}

async function injectJson(method, url, payload, headers) {
  const response = await inject(method, url, payload, headers);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

async function pollPrdRuns(prdId, expectedCount) {
  return poll(async () => {
    const snapshot = await injectJson("GET", "/api/snapshot");
    const runs = snapshot.agentRuns.filter((run) => run.prdId === prdId);
    return runs.length === expectedCount &&
      runs.every((run) => ["succeeded", "failed", "cancelled"].includes(run.status))
      ? runs
      : undefined;
  }, 10000);
}

async function poll(read, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function findGate(snapshot, id) {
  const releaseGate = snapshot.releaseGates.find((gate) => gate.id === id);
  if (!releaseGate) throw new Error(`Expected release gate to exist: ${id}`);
  return releaseGate;
}

function authHeaders(role, userId) {
  return {
    "x-patchpilot-user": userId,
    "x-patchpilot-role": role
  };
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
