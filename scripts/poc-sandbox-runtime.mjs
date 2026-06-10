import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const outputPath = resolve(
  repoRoot,
  process.env.PATCHPILOT_SANDBOX_POC_OUTPUT || "docs/adr/artifacts/td-301-sandbox-runtime-poc.json"
);
const image = process.env.PATCHPILOT_SANDBOX_POC_IMAGE || "postgres:16-alpine";
const requestedRuntime = process.env.PATCHPILOT_SANDBOX_POC_RUNTIME || "auto";
const startedAt = new Date();

const toolAvailability = {
  docker: commandExists("docker"),
  podman: commandExists("podman"),
  runsc: commandExists("runsc"),
  kataRuntime: commandExists("kata-runtime"),
  firecracker: commandExists("firecracker")
};
const dockerRuntimes = toolAvailability.docker ? readDockerRuntimes() : [];
const runtime = chooseRuntime({ requestedRuntime, toolAvailability, dockerRuntimes });
const root = await mkdtemp(join(tmpdir(), "patchpilot-sandbox-runtime-poc-"));
const workspacePath = join(root, "workspace");
const deniedDir = join(root, "denied-host-path");
const deniedPath = join(deniedDir, "secret.txt");

try {
  await mkdir(workspacePath, { recursive: true });
  await mkdir(deniedDir, { recursive: true });
  await writeFile(join(workspacePath, "WORK_ITEM.md"), [
    "# TD-301 Minimal Work Item",
    "",
    "Acceptance:",
    "- run as a non-root user;",
    "- keep host home and Docker socket outside the sandbox;",
    "- write completion evidence only to the workspace."
  ].join("\n"), "utf8");
  await writeFile(deniedPath, "host secret should not be readable", "utf8");

  if (!runtime) {
    await writeEvidence({
      status: "blocked",
      startedAt,
      completedAt: new Date(),
      image,
      requestedRuntime,
      selectedRuntime: null,
      toolAvailability,
      dockerRuntimes,
      workspaceResult: null,
      residualRisk: [
        "No supported local container runtime was available for the PoC.",
        "Install Docker, Podman, or a registered gVisor/Kata runtime and rerun this script."
      ]
    });
    throw new Error("No supported local container runtime was available for the sandbox PoC");
  }

  assertImageAvailable(runtime.engine, image);

  const command = buildWorkItemCommand(deniedPath);
  const args = buildRunArgs({
    runtime,
    image,
    workspacePath,
    command,
    uid: currentUid(),
    gid: currentGid()
  });
  const result = await runProcess(runtime.engine, args, { cwd: repoRoot });
  const resultJsonPath = join(workspacePath, "result.json");
  const workspaceResult = JSON.parse(await readFile(resultJsonPath, "utf8"));
  const selectedProductionRuntime = runtime.family === "gvisor";
  const residualRisk = selectedProductionRuntime
    ? [
        "This PoC proves a minimal containerized work item only; production still needs Kubernetes RuntimeClass and E2E evidence."
      ]
    : [
        "The selected production runtime is gVisor, but this host did not expose a runnable gVisor Docker runtime.",
        `The PoC used ${runtime.label} as the best local substitute, so it does not prove production gVisor syscall compatibility or isolation.`,
        "Run this script on a Linux worker with Docker/containerd gVisor integration or complete the Kubernetes RuntimeClass E2E before production acceptance."
      ];

  const evidence = {
    status: "passed",
    startedAt,
    completedAt: new Date(),
    image,
    requestedRuntime,
    selectedRuntime: runtime,
    selectedProductionRuntime,
    toolAvailability,
    dockerRuntimes,
    command: `${runtime.engine} ${args.map((arg) => redactTempPath(arg, root)).join(" ")}`,
    process: {
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    },
    workspaceResult,
    residualRisk
  };

  assert(workspaceResult.nonRoot === true, "PoC command did not run as non-root");
  assert(workspaceResult.home === "/home/patchpilot", "PoC command did not use sandbox home");
  assert(workspaceResult.dockerSocketVisible === false, "Docker socket was visible in the sandbox");
  assert(workspaceResult.deniedHostPathReadable === false, "Denied host path was readable in the sandbox");
  assert(workspaceResult.workspaceWritable === true, "Workspace was not writable in the sandbox");

  await writeEvidence(evidence);
  console.log(`PatchPilot sandbox runtime PoC passed with ${runtime.label}`);
  console.log(`Evidence written to ${relativeToRepo(outputPath)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function chooseRuntime({ requestedRuntime, toolAvailability, dockerRuntimes }) {
  const dockerRuntimeNames = new Set(dockerRuntimes.map((runtime) => runtime.name));
  const candidates = [
    {
      family: "gvisor",
      label: "gVisor via Docker runtime runsc",
      engine: "docker",
      dockerRuntime: "runsc",
      available: toolAvailability.docker && dockerRuntimeNames.has("runsc")
    },
    {
      family: "gvisor",
      label: "gVisor via Docker runtime io.containerd.runsc.v1",
      engine: "docker",
      dockerRuntime: "io.containerd.runsc.v1",
      available: toolAvailability.docker && dockerRuntimeNames.has("io.containerd.runsc.v1")
    },
    ...dockerRuntimes
      .filter((runtime) => runtime.name.toLowerCase().includes("kata"))
      .map((runtime) => ({
        family: "kata",
        label: `Kata via Docker runtime ${runtime.name}`,
        engine: "docker",
        dockerRuntime: runtime.name,
        available: toolAvailability.docker
      })),
    {
      family: "docker-runc",
      label: "Docker default runc runtime",
      engine: "docker",
      dockerRuntime: undefined,
      available: toolAvailability.docker
    },
    {
      family: "podman-runc",
      label: "Podman default runc runtime",
      engine: "podman",
      dockerRuntime: undefined,
      available: toolAvailability.podman
    }
  ];

  if (requestedRuntime !== "auto") {
    const selected = candidates.find((candidate) => candidate.family === requestedRuntime && candidate.available);
    if (selected) return selected;
    return undefined;
  }

  return candidates.find((candidate) => candidate.available);
}

function buildRunArgs({ runtime, image, workspacePath, command, uid, gid }) {
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    `patchpilot-sandbox-poc-${process.pid}`,
    "--workdir",
    "/workspace",
    "--user",
    `${uid}:${gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--cpus",
    "1",
    "--memory",
    "256m",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=32m",
    "--tmpfs",
    "/home/patchpilot:rw,nosuid,nodev,size=32m",
    "--mount",
    `type=bind,src=${workspacePath},dst=/workspace`,
    "--env",
    "HOME=/home/patchpilot",
    "--env",
    "PATCHPILOT_CONTAINER_SANDBOX=1"
  ];

  if (runtime.dockerRuntime) {
    args.splice(1, 0, "--runtime", runtime.dockerRuntime);
  }

  if (runtime.engine === "podman") {
    args.push("--userns", "keep-id");
  }

  args.push(image, "sh", "-lc", command);
  return args;
}

function buildWorkItemCommand(deniedPath) {
  return [
    "set -eu",
    "denied_host_path_readable=false",
    `if cat ${shellQuote(deniedPath)} >/dev/null 2>&1; then denied_host_path_readable=true; fi`,
    "docker_socket_visible=false",
    "if [ -e /var/run/docker.sock ] || [ -S /var/run/docker.sock ]; then docker_socket_visible=true; fi",
    "workspace_writable=false",
    "if printf sandbox-poc-ok > /workspace/result.txt; then workspace_writable=true; fi",
    "non_root=false",
    "if [ \"$(id -u)\" != \"0\" ]; then non_root=true; fi",
    "cat > /workspace/result.json <<EOF",
    "{",
    "  \"workItem\": \"TD-301 minimal sandbox runtime PoC\",",
    "  \"nonRoot\": $non_root,",
    "  \"uid\": $(id -u),",
    "  \"gid\": $(id -g),",
    "  \"home\": \"$HOME\",",
    "  \"dockerSocketVisible\": $docker_socket_visible,",
    "  \"deniedHostPathReadable\": $denied_host_path_readable,",
    "  \"workspaceWritable\": $workspace_writable",
    "}",
    "EOF",
    "cat /workspace/result.json"
  ].join("\n");
}

function assertImageAvailable(engine, image) {
  const inspect = spawnSync(engine, ["image", "inspect", image], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (inspect.status === 0) return;

  const pull = spawnSync(engine, ["pull", image], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (pull.status !== 0) {
    throw new Error(`${engine} could not inspect or pull ${image}:\n${pull.stderr || pull.stdout}`);
  }
}

function readDockerRuntimes() {
  const result = spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) return [];
  try {
    return Object.keys(JSON.parse(result.stdout || "{}")).map((name) => ({ name }));
  } catch (_error) {
    return [];
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ exitCode, stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeEvidence(evidence) {
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function commandExists(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    cwd: repoRoot,
    stdio: "ignore"
  });
  return result.status === 0;
}

function currentUid() {
  return typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000;
}

function currentGid() {
  return typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000;
}

function relativeToRepo(path) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}

function redactTempPath(value, root) {
  return value.split(root).join("<temp-poc-root>");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
