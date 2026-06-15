import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCapabilityManifest } from "@patchpilot/policy";
import { FakePiPolicyToolBridge } from "./piPolicyToolBridge";

describe("FakePiPolicyToolBridge", () => {
  it("denies Pi custom tool actions before shell, file, network, or secret side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchpilot-pi-tool-policy-denied-"));
    const workspacePath = join(root, "workspace");
    await writeFixtureWorkspace(workspacePath);
    const manifest = buildToolManifest();
    const bridge = new FakePiPolicyToolBridge({
      runId: "run_pi_tool_policy",
      workItemId: "wi_pi_tool_policy",
      workspacePath,
      capabilityManifest: manifest,
      env: { PATH: process.env.PATH ?? "" },
      secretGrants: { "other-token": "patchpilot_fixture_secret_bridge_value" },
      redaction: { knownSecrets: ["patchpilot_fixture_secret_bridge_value"] }
    });
    let networkAttempts = 0;

    try {
      await expect(bridge.shell("node -e \"require('fs').writeFileSync('src/denied-shell.txt','bad')\""))
        .rejects.toMatchObject({ failureType: "policy_denied" });
      await expect(bridge.writeFile("src/blocked/secret.txt", "bad\n"))
        .rejects.toMatchObject({ failureType: "policy_denied" });
      await expect(bridge.networkRequest("https://blocked.example/v1", () => {
        networkAttempts += 1;
        return "would have called network";
      })).rejects.toMatchObject({ failureType: "policy_denied" });
      await expect(bridge.readSecret("ci-token")).rejects.toMatchObject({ failureType: "policy_denied" });

      expect(existsSync(join(workspacePath, "src", "denied-shell.txt"))).toBe(false);
      expect(existsSync(join(workspacePath, "src", "blocked", "secret.txt"))).toBe(false);
      expect(networkAttempts).toBe(0);
      expect(JSON.stringify(bridge.policyEvidence)).not.toContain("patchpilot_fixture_secret_bridge_value");
      expect(bridge.policyEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "policy_denied",
          kind: "shell",
          policyDecision: expect.objectContaining({ reason: "command_not_allowlisted" })
        }),
        expect.objectContaining({
          action: "policy_denied",
          kind: "file_write",
          policyDecision: expect.objectContaining({ reason: "repo_write_denylisted" })
        }),
        expect.objectContaining({
          action: "policy_denied",
          kind: "network",
          policyDecision: expect.objectContaining({ reason: "network_not_allowlisted" })
        }),
        expect.objectContaining({
          action: "policy_denied",
          kind: "secret",
          policyDecision: expect.objectContaining({ reason: "secret_grant_missing" })
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows full coding-agent tool flow when the active manifest permits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchpilot-pi-tool-policy-allowed-"));
    const workspacePath = join(root, "workspace");
    await writeFixtureWorkspace(workspacePath);
    const manifest = buildToolManifest();
    const bridge = new FakePiPolicyToolBridge({
      runId: "run_pi_tool_policy",
      workItemId: "wi_pi_tool_policy",
      workspacePath,
      capabilityManifest: manifest,
      env: { PATH: process.env.PATH ?? "" },
      secretGrants: { "ci-token": "patchpilot_fixture_secret_allowed_value" },
      redaction: { knownSecrets: ["patchpilot_fixture_secret_allowed_value"] }
    });
    let networkAttempts = 0;

    try {
      await bridge.writeFile("src/status.txt", "READY\n");
      await bridge.writeFile("src/notes.txt", "draft\n");
      await bridge.editFile("src/notes.txt", (content) => content.replace("draft", "done"));
      await expect(bridge.networkRequest("https://api.allowed.test/v1", () => {
        networkAttempts += 1;
        return { ok: true };
      })).resolves.toEqual({ ok: true });
      await expect(bridge.readSecret("ci-token")).resolves.toBe("patchpilot_fixture_secret_allowed_value");
      await expect(bridge.shell("node test.mjs")).resolves.toMatchObject({ exitCode: 0 });

      await expect(readFile(join(workspacePath, "src", "status.txt"), "utf8")).resolves.toBe("READY\n");
      await expect(readFile(join(workspacePath, "src", "notes.txt"), "utf8")).resolves.toBe("done\n");
      expect(networkAttempts).toBe(1);
      expect(bridge.toolCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "pi.file_write", status: "completed" }),
        expect.objectContaining({ name: "pi.file_edit", status: "completed" }),
        expect.objectContaining({ name: "pi.network", status: "completed" }),
        expect.objectContaining({ name: "pi.secret", status: "completed" }),
        expect.objectContaining({ name: "pi.shell", status: "completed", exitCode: 0 })
      ]));
      expect(JSON.stringify(bridge.toolCalls)).not.toContain("patchpilot_fixture_secret_allowed_value");
      expect(bridge.policyEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "policy_allowed", kind: "file_write" }),
        expect.objectContaining({ action: "policy_allowed", kind: "file_edit" }),
        expect.objectContaining({ action: "policy_allowed", kind: "network" }),
        expect.objectContaining({ action: "policy_allowed", kind: "secret" }),
        expect.objectContaining({ action: "policy_allowed", kind: "shell" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function buildToolManifest() {
  return generateCapabilityManifest({
    runId: "run_pi_tool_policy",
    prdId: "prd_pi_tool_policy",
    workItem: {
      id: "wi_pi_tool_policy",
      prdId: "prd_pi_tool_policy",
      requiredCapabilities: ["secret:ci-token"]
    },
    repo: {
      writeAllow: ["src/**"],
      writeDeny: ["src/blocked/**"]
    },
    commands: {
      allow: ["node test.mjs"]
    },
    network: {
      allow: ["api.allowed.test"]
    },
    testCommand: "node test.mjs",
    security: {
      egressPolicy: {
        allowedHosts: ["api.allowed.test"],
        allowGitRemotes: false
      },
      secretBroker: {
        allowedSecrets: [
          {
            id: "ci-token",
            envVar: "CI_TOKEN",
            sourceEnv: "PATCHPILOT_CI_TOKEN",
            environment: "ci"
          }
        ]
      }
    },
    createdBy: "pi-tool-policy-test"
  });
}

async function writeFixtureWorkspace(workspacePath: string) {
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "status.txt"), "TODO\n", "utf8");
  await writeFile(join(workspacePath, "test.mjs"), `
import { readFileSync } from "node:fs";

if (readFileSync("src/status.txt", "utf8") !== "READY\\n") {
  throw new Error("status was not updated");
}
`, "utf8");
}
