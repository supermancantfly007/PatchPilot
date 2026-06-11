process.env.NODE_ENV = "test";
process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0";

const { buildServer } = await import("../services/api/src/server.ts");
const { PatchPilotStore } = await import("../services/api/src/store.ts");

const repositories = [
  githubRepository("repo_github_4242_patchpilot_fixtures_delivery", "987654321", "delivery"),
  githubRepository("repo_github_4242_patchpilot_fixtures_docs", "987654322", "docs")
];
const repositoryIds = repositories.map((repository) => repository.id);
const upserts = [];

const store = new PatchPilotStore({
  dataFilePath: false,
  repository: false,
  githubAppRepositoryClient: {
    listRepositories: async () => repositories
  },
  pullRequestAdapter: {
    provider: "github",
    upsertPullRequest: async (input) => {
      upserts.push(input);
      const sequence = upserts.length;
      const repositoryPath = input.draft.repositoryFullName ?? "patchpilot-fixtures/unknown";
      return {
        ...input.draft,
        id: `github://${repositoryPath}/pull/${sequence}`,
        provider: "github",
        status: "ready_for_review",
        url: `https://github.com/${repositoryPath}/pull/${sequence}`,
        createdAt: input.existing?.createdAt ?? input.draft.createdAt
      };
    },
    readChecks: async () => ({ status: "passed", totalCount: 0, runs: [] }),
    writeReviewerComment: async () => undefined
  }
});
const app = await buildServer({ store });

try {
  const list = await injectJson(
    "GET",
    "/api/integrations/github/repositories",
    undefined,
    authHeaders("maintainer", "multi-repo-maintainer")
  );
  assertEqual(list.repositories.length, 2, "repository listing should expose both GitHub repos");

  const selection = await injectJson(
    "POST",
    "/api/integrations/github/repositories/select",
    { repositoryIds },
    authHeaders("maintainer", "multi-repo-maintainer")
  );
  assertEqual(selection.selectedRepositoryIds.length, 2, "selection should retain both repository ids");

  const requirement = await injectJson("POST", "/api/requirements", {
    rawInput: "Coordinate one PRD across delivery and docs repositories.",
    template: "feature"
  });
  const { prd } = await injectJson("POST", `/api/requirements/${requirement.id}/prd`);

  const startTeam = await injectJson(
    "POST",
    `/api/prds/${prd.id}/start-team`,
    { runner: "simulated" },
    authHeaders("maintainer", "multi-repo-maintainer")
  );
  assertEqual(startTeam.workItems.length, 8, "one PRD should create four work items per repository");
  assertEqual(startTeam.interfaceContracts.length, 6, "contracts should be scoped per selected repository");
  assertEqual(startTeam.runs.length, 2, "dependency gate should initially start only each repository backend item");
  assertEqual(startTeam.skippedWorkItems.length, 6, "dependent repo work items should wait for backend completion");

  await Promise.all(startTeam.runs.map((run) => pollRun(run.id)));

  const snapshot = await injectJson("GET", "/api/snapshot");
  const workItems = snapshot.workItems.filter((workItem) => workItem.prdId === prd.id);
  const interfaceContracts = snapshot.interfaceContracts.filter((contract) => contract.prdId === prd.id);
  const pullRequests = snapshot.pullRequests.filter((pullRequest) => pullRequest.prdId === prd.id);
  const workspaceRuns = snapshot.workspaceRuns.filter((workspace) => workspace.prdId === prd.id);
  const testCases = snapshot.testCases.filter((testCase) => testCase.prdId === prd.id);
  const testRuns = snapshot.testRuns.filter((testRun) => testRun.prdId === prd.id);
  const executionTestRuns = testRuns.filter((testRun) => testRun.runner === "simulated-test-runner");

  assertEqual(workItems.length, 8, "snapshot should retain eight repo-scoped work items");
  assertSetEqual(
    new Set(workItems.map((workItem) => workItem.repositoryId)),
    new Set(repositoryIds),
    "work items should target both selected repositories"
  );
  assert(workItems.filter((workItem) => workItem.role !== "backend").every((workItem) => workItem.dependsOn?.length === 1),
    "dependent work items should declare a repository-local backend dependency");
  assertEqual(pullRequests.length, 2, "two backend runs should create two repository-scoped PRs");
  assertSetEqual(
    new Set(pullRequests.map((pullRequest) => pullRequest.repositoryId)),
    new Set(repositoryIds),
    "pull requests should target both selected repositories"
  );
  assert(pullRequests.every((pullRequest) => pullRequest.bodyMarkdown.includes("## Repository")),
    "PR bodies should include repository scope");
  assertSetEqual(
    new Set(interfaceContracts.map((contract) => contract.repositoryId)),
    new Set(repositoryIds),
    "interface contracts should target both selected repositories"
  );
  assert(workspaceRuns.every((workspace) => repositoryIds.includes(workspace.repositoryId)),
    "workspace evidence should retain repository scope");
  assert(testCases.every((testCase) => repositoryIds.includes(testCase.repositoryId)),
    "test cases should retain repository scope");
  assert(testRuns.every((testRun) => repositoryIds.includes(testRun.repositoryId)),
    "test evidence should retain repository scope");
  assertEqual(executionTestRuns.length, 2, "two backend runs should create two execution test runs");
  assertEqual(upserts.length, 2, "GitHub PR adapter should be called once per repository backend run");

  console.log("PatchPilot multi-repo E2E passed");
} finally {
  await app.close();
}

async function injectJson(method, url, payload, headers) {
  const response = await app.inject({
    method,
    url,
    headers: headers ?? {},
    ...(payload === undefined ? {} : { payload })
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
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

function githubRepository(id, githubRepositoryId, name) {
  const owner = "patchpilot-fixtures";
  const fullName = `${owner}/${name}`;
  return {
    id,
    githubRepositoryId,
    installationId: 4242,
    owner,
    name,
    fullName,
    private: false,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    permissions: { admin: false, maintain: false, push: true }
  };
}

function authHeaders(role, userId = `multi-repo-${role}`) {
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

function assertSetEqual(actual, expected, message) {
  const actualValues = [...actual].sort();
  const expectedValues = [...expected].sort();
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(`${message}. Expected ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actualValues)}`);
  }
}
