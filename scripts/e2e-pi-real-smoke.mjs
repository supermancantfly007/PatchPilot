import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assert,
  assertEqual,
  authHeaders,
  cleanupTemp,
  compareSemver,
  createTinyProject,
  git,
  parseSemver,
  pollRun,
  requestJson,
  runProcess,
  seedWorkItemSnapshot,
  splitList,
  startApiServer,
  summarizeRunFailure,
  tempPrefix,
  waitForExit,
  waitForHealth
} from "./pi-e2e-lib.mjs";

const enabled = process.env.PATCHPILOT_PI_REAL_SMOKE === "1";
if (!enabled) {
  console.log("Skipping real Pi smoke. Set PATCHPILOT_PI_REAL_SMOKE=1 to run it.");
  process.exit(0);
}

const providerProfiles = {
  openai: {
    host: "api.openai.com",
    secretId: "openai-api-key",
    secretEnvVar: "OPENAI_API_KEY"
  },
  anthropic: {
    host: "api.anthropic.com",
    secretId: "anthropic-api-key",
    secretEnvVar: "ANTHROPIC_API_KEY"
  }
};

const provider = (process.env.PATCHPILOT_PI_PROVIDER || "").trim().toLowerCase();
const profile = providerProfiles[provider];
if (!profile) {
  throw new Error("PATCHPILOT_PI_PROVIDER must be one of: openai, anthropic.");
}

const piCommand = process.env.PATCHPILOT_PI_COMMAND?.trim() || "pi";
const root = await mkdtemp(tempPrefix("patchpilot-pi-real-smoke-"));
const projectRoot = join(root, "tiny-project");
const dataDir = join(root, "data");
const piStateRoot = join(root, "pi-state");
const apiPort = Number(process.env.PATCHPILOT_E2E_PI_REAL_PORT || 4500 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

await runPreflight({ provider, profile, piCommand });
await createTinyProject(projectRoot, { provider });
const gitStatus = await git(["status", "--short"], projectRoot);
assertEqual(gitStatus.stdout.trim(), "", "real smoke target repository should start clean");
const { workItemId } = await seedWorkItemSnapshot(dataDir, {
  requirementId: "req_pi_real_smoke",
  prdId: "prd_pi_real_smoke",
  workItemId: "wi_pi_real_smoke",
  title: "Real Pi smoke work item",
  requiredCapabilities: [`secret:${profile.secretId}`]
});

const { api, output } = startApiServer({
  port: apiPort,
  dataDir,
  projectRoot,
  configPath: join(projectRoot, ".patchpilot", "config.yaml"),
  piStateRoot,
  env: {
    PATCHPILOT_PI_COMMAND: piCommand,
    PATCHPILOT_PI_PROVIDER: provider,
    PATCHPILOT_SECRET_BROKER_ENABLED: "true",
    PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS: process.env.PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS,
    PATCHPILOT_EGRESS_ALLOWED_HOSTS: process.env.PATCHPILOT_EGRESS_ALLOWED_HOSTS,
    PATCHPILOT_EGRESS_POLICY_ENABLED: process.env.PATCHPILOT_EGRESS_POLICY_ENABLED,
    PATCHPILOT_CONTAINER_SANDBOX_ENABLED: process.env.PATCHPILOT_CONTAINER_SANDBOX_ENABLED,
    PATCHPILOT_CONTAINER_SANDBOX_RUNTIME: process.env.PATCHPILOT_CONTAINER_SANDBOX_RUNTIME
  }
});

let failed = false;
try {
  await waitForHealth(apiBaseUrl, api, output);

  const config = await requestJson(apiBaseUrl, "/api/config");
  assertEqual(config.activeRunner, "pi", "runtime config should select the Pi runner");
  assertEqual(config.pi.provider, provider, "runtime config should expose the requested Pi provider");
  assert(config.runnerAvailability.some((item) => item.runner === "pi" && item.runnerAvailable), "Pi runner should be available");

  const run = await requestJson(apiBaseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runner: "pi" })
  });
  assertEqual(run.runner, "pi", "started work item should use Pi");

  const completedRun = await pollRun(apiBaseUrl, run.id, Number(process.env.PATCHPILOT_PI_REAL_SMOKE_TIMEOUT_MS || 600000));
  if (completedRun.status !== "succeeded") {
    throw new Error(`Real Pi smoke did not succeed:\n${summarizeRunFailure(completedRun)}\nAPI output:\n${output()}`);
  }

  const snapshot = await requestJson(apiBaseUrl, "/api/snapshot");
  const latestRun = snapshot.agentRuns.find((item) => item.id === run.id);
  const testRuns = snapshot.testRuns.filter((testRun) => testRun.runId === run.id);
  const auditEvents = snapshot.auditEvents.filter((event) => event.runId === run.id);

  assertEqual(latestRun?.result?.runner, "pi", "run result should identify the Pi runner");
  assertEqual(latestRun.result.securityPreflightEvidence?.provider, provider, "preflight evidence should record provider");
  assertEqual(latestRun.result.securityPreflightEvidence?.providerHost, profile.host, "preflight evidence should record exact provider host");
  assertEqual(latestRun.result.securityPreflightEvidence?.providerSecretId, profile.secretId, "preflight evidence should record provider secret id");
  assert(
    latestRun.result.securityPreflightEvidence?.enforcementGaps?.includes("pi_internal_tool_pre_execution"),
    "preflight evidence should record the Pi internal tool pre-execution enforcement gap"
  );
  assert(latestRun.result.diffSummary?.hasChanges, "real Pi result should include a non-empty diff");
  assert(latestRun.result.changedFiles.includes("src/status.txt"), "real Pi result should change src/status.txt");
  assert(testRuns.some((testRun) => testRun.status === "passed" && testRun.command === "node test.mjs"), "target test should pass");
  assert(auditEvents.some((event) => event.action === "capability_manifest.activated"), "audit log should record manifest activation");
  assert(auditEvents.some((event) => event.action === "agent_run.succeeded"), "audit log should record run success");

  const branchStatus = await git(["show", `${latestRun.result.branchName}:src/status.txt`], projectRoot);
  assertEqual(branchStatus.stdout.trim(), "READY", "target repo delivery branch should contain the Pi change");
  assertEqual(
    (await readFile(join(projectRoot, "src", "status.txt"), "utf8")).trim(),
    "TODO",
    "target repo main worktree should remain unchanged until merge"
  );

  console.log("PatchPilot opt-in real Pi smoke passed");
} catch (error) {
  failed = true;
  console.error(`Fixture root kept for inspection: ${root}`);
  throw error;
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await cleanupTemp(root, failed);
}

async function runPreflight({ provider, profile, piCommand }) {
  const nodeVersion = process.versions.node;
  if (compareSemver(nodeVersion, "22.19.0") < 0) {
    throw new Error(`Node ${nodeVersion} does not satisfy Pi engine requirement >=22.19.0.`);
  }

  const piVersion = await runProcess(piCommand, ["--version"]);
  if (piVersion.code !== 0) {
    throw new Error(`${piCommand} --version failed before real smoke:\n${piVersion.stderr || piVersion.stdout}`);
  }
  const parsedPiVersion = parseSemver(piVersion.stdout || piVersion.stderr);
  if (!parsedPiVersion || compareSemver(`${parsedPiVersion.major}.${parsedPiVersion.minor}.${parsedPiVersion.patch}`, "0.79.3") < 0) {
    throw new Error(`Pi version must be >=0.79.3, got: ${(piVersion.stdout || piVersion.stderr).trim() || "<empty>"}`);
  }

  const localUnsafe = process.env.PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE === "1";
  const containerSandboxEnabled = parseBool(process.env.PATCHPILOT_CONTAINER_SANDBOX_ENABLED);
  const egressPolicyEnabled = parseBool(process.env.PATCHPILOT_EGRESS_POLICY_ENABLED);

  if (!containerSandboxEnabled && !localUnsafe) {
    throw new Error("Real Pi smoke requires PATCHPILOT_CONTAINER_SANDBOX_ENABLED=true, or explicit PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE=1.");
  }
  if (containerSandboxEnabled) {
    await assertContainerRuntimeAvailable(process.env.PATCHPILOT_CONTAINER_SANDBOX_RUNTIME || "auto");
  }

  if (!egressPolicyEnabled && !localUnsafe) {
    throw new Error("Real Pi smoke requires PATCHPILOT_EGRESS_POLICY_ENABLED=true, or explicit PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE=1.");
  }
  if (egressPolicyEnabled) {
    const allowedHosts = splitList(process.env.PATCHPILOT_EGRESS_ALLOWED_HOSTS);
    if (allowedHosts.some((host) => host.includes("*"))) {
      throw new Error("Real Pi smoke requires exact egress hosts; wildcard hosts are denied.");
    }
    if (!allowedHosts.includes(profile.host)) {
      throw new Error(`Real Pi smoke requires PATCHPILOT_EGRESS_ALLOWED_HOSTS to include exact host ${profile.host}.`);
    }
  }

  if (process.env.PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY !== "1") {
    throw new Error("Real Pi smoke requires PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY=1 to acknowledge Pi internal tool command evidence is observed after execution.");
  }

  const allowedSecrets = parseAllowedSecrets();
  const secret = allowedSecrets.find((item) => item.id === profile.secretId && item.envVar === profile.secretEnvVar);
  if (!secret) {
    throw new Error(`Secret Broker grant missing: configure ${profile.secretId} -> ${profile.secretEnvVar} in PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS.`);
  }
  const sourceEnv = secret.sourceEnv || secret.provider?.sourceEnv;
  if (!sourceEnv && secret.provider?.kind !== "vault") {
    throw new Error(`Secret ${profile.secretId} must define sourceEnv or a vault provider.`);
  }
  if (sourceEnv && !process.env[sourceEnv]) {
    throw new Error(`Secret source env ${sourceEnv} is not set for provider ${provider}.`);
  }
}

function parseAllowedSecrets() {
  const raw = process.env.PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS?.trim();
  if (!raw) throw new Error("PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS must be set for real Pi smoke.");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS must be a JSON array.");
  return parsed;
}

async function assertContainerRuntimeAvailable(runtime) {
  const candidates = runtime === "auto" ? ["podman", "docker"] : [runtime];
  for (const candidate of candidates) {
    const result = await runProcess(candidate, ["--version"]);
    if (result.code === 0) return;
  }
  throw new Error(`Container sandbox runtime is unavailable: ${runtime}.`);
}

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}
