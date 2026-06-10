import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-metrics-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_METRICS_PORT || 4600 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_RUNNER: "simulated",
    PATCHPILOT_SIMULATION_DELAY_FACTOR: "0"
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
  await waitForHealth();

  const requirement = await requestJson("/api/requirements", {
    method: "POST",
    body: JSON.stringify({
      rawInput: "Verify Prometheus metrics for one simulated PatchPilot run.",
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const approval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });
  const workItem = approval.workItems[0];
  assert(workItem?.id, "approved PRD should create a work item");

  const startedRun = await requestJson(`/api/work-items/${workItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "simulated" })
  });

  const completedRun = await poll(async () => {
    const run = await requestJson(`/api/runs/${startedRun.id}`);
    return run.status === "succeeded" ? run : undefined;
  }, 15000);

  await requestJson(`/api/acceptance/${completedRun.id}`, {
    method: "POST",
    body: JSON.stringify({ status: "accepted" })
  });

  const metrics = await requestText("/metrics");
  assert(metrics.contentType.includes("text/plain"), "metrics endpoint should return text/plain");
  assert(metrics.text.includes("# TYPE patchpilot_agent_run_duration_seconds histogram"), "run duration histogram should be exposed");
  assert(
    metrics.text.includes('patchpilot_agent_run_duration_seconds_count{runner="simulated",status="succeeded"} 1'),
    "completed simulated run should increment duration count"
  );
  assert(
    metrics.text.includes('patchpilot_agent_run_failures_total{runner="simulated",failure_type="test_failed"} 0'),
    "failure reason metric should expose stable failure_type labels"
  );
  assert(
    metrics.text.includes('patchpilot_work_item_queue_depth{role="backend",status="done"} 1'),
    "accepted run should update queue depth"
  );
  assert(
    metrics.text.includes('patchpilot_agent_run_cost_actual_usd{runner="simulated",status="succeeded"} 0.38'),
    "run cost metric should include simulated actual cost"
  );
  assert(metrics.text.includes("patchpilot_test_pass_rate_ratio 1"), "test pass rate should be one after passing evidence");
  assert(metrics.text.includes("patchpilot_acceptance_rate_ratio 1"), "acceptance rate should be one after acceptance");

  console.log("PatchPilot metrics E2E passed");
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await rm(dataDir, { recursive: true, force: true });
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

async function requestText(path) {
  const response = await fetch(`${apiBaseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${text}`);
  }
  return {
    text,
    contentType: response.headers.get("content-type") || ""
  };
}

async function waitForHealth() {
  await poll(async () => {
    if (api.exitCode !== null) {
      throw new Error(`API exited before health check\n${apiOutput}`);
    }
    try {
      const health = await requestJson("/health");
      return health.ok ? health : undefined;
    } catch (_error) {
      return undefined;
    }
  }, 20000);
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

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}
