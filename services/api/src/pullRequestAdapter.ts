import {
  GitHubPullRequestAdapter,
  LocalPullRequestAdapter,
  type PullRequestAdapter
} from "@patchpilot/pull-request-adapter";
import { readPatchPilotConfig, type PatchPilotConfigEnv, type ResolvedPatchPilotConfig } from "./config";

export function createConfiguredPullRequestAdapter(
  config: ResolvedPatchPilotConfig = readPatchPilotConfig(),
  env: PatchPilotConfigEnv = process.env
): PullRequestAdapter {
  if (config.pullRequest.provider === "local") return new LocalPullRequestAdapter();

  const github = config.pullRequest.github;
  if (!github.owner || !github.repo) {
    throw new Error("GitHub PR adapter requires PATCHPILOT_GITHUB_OWNER and PATCHPILOT_GITHUB_REPO.");
  }
  const token = env[github.tokenEnv]?.trim();
  if (!token) {
    throw new Error(`GitHub PR adapter requires ${github.tokenEnv} to be set.`);
  }

  return new GitHubPullRequestAdapter({
    owner: github.owner,
    repo: github.repo,
    token,
    remote: github.remote,
    ...(github.headOwner ? { headOwner: github.headOwner } : {}),
    ...(github.apiBaseUrl ? { apiBaseUrl: github.apiBaseUrl } : {}),
    pushTimeoutMs: github.pushTimeoutMs
  });
}
