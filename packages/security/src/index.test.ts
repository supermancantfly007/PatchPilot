import { describe, expect, it } from "vitest";
import {
  knownSecretsFromEnv,
  redactJsonValue,
  redactRecordValues,
  redactSecrets,
  scanSecrets
} from "./index";

const fixtureSecret = "patchpilot_fixture_secret_12345";

describe("secret redaction", () => {
  it("redacts common secret formats from prompt, log, and diff text", () => {
    const input = [
      `prompt leaked ${fixtureSecret}`,
      "Authorization: Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "DATABASE_URL=postgres://user:db-password@example.com/app",
      "https://example.com/hook?token=secret-token-value&ok=1",
      "npm_TOKEN='npm_1234567890abcdefghijklmnopqrstuvwxyz'"
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.changed).toBe(true);
    expect(result.redacted).not.toContain(fixtureSecret);
    expect(result.redacted).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result.redacted).not.toContain("db-password");
    expect(result.redacted).not.toContain("secret-token-value");
    expect(result.redacted).not.toContain("npm_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result.redacted).toContain("[REDACTED:token]");
    expect(result.findings.length).toBeGreaterThanOrEqual(4);
  });

  it("redacts broker-provided known secret values even when they are short fixtures", () => {
    const result = redactSecrets("test output ci-token-value", {
      knownSecrets: ["ci-token-value"]
    });

    expect(result.redacted).toBe("test output [REDACTED:secret]");
    expect(scanSecrets(result.redacted)).toHaveLength(0);
  });

  it("redacts JSON values and record metadata without hiding secret identifiers", () => {
    const value = redactJsonValue({
      requestedSecretIds: ["github-ci-token"],
      injected: [{ id: "github-ci-token", envVar: "GITHUB_TOKEN", sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN" }],
      command: "echo GITHUB_TOKEN=ci-token-value",
      nested: {
        apiKey: "plain-api-key-value"
      }
    }, { knownSecrets: ["ci-token-value"] });

    expect(value.requestedSecretIds).toEqual(["github-ci-token"]);
    expect(value.injected[0]).toMatchObject({
      id: "github-ci-token",
      envVar: "GITHUB_TOKEN",
      sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN"
    });
    expect(value.command).toBe("echo GITHUB_TOKEN=[REDACTED:secret]");
    expect(value.nested.apiKey).toBe("[REDACTED:secret]");

    expect(redactRecordValues({ command: "TOKEN=abc12345", status: "passed" })).toEqual({
      command: "TOKEN=[REDACTED:secret]",
      status: "passed"
    });
  });

  it("derives known secret values from secret-bearing env keys only", () => {
    expect(knownSecretsFromEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ci-token-value",
      PATCHPILOT_SECRET_KEY: "fixture-key"
    })).toEqual(["ci-token-value", "fixture-key"]);
  });
});
