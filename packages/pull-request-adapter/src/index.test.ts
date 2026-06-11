import { mkdir, writeFile } from "node:fs/promises";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import {
  GitHubAppInstallationRepositoryClient,
  GitHubAppInstallationTokenProvider,
  GitHubPullRequestAdapter,
  LocalPullRequestAdapter,
  createGitHubAppJwt,
  githubPullRequestId,
  verifyGitHubWebhookSignature,
  type GitCommandRunner,
  type GitHubOctokitClient,
  type GitHubRequestClient,
  type PullRequestDraft
} from ".";

describe("LocalPullRequestAdapter", () => {
  it("preserves the existing local PullRequestRecord shape and URL", async () => {
    const adapter = new LocalPullRequestAdapter();
    const draft = makeDraft();

    const created = await adapter.upsertPullRequest({ draft });
    expect(created).toMatchObject({
      id: "pr_run_1",
      provider: "local",
      status: "ready_for_review",
      url: "local://pull-requests/run_1",
      branchName: "patchpilot/wi_1-fixture",
      baseBranch: "main"
    });

    const updated = await adapter.upsertPullRequest({
      draft: { ...draft, bodyMarkdown: "# Updated", updatedAt: "2026-06-11T00:01:00.000Z" },
      existing: created
    });
    expect(updated.id).toBe(created.id);
    expect(updated.url).toBe("local://pull-requests/run_1");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.bodyMarkdown).toBe("# Updated");
  });
});

describe("GitHubPullRequestAdapter", () => {
  it("pushes the local branch and creates a GitHub pull request", async () => {
    const git = new FakeGitRunner();
    const octokit = new FakeOctokit();
    const adapter = new GitHubPullRequestAdapter({
      owner: "patchpilot-fixtures",
      repo: "delivery",
      octokit,
      git,
      remote: "upstream"
    });

    const pullRequest = await adapter.upsertPullRequest({
      draft: makeDraft(),
      workspacePath: "/tmp/patchpilot-worktree"
    });

    expect(git.pushes).toEqual([
      {
        cwd: "/tmp/patchpilot-worktree",
        remote: "upstream",
        branchName: "patchpilot/wi_1-fixture",
        timeoutMs: 30000
      }
    ]);
    expect(octokit.calls.pullsCreate[0]).toMatchObject({
      owner: "patchpilot-fixtures",
      repo: "delivery",
      title: "[PatchPilot] Fixture task",
      head: "patchpilot/wi_1-fixture",
      base: "main",
      maintainer_can_modify: true
    });
    expect(pullRequest).toMatchObject({
      id: githubPullRequestId("patchpilot-fixtures", "delivery", 42),
      provider: "github",
      status: "ready_for_review",
      url: "https://github.com/patchpilot-fixtures/delivery/pull/42",
      branchName: "patchpilot/wi_1-fixture",
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });

    const checks = await adapter.readChecks({ pullRequest });
    expect(checks).toEqual({
      status: "passed",
      totalCount: 1,
      runs: [
        {
          name: "ci/test",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/patchpilot-fixtures/delivery/actions/runs/1",
          startedAt: "2026-06-11T00:00:01Z",
          completedAt: "2026-06-11T00:00:05Z"
        }
      ]
    });

    const comment = await adapter.writeReviewerComment({
      pullRequest,
      body: "Reviewer agent summary"
    });
    expect(comment).toEqual({
      id: "9001",
      url: "https://github.com/patchpilot-fixtures/delivery/pull/42#issuecomment-9001"
    });
    expect(octokit.calls.issuesCreateComment[0]).toMatchObject({
      issue_number: 42,
      body: "Reviewer agent summary"
    });
  });

  it("updates an existing GitHub pull request by URL without changing the local record id", async () => {
    const git = new FakeGitRunner();
    const octokit = new FakeOctokit([
      makeGitHubPullRequest({
        number: 7,
        html_url: "https://github.com/patchpilot-fixtures/delivery/pull/7"
      })
    ]);
    const adapter = new GitHubPullRequestAdapter({
      owner: "patchpilot-fixtures",
      repo: "delivery",
      octokit,
      git
    });
    const existing = {
      ...await new LocalPullRequestAdapter().upsertPullRequest({ draft: makeDraft() }),
      id: githubPullRequestId("patchpilot-fixtures", "delivery", 7),
      provider: "github" as const,
      url: "https://github.com/patchpilot-fixtures/delivery/pull/7"
    };

    const pullRequest = await adapter.upsertPullRequest({
      draft: { ...makeDraft(), bodyMarkdown: "# Updated body" },
      existing,
      workspacePath: "/tmp/patchpilot-worktree"
    });

    expect(octokit.calls.pullsCreate).toHaveLength(0);
    expect(octokit.calls.pullsUpdate[0]).toMatchObject({
      pull_number: 7,
      body: "# Updated body",
      base: "main"
    });
    expect(pullRequest.id).toBe(existing.id);
    expect(pullRequest.url).toBe("https://github.com/patchpilot-fixtures/delivery/pull/7");
  });

  it("finds an open pull request by source branch when no existing record has a GitHub URL", async () => {
    const git = new FakeGitRunner();
    const octokit = new FakeOctokit([
      makeGitHubPullRequest({
        number: 9,
        html_url: "https://github.com/patchpilot-fixtures/delivery/pull/9"
      })
    ]);
    const adapter = new GitHubPullRequestAdapter({
      owner: "patchpilot-fixtures",
      repo: "delivery",
      octokit,
      git
    });

    const pullRequest = await adapter.upsertPullRequest({
      draft: makeDraft(),
      workspacePath: "/tmp/patchpilot-worktree"
    });

    expect(octokit.calls.pullsList[0]).toMatchObject({
      head: "patchpilot-fixtures:patchpilot/wi_1-fixture",
      base: "main"
    });
    expect(octokit.calls.pullsUpdate[0]).toMatchObject({ pull_number: 9 });
    expect(pullRequest.id).toBe(githubPullRequestId("patchpilot-fixtures", "delivery", 9));
  });

  it("requires a workspace path before pushing to GitHub", async () => {
    const adapter = new GitHubPullRequestAdapter({
      owner: "patchpilot-fixtures",
      repo: "delivery",
      octokit: new FakeOctokit(),
      git: new FakeGitRunner()
    });

    await expect(adapter.upsertPullRequest({ draft: makeDraft() }))
      .rejects
      .toThrow("requires a local workspacePath");
  });
});

describe("GitHub App helpers", () => {
  it("creates GitHub App JWTs with stable issuer and bounded lifetime claims", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = createGitHubAppJwt({
      appId: 12345,
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      now: new Date("2026-06-11T00:00:00.000Z")
    });
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT"
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))).toEqual({
      iat: 1781135940,
      exp: 1781136540,
      iss: "12345"
    });
    expect(signature?.length).toBeGreaterThan(20);
  });

  it("mints and caches installation access tokens through the GitHub App endpoint", async () => {
    const requestClient = new FakeRequestClient();
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\\nfixture\\n-----END RSA PRIVATE KEY-----",
      installationId: 98765,
      permissions: {
        contents: "write",
        pull_requests: "write",
        checks: "read"
      },
      repositories: ["delivery"],
      octokit: requestClient,
      now: () => new Date("2026-06-11T00:00:00.000Z")
    });

    await expect(provider.getToken()).resolves.toBe("installation-token-1");
    await expect(provider.getToken()).resolves.toBe("installation-token-1");
    expect(requestClient.calls).toHaveLength(1);
    expect(requestClient.calls[0]).toMatchObject({
      route: "POST /app/installations/{installation_id}/access_tokens",
      parameters: {
        installation_id: 98765,
        repositories: ["delivery"],
        permissions: {
          contents: "write",
          pull_requests: "write",
          checks: "read"
        }
      }
    });
  });

  it("lists repositories accessible to a GitHub App installation", async () => {
    const requestClient = new FakeRequestClient();
    const client = new GitHubAppInstallationRepositoryClient({
      installationId: 98765,
      token: "installation-token",
      octokit: requestClient
    });

    const repositories = await client.listRepositories();

    expect(requestClient.calls[0]).toMatchObject({
      route: "GET /installation/repositories",
      parameters: { per_page: 100 }
    });
    expect(repositories).toEqual([
      {
        id: "repo_github_98765_patchpilot_fixtures_delivery",
        githubRepositoryId: "123",
        installationId: 98765,
        owner: "patchpilot-fixtures",
        name: "delivery",
        fullName: "patchpilot-fixtures/delivery",
        private: true,
        htmlUrl: "https://github.com/patchpilot-fixtures/delivery",
        cloneUrl: "https://github.com/patchpilot-fixtures/delivery.git",
        defaultBranch: "main",
        permissions: {
          admin: false,
          maintain: true,
          push: true,
          pull: true
        }
      }
    ]);
  });

  it("verifies GitHub webhook HMAC signatures without accepting mismatches", () => {
    const payload = JSON.stringify({ action: "created", installation: { id: 98765 } });
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifyGitHubWebhookSignature({ payload, signature, secret })).toBe(true);
    expect(verifyGitHubWebhookSignature({ payload, signature: "sha256=bad", secret })).toBe(false);
    expect(verifyGitHubWebhookSignature({ payload, signature: undefined, secret })).toBe(false);
  });
});

const runFixtureIntegration = process.env.PATCHPILOT_GITHUB_FIXTURE === "1";

describe.skipIf(!runFixtureIntegration)("GitHub fixture integration", () => {
  it("creates a real PR, reads checks, and writes a reviewer comment", async () => {
    const owner = requiredEnv("PATCHPILOT_GITHUB_OWNER");
    const repo = requiredEnv("PATCHPILOT_GITHUB_REPO");
    const token = requiredEnv("PATCHPILOT_GITHUB_TOKEN");
    const workspacePath = requiredEnv("PATCHPILOT_GITHUB_FIXTURE_WORKSPACE");
    const remote = process.env.PATCHPILOT_GITHUB_REMOTE || "origin";
    const baseBranch = process.env.PATCHPILOT_GITHUB_BASE_BRANCH || "main";
    const branchName = `patchpilot/td215-fixture-${Date.now()}`;
    const octokit = new Octokit({ auth: token });
    const adapter = new GitHubPullRequestAdapter({ owner, repo, token, remote });
    let pullNumber: number | undefined;

    try {
      await git(["fetch", remote, baseBranch], workspacePath);
      await git(["checkout", "-B", branchName, `FETCH_HEAD`], workspacePath);
      const fixtureDir = join(workspacePath, ".patchpilot-fixtures");
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(join(fixtureDir, `${branchName.replace(/\W+/gu, "-")}.md`), `TD-215 fixture ${new Date().toISOString()}\n`);
      await git(["add", ".patchpilot-fixtures"], workspacePath);
      await git(["-c", "user.name=PatchPilot", "-c", "user.email=patchpilot@example.local", "commit", "-m", "PatchPilot TD-215 fixture"], workspacePath);
      const headCommit = (await git(["rev-parse", "HEAD"], workspacePath)).trim();
      const baseCommit = (await git(["rev-parse", "FETCH_HEAD"], workspacePath)).trim();

      const pullRequest = await adapter.upsertPullRequest({
        draft: makeDraft({
          branchName,
          baseBranch,
          baseCommit,
          headCommit,
          bodyMarkdown: "TD-215 fixture PR body",
          updatedAt: new Date().toISOString()
        }),
        workspacePath
      });
      pullNumber = Number(pullRequest.url.match(/\/pull\/(\d+)$/u)?.[1]);

      expect(pullRequest.provider).toBe("github");
      expect(pullRequest.url).toContain(`github.com/${owner}/${repo}/pull/`);
      await adapter.writeReviewerComment({ pullRequest, body: "TD-215 fixture reviewer comment" });
      const checks = await adapter.readChecks({ pullRequest });
      expect(checks.totalCount).toBeGreaterThanOrEqual(0);
    } finally {
      if (pullNumber) {
        await octokit.rest.pulls.update({ owner, repo, pull_number: pullNumber, state: "closed" });
      }
      await git(["checkout", baseBranch], workspacePath).catch(() => "");
      await git(["branch", "-D", branchName], workspacePath).catch(() => "");
      await git(["push", remote, `:${branchName}`], workspacePath).catch(() => "");
    }
  }, 120000);
});

function makeDraft(overrides: Partial<PullRequestDraft> = {}): PullRequestDraft {
  return {
    id: "pr_run_1",
    status: "ready_for_review",
    title: "[PatchPilot] Fixture task",
    requirementId: "req_1",
    prdId: "prd_1",
    workItemId: "wi_1",
    runId: "run_1",
    branchName: "patchpilot/wi_1-fixture",
    baseBranch: "main",
    baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    bodyMarkdown: "# Fixture PR body",
    reviewerSummary: "Reviewer approved",
    testSummary: "passed: pnpm test",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    ...overrides
  };
}

class FakeGitRunner implements GitCommandRunner {
  readonly pushes: Parameters<GitCommandRunner["pushBranch"]>[0][] = [];

  async pushBranch(input: Parameters<GitCommandRunner["pushBranch"]>[0]) {
    this.pushes.push(input);
    return { output: "pushed" };
  }
}

class FakeOctokit implements GitHubOctokitClient {
  readonly calls = {
    pullsCreate: [] as unknown[],
    pullsUpdate: [] as unknown[],
    pullsGet: [] as unknown[],
    pullsList: [] as unknown[],
    checksListForRef: [] as unknown[],
    issuesCreateComment: [] as unknown[]
  };

  readonly rest: GitHubOctokitClient["rest"];
  private readonly pullRequests: ReturnType<typeof makeGitHubPullRequest>[];
  private nextPullNumber = 42;

  constructor(pullRequests: ReturnType<typeof makeGitHubPullRequest>[] = []) {
    this.pullRequests = [...pullRequests];
    this.rest = {
      pulls: {
        create: async (input) => {
          this.calls.pullsCreate.push(input);
          const pullRequest = makeGitHubPullRequest({
            number: this.nextPullNumber,
            html_url: `https://github.com/${input.owner}/${input.repo}/pull/${this.nextPullNumber}`,
            draft: input.draft
          });
          this.nextPullNumber += 1;
          this.pullRequests.push(pullRequest);
          return { data: pullRequest };
        },
        update: async (input) => {
          this.calls.pullsUpdate.push(input);
          const pullRequest = this.pullRequests.find((item) => item.number === input.pull_number)
            ?? makeGitHubPullRequest({ number: input.pull_number });
          return { data: pullRequest };
        },
        get: async (input) => {
          this.calls.pullsGet.push(input);
          const pullRequest = this.pullRequests.find((item) => item.number === input.pull_number)
            ?? makeGitHubPullRequest({ number: input.pull_number });
          return { data: pullRequest };
        },
        list: async (input) => {
          this.calls.pullsList.push(input);
          return { data: this.pullRequests };
        }
      },
      checks: {
        listForRef: async (input) => {
          this.calls.checksListForRef.push(input);
          return {
            data: {
              total_count: 1,
              check_runs: [
                {
                  name: "ci/test",
                  status: "completed",
                  conclusion: "success",
                  html_url: "https://github.com/patchpilot-fixtures/delivery/actions/runs/1",
                  started_at: "2026-06-11T00:00:01Z",
                  completed_at: "2026-06-11T00:00:05Z"
                }
              ]
            }
          };
        }
      },
      issues: {
        createComment: async (input) => {
          this.calls.issuesCreateComment.push(input);
          return {
            data: {
              id: 9001,
              html_url: "https://github.com/patchpilot-fixtures/delivery/pull/42#issuecomment-9001"
            }
          };
        }
      }
    };
  }
}

class FakeRequestClient implements GitHubRequestClient {
  readonly calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];

  async request<T>(route: string, parameters?: Record<string, unknown>) {
    this.calls.push({ route, parameters });
    if (route === "POST /app/installations/{installation_id}/access_tokens") {
      return {
        data: {
          token: "installation-token-1",
          expires_at: "2026-06-11T01:00:00.000Z"
        } as T
      };
    }
    if (route === "GET /installation/repositories") {
      return {
        data: {
          repositories: [
            {
              id: 123,
              name: "delivery",
              full_name: "patchpilot-fixtures/delivery",
              private: true,
              html_url: "https://github.com/patchpilot-fixtures/delivery",
              clone_url: "https://github.com/patchpilot-fixtures/delivery.git",
              default_branch: "main",
              owner: { login: "patchpilot-fixtures" },
              permissions: {
                admin: false,
                maintain: true,
                push: true,
                pull: true
              }
            }
          ]
        } as T
      };
    }
    throw new Error(`Unexpected route ${route}`);
  }
}

function makeGitHubPullRequest(overrides: Partial<{
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  merged: boolean;
}> = {}) {
  const number = overrides.number ?? 42;
  return {
    number,
    html_url: overrides.html_url ?? `https://github.com/patchpilot-fixtures/delivery/pull/${number}`,
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false
  };
}

async function git(args: string[], cwd: string) {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve(output);
      else reject(new Error(output));
    });
  });
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when PATCHPILOT_GITHUB_FIXTURE=1`);
  return value;
}
