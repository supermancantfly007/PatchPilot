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
  containerSandbox:
    enabled: true
    runtime: docker
    image: patchpilot/sandbox:test
    cpus: 1.5
    memoryMb: 512
    workspaceDiskMb: 1024
    tmpfsMb: 64
    pidsLimit: 128
    uid: 1001
    gid: 1002
  egressPolicy:
    enabled: true
    allowedHosts:
      - registry.npmjs.org
      - api.openai.com
    allowGitRemotes: false
    proxyImage: patchpilot/egress-proxy:test
    proxyPort: 43128
    auditLogPath: .patchpilot/custom-egress-audit.jsonl
  secretBroker:
    enabled: true
    allowedSecrets:
      - id: npm-read-token
        envVar: NPM_TOKEN
        sourceEnv: PATCHPILOT_DEV_NPM_TOKEN
        environment: ci
        description: Fixture npm read-only token
      - id: fake-package-token
        envVar: PACKAGE_TOKEN
        environment: ci
        ttlSeconds: 120
        provider:
          kind: local_fake
          seedEnv: PATCHPILOT_FAKE_SECRET_SEED
      - id: vault-db-token
        envVar: DATABASE_TOKEN
        environment: ci
        provider:
          kind: vault
          address: http://vault.fixture:8200/
          tokenEnv: PATCHPILOT_VAULT_TOKEN
          mount: /secret/
          path: /patchpilot/db/
          key: token
          kvVersion: 2
          namespaceEnv: PATCHPILOT_VAULT_NAMESPACE
          ttlSeconds: 600
          rotatePath: /sys/rotate/db/
          revokePath: /sys/revoke/db/
budget:
  codexTimeoutMs: 123000
  maxCostUsd: 4.5
  workItemUsd: 1.25
  runUsd: 0.75
  softThresholdRatio: 0.6
artifacts:
  provider: s3
  localRoot: .patchpilot/artifacts-fixture
  s3:
    endpoint: http://minio.fixture:9000
    region: us-west-2
    bucket: patchpilot-fixture
    accessKeyId: fixture-access
    secretAccessKey: fixture-secret
    forcePathStyle: false
    prefix: fixture-prefix
pullRequest:
  provider: github
  github:
    owner: patchpilot-fixtures
    repo: delivery
    remote: upstream
    headOwner: patchpilot-fork
    tokenEnv: PATCHPILOT_FIXTURE_GITHUB_TOKEN
    authMode: app
    appId: "12345"
    appPrivateKeyEnv: PATCHPILOT_FIXTURE_GITHUB_APP_PRIVATE_KEY
    appPrivateKeyPath: .patchpilot/github-app.pem
    installationId: 98765
    webhookSecretEnv: PATCHPILOT_FIXTURE_GITHUB_WEBHOOK_SECRET
    apiBaseUrl: https://github.fixture/api/v3
    pushTimeoutMs: 45000
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
      expect(config.security).toEqual({
        codexSandbox: "read-only",
        codexBypass: false,
        containerSandbox: {
          enabled: true,
          runtime: "docker",
          image: "patchpilot/sandbox:test",
          cpus: 1.5,
          memoryMb: 512,
          workspaceDiskMb: 1024,
          tmpfsMb: 64,
          pidsLimit: 128,
          uid: 1001,
          gid: 1002
        },
        egressPolicy: {
          enabled: true,
          allowedHosts: ["registry.npmjs.org", "api.openai.com"],
          allowGitRemotes: false,
          proxyImage: "patchpilot/egress-proxy:test",
          proxyPort: 43128,
          auditLogPath: ".patchpilot/custom-egress-audit.jsonl",
          denyPrivateNetworks: true,
          denyMetadataEndpoints: true
        },
        secretBroker: {
          enabled: true,
          allowedSecrets: [
            {
              id: "npm-read-token",
              envVar: "NPM_TOKEN",
              sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN",
              environment: "ci",
              description: "Fixture npm read-only token",
              provider: {
                kind: "env",
                sourceEnv: "PATCHPILOT_DEV_NPM_TOKEN"
              }
            },
            {
              id: "fake-package-token",
              envVar: "PACKAGE_TOKEN",
              environment: "ci",
              ttlSeconds: 120,
              provider: {
                kind: "local_fake",
                seedEnv: "PATCHPILOT_FAKE_SECRET_SEED"
              }
            },
            {
              id: "vault-db-token",
              envVar: "DATABASE_TOKEN",
              environment: "ci",
              provider: {
                kind: "vault",
                address: "http://vault.fixture:8200",
                tokenEnv: "PATCHPILOT_VAULT_TOKEN",
                mount: "secret",
                path: "patchpilot/db",
                key: "token",
                kvVersion: 2,
                namespaceEnv: "PATCHPILOT_VAULT_NAMESPACE",
                ttlSeconds: 600,
                rotatePath: "sys/rotate/db",
                revokePath: "sys/revoke/db"
              }
            }
          ],
          allowProductionSecrets: false
        }
      });
      expect(config.budget).toEqual({
        codexTimeoutMs: 123000,
        maxCostUsd: 4.5,
        prdUsd: 4.5,
        workItemUsd: 1.25,
        runUsd: 0.75,
        softThresholdRatio: 0.6
      });
      expect(config.artifacts).toEqual({
        provider: "s3",
        localRoot: join(fixture.root, ".patchpilot", "artifacts-fixture"),
        s3: {
          endpoint: "http://minio.fixture:9000",
          region: "us-west-2",
          bucket: "patchpilot-fixture",
          accessKeyId: "fixture-access",
          secretAccessKey: "fixture-secret",
          forcePathStyle: false,
          prefix: "fixture-prefix"
        }
      });
      expect(config.pullRequest).toEqual({
        provider: "github",
        github: {
          owner: "patchpilot-fixtures",
          repo: "delivery",
          remote: "upstream",
          headOwner: "patchpilot-fork",
          tokenEnv: "PATCHPILOT_FIXTURE_GITHUB_TOKEN",
          authMode: "app",
          appId: "12345",
          appPrivateKeyEnv: "PATCHPILOT_FIXTURE_GITHUB_APP_PRIVATE_KEY",
          appPrivateKeyPath: join(fixture.root, ".patchpilot", "github-app.pem"),
          installationId: 98765,
          webhookSecretEnv: "PATCHPILOT_FIXTURE_GITHUB_WEBHOOK_SECRET",
          apiBaseUrl: "https://github.fixture/api/v3",
          pushTimeoutMs: 45000
        }
      });
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
          PATCHPILOT_CODEX_BYPASS: "true",
          PATCHPILOT_CONTAINER_SANDBOX_ENABLED: "true",
          PATCHPILOT_CONTAINER_SANDBOX_RUNTIME: "podman",
          PATCHPILOT_CONTAINER_SANDBOX_IMAGE: "patchpilot/sandbox:env",
          PATCHPILOT_CONTAINER_SANDBOX_CPUS: "0.5",
          PATCHPILOT_CONTAINER_SANDBOX_MEMORY_MB: "256",
          PATCHPILOT_CONTAINER_SANDBOX_WORKSPACE_DISK_MB: "512",
          PATCHPILOT_CONTAINER_SANDBOX_TMPFS_MB: "32",
          PATCHPILOT_CONTAINER_SANDBOX_PIDS_LIMIT: "64",
          PATCHPILOT_CONTAINER_SANDBOX_UID: "1003",
          PATCHPILOT_CONTAINER_SANDBOX_GID: "1004",
          PATCHPILOT_EGRESS_POLICY_ENABLED: "true",
          PATCHPILOT_EGRESS_ALLOWED_HOSTS: "registry.npmjs.org,api.openai.com",
          PATCHPILOT_EGRESS_ALLOW_GIT_REMOTES: "false",
          PATCHPILOT_EGRESS_PROXY_IMAGE: "patchpilot/egress-proxy:env",
          PATCHPILOT_EGRESS_PROXY_PORT: "43129",
          PATCHPILOT_EGRESS_AUDIT_LOG_PATH: ".patchpilot/env-egress-audit.jsonl",
          PATCHPILOT_SECRET_BROKER_ENABLED: "true",
          PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS: JSON.stringify([
            {
              id: "github-ci-token",
              envVar: "GITHUB_TOKEN",
              sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN",
              environment: "ci"
            }
          ]),
          PATCHPILOT_BUDGET_MAX_COST_USD: "6",
          PATCHPILOT_BUDGET_WORK_ITEM_USD: "3.25",
          PATCHPILOT_BUDGET_RUN_USD: "1.5",
          PATCHPILOT_BUDGET_SOFT_THRESHOLD_RATIO: "0.7",
          PATCHPILOT_ARTIFACT_STORE: "s3",
          PATCHPILOT_ARTIFACT_ROOT: ".patchpilot/artifacts-env",
          PATCHPILOT_ARTIFACT_S3_ENDPOINT: "http://minio.env:9000",
          PATCHPILOT_ARTIFACT_S3_REGION: "eu-central-1",
          PATCHPILOT_ARTIFACT_S3_BUCKET: "patchpilot-env",
          PATCHPILOT_ARTIFACT_S3_ACCESS_KEY_ID: "env-access",
          PATCHPILOT_ARTIFACT_S3_SECRET_ACCESS_KEY: "env-secret",
          PATCHPILOT_ARTIFACT_S3_FORCE_PATH_STYLE: "false",
          PATCHPILOT_ARTIFACT_S3_PREFIX: "env-prefix",
          PATCHPILOT_PR_PROVIDER: "github",
          PATCHPILOT_GITHUB_OWNER: "env-owner",
          PATCHPILOT_GITHUB_REPO: "env-repo",
          PATCHPILOT_GITHUB_REMOTE: "env-remote",
          PATCHPILOT_GITHUB_HEAD_OWNER: "env-head-owner",
          PATCHPILOT_GITHUB_TOKEN_ENV: "PATCHPILOT_ENV_GITHUB_TOKEN",
          PATCHPILOT_GITHUB_AUTH_MODE: "app",
          PATCHPILOT_GITHUB_APP_ID: "24680",
          PATCHPILOT_GITHUB_APP_PRIVATE_KEY_ENV: "PATCHPILOT_ENV_GITHUB_APP_PRIVATE_KEY",
          PATCHPILOT_GITHUB_APP_PRIVATE_KEY_PATH: ".patchpilot/env-github-app.pem",
          PATCHPILOT_GITHUB_INSTALLATION_ID: "13579",
          PATCHPILOT_GITHUB_WEBHOOK_SECRET_ENV: "PATCHPILOT_ENV_GITHUB_WEBHOOK_SECRET",
          PATCHPILOT_GITHUB_API_BASE_URL: "https://github.env/api/v3",
          PATCHPILOT_GITHUB_PUSH_TIMEOUT_MS: "65000"
        }
      });

      expect(config.test.command).toBe("pnpm test:from-env");
      expect(config.dev.previewUrl).toBe("http://from-env.local");
      expect(config.dev.runner).toBe("simulated");
      expect(config.security.codexBypass).toBe(true);
      expect(config.security.containerSandbox).toEqual({
        enabled: true,
        runtime: "podman",
        image: "patchpilot/sandbox:env",
        cpus: 0.5,
        memoryMb: 256,
        workspaceDiskMb: 512,
        tmpfsMb: 32,
        pidsLimit: 64,
        uid: 1003,
        gid: 1004
      });
      expect(config.security.egressPolicy).toEqual({
        enabled: true,
        allowedHosts: ["registry.npmjs.org", "api.openai.com"],
        allowGitRemotes: false,
        proxyImage: "patchpilot/egress-proxy:env",
        proxyPort: 43129,
        auditLogPath: ".patchpilot/env-egress-audit.jsonl",
        denyPrivateNetworks: true,
        denyMetadataEndpoints: true
      });
      expect(config.security.secretBroker).toEqual({
        enabled: true,
        allowedSecrets: [
          {
            id: "github-ci-token",
            envVar: "GITHUB_TOKEN",
            sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN",
            environment: "ci",
            provider: {
              kind: "env",
              sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN"
            }
          }
        ],
        allowProductionSecrets: false
      });
      expect(config.test.timeoutMs).toBe(120000);
      expect(config.budget.codexTimeoutMs).toBe(600000);
      expect(config.budget.maxCostUsd).toBe(6);
      expect(config.budget.prdUsd).toBe(6);
      expect(config.budget.workItemUsd).toBe(3.25);
      expect(config.budget.runUsd).toBe(1.5);
      expect(config.budget.softThresholdRatio).toBe(0.7);
      expect(config.artifacts).toEqual({
        provider: "s3",
        localRoot: ".patchpilot/artifacts-env",
        s3: {
          endpoint: "http://minio.env:9000",
          region: "eu-central-1",
          bucket: "patchpilot-env",
          accessKeyId: "env-access",
          secretAccessKey: "env-secret",
          forcePathStyle: false,
          prefix: "env-prefix"
        }
      });
      expect(config.pullRequest).toEqual({
        provider: "github",
        github: {
          owner: "env-owner",
          repo: "env-repo",
          remote: "env-remote",
          headOwner: "env-head-owner",
          tokenEnv: "PATCHPILOT_ENV_GITHUB_TOKEN",
          authMode: "app",
          appId: "24680",
          appPrivateKeyEnv: "PATCHPILOT_ENV_GITHUB_APP_PRIVATE_KEY",
          appPrivateKeyPath: ".patchpilot/env-github-app.pem",
          installationId: 13579,
          webhookSecretEnv: "PATCHPILOT_ENV_GITHUB_WEBHOOK_SECRET",
          apiBaseUrl: "https://github.env/api/v3",
          pushTimeoutMs: 65000
        }
      });
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
