import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressPolicyEvidence, EgressPolicyRuntimeConfig } from "@patchpilot/domain";
import {
  buildEffectiveEgressAllowedHosts,
  buildEgressProxyNodeEvalScript,
  defaultEgressPolicyConfig,
  egressProxyHost,
  mergeEgressPolicyEvidence,
  readEgressPolicyEvidence
} from "./egressPolicy";

export { defaultEgressPolicyConfig } from "./egressPolicy";

export type ContainerRuntimeKind = "auto" | "docker" | "podman";

export interface ContainerSandboxConfig {
  enabled: boolean;
  runtime: ContainerRuntimeKind;
  image: string;
  cpus: number;
  memoryMb: number;
  workspaceDiskMb: number;
  tmpfsMb: number;
  pidsLimit: number;
  uid: number;
  gid: number;
}

export interface RootlessContainerSandboxConfig extends ContainerSandboxConfig {
  egressPolicy: EgressPolicyRuntimeConfig;
}

export interface SandboxedCommandOptions {
  workspacePath: string;
  command: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface SandboxedCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  diskLimitExceeded: boolean;
  durationMs: number;
  egressPolicyEvidence?: EgressPolicyEvidence;
}

export interface SandboxedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{
    timedOut: boolean;
    diskLimitExceeded: boolean;
    durationMs: number;
    egressPolicyEvidence?: EgressPolicyEvidence;
  }>;
}

interface EgressProxyContext {
  networkName: string;
  proxyName: string;
  allowedHosts: string[];
  auditLogHostDir: string;
  auditLogHostPath: string;
  auditLogContainerPath: string;
}

interface EgressProxyRunArgsInput {
  config: RootlessContainerSandboxConfig;
  runtime: Exclude<ContainerRuntimeKind, "auto">;
  proxyName: string;
  networkName: string;
  allowedHosts: string[];
  auditLogHostDir: string;
  auditLogContainerPath: string;
}

const egressAuditContainerDir = "/patchpilot-egress-audit";
const egressAuditFileName = "egress-audit.jsonl";
const egressAuditContainerPath = `${egressAuditContainerDir}/${egressAuditFileName}`;

export class RootlessContainerSandbox {
  private readonly collectedEgressPolicyEvidence: EgressPolicyEvidence[] = [];

  constructor(private readonly config: RootlessContainerSandboxConfig) {}

  async run(options: SandboxedCommandOptions): Promise<SandboxedCommandResult> {
    const process = await this.spawn(options);
    let output = "";
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > maxOutputBytes) output = output.slice(output.length - maxOutputBytes);
    };

    process.child.stdout.on("data", append);
    process.child.stderr.on("data", append);

    const exitCode = await new Promise<number | null>((resolve) => {
      process.child.on("close", resolve);
    });
    const completion = await process.done;

    return {
      exitCode,
      output,
      timedOut: completion.timedOut,
      diskLimitExceeded: completion.diskLimitExceeded,
      durationMs: completion.durationMs,
      ...(completion.egressPolicyEvidence ? { egressPolicyEvidence: completion.egressPolicyEvidence } : {})
    };
  }

  async spawn(options: SandboxedCommandOptions): Promise<SandboxedProcess> {
    const runtime = await resolveContainerRuntime(this.config.runtime);
    if (!runtime) {
      throw new Error(`Container sandbox runtime is unavailable: ${this.config.runtime}`);
    }
    if (!existsSync(options.workspacePath)) {
      throw new Error(`Container sandbox workspace does not exist: ${options.workspacePath}`);
    }

    const containerName = `patchpilot-${randomUUID()}`;
    const egressProxy = this.config.egressPolicy.enabled
      ? await this.startEgressProxy(runtime, containerName, options.workspacePath)
      : undefined;
    const args = buildRootlessContainerRunArgs({
      config: this.config,
      runtime,
      containerName,
      workspacePath: options.workspacePath,
      command: options.command,
      env: options.env,
      egressProxy
    });
    const startedAt = Date.now();
    let timedOut = false;
    let diskLimitExceeded = false;
    let closed = false;

    const child = spawn(runtime, args, {
      cwd: options.workspacePath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stopContainer = () => {
      if (closed) return;
      const killer = spawn(runtime, ["kill", containerName], {
        stdio: "ignore"
      });
      killer.on("error", () => undefined);
      child.kill("SIGTERM");
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopContainer();
    }, options.timeoutMs);

    const diskPoll = setInterval(async () => {
      const sizeBytes = await readDirectorySizeBytes(options.workspacePath);
      if (sizeBytes <= this.config.workspaceDiskMb * 1024 * 1024) return;
      diskLimitExceeded = true;
      stopContainer();
    }, 500);

    const done = new Promise<{
      timedOut: boolean;
      diskLimitExceeded: boolean;
      durationMs: number;
      egressPolicyEvidence?: EgressPolicyEvidence;
    }>((resolve) => {
      child.on("close", async () => {
        closed = true;
        clearTimeout(timeout);
        clearInterval(diskPoll);
        if (!diskLimitExceeded) {
          const sizeBytes = await readDirectorySizeBytes(options.workspacePath);
          diskLimitExceeded = sizeBytes > this.config.workspaceDiskMb * 1024 * 1024;
        }
        const egressPolicyEvidence = egressProxy
          ? await this.collectEgressPolicyEvidence(
              options.workspacePath,
              egressProxy.allowedHosts,
              egressProxy.auditLogHostPath
            )
          : undefined;
        if (egressPolicyEvidence) this.collectedEgressPolicyEvidence.push(egressPolicyEvidence);
        await cleanupEgressProxy(runtime, egressProxy);
        resolve({
          timedOut,
          diskLimitExceeded,
          durationMs: Date.now() - startedAt,
          ...(egressPolicyEvidence ? { egressPolicyEvidence } : {})
        });
      });
    });

    return { child, done };
  }

  collectEgressPolicyEvidence(workspacePath: string, allowedHosts?: string[], auditLogHostPath?: string) {
    if (!auditLogHostPath && this.collectedEgressPolicyEvidence.length > 0) {
      return Promise.resolve(
        mergeEgressPolicyEvidence(
          this.collectedEgressPolicyEvidence,
          allowedHosts ?? this.config.egressPolicy.allowedHosts
        )
      );
    }
    return readEgressPolicyEvidence(
      this.config.egressPolicy,
      workspacePath,
      allowedHosts ?? this.config.egressPolicy.allowedHosts,
      auditLogHostPath
    );
  }

  private async startEgressProxy(
    runtime: Exclude<ContainerRuntimeKind, "auto">,
    containerName: string,
    workspacePath: string
  ): Promise<EgressProxyContext> {
    const networkName = `${containerName.slice(0, 31)}-net`;
    const proxyName = `${containerName.slice(0, 25)}-egress`;
    const auditLogHostDir = await mkdtemp(join(tmpdir(), "patchpilot-egress-audit-"));
    const auditLogHostPath = join(auditLogHostDir, egressAuditFileName);
    const context = {
      networkName,
      proxyName,
      allowedHosts: [] as string[],
      auditLogHostDir,
      auditLogHostPath,
      auditLogContainerPath: egressAuditContainerPath
    };
    try {
      const allowedHosts = await buildEffectiveEgressAllowedHosts(this.config.egressPolicy, workspacePath);
      context.allowedHosts = allowedHosts;
      await runRuntimeCommand(runtime, ["network", "create", "--internal", networkName], 10_000);
      const proxyArgs = buildEgressProxyRunArgs({
        config: this.config,
        runtime,
        proxyName,
        networkName,
        allowedHosts,
        auditLogHostDir,
        auditLogContainerPath: egressAuditContainerPath
      });
      await runRuntimeCommand(runtime, proxyArgs, 20_000);
      await runRuntimeCommand(
        runtime,
        ["network", "connect", "--alias", egressProxyHost, networkName, proxyName],
        10_000
      );
      await waitForEgressProxy(runtime, proxyName, this.config.egressPolicy.proxyPort);
      return context;
    } catch (error) {
      await cleanupEgressProxy(runtime, context);
      throw error;
    }
  }
}

export interface BuildRootlessContainerRunArgsInput {
  config: RootlessContainerSandboxConfig;
  runtime: Exclude<ContainerRuntimeKind, "auto">;
  containerName: string;
  workspacePath: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  egressProxy?: EgressProxyContext;
}

export function buildRootlessContainerRunArgs(input: BuildRootlessContainerRunArgsInput) {
  const env = sanitizeContainerEnv(input.env, input.egressProxy ? input.config.egressPolicy : undefined);
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    input.containerName,
    "--workdir",
    "/workspace",
    "--user",
    `${input.config.uid}:${input.config.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(input.config.pidsLimit),
    "--cpus",
    String(input.config.cpus),
    "--memory",
    `${input.config.memoryMb}m`,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${input.config.tmpfsMb}m`,
    "--tmpfs",
    `/home/patchpilot:rw,nosuid,nodev,size=${input.config.tmpfsMb}m`,
    "--mount",
    `type=bind,src=${input.workspacePath},dst=/workspace`
  ];

  if (input.egressProxy) {
    args.push("--network", input.egressProxy.networkName);
  }

  if (input.runtime === "podman") {
    args.push("--userns", "keep-id");
  }

  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(input.config.image, "sh", "-lc", input.command);
  return args;
}

export function buildEgressProxyRunArgs(input: EgressProxyRunArgsInput) {
  const args = [
    "run",
    "--rm",
    "--detach",
    "--name",
    input.proxyName,
    "--workdir",
    "/",
    "--user",
    `${input.config.uid}:${input.config.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--cpus",
    "0.5",
    "--memory",
    "256m",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${Math.min(input.config.tmpfsMb, 128)}m`,
    "--mount",
    `type=bind,src=${input.auditLogHostDir},dst=${egressAuditContainerDir}`,
    "--env",
    `PP_EGRESS_PROXY_PORT=${input.config.egressPolicy.proxyPort}`,
    "--env",
    `PP_EGRESS_AUDIT_LOG=${input.auditLogContainerPath}`,
    "--env",
    `PP_EGRESS_ALLOWED_HOSTS=${JSON.stringify(input.allowedHosts)}`,
    input.config.egressPolicy.proxyImage,
    "node",
    "-e",
    buildEgressProxyNodeEvalScript()
  ];

  if (input.runtime === "podman") {
    args.splice(args.indexOf("--mount"), 0, "--userns", "keep-id");
  }

  return args;
}

export async function resolveContainerRuntime(runtime: ContainerRuntimeKind) {
  if (runtime === "docker" || runtime === "podman") {
    return await commandExists(runtime) ? runtime : undefined;
  }

  if (await commandExists("podman")) return "podman";
  if (await commandExists("docker")) return "docker";
  return undefined;
}

export function defaultContainerSandboxConfig(): RootlessContainerSandboxConfig {
  return {
    enabled: false,
    runtime: "auto",
    image: "node:24-alpine",
    cpus: 2,
    memoryMb: 4096,
    workspaceDiskMb: 8192,
    tmpfsMb: 256,
    pidsLimit: 512,
    uid: typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000,
    gid: typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000,
    egressPolicy: defaultEgressPolicyConfig()
  };
}

export function toContainerWorkspacePath(hostWorkspacePath: string, hostPath: string) {
  const normalizedWorkspace = stripTrailingSlash(hostWorkspacePath);
  const normalizedPath = stripTrailingSlash(hostPath);
  if (normalizedPath === normalizedWorkspace) return "/workspace";
  if (!normalizedPath.startsWith(`${normalizedWorkspace}/`)) return hostPath;
  return `/workspace/${normalizedPath.slice(normalizedWorkspace.length + 1)}`;
}

function sanitizeContainerEnv(env: NodeJS.ProcessEnv = {}, egressPolicy?: EgressPolicyRuntimeConfig) {
  const sanitized: Record<string, string> = {
    HOME: "/home/patchpilot",
    XDG_CONFIG_HOME: "/home/patchpilot/.config",
    XDG_CACHE_HOME: "/tmp/patchpilot-cache",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    PATCHPILOT_CONTAINER_SANDBOX: "1"
  };
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/^[A-Z_][A-Z0-9_]*$/u.test(key)) continue;
    if (["HOME", "DOCKER_HOST", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"].includes(key)) continue;
    sanitized[key] = value;
  }
  if (egressPolicy?.enabled) {
    const proxyUrl = `http://${egressProxyHost}:${egressPolicy.proxyPort}`;
    Object.assign(sanitized, {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NPM_CONFIG_PROXY: proxyUrl,
      NPM_CONFIG_HTTPS_PROXY: proxyUrl,
      npm_config_proxy: proxyUrl,
      npm_config_https_proxy: proxyUrl,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.proxy",
      GIT_CONFIG_VALUE_0: proxyUrl,
      GIT_CONFIG_KEY_1: "https.proxy",
      GIT_CONFIG_VALUE_1: proxyUrl,
      PATCHPILOT_EGRESS_POLICY: "proxy_sidecar"
    });
  }
  return sanitized;
}

async function waitForEgressProxy(
  runtime: Exclude<ContainerRuntimeKind, "auto">,
  proxyName: string,
  proxyPort: number
) {
  const script = [
    "const http = require('node:http');",
    `const request = http.get('http://127.0.0.1:${proxyPort}/__health', (response) => process.exit(response.statusCode === 200 ? 0 : 1));`,
    "request.on('error', () => process.exit(1));",
    "request.setTimeout(1000, () => process.exit(1));"
  ].join("");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const result = await runRuntimeCommand(runtime, ["exec", proxyName, "node", "-e", script], 2_000, true);
    if (result.exitCode === 0) return;
    await sleep(250);
  }
  const logs = await runRuntimeCommand(runtime, ["logs", proxyName], 5_000, true);
  throw new Error(`Egress policy proxy did not become ready: ${logs.output.trim()}`);
}

async function cleanupEgressProxy(
  runtime: Exclude<ContainerRuntimeKind, "auto">,
  context: EgressProxyContext | undefined
) {
  if (!context) return;
  await runRuntimeCommand(runtime, ["kill", context.proxyName], 5_000, true);
  await runRuntimeCommand(runtime, ["network", "rm", context.networkName], 10_000, true);
  await rm(context.auditLogHostDir, { recursive: true, force: true });
}

function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      stdio: "ignore"
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function readDirectorySizeBytes(path: string) {
  const result = await runShell(`du -sk ${shellQuote(path)}`);
  if (result.exitCode !== 0) return 0;
  const kilobytes = Number(result.output.trim().split(/\s+/u)[0]);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
}

function runShell(command: string) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ exitCode: 1, output: error.message }));
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}

function runRuntimeCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  allowFailure = false
) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (allowFailure) resolve({ exitCode: 1, output: error.message });
      else reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${output.trim()}`));
        return;
      }
      resolve({ exitCode, output });
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/u, "");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
