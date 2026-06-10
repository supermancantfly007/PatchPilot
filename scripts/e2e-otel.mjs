import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-otel-e2e-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_OTEL_API_PORT || 4500 + (process.pid % 1000));
const apiBaseUrl = `http://localhost:${apiPort}`;
const collector = createCollector();
await collector.listen();

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_RUNNER: "simulated",
    PATCHPILOT_SIMULATION_DELAY_FACTOR: "0",
    PATCHPILOT_OTEL_ENABLED: "true",
    PATCHPILOT_OTEL_EXPORTER: "otlp",
    PATCHPILOT_OTEL_EXPORT_INTERVAL_MS: "50",
    PATCHPILOT_OTEL_METRIC_INTERVAL_MS: "50",
    PATCHPILOT_OTEL_SERVICE_NAME: "patchpilot-api-e2e",
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.baseUrl
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
      rawInput: "验证本地 OpenTelemetry collector 能看到一次 PatchPilot run trace。",
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

  await poll(() => {
    const traceText = collector.textFor("traces");
    const metricText = collector.textFor("metrics");
    const logText = collector.textFor("logs");
    if (!traceText.includes(completedRun.id)) return undefined;
    if (!traceText.includes(completedRun.requirementId)) return undefined;
    if (!traceText.includes(completedRun.prdId)) return undefined;
    if (!traceText.includes(completedRun.workItemId)) return undefined;
    if (!traceText.includes("patchpilot.agent_run")) return undefined;
    if (!metricText.includes("patchpilot.agent_run.completed")) return undefined;
    if (!logText.includes("patchpilot.agent_run.succeeded")) return undefined;
    return { traceText, metricText, logText };
  }, 10000);

  assert(collector.received.traces.length > 0, "collector should receive at least one trace export");
  assert(collector.received.metrics.length > 0, "collector should receive at least one metrics export");
  assert(collector.received.logs.length > 0, "collector should receive at least one logs export");

  console.log("PatchPilot OpenTelemetry E2E passed");
} finally {
  api.kill("SIGTERM");
  await waitForExit(api);
  await collector.close();
  await rm(dataDir, { recursive: true, force: true });
}

function createCollector() {
  const received = {
    traces: [],
    metrics: [],
    logs: []
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const pathname = new URL(request.url || "/", "http://collector.local").pathname;
      if (pathname === "/v1/traces") received.traces.push(body);
      else if (pathname === "/v1/metrics") received.metrics.push(body);
      else if (pathname === "/v1/logs") received.logs.push(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });

  return {
    received,
    baseUrl: "",
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("collector did not bind to a TCP port");
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
      });
    },
    textFor(signal) {
      return received[signal].map((body) => body.toString("utf8")).join("\n");
    }
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
