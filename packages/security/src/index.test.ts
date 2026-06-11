import { describe, expect, it } from "vitest";
import {
  PatchPilotAuthError,
  assertCanDecideApproval,
  assertCanExportAuditPackage,
  assertCanStartCapabilities,
  knownSecretsFromEnv,
  parsePatchPilotAuthHeaders,
  redactJsonValue,
  redactRecordValues,
  redactSecrets,
  scanSecrets
} from "./index";

const fixtureSecret = "patchpilot_fixture_secret_12345";

describe("RBAC auth policy", () => {
  it("parses explicit user and role headers", () => {
    expect(parsePatchPilotAuthHeaders({
      "x-patchpilot-user": "maintainer-1",
      "x-patchpilot-role": "maintainer"
    })).toEqual({
      userId: "maintainer-1",
      role: "maintainer"
    });

    expect(parsePatchPilotAuthHeaders({})).toBeUndefined();
  });

  it("fails closed for partial or unsupported auth headers", () => {
    expect(() => parsePatchPilotAuthHeaders({ "x-patchpilot-user": "alice" })).toThrow(PatchPilotAuthError);
    expect(() => parsePatchPilotAuthHeaders({
      "x-patchpilot-user": "alice",
      "x-patchpilot-role": "owner"
    })).toThrow(/Unsupported PatchPilot auth role/u);
  });

  it("requires admin authorization for high-risk secret and production data approvals", () => {
    const submitter = { userId: "submitter-1", role: "submitter" as const };
    const reviewer = { userId: "reviewer-1", role: "reviewer" as const };
    const admin = { userId: "admin-1", role: "admin" as const };

    expect(() => assertCanDecideApproval(submitter, { kind: "secret_grant", riskLevel: "high" }))
      .toThrow(PatchPilotAuthError);
    expect(() => assertCanDecideApproval(reviewer, { kind: "production_data_access", riskLevel: "critical" }))
      .toThrow(/requires an admin role/u);
    expect(() => assertCanDecideApproval(admin, { kind: "secret_grant", riskLevel: "high" })).not.toThrow();
  });

  it("protects secret-sensitive and production-data work item starts by capability", () => {
    const maintainer = { userId: "maintainer-1", role: "maintainer" as const };
    const reviewer = { userId: "reviewer-1", role: "reviewer" as const };
    const admin = { userId: "admin-1", role: "admin" as const };

    expect(() => assertCanStartCapabilities(undefined, ["secret:github-ci-token"])).toThrow(PatchPilotAuthError);
    expect(() => assertCanStartCapabilities(maintainer, ["secret:github-ci-token"])).toThrow(/reviewer or admin/u);
    expect(() => assertCanStartCapabilities(reviewer, ["secret:github-ci-token"])).not.toThrow();
    expect(() => assertCanStartCapabilities(reviewer, ["production_data:customer-export"])).toThrow(/admin role/u);
    expect(() => assertCanStartCapabilities(admin, ["production_data:customer-export"])).not.toThrow();
  });

  it("requires admin authorization for audit package export", () => {
    const reviewer = { userId: "reviewer-1", role: "reviewer" as const };
    const admin = { userId: "admin-1", role: "admin" as const };

    expect(() => assertCanExportAuditPackage(undefined)).toThrow(PatchPilotAuthError);
    expect(() => assertCanExportAuditPackage(reviewer)).toThrow(/admin role/u);
    expect(() => assertCanExportAuditPackage(admin)).not.toThrow();
  });
});

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

  it("redacts common PII used in audit exports", () => {
    const result = redactSecrets(
      "Contact alice@example.com at +1 415-555-0134 for customer_ABC123456 evidence."
    );

    expect(result.redacted).toBe(
      "Contact [REDACTED:email] at [REDACTED:phone] for [REDACTED:account-id] evidence."
    );
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "email_address",
      "phone_number",
      "account_identifier"
    ]);
  });

  it("does not corrupt Git SSH remotes while redacting normal emails", () => {
    const scpRemote = "git@github.example.com:org/repo.git";
    const sshRemote = "ssh://git@github.example.com/org/repo.git";
    const result = redactSecrets(
      `Contact alice@example.com after cloning ${scpRemote} or ${sshRemote}.`
    );

    expect(result.redacted).toContain("[REDACTED:email]");
    expect(result.redacted).not.toContain("alice@example.com");
    expect(result.redacted).toContain(scpRemote);
    expect(result.redacted).toContain(sshRemote);
    expect(result.findings.map((finding) => finding.kind)).toEqual(["email_address"]);
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
