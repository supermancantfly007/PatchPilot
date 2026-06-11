import { createHmac } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0";
process.env.PATCHPILOT_GITHUB_WEBHOOK_SECRET = "e2e-github-webhook-secret";

const { buildServer } = await import("../services/api/src/server.ts");
const { PatchPilotStore } = await import("../services/api/src/store.ts");

const repositoryId = "repo_github_4242_patchpilot_fixtures_delivery";
const githubRepository = {
  id: repositoryId,
  githubRepositoryId: "987654321",
  installationId: 4242,
  owner: "patchpilot-fixtures",
  name: "delivery",
  fullName: "patchpilot-fixtures/delivery",
  private: false,
  htmlUrl: "https://github.com/patchpilot-fixtures/delivery",
  cloneUrl: "https://github.com/patchpilot-fixtures/delivery.git",
  defaultBranch: "main",
  permissions: { admin: false, maintain: false, push: true }
};
const upserts = [];
const store = new PatchPilotStore({
  dataFilePath: false,
  repository: false,
  githubAppRepositoryClient: {
    listRepositories: async () => [githubRepository]
  },
  pullRequestAdapter: {
    provider: "github",
    upsertPullRequest: async (input) => {
      upserts.push(input);
      return {
        ...input.draft,
        id: "github://patchpilot-fixtures/delivery/pull/42",
        provider: "github",
        status: "ready_for_review",
        url: "https://github.com/patchpilot-fixtures/delivery/pull/42",
        createdAt: input.existing?.createdAt ?? input.draft.createdAt
      };
    },
    readChecks: async () => ({ status: "passed", totalCount: 0, runs: [] }),
    writeReviewerComment: async () => undefined
  }
});
const app = await buildServer({ store });

try {
  const webhookPayload = {
    action: "added",
    installation: {
      id: 4242,
      account: { login: "patchpilot-fixtures", type: "Organization" },
      repository_selection: "selected",
      permissions: { contents: "write", pull_requests: "write" }
    },
    repositories: [
      {
        id: 987654321,
        full_name: "patchpilot-fixtures/delivery",
        private: false,
        html_url: "https://github.com/patchpilot-fixtures/delivery",
        clone_url: "https://github.com/patchpilot-fixtures/delivery.git",
        default_branch: "main",
        permissions: { admin: false, maintain: false, push: true }
      }
    ],
    sender: { login: "patchpilot-fixtures" }
  };
  const webhook = await injectJson(
    "POST",
    "/api/integrations/github/webhook",
    webhookPayload,
    {
      "x-github-event": "installation_repositories",
      "x-github-delivery": "e2e-delivery-1",
      "x-hub-signature-256": signGitHubWebhook(webhookPayload)
    }
  );
  assertEqual(webhook.accepted, true, "signed GitHub App webhook should be accepted");
  assertEqual(webhook.repositoryCount, 1, "webhook should import one repository");

  const anonymousList = await injectRaw("GET", "/api/integrations/github/repositories");
  assertEqual(anonymousList.statusCode, 401, "anonymous GitHub repository listing should be rejected");

  const list = await injectJson(
    "GET",
    "/api/integrations/github/repositories",
    undefined,
    authHeaders("maintainer", "github-app-maintainer")
  );
  assertEqual(list.repositories.length, 1, "GitHub App repository list should include install repositories");
  assertEqual(list.repositories[0].id, repositoryId, "GitHub App list should expose repository ids for selection");

  const selection = await injectJson(
    "POST",
    "/api/integrations/github/repositories/select",
    { repositoryId },
    authHeaders("maintainer", "github-app-maintainer")
  );
  assertEqual(selection.repository.selected, true, "selected repository should be marked selected");
  assertEqual(selection.permissionReady, true, "selected repository should be PR-ready");

  const requirement = await injectJson("POST", "/api/requirements", {
    rawInput: "GitHub App E2E should create a PR after selecting an installed repository.",
    template: "feature"
  });
  const { prd } = await injectJson("POST", `/api/requirements/${requirement.id}/prd`);
  const approval = await injectJson(
    "POST",
    `/api/prds/${prd.id}/approve`,
    undefined,
    authHeaders("maintainer", "github-app-maintainer")
  );
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const run = await injectJson("POST", `/api/work-items/${workItem.id}/start`, { runner: "simulated" });
  const completedRun = await pollRun(run.id);
  assertEqual(completedRun.status, "succeeded", "selected repository flow should complete a run");

  const snapshot = await injectJson("GET", "/api/snapshot");
  const selectedRepository = snapshot.repositories.find((repository) => repository.id === repositoryId);
  const installation = snapshot.githubInstallations.find((candidate) => candidate.installationId === 4242);
  const pullRequest = snapshot.pullRequests.find((candidate) => candidate.runId === run.id);
  assertEqual(selectedRepository?.selected, true, "snapshot should retain selected GitHub repository");
  assertEqual(installation?.permissions.pull_requests, "write", "repository listing should preserve webhook app permissions");
  assertEqual(upserts.length, 1, "GitHub PR adapter should be called once");
  assertEqual(pullRequest?.provider, "github", "run should produce a GitHub PullRequestRecord");
  assert(snapshot.auditEvents.some((event) => event.action === "github_app.repository_selected"), "selection audit should be recorded");

  console.log("PatchPilot GitHub App E2E passed");
} finally {
  await app.close();
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

async function pollRun(runId) {
  return poll(async () => {
    const run = await injectJson("GET", `/api/runs/${runId}`);
    return ["succeeded", "failed", "cancelled"].includes(run.status) ? run : undefined;
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

function authHeaders(role, userId = `github-app-${role}`) {
  return {
    "x-patchpilot-user": userId,
    "x-patchpilot-role": role
  };
}

function signGitHubWebhook(payload) {
  return `sha256=${createHmac("sha256", process.env.PATCHPILOT_GITHUB_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex")}`;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
