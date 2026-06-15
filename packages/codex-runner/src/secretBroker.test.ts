import { describe, expect, it } from "vitest";
import { generateCapabilityManifest } from "@patchpilot/policy";
import {
  createSecretBrokerProviderRegistry,
  requestedSecretIdsForWorkItem,
  resolveSecretBrokerGrants,
  revokeSecretBrokerGrants,
  rotateSecretBrokerSecret,
  type VaultFetch
} from "./secretBroker";
import type { SecretBrokerRuntimeConfig, WorkItem } from "@patchpilot/domain";

const baseConfig: SecretBrokerRuntimeConfig = {
  enabled: true,
  allowedSecrets: [],
  allowProductionSecrets: false
};
const now = new Date("2026-06-10T12:00:00.000Z");

describe("secret broker", () => {
  it("does not inject configured secrets unless the work item requests them", async () => {
    const resolution = await resolveSecretBrokerGrants({
      config: {
        ...baseConfig,
        allowedSecrets: [
          {
            id: "npm-read-token",
            envVar: "NPM_TOKEN",
            sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
            environment: "ci"
          }
        ]
      },
      workItem: workItem({ requiredCapabilities: ["backend"] }),
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" },
      now
    });

    expect(resolution).toMatchObject({
      authorized: true,
      env: {},
      evidence: {
        requestedSecretIds: [],
        injected: [],
        denied: [],
        revoked: []
      }
    });
  });

  it("injects only explicitly configured dev or CI token requests", async () => {
    const resolution = await resolveSecretBrokerGrants({
      config: {
        ...baseConfig,
        allowedSecrets: [
          {
            id: "npm-read-token",
            envVar: "NPM_TOKEN",
            sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
            environment: "ci",
            ttlSeconds: 60
          }
        ]
      },
      workItem: workItem({ requiredCapabilities: ["secret:npm-read-token", "secret:npm-read-token"] }),
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" },
      now
    });

    expect(requestedSecretIdsForWorkItem(workItem({ requiredCapabilities: ["secret:npm-read-token"] }))).toEqual([
      "npm-read-token"
    ]);
    expect(resolution.authorized).toBe(true);
    expect(resolution.env).toEqual({ NPM_TOKEN: "secret-value" });
    expect(resolution.grants).toMatchObject([{ id: "npm-read-token", envVar: "NPM_TOKEN", provider: "env" }]);
    expect(resolution.evidence).toMatchObject({
      enabled: true,
      mode: "env",
      requestedSecretIds: ["npm-read-token"],
      injected: [
        {
          id: "npm-read-token",
          envVar: "NPM_TOKEN",
          sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
          environment: "ci",
          provider: "env",
          issuedAt: "2026-06-10T12:00:00.000Z",
          expiresAt: "2026-06-10T12:01:00.000Z",
          ttlSeconds: 60,
          renewable: false,
          rotationSupported: false,
          revocationSupported: false
        }
      ],
      denied: [],
      revoked: []
    });
    expect(resolution.evidence.injected[0]?.valueFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(resolution.evidence)).not.toContain("secret-value");
  });

  it("denies unconfigured or unavailable secret requests without partial injection", async () => {
    const resolution = await resolveSecretBrokerGrants({
      config: {
        ...baseConfig,
        allowedSecrets: [
          {
            id: "npm-read-token",
            envVar: "NPM_TOKEN",
            sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
            environment: "ci"
          }
        ]
      },
      workItem: workItem({
        requiredCapabilities: ["secret:npm-read-token", "secret:github-ci-token"]
      }),
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" },
      now
    });

    expect(resolution.authorized).toBe(false);
    expect(resolution.env).toEqual({});
    expect(resolution.evidence.denied).toEqual([{ id: "github-ci-token", reason: "not_configured" }]);
    expect(resolution.evidence.injected).toEqual([]);
  });

  it("requires requested secrets to be allowed by the capability manifest", async () => {
    const resolution = await resolveSecretBrokerGrants({
      config: {
        ...baseConfig,
        allowedSecrets: [
          {
            id: "npm-read-token",
            envVar: "NPM_TOKEN",
            sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
            environment: "ci"
          }
        ]
      },
      workItem: workItem({ requiredCapabilities: ["secret:npm-read-token"] }),
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" },
      now,
      capabilityManifest: {
        ...generateCapabilityManifest({
          workItem: {
            id: "wi_1",
            prdId: "prd_1",
            requiredCapabilities: ["secret:npm-read-token"]
          }
        }),
        secrets: {
          requested: ["npm-read-token"],
          allow: [],
          allowProductionSecrets: false
        }
      }
    });

    expect(resolution.authorized).toBe(false);
    expect(resolution.env).toEqual({});
    expect(resolution.evidence.denied).toEqual([{ id: "npm-read-token", reason: "not_configured" }]);
  });

  it("resolves Vault-compatible grants through broker authorization and supports adapter rotation/revocation", async () => {
    const calls: Array<{ url: string; init?: Parameters<VaultFetch>[1] }> = [];
    const vaultFetch: VaultFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/secret/data/patchpilot/db") && init?.method === "GET") {
        return vaultResponse({
          request_id: "vault-read-request",
          lease_id: "database/creds/patchpilot/lease-1",
          lease_duration: 120,
          renewable: true,
          data: {
            data: {
              token: "vault-secret-value"
            },
            metadata: {
              version: 7
            }
          }
        });
      }
      if (url.endsWith("/v1/database/rotate-role/patchpilot") && init?.method === "POST") {
        return vaultResponse({ request_id: "vault-rotate-request", data: { version: 8 } });
      }
      if (url.endsWith("/v1/sys/leases/revoke") && init?.method === "POST") {
        return vaultResponse({ request_id: "vault-revoke-request" });
      }
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    };
    const providers = createSecretBrokerProviderRegistry({ fetch: vaultFetch });
    const config: SecretBrokerRuntimeConfig = {
      ...baseConfig,
      allowedSecrets: [
        {
          id: "vault-db-token",
          envVar: "DATABASE_TOKEN",
          environment: "ci",
          provider: {
            kind: "vault",
            address: "http://vault.fixture:8200",
            tokenEnv: "PATCHPILOT_TEST_VAULT_TOKEN",
            mount: "secret",
            path: "patchpilot/db",
            key: "token",
            kvVersion: 2,
            rotatePath: "database/rotate-role/patchpilot"
          }
        }
      ]
    };

    const resolution = await resolveSecretBrokerGrants({
      config,
      workItem: workItem({ requiredCapabilities: ["secret:vault-db-token"] }),
      env: { PATCHPILOT_TEST_VAULT_TOKEN: "vault-token" },
      providers,
      now
    });

    expect(resolution.authorized).toBe(true);
    expect(resolution.env).toEqual({ DATABASE_TOKEN: "vault-secret-value" });
    expect(resolution.evidence).toMatchObject({
      mode: "adapter",
      injected: [
        {
          id: "vault-db-token",
          envVar: "DATABASE_TOKEN",
          environment: "ci",
          provider: "vault",
          issuedAt: "2026-06-10T12:00:00.000Z",
          expiresAt: "2026-06-10T12:02:00.000Z",
          ttlSeconds: 120,
          renewable: true,
          rotationSupported: true,
          revocationSupported: true,
          providerAuditId: "vault-read-request"
        }
      ]
    });
    expect(JSON.stringify(resolution.evidence)).not.toContain("vault-secret-value");

    const rotated = await rotateSecretBrokerSecret({
      config,
      secretId: "vault-db-token",
      env: { PATCHPILOT_TEST_VAULT_TOKEN: "vault-token" },
      providers,
      now: new Date("2026-06-10T12:01:00.000Z")
    });
    expect(rotated).toMatchObject({
      id: "vault-db-token",
      provider: "vault",
      action: "rotate",
      status: "succeeded",
      rotationVersion: "8",
      providerAuditId: "vault-rotate-request"
    });

    const revoked = await revokeSecretBrokerGrants({
      config,
      grants: resolution.grants,
      env: { PATCHPILOT_TEST_VAULT_TOKEN: "vault-token" },
      providers,
      now: new Date("2026-06-10T12:02:00.000Z")
    });
    expect(revoked).toEqual([
      expect.objectContaining({
        id: "vault-db-token",
        provider: "vault",
        action: "revoke",
        status: "succeeded",
        providerAuditId: "vault-revoke-request"
      })
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "http://vault.fixture:8200/v1/secret/data/patchpilot/db",
      "http://vault.fixture:8200/v1/database/rotate-role/patchpilot",
      "http://vault.fixture:8200/v1/sys/leases/revoke"
    ]);
    expect(calls[2]?.init?.body).toBe(JSON.stringify({ lease_id: "database/creds/patchpilot/lease-1" }));
  });
});

function workItem(input: Pick<WorkItem, "requiredCapabilities">): Pick<WorkItem, "requiredCapabilities"> {
  return input;
}

function vaultResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body
  };
}
