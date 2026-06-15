process.env.NODE_ENV = "test";

const { buildServer } = await import("../services/api/src/server.ts");
const { PatchPilotStore } = await import("../services/api/src/store.ts");

const store = new PatchPilotStore({
  dataFilePath: false,
  repository: false
});
const app = await buildServer({ store });

try {
  const prd = await createPrd("RBAC E2E verifies PRD approval requires a maintainer.");

  const anonymousPrdApproval = await injectRaw("POST", `/api/prds/${prd.id}/approve`);
  assertEqual(anonymousPrdApproval.statusCode, 401, "anonymous PRD approval should be rejected");

  const submitterPrdApproval = await injectRaw("POST", `/api/prds/${prd.id}/approve`, undefined, authHeaders("submitter"));
  assertEqual(submitterPrdApproval.statusCode, 403, "submitter PRD approval should be rejected");

  const approvedPrd = await injectJson("POST", `/api/prds/${prd.id}/approve`, undefined, authHeaders("maintainer"));
  const workItem = approvedPrd.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const secretApproval = await injectJson("POST", "/api/approvals", {
    kind: "secret_grant",
    targetType: "secret",
    targetId: "github-ci-token",
    requestedBy: "request-payload-should-be-overridden",
    requestedReason: "Secret grant needs an admin decision.",
    riskLevel: "high",
    expiresAt: futureIso()
  }, authHeaders("maintainer", "rbac-requester"));
  assertEqual(secretApproval.requestedBy, "rbac-requester", "approval requester should come from auth context");

  const reviewerSecretApproval = await injectRaw("POST", `/api/approvals/${secretApproval.id}/approve`, {
    decidedBy: "reviewer-payload-should-not-pass",
    decisionReason: "Trying to approve a high-risk secret as reviewer."
  }, authHeaders("reviewer", "rbac-reviewer"));
  assertEqual(reviewerSecretApproval.statusCode, 403, "reviewer secret approval decision should be rejected");

  const adminSecretApproval = await injectJson("POST", `/api/approvals/${secretApproval.id}/approve`, {
    decidedBy: "admin-payload-should-be-overridden",
    decisionReason: "Admin approves the high-risk secret grant."
  }, authHeaders("admin", "rbac-admin"));
  assertEqual(adminSecretApproval.status, "approved", "admin should approve high-risk secret grants");
  assertEqual(adminSecretApproval.approvedBy, "rbac-admin", "approval decider should come from auth context");

  const secretWorkItem = await createApprovedWorkItem("RBAC E2E verifies secret capability starts need reviewer auth.");
  await setWorkItemCapabilities(secretWorkItem.id, ["secret:github-ci-token"]);

  const anonymousSecretStart = await injectRaw("POST", `/api/work-items/${secretWorkItem.id}/start`, { runner: "codex" });
  assertEqual(anonymousSecretStart.statusCode, 401, "anonymous secret-sensitive start should be rejected");

  const maintainerSecretStart = await injectRaw(
    "POST",
    `/api/work-items/${secretWorkItem.id}/start`,
    { runner: "codex" },
    authHeaders("maintainer")
  );
  assertEqual(maintainerSecretStart.statusCode, 403, "maintainer secret-sensitive start should be rejected");

  const reviewerSecretStart = await injectJson(
    "POST",
    `/api/work-items/${secretWorkItem.id}/start`,
    { runner: "codex" },
    authHeaders("reviewer")
  );
  assertEqual(reviewerSecretStart.status, "running", "reviewer should start secret-sensitive work");
  await pollRun(reviewerSecretStart.id);

  const productionWorkItem = await createApprovedWorkItem("RBAC E2E verifies production data starts need admin auth.");
  await setWorkItemCapabilities(productionWorkItem.id, ["production_data:customer-export"]);

  const reviewerProductionStart = await injectRaw(
    "POST",
    `/api/work-items/${productionWorkItem.id}/start`,
    { runner: "codex" },
    authHeaders("reviewer")
  );
  assertEqual(reviewerProductionStart.statusCode, 403, "reviewer production-data start should be rejected");

  const adminProductionStart = await injectJson(
    "POST",
    `/api/work-items/${productionWorkItem.id}/start`,
    { runner: "codex" },
    authHeaders("admin")
  );
  assertEqual(adminProductionStart.status, "running", "admin should start production-data work");
  const completedProductionRun = await pollRun(adminProductionStart.id);

  const reviewerExport = await injectRaw(
    "GET",
    `/api/prds/${completedProductionRun.prdId}/audit-export`,
    undefined,
    authHeaders("reviewer")
  );
  assertEqual(reviewerExport.statusCode, 403, "reviewer audit export should be rejected");

  const auditPackage = await injectJson(
    "GET",
    `/api/prds/${completedProductionRun.prdId}/audit-export`,
    undefined,
    authHeaders("admin", "rbac-export-admin")
  );
  assertEqual(auditPackage.manifest.createdBy.actorId, "rbac-export-admin", "audit export should use admin auth actor");
  assertEqual(
    auditPackage.manifest.createdBy.authEnforcement,
    "td_222_rbac_enforced",
    "audit export should record enforced TD-222 RBAC"
  );

  console.log("PatchPilot RBAC auth E2E passed");
} finally {
  await app.close();
}

async function createPrd(rawInput) {
  const requirement = await injectJson("POST", "/api/requirements", { rawInput, template: "feature" });
  const response = await injectJson("POST", `/api/requirements/${requirement.id}/prd`);
  return response.prd;
}

async function createApprovedWorkItem(rawInput) {
  const prd = await createPrd(rawInput);
  const approval = await injectJson("POST", `/api/prds/${prd.id}/approve`, undefined, authHeaders("maintainer"));
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");
  return workItem;
}

async function setWorkItemCapabilities(workItemId, requiredCapabilities) {
  const snapshot = await store.exportJsonSnapshot();
  const workItem = snapshot.workItems.find((item) => item.id === workItemId);
  assert(workItem, `expected work item ${workItemId}`);
  workItem.requiredCapabilities = requiredCapabilities;
  await store.importJsonSnapshot(snapshot);
}

async function pollRun(runId) {
  return poll(async () => {
    const run = await injectJson("GET", `/api/runs/${runId}`);
    return ["succeeded", "failed", "cancelled"].includes(run.status) ? run : undefined;
  }, 10000);
}

async function injectJson(method, url, payload, headers) {
  const response = await injectRaw(method, url, payload, headers);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

async function injectRaw(method, url, payload, headers = {}) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload })
  });
}

function authHeaders(role, userId = `rbac-${role}`) {
  return {
    "x-patchpilot-user": userId,
    "x-patchpilot-role": role
  };
}

function futureIso() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
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

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
