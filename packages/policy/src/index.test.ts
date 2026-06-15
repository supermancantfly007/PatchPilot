import { describe, expect, it } from "vitest";
import {
  CapabilityPolicyViolation,
  agentSatisfiesCapabilityManifest,
  applyManifestToEgressPolicyConfig,
  enforceCommandPolicy,
  enforceNetworkPolicy,
  enforceSecretPolicy,
  enforceWorkspaceWritePolicy,
  generateCapabilityManifest,
  isCostWithinCapabilityManifest,
  summarizeCapabilityManifest,
  validateCapabilityManifest
} from "./index";

describe("capability manifest policy", () => {
  it("generates a run-scoped manifest from work item and runtime policy inputs", () => {
    const manifest = generateCapabilityManifest({
      runId: "run_123",
      workItem: {
        id: "wi_123",
        prdId: "prd_123",
        requiredCapabilities: ["backend", "secret:github-token"],
        budgetUsd: 3
      },
      testCommand: "pnpm --filter @patchpilot/api test",
      testTimeoutMs: 120_000,
      security: {
        codexSandbox: "workspace-write",
        containerSandbox: {
          enabled: true,
          runtime: "docker",
          image: "patchpilot/sandbox:test"
        },
        egressPolicy: {
          allowedHosts: ["api.openai.com"],
          allowGitRemotes: false,
          auditLogPath: ".patchpilot/egress.jsonl"
        },
        secretBroker: {
          allowedSecrets: [
            {
              id: "github-token",
              envVar: "GITHUB_TOKEN",
              sourceEnv: "PATCHPILOT_GITHUB_TOKEN",
              environment: "ci"
            }
          ]
        }
      },
      budget: {
        softThresholdRatio: 0.75
      }
    });

    expect(validateCapabilityManifest(manifest).valid).toBe(true);
    expect(manifest).toMatchObject({
      id: "manifest_run_123",
      scope: {
        runId: "run_123",
        prdId: "prd_123",
        workItemId: "wi_123"
      },
      capabilities: {
        required: ["backend", "secret:github-token"]
      },
      commands: {
        allow: expect.arrayContaining(["pnpm --filter @patchpilot/api test"])
      },
      network: {
        allow: ["api.openai.com"],
        allowGitRemotes: false
      },
      secrets: {
        requested: ["github-token"],
        allow: ["github-token"],
        allowProductionSecrets: false
      },
      runtime: {
        maxRuntimeMs: 120_000,
        container: expect.objectContaining({
          enabled: true,
          runtime: "docker",
          image: "patchpilot/sandbox:test"
        })
      },
      cost: {
        maxCostUsd: 3,
        softThresholdRatio: 0.75
      }
    });
  });

  it("rejects invalid or conflicting manifest policy", () => {
    const manifest = generateCapabilityManifest({
      repo: {
        writeAllow: ["docs/adr/**"],
        writeDeny: ["docs/adr/**"]
      }
    });

    expect(validateCapabilityManifest(manifest)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "repo.write"
        })
      ])
    });
  });

  it("enforces command deny before command allow", () => {
    const manifest = generateCapabilityManifest({
      commands: {
        allow: ["pnpm test", "docker version"],
        deny: ["docker"]
      }
    });

    expect(() => enforceCommandPolicy(manifest, "pnpm test")).not.toThrow();
    expect(() => enforceCommandPolicy(manifest, "docker version")).toThrow(CapabilityPolicyViolation);
    expect(() => enforceCommandPolicy(manifest, "npm test")).toThrow(/command_not_allowlisted/u);
  });

  it("allows Pi JSON and RPC runner launch commands", () => {
    const manifest = generateCapabilityManifest();

    expect(() => enforceCommandPolicy(manifest, "pi --mode json --no-session")).not.toThrow();
    expect(() => enforceCommandPolicy(manifest, "pi --mode rpc")).not.toThrow();
    expect(() => enforceCommandPolicy(manifest, "pi --version")).not.toThrow();
  });

  it("enforces repo write allow and deny path policies", () => {
    const manifest = generateCapabilityManifest({
      repo: {
        writeAllow: ["packages/policy/**"],
        writeDeny: ["packages/policy/fixtures/**"]
      }
    });

    expect(() => enforceWorkspaceWritePolicy(manifest, ["packages/policy/src/index.ts"])).not.toThrow();
    expect(() => enforceWorkspaceWritePolicy(manifest, ["packages/policy/fixtures/secret.txt"]))
      .toThrow(/repo_write_denylisted/u);
    expect(() => enforceWorkspaceWritePolicy(manifest, ["services/api/src/store.ts"]))
      .toThrow(/repo_write_not_allowlisted/u);
    expect(() => enforceWorkspaceWritePolicy(manifest, ["/etc/passwd"])).toThrow(/repo_write_path_escape/u);
  });

  it("checks scheduler capability and cost gates from the same manifest", () => {
    const manifest = generateCapabilityManifest({
      workItem: {
        id: "wi_backend",
        prdId: "prd_1",
        requiredCapabilities: ["backend", "database-migration"],
        budgetUsd: 1
      }
    });

    expect(agentSatisfiesCapabilityManifest({ role: "backend", capabilities: ["database-migration"] }, manifest))
      .toBe(true);
    expect(agentSatisfiesCapabilityManifest({ role: "backend", capabilities: ["api"] }, manifest)).toBe(false);
    expect(isCostWithinCapabilityManifest(manifest, 0.5, 0.49)).toBe(true);
    expect(isCostWithinCapabilityManifest(manifest, 0.5, 0.5)).toBe(false);
  });

  it("projects manifest network policy into egress runtime config without secret values", () => {
    const manifest = generateCapabilityManifest({
      network: {
        allow: ["registry.npmjs.org"]
      },
      security: {
        egressPolicy: {
          allowGitRemotes: false
        }
      }
    });

    const config = applyManifestToEgressPolicyConfig({
      enabled: true,
      allowedHosts: ["example.com"],
      allowGitRemotes: true,
      proxyImage: "node:24-alpine",
      proxyPort: 3128,
      auditLogPath: ".patchpilot/egress-audit.jsonl",
      denyPrivateNetworks: true,
      denyMetadataEndpoints: true
    }, manifest);

    expect(config.allowedHosts).toEqual(expect.arrayContaining(["registry.npmjs.org"]));
    expect(config.allowGitRemotes).toBe(false);
    expect(summarizeCapabilityManifest(manifest).secretValuesStored).toBe(false);
  });

  it("enforces manifest network host policy before egress", () => {
    const manifest = generateCapabilityManifest({
      network: {
        allow: ["api.allowed.test", "*.registry.test"]
      }
    });

    expect(() => enforceNetworkPolicy(manifest, "https://api.allowed.test/v1")).not.toThrow();
    expect(() => enforceNetworkPolicy(manifest, "packages.registry.test:443")).not.toThrow();
    expect(() => enforceNetworkPolicy(manifest, "https://blocked.example/v1")).toThrow(/network_not_allowlisted/u);
    expect(() => enforceNetworkPolicy(manifest, "http://169.254.169.254/latest/meta-data")).toThrow(/network_metadata_denied/u);
    expect(() => enforceNetworkPolicy(manifest, "http://127.0.0.1:8080")).toThrow(/network_private_denied/u);
  });

  it("enforces manifest secret refs without storing secret values", () => {
    const manifest = generateCapabilityManifest({
      workItem: {
        id: "wi_secret",
        prdId: "prd_secret",
        requiredCapabilities: ["secret:ci-token"]
      },
      security: {
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
      }
    });

    expect(() => enforceSecretPolicy(manifest, "ci-token")).not.toThrow();
    expect(() => enforceSecretPolicy(manifest, "prod-token")).toThrow(/secret_not_requested/u);
    expect(JSON.stringify(summarizeCapabilityManifest(manifest))).not.toContain("PATCHPILOT_CI_TOKEN");
  });
});
