import { describe, expect, it } from "vitest";
import {
  buildEgressProxyRunArgs,
  buildRootlessContainerRunArgs,
  defaultContainerSandboxConfig,
  toContainerWorkspacePath
} from "./containerSandbox";

describe("RootlessContainerSandbox", () => {
  it("builds a non-privileged Docker run command with bounded writable mounts", () => {
    const args = buildRootlessContainerRunArgs({
      config: {
        ...defaultContainerSandboxConfig(),
        enabled: true,
        runtime: "docker",
        image: "patchpilot/sandbox:test",
        cpus: 1,
        memoryMb: 512,
        workspaceDiskMb: 1024,
        tmpfsMb: 64,
        pidsLimit: 128,
        uid: 1001,
        gid: 1002
      },
      runtime: "docker",
      containerName: "patchpilot-test",
      workspacePath: "/tmp/workspace",
      command: "pnpm test",
      env: {
        CI: "1",
        HOME: "/Users/example",
        DOCKER_HOST: "unix:///Users/example/docker.sock",
        DOCKER_CONFIG: "/Users/example/.docker"
      }
    });

    expect(args).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--interactive",
      "--name",
      "patchpilot-test",
      "--workdir",
      "/workspace",
      "--user",
      "1001:1002",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--tmpfs",
      "/home/patchpilot:rw,nosuid,nodev,size=64m",
      "--mount",
      "type=bind,src=/tmp/workspace,dst=/workspace",
      "--env",
      "HOME=/home/patchpilot",
      "--env",
      "DOCKER_HOST=unix:///var/run/docker.sock",
      "patchpilot/sandbox:test",
      "sh",
      "-lc",
      "pnpm test"
    ]));
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("/Users/example");
    expect(args).not.toContain("unix:///Users/example/docker.sock");
  });

  it("adds Podman keep-id user namespace when Podman is selected", () => {
    const args = buildRootlessContainerRunArgs({
      config: defaultContainerSandboxConfig(),
      runtime: "podman",
      containerName: "patchpilot-test",
      workspacePath: "/tmp/workspace",
      command: "true"
    });

    expect(args).toEqual(expect.arrayContaining(["--userns", "keep-id"]));
  });

  it("routes sandbox command egress through the internal proxy network", () => {
    const args = buildRootlessContainerRunArgs({
      config: {
        ...defaultContainerSandboxConfig(),
        enabled: true,
        egressPolicy: {
          ...defaultContainerSandboxConfig().egressPolicy,
          proxyPort: 43128
        }
      },
      runtime: "docker",
      containerName: "patchpilot-test",
      workspacePath: "/tmp/workspace",
      command: "npm ping",
      egressProxy: {
        networkName: "patchpilot-test-net",
        proxyName: "patchpilot-test-egress",
        allowedHosts: ["registry.npmjs.org"]
      }
    });

    expect(args).toEqual(expect.arrayContaining([
      "--network",
      "patchpilot-test-net",
      "--env",
      "HTTPS_PROXY=http://patchpilot-egress-proxy:43128",
      "--env",
      "GIT_CONFIG_KEY_0=http.proxy",
      "--env",
      "PATCHPILOT_EGRESS_POLICY=proxy_sidecar"
    ]));
  });

  it("builds a constrained egress proxy sidecar command", () => {
    const args = buildEgressProxyRunArgs({
      config: {
        ...defaultContainerSandboxConfig(),
        enabled: true,
        image: "patchpilot/sandbox:test",
        uid: 1001,
        gid: 1002,
        egressPolicy: {
          ...defaultContainerSandboxConfig().egressPolicy,
          proxyImage: "node:egress-test",
          proxyPort: 43128,
          auditLogPath: ".patchpilot/egress-audit.jsonl"
        }
      },
      runtime: "docker",
      proxyName: "patchpilot-test-egress",
      networkName: "patchpilot-test-net",
      workspacePath: "/tmp/workspace",
      allowedHosts: ["api.openai.com", "registry.npmjs.org"]
    });

    expect(args).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--detach",
      "--name",
      "patchpilot-test-egress",
      "--user",
      "1001:1002",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--mount",
      "type=bind,src=/tmp/workspace,dst=/workspace",
      "--env",
      "PP_EGRESS_PROXY_PORT=43128",
      "--env",
      "PP_EGRESS_AUDIT_LOG=/workspace/.patchpilot/egress-audit.jsonl",
      "--env",
      "PP_EGRESS_ALLOWED_HOSTS=[\"api.openai.com\",\"registry.npmjs.org\"]",
      "node:egress-test",
      "node",
      "-e"
    ]));
    expect(args).not.toContain("--privileged");
  });

  it("maps host workspace paths to the container workspace", () => {
    expect(toContainerWorkspacePath("/tmp/workspace", "/tmp/workspace/PATCHPILOT_TASK.md"))
      .toBe("/workspace/PATCHPILOT_TASK.md");
    expect(toContainerWorkspacePath("/tmp/workspace", "/tmp/workspace"))
      .toBe("/workspace");
    expect(toContainerWorkspacePath("/tmp/workspace", "/tmp/other/file.txt"))
      .toBe("/tmp/other/file.txt");
  });
});
