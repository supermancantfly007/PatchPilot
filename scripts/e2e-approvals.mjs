const apiBaseUrl = process.env.PATCHPILOT_E2E_API_BASE_URL || "http://localhost:4000";
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();
const maintainerAuth = authHeaders("maintainer", "e2e-maintainer");
const adminAuth = authHeaders("admin", "e2e-security-admin");
const kinds = [
  "budget_exceeded",
  "dangerous_operation",
  "breaking_contract",
  "secret_grant",
  "network_allowlist_change"
];

const approvals = [];
for (const kind of kinds) {
  approvals.push(
    await requestJson("/api/approvals", {
      method: "POST",
      headers: maintainerAuth,
      body: JSON.stringify({
        kind,
        targetType: targetTypeFor(kind),
        targetId: `e2e-${kind}-${Date.now()}`,
        requestedBy: "e2e-policy",
        requestedReason: `${kind} approval E2E coverage`,
        riskLevel: kind === "dangerous_operation" ? "critical" : "high",
        expiresAt: future
      })
    })
  );
}

assertEqual(approvals.length, kinds.length, "approval E2E should create every policy kind");
assertEqual(approvals.every((approval) => approval.status === "pending"), true, "created approvals should be pending");

const approved = await requestJson(`/api/approvals/${approvals[0].id}/approve`, {
  method: "POST",
  headers: authHeaders("maintainer", "e2e-maintainer"),
  body: JSON.stringify({
    decidedBy: "e2e-maintainer",
    decisionReason: "E2E approves this policy gate"
  })
});
assertEqual(approved.status, "approved", "approval should move to approved");
assertEqual(approved.approvedBy, "e2e-maintainer", "approved record should preserve approver");

const denied = await requestJson(`/api/approvals/${approvals[1].id}/deny`, {
  method: "POST",
  headers: adminAuth,
  body: JSON.stringify({
    decidedBy: "e2e-security",
    decisionReason: "E2E denies this policy gate"
  })
});
assertEqual(denied.status, "denied", "approval should move to denied");
assertEqual(denied.deniedBy, "e2e-security-admin", "denied record should preserve denier");

const expired = await requestJson("/api/approvals", {
  method: "POST",
  headers: maintainerAuth,
  body: JSON.stringify({
    kind: "network_allowlist_change",
    targetType: "network",
    targetId: `e2e-expired-network-${Date.now()}`,
    requestedBy: "e2e-policy",
    requestedReason: "E2E expired approval coverage",
    riskLevel: "medium",
    expiresAt: past
  })
});
assertEqual(expired.status, "expired", "past-dated approval should expire");

const snapshot = await requestJson("/api/snapshot");
const byId = new Map(snapshot.approvals.map((approval) => [approval.id, approval]));
assertEqual(byId.get(approved.id)?.status, "approved", "snapshot should retain approved decision");
assertEqual(byId.get(denied.id)?.status, "denied", "snapshot should retain denied decision");
assertEqual(byId.get(expired.id)?.status, "expired", "snapshot should retain expired decision");
assertEqual(
  snapshot.auditEvents.some((event) => event.action === "approval.requested"),
  true,
  "audit should record approval requests"
);
assertEqual(
  snapshot.auditEvents.some((event) => event.action === "approval.approved"),
  true,
  "audit should record approvals"
);
assertEqual(
  snapshot.auditEvents.some((event) => event.action === "approval.denied"),
  true,
  "audit should record denials"
);
assertEqual(
  snapshot.auditEvents.some((event) => event.action === "approval.expired"),
  true,
  "audit should record expirations"
);

console.log("PatchPilot approval API E2E passed");

function targetTypeFor(kind) {
  if (kind === "secret_grant") return "secret";
  if (kind === "network_allowlist_change") return "network";
  if (kind === "breaking_contract") return "interface_contract";
  if (kind === "budget_exceeded") return "budget";
  return "policy";
}

function authHeaders(role, userId) {
  return {
    "x-patchpilot-user": userId,
    "x-patchpilot-role": role
  };
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
