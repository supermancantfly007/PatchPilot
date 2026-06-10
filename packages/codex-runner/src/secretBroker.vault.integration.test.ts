import { describe, expect, it } from "vitest";
import { generateCapabilityManifest } from "@patchpilot/policy";
import { resolveSecretBrokerGrants, revokeSecretBrokerGrants, rotateSecretBrokerSecret } from "./secretBroker";
import type { SecretBrokerRuntimeConfig } from "@patchpilot/domain";

const requiredEnv = [
  "PATCHPILOT_TEST_VAULT_ADDR",
  "PATCHPILOT_TEST_VAULT_TOKEN",
  "PATCHPILOT_TEST_VAULT_MOUNT",
  "PATCHPILOT_TEST_VAULT_PATH",
  "PATCHPILOT_TEST_VAULT_KEY"
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]?.trim());
const describeVault = missingEnv.length === 0 ? describe : describe.skip;

describeVault(`vault secret broker integration${missingEnv.length > 0 ? ` (requires ${requiredEnv.join(", ")})` : ""}`, () => {
  it("resolves a Vault secret through the broker without persisting its value", async () => {
    const config = vaultIntegrationConfig();
    const workItem = { requiredCapabilities: ["secret:vault-integration-token"] };
    const resolution = await resolveSecretBrokerGrants({
      config,
      workItem,
      env: process.env,
      capabilityManifest: generateCapabilityManifest({
        workItem: {
          id: "wi_vault_integration",
          prdId: "prd_vault_integration",
          requiredCapabilities: workItem.requiredCapabilities
        }
      })
    });

    expect(resolution.authorized).toBe(true);
    expect(resolution.env.PATCHPILOT_VAULT_INTEGRATION_TOKEN).toBeTruthy();
    expect(resolution.evidence.injected[0]).toMatchObject({
      id: "vault-integration-token",
      envVar: "PATCHPILOT_VAULT_INTEGRATION_TOKEN",
      provider: "vault"
    });
    expect(JSON.stringify(resolution.evidence)).not.toContain(
      resolution.env.PATCHPILOT_VAULT_INTEGRATION_TOKEN
    );

    if (process.env.PATCHPILOT_TEST_VAULT_ROTATE_PATH?.trim()) {
      const rotation = await rotateSecretBrokerSecret({
        config,
        secretId: "vault-integration-token",
        env: process.env
      });
      expect(rotation.status).toBe("succeeded");
    }

    const revocation = await revokeSecretBrokerGrants({
      config,
      grants: resolution.grants,
      env: process.env
    });
    expect(revocation.every((item) => item.status === "succeeded" || item.status === "unsupported")).toBe(true);
  });
});

function vaultIntegrationConfig(): SecretBrokerRuntimeConfig {
  return {
    enabled: true,
    allowedSecrets: [
      {
        id: "vault-integration-token",
        envVar: "PATCHPILOT_VAULT_INTEGRATION_TOKEN",
        environment: "ci",
        provider: {
          kind: "vault",
          address: requiredEnvValue("PATCHPILOT_TEST_VAULT_ADDR"),
          tokenEnv: "PATCHPILOT_TEST_VAULT_TOKEN",
          mount: requiredEnvValue("PATCHPILOT_TEST_VAULT_MOUNT"),
          path: requiredEnvValue("PATCHPILOT_TEST_VAULT_PATH"),
          key: requiredEnvValue("PATCHPILOT_TEST_VAULT_KEY"),
          kvVersion: process.env.PATCHPILOT_TEST_VAULT_KV_VERSION === "1" ? 1 : 2,
          ...(process.env.PATCHPILOT_TEST_VAULT_NAMESPACE?.trim()
            ? { namespaceEnv: "PATCHPILOT_TEST_VAULT_NAMESPACE" }
            : {}),
          ...(process.env.PATCHPILOT_TEST_VAULT_ROTATE_PATH?.trim()
            ? { rotatePath: process.env.PATCHPILOT_TEST_VAULT_ROTATE_PATH.trim() }
            : {}),
          ...(process.env.PATCHPILOT_TEST_VAULT_REVOKE_PATH?.trim()
            ? { revokePath: process.env.PATCHPILOT_TEST_VAULT_REVOKE_PATH.trim() }
            : {})
        }
      }
    ],
    allowProductionSecrets: false
  };
}

function requiredEnvValue(key: string) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required Vault integration env var: ${key}`);
  return value;
}
