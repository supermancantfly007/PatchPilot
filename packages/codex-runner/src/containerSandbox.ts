import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

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
}

export interface SandboxedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{
    timedOut: boolean;
    diskLimitExceeded: boolean;
    durationMs: number;
  }>;
}

export class RootlessContainerSandbox {
  constructor(private readonly config: ContainerSandboxConfig) {}

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
      durationMs: completion.durationMs
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
    const args = buildRootlessContainerRunArgs({
      config: this.config,
      runtime,
      containerName,
      workspacePath: options.workspacePath,
      command: options.command,
      env: options.env
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
    }>((resolve) => {
      child.on("close", async () => {
        closed = true;
        clearTimeout(timeout);
        clearInterval(diskPoll);
        if (!diskLimitExceeded) {
          const sizeBytes = await readDirectorySizeBytes(options.workspacePath);
          diskLimitExceeded = sizeBytes > this.config.workspaceDiskMb * 1024 * 1024;
        }
        resolve({
          timedOut,
          diskLimitExceeded,
          durationMs: Date.now() - startedAt
        });
      });
    });

    return { child, done };
  }
}

export interface BuildRootlessContainerRunArgsInput {
  config: ContainerSandboxConfig;
  runtime: Exclude<ContainerRuntimeKind, "auto">;
  containerName: string;
  workspacePath: string;
  command: string;
  env?: NodeJS.ProcessEnv;
}

export function buildRootlessContainerRunArgs(input: BuildRootlessContainerRunArgsInput) {
  const env = sanitizeContainerEnv(input.env);
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

  if (input.runtime === "podman") {
    args.push("--userns", "keep-id");
  }

  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(input.config.image, "sh", "-lc", input.command);
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

export function defaultContainerSandboxConfig(): ContainerSandboxConfig {
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
    gid: typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
  };
}

export function toContainerWorkspacePath(hostWorkspacePath: string, hostPath: string) {
  const normalizedWorkspace = stripTrailingSlash(hostWorkspacePath);
  const normalizedPath = stripTrailingSlash(hostPath);
  if (normalizedPath === normalizedWorkspace) return "/workspace";
  if (!normalizedPath.startsWith(`${normalizedWorkspace}/`)) return hostPath;
  return `/workspace/${normalizedPath.slice(normalizedWorkspace.length + 1)}`;
}

function sanitizeContainerEnv(env: NodeJS.ProcessEnv = {}) {
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
  return sanitized;
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

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/u, "");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
