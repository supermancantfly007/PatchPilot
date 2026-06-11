import { readFileSync } from "node:fs";
import {
  GitHubAppInstallationRepositoryClient,
  GitHubAppInstallationTokenProvider,
  GitHubPullRequestAdapter,
  LocalPullRequestAdapter,
  type PullRequestAdapter
} from "@patchpilot/pull-request-adapter";
import type { RepositoryRecord } from "@patchpilot/domain";
import { readPatchPilotConfig, type PatchPilotConfigEnv, type ResolvedPatchPilotConfig } from "./config";

export function createConfiguredPullRequestAdapter(
  config: ResolvedPatchPilotConfig = readPatchPilotConfig(),
  env: PatchPilotConfigEnv = process.env,
  selectedRepository?: RepositoryRecord
): PullRequestAdapter {
  if (config.pullRequest.provider === "local") return new LocalPullRequestAdapter();

  const github = config.pullRequest.github;
  const owner = selectedRepository?.owner || github.owner;
  const repo = selectedRepository?.name || github.repo;
  if (!owner || !repo) {
    throw new Error("GitHub PR adapter requires PATCHPILOT_GITHUB_OWNER and PATCHPILOT_GITHUB_REPO.");
  }
  const tokenProvider = github.authMode === "app"
    ? createGitHubAppInstallationTokenProvider(config, env, selectedRepository)
    : undefined;
  const token = github.authMode === "token" ? env[github.tokenEnv]?.trim() : undefined;
  if (github.authMode === "token" && !token) throw new Error(`GitHub PR adapter requires ${github.tokenEnv} to be set.`);

  return new GitHubPullRequestAdapter({
    owner,
    repo,
    ...(token ? { token } : {}),
    ...(tokenProvider ? { tokenProvider } : {}),
    remote: github.remote,
    ...(github.headOwner ? { headOwner: github.headOwner } : selectedRepository?.owner ? { headOwner: selectedRepository.owner } : {}),
    ...(github.apiBaseUrl ? { apiBaseUrl: github.apiBaseUrl } : {}),
    pushTimeoutMs: github.pushTimeoutMs
  });
}

export function createConfiguredGitHubAppRepositoryClient(
  config: ResolvedPatchPilotConfig = readPatchPilotConfig(),
  env: PatchPilotConfigEnv = process.env,
  installationId = config.pullRequest.github.installationId
) {
  if (config.pullRequest.github.authMode !== "app") {
    throw new Error("GitHub App repository listing requires pullRequest.github.authMode=app.");
  }
  if (!installationId) throw new Error("GitHub App repository listing requires a GitHub installation id.");
  return new GitHubAppInstallationRepositoryClient({
    installationId,
    tokenProvider: createGitHubAppInstallationTokenProvider(config, env, undefined, installationId),
    ...(config.pullRequest.github.apiBaseUrl ? { apiBaseUrl: config.pullRequest.github.apiBaseUrl } : {})
  });
}

export function readConfiguredGitHubWebhookSecret(
  config: ResolvedPatchPilotConfig = readPatchPilotConfig(),
  env: PatchPilotConfigEnv = process.env
) {
  const secret = env[config.pullRequest.github.webhookSecretEnv]?.trim();
  if (!secret) throw new Error(`GitHub webhook verification requires ${config.pullRequest.github.webhookSecretEnv} to be set.`);
  return secret;
}

function createGitHubAppInstallationTokenProvider(
  config: ResolvedPatchPilotConfig,
  env: PatchPilotConfigEnv,
  selectedRepository?: RepositoryRecord,
  explicitInstallationId?: number
) {
  const github = config.pullRequest.github;
  if (!github.appId) throw new Error("GitHub App auth requires PATCHPILOT_GITHUB_APP_ID.");
  const installationId = explicitInstallationId ?? github.installationId ?? installationIdFromRepository(selectedRepository);
  if (!installationId) throw new Error("GitHub App auth requires PATCHPILOT_GITHUB_INSTALLATION_ID or a selected installation repository.");
  return new GitHubAppInstallationTokenProvider({
    appId: github.appId,
    privateKey: readGitHubAppPrivateKey(config, env),
    installationId,
    permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      metadata: "read"
    },
    ...(selectedRepository ? { repositories: [selectedRepository.name] } : {}),
    ...(github.apiBaseUrl ? { apiBaseUrl: github.apiBaseUrl } : {})
  });
}

function readGitHubAppPrivateKey(config: ResolvedPatchPilotConfig, env: PatchPilotConfigEnv) {
  const github = config.pullRequest.github;
  const fromEnv = env[github.appPrivateKeyEnv]?.trim();
  if (fromEnv) return fromEnv;
  if (github.appPrivateKeyPath) return readFileSync(github.appPrivateKeyPath, "utf8");
  throw new Error(`GitHub App auth requires ${github.appPrivateKeyEnv} or PATCHPILOT_GITHUB_APP_PRIVATE_KEY_PATH.`);
}

function installationIdFromRepository(repository: RepositoryRecord | undefined) {
  if (!repository?.githubInstallationId) return undefined;
  const parsed = Number(repository.githubInstallationId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
