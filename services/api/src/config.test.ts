import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPatchPilotConfig } from "./config";

describe("PatchPilot config", () => {
  it("reads .patchpilot/config.yaml sections and resolves fixture-relative paths", async () => {
    const fixture = await writeConfig(`
setup:
  commands:
    - pnpm install
test:
  command: pnpm test:fixture
  timeoutMs: 45000
  maxRepairAttempts: 2
smoke:
  command: pnpm smoke:fixture
  timeoutMs: 30000
  previewUrl: http://fixture.local:5173
e2e:
  command: pnpm e2e:fixture
  timeoutMs: 90000
  baseUrl: http://fixture.local:4173
dev:
  runner: simulated
  simulationDelayFactor: 0.25
  workspaceRoot: .patchpilot/worktrees-fixture
  previewUrl: http://fixture.local:3001
security:
  codexSandbox: read-only
  codexBypass: false
budget:
  codexTimeoutMs: 123000
  maxCostUsd: 4.5
`);

    try {
      const config = readPatchPilotConfig({ cwd: fixture.root, env: {} });

      expect(config.configSource).toBe("file");
      expect(config.setup.commands).toEqual(["pnpm install"]);
      expect(config.test).toEqual({
        command: "pnpm test:fixture",
        timeoutMs: 45000,
        maxRepairAttempts: 2
      });
      expect(config.smoke.previewUrl).toBe("http://fixture.local:5173");
      expect(config.e2e.baseUrl).toBe("http://fixture.local:4173");
      expect(config.dev).toEqual({
        runner: "simulated",
        simulationDelayFactor: 0.25,
        workspaceRoot: join(fixture.root, ".patchpilot", "worktrees-fixture"),
        previewUrl: "http://fixture.local:3001"
      });
      expect(config.security).toEqual({ codexSandbox: "read-only", codexBypass: false });
      expect(config.budget).toEqual({ codexTimeoutMs: 123000, maxCostUsd: 4.5 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("finds the repository config when called from a package subdirectory", async () => {
    const fixture = await writeConfig(`
test:
  command: pnpm test:from-root-config
dev:
  workspaceRoot: .patchpilot/worktrees-from-root
`);
    const packageCwd = join(fixture.root, "services", "api");
    await mkdir(packageCwd, { recursive: true });

    try {
      const config = readPatchPilotConfig({ cwd: packageCwd, env: {} });

      expect(config.configSource).toBe("file");
      expect(config.configPath).toBe(fixture.configPath);
      expect(config.test.command).toBe("pnpm test:from-root-config");
      expect(config.dev.workspaceRoot).toBe(join(fixture.root, ".patchpilot", "worktrees-from-root"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps environment variables as overrides and defaults when config values are absent", async () => {
    const fixture = await writeConfig(`
test:
  command: pnpm test:from-config
dev:
  runner: codex
  previewUrl: http://from-config.local
security:
  codexBypass: false
`);

    try {
      const config = readPatchPilotConfig({
        cwd: fixture.root,
        env: {
          PATCHPILOT_TEST_COMMAND: "pnpm test:from-env",
          PATCHPILOT_TEST_TIMEOUT_MS: "",
          PATCHPILOT_PREVIEW_URL: "http://from-env.local",
          PATCHPILOT_RUNNER: "simulated",
          PATCHPILOT_CODEX_BYPASS: "true"
        }
      });

      expect(config.test.command).toBe("pnpm test:from-env");
      expect(config.dev.previewUrl).toBe("http://from-env.local");
      expect(config.dev.runner).toBe("simulated");
      expect(config.security.codexBypass).toBe(true);
      expect(config.test.timeoutMs).toBe(120000);
      expect(config.budget.codexTimeoutMs).toBe(600000);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function writeConfig(content: string) {
  const root = await mkdtemp(join(tmpdir(), "patchpilot-config-fixture-"));
  const configDir = join(root, ".patchpilot");
  const configPath = join(configDir, "config.yaml");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, content.trimStart(), "utf8");
  return { root, configPath };
}
