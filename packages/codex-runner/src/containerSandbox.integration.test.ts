import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RootlessContainerSandbox,
  defaultContainerSandboxConfig,
  resolveContainerRuntime,
  type ContainerRuntimeKind
} from "./containerSandbox";

const runIntegration = process.env.PATCHPILOT_CONTAINER_SANDBOX_INTEGRATION === "1";
const integrationIt = runIntegration ? it : it.skip;

describe("RootlessContainerSandbox integration", () => {
  integrationIt("allows workspace writes while denying a host path and Docker socket", async () => {
    const requestedRuntime = (process.env.PATCHPILOT_CONTAINER_SANDBOX_RUNTIME || "auto") as ContainerRuntimeKind;
    const runtime = await resolveContainerRuntime(requestedRuntime);
    expect(runtime, `container runtime ${requestedRuntime} must be installed`).toBeDefined();
    if (!runtime) throw new Error(`container runtime ${requestedRuntime} must be installed`);
    const image = process.env.PATCHPILOT_CONTAINER_SANDBOX_TEST_IMAGE || "postgres:16-alpine";
    expect(await imageExists(runtime, image), `container image ${image} must already exist locally`).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "patchpilot-container-sandbox-"));
    const workspacePath = join(root, "workspace");
    const deniedDir = join(root, "denied-host-path");
    const deniedPath = join(deniedDir, "secret.txt");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(deniedDir, { recursive: true });
    await writeFile(deniedPath, "host secret", "utf8");

    const sandbox = new RootlessContainerSandbox({
      ...defaultContainerSandboxConfig(),
      enabled: true,
      runtime,
      image,
      cpus: 1,
      memoryMb: 128,
      workspaceDiskMb: 128,
      tmpfsMb: 16,
      pidsLimit: 64
    });

    try {
      const result = await sandbox.run({
        workspacePath,
        timeoutMs: 30000,
        env: { CI: "1" },
        command: [
          "set -eu",
          "test \"$(id -u)\" != \"0\"",
          "test \"$HOME\" = \"/home/patchpilot\"",
          `if cat ${shellQuote(deniedPath)} >/dev/null 2>&1; then echo denied_path_readable; exit 20; fi`,
          "if [ -e /var/run/docker.sock ] || [ -S /var/run/docker.sock ]; then echo docker_socket_visible; exit 21; fi",
          "printf sandbox-ok > /workspace/result.txt"
        ].join("\n")
      });

      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        diskLimitExceeded: false
      });
      expect(result.output).not.toContain("denied_path_readable");
      expect(result.output).not.toContain("docker_socket_visible");
      await expect(readFile(join(workspacePath, "result.txt"), "utf8")).resolves.toBe("sandbox-ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

function imageExists(runtime: string, image: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(runtime, ["image", "inspect", image], {
      stdio: "ignore"
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
