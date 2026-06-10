import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEffectiveEgressAllowedHosts,
  defaultEgressPolicyConfig,
  isEgressHostAllowed,
  isMetadataHost,
  isPrivateOrMetadataIp,
  readEgressPolicyEvidence
} from "./egressPolicy";

describe("egress policy", () => {
  it("allows exact and wildcard hosts but denies non-allowlisted hosts", () => {
    const allowedHosts = ["registry.npmjs.org", "*.openai.com"];

    expect(isEgressHostAllowed("registry.npmjs.org", allowedHosts)).toBe(true);
    expect(isEgressHostAllowed("api.openai.com", allowedHosts)).toBe(true);
    expect(isEgressHostAllowed("example.com", allowedHosts)).toBe(false);
  });

  it("denies private networks and cloud metadata hosts", () => {
    expect(isPrivateOrMetadataIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrMetadataIp("172.16.8.10")).toBe(true);
    expect(isPrivateOrMetadataIp("192.168.1.10")).toBe(true);
    expect(isPrivateOrMetadataIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrMetadataIp("8.8.8.8")).toBe(false);
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isEgressHostAllowed("metadata.google.internal", ["metadata.google.internal"])).toBe(false);
  });

  it("adds configured Git remote hosts to the effective allowlist", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "patchpilot-egress-policy-"));
    spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    spawnSync("git", ["remote", "add", "origin", "git@github.example.com:org/repo.git"], {
      cwd: workspace,
      stdio: "ignore"
    });
    spawnSync("git", ["remote", "add", "mirror", "https://mirror.example.net/org/repo.git"], {
      cwd: workspace,
      stdio: "ignore"
    });

    await expect(buildEffectiveEgressAllowedHosts({
      ...defaultEgressPolicyConfig(),
      allowedHosts: ["registry.npmjs.org"],
      allowGitRemotes: true
    }, workspace)).resolves.toEqual([
      "github.example.com",
      "mirror.example.net",
      "registry.npmjs.org"
    ]);
  });

  it("summarizes audit-log evidence for allowed and denied requests", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "patchpilot-egress-audit-"));
    await mkdir(join(workspace, ".patchpilot"), { recursive: true });
    await writeFile(
      join(workspace, ".patchpilot", "egress-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-06-11T00:00:00.000Z",
          decision: "allowed",
          reason: "allowlisted",
          protocol: "https",
          host: "registry.npmjs.org",
          port: 443,
          target: "https://registry.npmjs.org/"
        }),
        JSON.stringify({
          at: "2026-06-11T00:00:01.000Z",
          decision: "denied",
          reason: "metadata_endpoint",
          protocol: "http",
          host: "169.254.169.254",
          port: 80,
          target: "http://169.254.169.254/latest/meta-data"
        })
      ].join("\n"),
      "utf8"
    );

    await expect(readEgressPolicyEvidence(defaultEgressPolicyConfig(), workspace, ["registry.npmjs.org"]))
      .resolves.toMatchObject({
        enabled: true,
        mode: "proxy_sidecar",
        allowedHosts: ["registry.npmjs.org"],
        allowedCount: 1,
        deniedCount: 1,
        denied: [
          {
            reason: "metadata_endpoint",
            target: "http://169.254.169.254/latest/meta-data"
          }
        ]
      });
  });
});
