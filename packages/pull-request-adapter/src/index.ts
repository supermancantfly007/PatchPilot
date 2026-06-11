import { spawn } from "node:child_process";
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { GitHubAppPermissionLevel, PullRequestRecord, PullRequestStatus } from "@patchpilot/domain";

export interface PullRequestDraft {
  id: string;
  status: PullRequestStatus;
  title: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  runId: string;
  repositoryId?: string;
  repositoryFullName?: string;
  branchName: string;
  baseBranch: string;
  baseCommit?: string;
  headCommit?: string;
  bodyMarkdown: string;
  reviewerSummary: string;
  testSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPullRequestInput {
  draft: PullRequestDraft;
  existing?: PullRequestRecord;
  workspacePath?: string;
}

export interface PullRequestCheckRun {
  name: string;
  status: string;
  conclusion?: string | null;
  url?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface PullRequestCheckSummary {
  status: "passed" | "failed" | "pending" | "skipped";
  totalCount: number;
  runs: PullRequestCheckRun[];
}

export interface ReadPullRequestChecksInput {
  pullRequest: PullRequestRecord;
}

export interface WriteReviewerCommentInput {
  pullRequest: PullRequestRecord;
  body: string;
}

export interface ReviewerCommentResult {
  id: string;
  url: string;
}

export interface PullRequestAdapter {
  readonly provider: PullRequestRecord["provider"];
  upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequestRecord>;
  readChecks(input: ReadPullRequestChecksInput): Promise<PullRequestCheckSummary>;
  writeReviewerComment(input: WriteReviewerCommentInput): Promise<ReviewerCommentResult | undefined>;
}

export interface GitPushInput {
  cwd: string;
  remote: string;
  branchName: string;
  timeoutMs: number;
}

export interface GitPushResult {
  output: string;
}

export interface GitCommandRunner {
  pushBranch(input: GitPushInput): Promise<GitPushResult>;
}

export class ShellGitCommandRunner implements GitCommandRunner {
  async pushBranch(input: GitPushInput): Promise<GitPushResult> {
    const refspec = `${input.branchName}:${input.branchName}`;
    const result = await runGit(["push", "--porcelain", input.remote, refspec], input.cwd, input.timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to push ${input.branchName} to ${input.remote}: ${tail(result.output, 1600)}`);
    }
    return { output: result.output };
  }
}

export class LocalPullRequestAdapter implements PullRequestAdapter {
  readonly provider = "local" as const;

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequestRecord> {
    const { draft, existing } = input;
    return {
      ...draft,
      id: existing?.id ?? draft.id,
      provider: "local",
      url: existing?.url ?? `local://pull-requests/${draft.runId}`,
      createdAt: existing?.createdAt ?? draft.createdAt
    };
  }

  async readChecks(_input: ReadPullRequestChecksInput): Promise<PullRequestCheckSummary> {
    return { status: "skipped", totalCount: 0, runs: [] };
  }

  async writeReviewerComment(_input: WriteReviewerCommentInput): Promise<ReviewerCommentResult | undefined> {
    return undefined;
  }
}

export interface GitHubPullRequestAdapterConfig {
  owner: string;
  repo: string;
  token?: string;
  tokenProvider?: GitHubTokenProvider;
  apiBaseUrl?: string;
  remote?: string;
  headOwner?: string;
  pushTimeoutMs?: number;
  octokit?: GitHubOctokitClient;
  git?: GitCommandRunner;
}

export class GitHubPullRequestAdapter implements PullRequestAdapter {
  readonly provider = "github" as const;
  private readonly owner: string;
  private readonly repo: string;
  private readonly remote: string;
  private readonly headOwner: string;
  private readonly pushTimeoutMs: number;
  private readonly apiBaseUrl?: string;
  private readonly octokit?: GitHubOctokitClient;
  private readonly tokenProvider?: GitHubTokenProvider;
  private readonly git: GitCommandRunner;

  constructor(config: GitHubPullRequestAdapterConfig) {
    this.owner = requireNonEmpty(config.owner, "GitHub owner");
    this.repo = requireNonEmpty(config.repo, "GitHub repo");
    this.remote = config.remote?.trim() || "origin";
    this.headOwner = config.headOwner?.trim() || this.owner;
    this.pushTimeoutMs = config.pushTimeoutMs ?? 30000;
    this.apiBaseUrl = config.apiBaseUrl;
    this.git = config.git ?? new ShellGitCommandRunner();
    this.octokit = config.octokit;
    this.tokenProvider = config.tokenProvider ?? (config.token ? new StaticGitHubTokenProvider(config.token) : undefined);
  }

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequestRecord> {
    const { draft, existing } = input;
    if (!input.workspacePath) {
      throw new Error("GitHub PR adapter requires a local workspacePath so it can push the source branch.");
    }

    await this.git.pushBranch({
      cwd: input.workspacePath,
      remote: this.remote,
      branchName: draft.branchName,
      timeoutMs: this.pushTimeoutMs
    });

    const octokit = await this.getOctokit();
    const currentPullRequest = await this.findPullRequest(octokit, draft, existing);
    const pullRequest = currentPullRequest
      ? (await octokit.rest.pulls.update({
          owner: this.owner,
          repo: this.repo,
          pull_number: currentPullRequest.number,
          title: draft.title,
          body: draft.bodyMarkdown,
          base: draft.baseBranch
        })).data
      : (await octokit.rest.pulls.create({
          owner: this.owner,
          repo: this.repo,
          title: draft.title,
          body: draft.bodyMarkdown,
          head: this.formatHeadForCreate(draft.branchName),
          base: draft.baseBranch,
          draft: draft.status === "draft",
          maintainer_can_modify: true
        })).data;

    return {
      ...draft,
      id: existing?.provider === "github" ? existing.id : githubPullRequestId(this.owner, this.repo, pullRequest.number),
      provider: "github",
      status: mapGitHubPullRequestStatus(pullRequest),
      url: pullRequest.html_url,
      createdAt: existing?.provider === "github" ? existing.createdAt : draft.createdAt,
      updatedAt: draft.updatedAt
    };
  }

  async readChecks(input: ReadPullRequestChecksInput): Promise<PullRequestCheckSummary> {
    const ref = input.pullRequest.headCommit || input.pullRequest.branchName;
    const octokit = await this.getOctokit();
    const response = await octokit.rest.checks.listForRef({
      owner: this.owner,
      repo: this.repo,
      ref,
      per_page: 100
    });
    const runs = response.data.check_runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      startedAt: run.started_at,
      completedAt: run.completed_at
    }));
    return {
      status: summarizeCheckRuns(runs),
      totalCount: response.data.total_count,
      runs
    };
  }

  async writeReviewerComment(input: WriteReviewerCommentInput): Promise<ReviewerCommentResult> {
    const pullNumber = parseGitHubPullNumber(input.pullRequest, this.owner, this.repo);
    if (!pullNumber) {
      throw new Error(`Cannot determine GitHub pull request number from ${input.pullRequest.id} / ${input.pullRequest.url}`);
    }
    const octokit = await this.getOctokit();
    const response = await octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: pullNumber,
      body: input.body
    });
    return {
      id: String(response.data.id),
      url: response.data.html_url
    };
  }

  private async findPullRequest(
    octokit: GitHubOctokitClient,
    draft: PullRequestDraft,
    existing?: PullRequestRecord
  ): Promise<GitHubPullRequest | undefined> {
    const pullNumber = existing ? parseGitHubPullNumber(existing, this.owner, this.repo) : undefined;
    if (pullNumber) {
      const response = await octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber
      });
      return response.data;
    }

    const response = await octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: this.formatHeadForList(draft.branchName),
      base: draft.baseBranch,
      per_page: 10
    });
    return response.data[0];
  }

  private formatHeadForCreate(branchName: string) {
    return this.headOwner === this.owner ? branchName : `${this.headOwner}:${branchName}`;
  }

  private formatHeadForList(branchName: string) {
    return `${this.headOwner}:${branchName}`;
  }

  private async getOctokit() {
    if (this.octokit) return this.octokit;
    if (!this.tokenProvider) {
      throw new Error("GitHub PR adapter requires a token, token provider, or an injected Octokit client.");
    }
    return createOctokitForToken(await this.tokenProvider.getToken(), this.apiBaseUrl);
  }
}

export interface GitHubTokenProvider {
  getToken(): Promise<string>;
}

export class StaticGitHubTokenProvider implements GitHubTokenProvider {
  constructor(private readonly token: string) {}

  async getToken() {
    return this.token;
  }
}

export interface GitHubAppInstallationTokenProviderConfig {
  appId: string | number;
  privateKey: string;
  installationId: number;
  apiBaseUrl?: string;
  permissions?: Record<string, GitHubAppPermissionLevel | string>;
  repositories?: string[];
  octokit?: GitHubRequestClient;
  now?: () => Date;
}

export class GitHubAppInstallationTokenProvider implements GitHubTokenProvider {
  private cachedToken: { token: string; expiresAt: number } | undefined;
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly installationId: number;
  private readonly apiBaseUrl?: string;
  private readonly permissions?: Record<string, GitHubAppPermissionLevel | string>;
  private readonly repositories?: string[];
  private readonly octokit?: GitHubRequestClient;
  private readonly now: () => Date;

  constructor(config: GitHubAppInstallationTokenProviderConfig) {
    this.appId = requireNonEmpty(String(config.appId), "GitHub App id");
    this.privateKey = normalizePrivateKey(requireNonEmpty(config.privateKey, "GitHub App private key"));
    this.installationId = config.installationId;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissions = config.permissions;
    this.repositories = config.repositories;
    this.octokit = config.octokit;
    this.now = config.now ?? (() => new Date());
  }

  async getToken() {
    const nowMs = this.now().getTime();
    if (this.cachedToken && this.cachedToken.expiresAt - nowMs > 60_000) return this.cachedToken.token;
    const appOctokit = this.octokit ?? createAppOctokit(this.appId, this.privateKey, this.apiBaseUrl, this.now);
    const response = await appOctokit.request<GitHubInstallationAccessTokenResponse>(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: this.installationId,
        ...(this.permissions ? { permissions: this.permissions } : {}),
        ...(this.repositories ? { repositories: this.repositories } : {})
      }
    );
    this.cachedToken = {
      token: response.data.token,
      expiresAt: Date.parse(response.data.expires_at)
    };
    return response.data.token;
  }
}

export interface GitHubAppRepository {
  id: string;
  githubRepositoryId: string;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  permissions: Record<string, boolean>;
}

export interface GitHubAppInstallationRepositoryClientConfig {
  installationId: number;
  token?: string;
  tokenProvider?: GitHubTokenProvider;
  apiBaseUrl?: string;
  octokit?: GitHubRequestClient;
}

export class GitHubAppInstallationRepositoryClient {
  private readonly installationId: number;
  private readonly tokenProvider?: GitHubTokenProvider;
  private readonly apiBaseUrl?: string;
  private readonly octokit?: GitHubRequestClient;

  constructor(config: GitHubAppInstallationRepositoryClientConfig) {
    this.installationId = config.installationId;
    this.tokenProvider = config.tokenProvider ?? (config.token ? new StaticGitHubTokenProvider(config.token) : undefined);
    this.apiBaseUrl = config.apiBaseUrl;
    this.octokit = config.octokit;
  }

  async listRepositories(): Promise<GitHubAppRepository[]> {
    const octokit = await this.getOctokit();
    const response = await octokit.request<GitHubInstallationRepositoriesResponse>(
      "GET /installation/repositories",
      { per_page: 100 }
    );
    return response.data.repositories.map((repository) => mapGitHubAppRepository(repository, this.installationId));
  }

  private async getOctokit() {
    if (this.octokit) return this.octokit;
    if (!this.tokenProvider) {
      throw new Error("GitHub App repository client requires a token, token provider, or injected Octokit client.");
    }
    return createRequestOctokit(await this.tokenProvider.getToken(), this.apiBaseUrl);
  }
}

export function githubPullRequestId(owner: string, repo: string, pullNumber: number) {
  return `github://${owner}/${repo}/pull/${pullNumber}`;
}

export function parseGitHubPullNumber(
  pullRequest: Pick<PullRequestRecord, "id" | "url">,
  owner?: string,
  repo?: string
) {
  const candidates = [pullRequest.url, pullRequest.id];
  for (const candidate of candidates) {
    const parsed = parseGitHubPullNumberFromText(candidate, owner, repo);
    if (parsed) return parsed;
  }
  return undefined;
}

export function createGitHubAppJwt(input: {
  appId: string | number;
  privateKey: string;
  now?: Date;
}) {
  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: String(input.appId)
  });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(normalizePrivateKey(input.privateKey), "base64url");
  return `${unsigned}.${signature}`;
}

export function verifyGitHubWebhookSignature(input: {
  payload: string | Buffer;
  signature: string | undefined;
  secret: string;
}) {
  const signature = input.signature?.trim() ?? "";
  if (!signature.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", input.secret).update(input.payload).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function createOctokitForToken(token: string, apiBaseUrl?: string): GitHubOctokitClient {
  return createRequestOctokit(token, apiBaseUrl) as unknown as GitHubOctokitClient;
}

function createRequestOctokit(token: string, apiBaseUrl?: string): GitHubRequestClient {
  const options: ConstructorParameters<typeof Octokit>[0] = { auth: token };
  if (apiBaseUrl) options.baseUrl = apiBaseUrl;
  return new Octokit(options) as unknown as GitHubRequestClient;
}

function createAppOctokit(
  appId: string,
  privateKey: string,
  apiBaseUrl: string | undefined,
  now: () => Date
): GitHubRequestClient {
  const options: ConstructorParameters<typeof Octokit>[0] = {
    auth: createGitHubAppJwt({ appId, privateKey, now: now() })
  };
  if (apiBaseUrl) options.baseUrl = apiBaseUrl;
  return new Octokit(options) as unknown as GitHubRequestClient;
}

function parseGitHubPullNumberFromText(text: string, owner?: string, repo?: string) {
  const numberText = text.match(/\/pull\/(\d+)(?:$|[/?#])/u)?.[1];
  if (!numberText) return undefined;
  if (owner && repo) {
    const escapedOwner = escapeRegExp(owner);
    const escapedRepo = escapeRegExp(repo);
    const scoped = new RegExp(`(?:github://|github\\.com/)${escapedOwner}/${escapedRepo}/pull/${numberText}(?:$|[/?#])`, "u");
    if (!scoped.test(text)) return undefined;
  }
  return Number(numberText);
}

function mapGitHubPullRequestStatus(pullRequest: GitHubPullRequest): PullRequestStatus {
  if (pullRequest.merged) return "merged";
  if (pullRequest.state === "closed") return "closed";
  if (pullRequest.draft) return "draft";
  return "ready_for_review";
}

function summarizeCheckRuns(runs: PullRequestCheckRun[]): PullRequestCheckSummary["status"] {
  if (runs.length === 0) return "pending";
  if (runs.some((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion ?? ""))) {
    return "failed";
  }
  if (runs.every((run) =>
    run.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
  )) {
    return "passed";
  }
  return "pending";
}

function runGit(args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, output: error.message });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, output });
    });
  });
}

function requireNonEmpty(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function tail(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/gu, "\n");
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function mapGitHubAppRepository(repository: GitHubRepositoryResponse, installationId: number): GitHubAppRepository {
  const [owner, name] = repository.full_name.split("/");
  return {
    id: githubRepositoryRecordId(installationId, owner ?? repository.owner.login, name ?? repository.name),
    githubRepositoryId: String(repository.id),
    installationId,
    owner: owner ?? repository.owner.login,
    name: name ?? repository.name,
    fullName: repository.full_name,
    private: repository.private,
    htmlUrl: repository.html_url,
    cloneUrl: repository.clone_url,
    defaultBranch: repository.default_branch,
    permissions: repository.permissions ?? {}
  };
}

export function githubRepositoryRecordId(installationId: number, owner: string, repo: string) {
  return `repo_github_${installationId}_${slug(owner)}_${slug(repo)}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "repo";
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean | null;
  merged?: boolean | null;
}

interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface GitHubInstallationAccessTokenResponse {
  token: string;
  expires_at: string;
}

interface GitHubInstallationRepositoriesResponse {
  repositories: GitHubRepositoryResponse[];
}

interface GitHubRepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner: {
    login: string;
  };
  permissions?: Record<string, boolean>;
}

export interface GitHubRequestClient {
  request<T>(route: string, parameters?: Record<string, unknown>): Promise<{ data: T }>;
}

export interface GitHubOctokitClient {
  rest: {
    pulls: {
      create(input: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
        draft: boolean;
        maintainer_can_modify: boolean;
      }): Promise<{ data: GitHubPullRequest }>;
      update(input: {
        owner: string;
        repo: string;
        pull_number: number;
        title: string;
        body: string;
        base: string;
      }): Promise<{ data: GitHubPullRequest }>;
      get(input: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: GitHubPullRequest }>;
      list(input: {
        owner: string;
        repo: string;
        state: "open" | "closed" | "all";
        head: string;
        base: string;
        per_page: number;
      }): Promise<{ data: GitHubPullRequest[] }>;
    };
    checks: {
      listForRef(input: {
        owner: string;
        repo: string;
        ref: string;
        per_page: number;
      }): Promise<{
        data: {
          total_count: number;
          check_runs: GitHubCheckRun[];
        };
      }>;
    };
    issues: {
      createComment(input: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{
        data: {
          id: number | string;
          html_url: string;
        };
      }>;
    };
  };
}
