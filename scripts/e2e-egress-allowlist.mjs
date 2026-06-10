import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const {
  buildEgressProxyNodeEvalScript,
  defaultEgressPolicyConfig,
  readEgressPolicyEvidence
} = await import("../packages/codex-runner/src/egressPolicy.ts");

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "patchpilot-egress-e2e-"));
const privateAuditDir = await mkdtemp(join(tmpdir(), "patchpilot-egress-private-audit-"));
const auditLogPath = join(privateAuditDir, "egress-audit.jsonl");
const artifactPath = resolve(repoRoot, "docs/adr/artifacts/td-212-egress-allowlist-verifier.json");
const proxyPort = await reservePort();
const allowedHosts = ["registry.npmjs.org"];
await mkdir(dirname(auditLogPath), { recursive: true });

const proxy = spawn(process.execPath, ["-e", buildEgressProxyNodeEvalScript()], {
  env: {
    ...process.env,
    PP_EGRESS_PROXY_PORT: String(proxyPort),
    PP_EGRESS_AUDIT_LOG: auditLogPath,
    PP_EGRESS_ALLOWED_HOSTS: JSON.stringify(allowedHosts)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let proxyOutput = "";
proxy.stdout.on("data", (chunk) => {
  proxyOutput += chunk.toString("utf8");
});
proxy.stderr.on("data", (chunk) => {
  proxyOutput += chunk.toString("utf8");
});

try {
  await waitForProxy(proxyPort);
  const allowed = await requestThroughProxy(proxyPort, "http://registry.npmjs.org/-/ping");
  assert(allowed.statusCode !== 403, `allowlisted registry request was denied: ${allowed.statusCode} ${allowed.body}`);

  const denied = await requestThroughProxy(proxyPort, "http://169.254.169.254/latest/meta-data");
  assert(denied.statusCode === 403, `metadata endpoint request should be denied, got ${denied.statusCode}`);
  assert(denied.body.includes("PatchPilot egress policy denied"), "denied response should name PatchPilot policy");

  const evidence = await readEgressPolicyEvidence({
    ...defaultEgressPolicyConfig(),
    allowedHosts,
    proxyPort,
    auditLogPath: ".patchpilot/egress-audit.jsonl"
  }, workspace, allowedHosts, auditLogPath);

  assert(evidence.allowedCount >= 1, "evidence should include at least one allowed request");
  assert(evidence.deniedCount >= 1, "evidence should include at least one denied request");
  assert(
    evidence.denied.some((entry) => entry.host === "169.254.169.254" && entry.reason === "metadata_endpoint"),
    "evidence should include metadata endpoint denial"
  );

  const artifact = {
    workItem: "TD-212 network egress allowlist",
    generatedAt: new Date().toISOString(),
    verifier: "scripts/e2e-egress-allowlist.mjs",
    allowedRequest: {
      target: "http://registry.npmjs.org/-/ping",
      statusCode: allowed.statusCode
    },
    deniedRequest: {
      target: "http://169.254.169.254/latest/meta-data",
      statusCode: denied.statusCode,
      responseExcerpt: denied.body.slice(0, 160)
    },
    auditSource: {
      mode: "private_host_path",
      taskWorkspacePath: "<temp-task-workspace>",
      taskWritable: false
    },
    evidence
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`Egress allowlist verifier passed; evidence written to ${artifactPath}`);
} finally {
  proxy.kill("SIGTERM");
  await new Promise((resolve) => {
    proxy.once("close", resolve);
    setTimeout(resolve, 1000);
  });
  if (proxy.exitCode && proxy.exitCode !== 0 && proxyOutput.trim()) {
    console.error(proxyOutput.trim());
  }
  await rm(privateAuditDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

function requestThroughProxy(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: target,
      timeout: 10_000
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Timed out requesting ${target}`));
    });
    request.on("error", reject);
    request.end();
  });
}

function waitForProxy(port) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      requestProxyHealth(port)
        .then((response) => {
          if (response.statusCode === 200) {
            resolve();
            return;
          }
          retry();
        })
        .catch(retry);
    };
    const retry = (error) => {
      if (Date.now() - startedAt > 10_000) {
        reject(error || new Error(`Egress proxy did not start on ${port}`));
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

function requestProxyHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/__health",
      timeout: 1000
    }, (response) => {
      response.resume();
      response.on("end", () => {
        resolve({ statusCode: response.statusCode });
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Timed out waiting for egress proxy health"));
    });
    request.on("error", reject);
    request.end();
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("Could not reserve a local port"));
      });
    });
    server.on("error", reject);
  });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}
