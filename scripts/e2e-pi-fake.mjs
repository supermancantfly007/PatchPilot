import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  assert,
  assertEqual,
  authHeaders,
  cleanupTemp,
  createTinyProject,
  git,
  pollRun,
  requestJson,
  seedWorkItemSnapshot,
  startApiServer,
  summarizeRunFailure,
  tempPrefix,
  waitForExit,
  waitForHealth,
  writeFakePiExecutable
} from "./pi-e2e-lib.mjs";

const root = await mkdtemp(tempPrefix("patchpilot-pi-fake-e2e-"));
const projectRoot = join(root, "tiny-project");
const dataDir = join(root, "data");
const piStateRoot = join(root, "pi-state");
const fakePiPath = join(root, "fake-pi.cjs");
const apiPort = Number(process.env.PATCHPILOT_E2E_PI_FAKE_PORT || 4400 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

await createTinyProject(projectRoot, { provider: "fake" });
await writeFakePiExecutable(fakePiPath);
const { workItemId } = await seedWorkItemSnapshot(dataDir, {
  requirementId: "req_pi_fake_e2e",
  prdId: "prd_pi_fake_e2e",
  workItemId: "wi_pi_fake_e2e",
  title: "Fake Pi API E2E"
});

const { api, output } = startApiServer({
  port: apiPort,
  dataDir,
  projectRoot,
  configPath: join(projectRoot, ".patchpilot", "config.yaml"),
  piStateRoot,
  env: {
    PATCHPILOT_PI_COMMAND: fakePiPath,
    PATCHPILOT_PI_PROVIDER: "fake",
    PATCHPILOT_PI_FAKE: "1",
    PATCHPILOT_CONTAINER_SANDBOX_ENABLED: "false",
    PATCHPILOT_EGRESS_POLICY_ENABLED: "false",
    PATCHPILOT_SECRET_BROKER_ENABLED: "false"
  }
});

let failed = false;
try {
  await waitForHealth(apiBaseUrl, api, output);

  const config = await requestJson(apiBaseUrl, "/api/config");
  assertEqual(config.activeRunner, "pi", "runtime config should select the Pi runner");
  assertEqual(config.repositoryRoot, projectRoot, "runtime config should expose the target repository root");
  assert(config.gitWorkspaceAvailable, "target repository should support git worktrees");
  assert(
    config.runnerAvailability.some((item) => item.runner === "pi" && item.mode === "fake" && item.runnerAvailable),
    "runtime config should report fake Pi availability"
  );

  const run = await requestJson(apiBaseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runner: "pi" })
  });
  assertEqual(run.runner, "pi", "started work item should use Pi");

  const completedRun = await pollRun(apiBaseUrl, run.id, 240000);
  if (completedRun.status !== "succeeded") {
    throw new Error(`Fake Pi run did not succeed:\n${summarizeRunFailure(completedRun)}\nAPI output:\n${output()}`);
  }

  const snapshot = await requestJson(apiBaseUrl, "/api/snapshot");
  const latestRun = snapshot.agentRuns.find((item) => item.id === run.id);
  const testRuns = snapshot.testRuns.filter((testRun) => testRun.runId === run.id);
  const workspaceRun = snapshot.workspaceRuns.find((workspace) => workspace.runId === run.id);
  const pullRequest = snapshot.pullRequests.find((item) => item.runId === run.id);
  const review = snapshot.reviewRecords.find((item) => item.runId === run.id);
  const auditEvents = snapshot.auditEvents.filter((event) => event.runId === run.id);
  const artifacts = snapshot.artifacts.filter((artifact) => artifact.runId === run.id);

  assertEqual(latestRun?.result?.runner, "pi", "run result should identify the Pi runner");
  assert(latestRun.result.diffSummary?.hasChanges, "fake Pi result should include a non-empty diff");
  assert(
    latestRun.result.changedFiles.includes("src/status.txt"),
    `fake Pi result should change src/status.txt, got ${latestRun.result.changedFiles.join(", ")}`
  );
  assertEqual(latestRun.result.securityPreflightEvidence?.mode, "fake", "preflight evidence should identify fake mode");
  assertEqual(latestRun.result.securityPreflightEvidence?.secretBroker, "not_required", "fake Pi should not require credentials");
  assert(
    latestRun.result.agentMessages?.some((message) => message.includes("Fake Pi E2E summary")),
    "agent output should include fake Pi final summary"
  );
  assert(
    latestRun.result.toolCalls?.some((tool) => tool.name === "bash" && tool.command?.includes("src/status.txt")),
    "tool evidence should include the parsed fake Pi bash call"
  );

  const eventTypes = latestRun.events.map((event) => event.type);
  for (const expected of ["agent.started", "agent.output", "agent.tool.started", "agent.tool.completed", "test.passed", "git.diff.created"]) {
    assert(eventTypes.includes(expected), `run event stream should include ${expected}`);
  }

  assertEqual(workspaceRun?.isolation, "git_worktree", "workspace evidence should record git worktree isolation");
  assertEqual(workspaceRun?.status, "archived", "workspace evidence should be archived after completion");
  assert(
    workspaceRun?.path?.startsWith(join(projectRoot, ".patchpilot", "worktrees")),
    `workspace should be created under the target project, got ${workspaceRun?.path}`
  );
  assert(testRuns.some((testRun) => testRun.status === "passed" && testRun.command === "node test.mjs"), "target test should pass");
  assertEqual(pullRequest?.status, "ready_for_review", "fake Pi run should create a local PR record");
  assertEqual(review?.status, "approved", "fake Pi run should create approved review evidence");
  assert(artifacts.some((artifact) => artifact.kind === "trace"), "run artifacts should include a trace artifact");
  assert(artifacts.some((artifact) => artifact.kind === "diff"), "run artifacts should include a diff artifact");
  assert(auditEvents.some((event) => event.action === "capability_manifest.activated"), "audit log should record manifest activation");
  assert(auditEvents.some((event) => event.action === "agent_run.succeeded"), "audit log should record run success");

  const branchStatus = await git(["show", `${latestRun.result.branchName}:src/status.txt`], projectRoot);
  assertEqual(branchStatus.stdout.trim(), "READY", "target repo delivery branch should contain the Pi change");
  assertEqual(
    (await readFile(join(projectRoot, "src", "status.txt"), "utf8")).trim(),
    "TODO",
    "target repo main worktree should remain unchanged until merge"
  );

  const observation = JSON.parse(
    await readFile(join(piStateRoot, "runner", "pi", run.id, "sessions", "observation.json"), "utf8")
  );
  assertEqual(
    await realpath(observation.cwd),
    await realpath(latestRun.result.workspacePath),
    "fake Pi should run inside the prepared worktree"
  );
  assertEqual(observation.env.HOME, join(piStateRoot, "runner", "pi", run.id, "home"), "Pi HOME should be run-scoped");
  assert(!observation.env.OPENAI_API_KEY, "fake Pi launch evidence should not contain provider credentials");
  assert(!observation.env.SSH_AUTH_SOCK, "fake Pi launch evidence should not inherit SSH agent");
  assert(!observation.env.DOCKER_HOST, "fake Pi launch evidence should not inherit Docker socket");

  console.log("PatchPilot fake Pi API E2E passed");
} catch (error) {
  failed = true;
  console.error(`Fixture root kept for inspection: ${root}`);
  throw error;
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await cleanupTemp(root, failed);
}
