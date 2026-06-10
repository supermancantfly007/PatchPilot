import { describe, expect, it } from "vitest";
import { requestedSecretIdsForWorkItem, resolveSecretBrokerGrants } from "./secretBroker";
import type { SecretBrokerRuntimeConfig, WorkItem } from "@patchpilot/domain";

const baseConfig: SecretBrokerRuntimeConfig = {
  enabled: true,
  allowedSecrets: [],
  allowProductionSecrets: false
};

describe("secret broker", () => {
  it("does not inject configured secrets unless the work item requests them", () => {
    const resolution = resolveSecretBrokerGrants({
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
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" }
    });

    expect(resolution).toMatchObject({
      authorized: true,
      env: {},
      evidence: {
        requestedSecretIds: [],
        injected: [],
        denied: []
      }
    });
  });

  it("injects only explicitly configured dev or CI token requests", () => {
    const resolution = resolveSecretBrokerGrants({
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
      workItem: workItem({ requiredCapabilities: ["secret:npm-read-token", "secret:npm-read-token"] }),
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" }
    });

    expect(requestedSecretIdsForWorkItem(workItem({ requiredCapabilities: ["secret:npm-read-token"] }))).toEqual([
      "npm-read-token"
    ]);
    expect(resolution.authorized).toBe(true);
    expect(resolution.env).toEqual({ NPM_TOKEN: "secret-value" });
    expect(resolution.evidence).toEqual({
      enabled: true,
      mode: "env",
      requestedSecretIds: ["npm-read-token"],
      injected: [
        {
          id: "npm-read-token",
          envVar: "NPM_TOKEN",
          sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
          environment: "ci"
        }
      ],
      denied: []
    });
    expect(JSON.stringify(resolution.evidence)).not.toContain("secret-value");
  });

  it("denies unconfigured or unavailable secret requests without partial injection", () => {
    const resolution = resolveSecretBrokerGrants({
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
      env: { PATCHPILOT_DEV_NPM_TOKEN: "secret-value" }
    });

    expect(resolution.authorized).toBe(false);
    expect(resolution.env).toEqual({});
    expect(resolution.evidence.denied).toEqual([{ id: "github-ci-token", reason: "not_configured" }]);
    expect(resolution.evidence.injected).toEqual([]);
  });
});

function workItem(input: Pick<WorkItem, "requiredCapabilities">): Pick<WorkItem, "requiredCapabilities"> {
  return input;
}
