import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Prd, Requirement, WorkItem } from "@patchpilot/domain";
import { generateCapabilityManifest } from "@patchpilot/policy";
import { buildWorkspaceBranchName, GitWorkspaceManager } from "./index";

describe("GitWorkspaceManager", () => {
  it("builds stable PatchPilot branch names", () => {
    expect(buildWorkspaceBranchName(makeContext())).toBe("patchpilot/wi_test-backend-slice");
  });

  it("prepares a worktree and collects workspace artifacts", async () => {
    const fixture = await createGitFixture();
    const previousCwd = process.cwd();
    process.chdir(fixture.repo);
    const manager = new GitWorkspaceManager();

    try {
      const workspace = await manager.prepareWorkspace(makeContext(), {
        workspaceRoot: fixture.workspaceRoot
      });
      expect(workspace.path).toBe(join(fixture.workspaceRoot, "run_12345678"));
      expect(workspace.branchName).toBe("patchpilot/wi_test-backend-slice");
      expect(workspace.baseBranch).toBe("main");
      expect(workspace.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(workspace.taskFilePath)).toBe(true);
      const currentBranch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspace.path);
      expect(currentBranch.stdout.trim()).toBe(workspace.branchName);
      expect(await manager.getWorkspaceStatus(workspace.path)).toBe("clean");

      const initialArtifacts = await manager.collectArtifacts(workspace);
      expect(initialArtifacts).toMatchObject({
        changedFiles: [],
        status: "clean"
      });

      await writeFile(join(workspace.path, "feature.txt"), "new feature");
      await writeFile(join(workspace.path, ".patchpilot-codex-summary.md"), "agent summary");
      const artifacts = await manager.collectArtifacts(workspace, {
        summaryPath: join(workspace.path, ".patchpilot-codex-summary.md")
      });

      expect(artifacts.changedFiles).toEqual(["feature.txt"]);
      expect(artifacts.summary).toBe("agent summary");
      expect(artifacts.status).toBe("dirty");

      const commit = await manager.commitWorkspace(workspace, {
        message: "PatchPilot wi_test: Backend slice"
      });
      expect(commit).toMatchObject({
        status: "committed",
        branchName: workspace.branchName,
        baseBranch: "main",
        baseCommit: workspace.baseCommit,
        changedFiles: ["feature.txt"]
      });
      expect(commit.headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.headCommit).not.toBe(workspace.baseCommit);
      const branchHead = await runGit(["rev-parse", workspace.branchName], fixture.repo);
      expect(branchHead.stdout.trim()).toBe(commit.headCommit);
      const committedFiles = await runGit(["show", "--name-only", "--format=", commit.headCommit], workspace.path);
      expect(committedFiles.stdout.trim().split("\n")).toEqual(["feature.txt"]);
      expect(await manager.getWorkspaceStatus(workspace.path)).toBe("clean");

      await manager.cleanupWorkspace(workspace);
      expect(existsSync(workspace.path)).toBe(false);
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("cleans up a partially-created worktree when task materialization fails", async () => {
    const fixture = await createGitFixture();
    const previousCwd = process.cwd();
    process.chdir(fixture.repo);
    const manager = new GitWorkspaceManager();
    const context = makeContext({ runId: "run_cleanup" });
    const workspacePath = join(fixture.workspaceRoot, "run_cleanup");

    try {
      await expect(manager.prepareWorkspace(context, {
        workspaceRoot: fixture.workspaceRoot,
        taskFileName: "missing-parent/PATCHPILOT_TASK.md"
      })).rejects.toThrow();

      expect(existsSync(workspacePath)).toBe(false);
      const worktrees = await runGit(["worktree", "list", "--porcelain"], fixture.repo);
      expect(worktrees.stdout).not.toContain(workspacePath);
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns the base commit when no deliverable files changed", async () => {
    const fixture = await createGitFixture();
    const previousCwd = process.cwd();
    process.chdir(fixture.repo);
    const manager = new GitWorkspaceManager();

    try {
      const workspace = await manager.prepareWorkspace(makeContext({ runId: "run_no_changes" }), {
        workspaceRoot: fixture.workspaceRoot
      });
      await writeFile(join(workspace.path, ".patchpilot-codex-summary.md"), "agent summary");
      const commit = await manager.commitWorkspace(workspace, {
        message: "PatchPilot wi_test: Backend slice"
      });

      expect(commit).toMatchObject({
        status: "unchanged",
        branchName: workspace.branchName,
        baseBranch: "main",
        baseCommit: workspace.baseCommit,
        headCommit: workspace.baseCommit,
        changedFiles: []
      });

      await manager.cleanupWorkspace(workspace);
      expect(existsSync(workspace.path)).toBe(false);
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects workspace artifacts and commits that violate repo write policy", async () => {
    const fixture = await createGitFixture();
    const previousCwd = process.cwd();
    process.chdir(fixture.repo);
    const manager = new GitWorkspaceManager();
    const manifest = generateCapabilityManifest({
      repo: {
        writeAllow: ["src/**"],
        writeDeny: ["src/private/**"]
      }
    });

    try {
      const workspace = await manager.prepareWorkspace(makeContext({ runId: "run_policy" }), {
        workspaceRoot: fixture.workspaceRoot,
        capabilityManifest: manifest
      });
      await mkdir(join(workspace.path, "docs"), { recursive: true });
      await writeFile(join(workspace.path, "docs", "plan.md"), "not allowed");

      await expect(manager.collectArtifacts(workspace)).rejects.toThrow(/repo_write_not_allowlisted/u);
      await expect(manager.commitWorkspace(workspace, {
        message: "PatchPilot wi_test: Backend slice"
      })).rejects.toThrow(/repo_write_not_allowlisted/u);

      await rm(join(workspace.path, "docs"), { recursive: true, force: true });
      await mkdir(join(workspace.path, "src"), { recursive: true });
      await writeFile(join(workspace.path, "src", "feature.ts"), "export const ok = true;\n");
      await expect(manager.collectArtifacts(workspace)).resolves.toMatchObject({
        changedFiles: ["src/feature.ts"]
      });

      await mkdir(join(workspace.path, "src", "private"), { recursive: true });
      await writeFile(join(workspace.path, "src", "private", "token.txt"), "nope");
      await expect(manager.collectArtifacts(workspace)).rejects.toThrow(/repo_write_denylisted/u);

      await manager.cleanupWorkspace(workspace);
      expect(existsSync(workspace.path)).toBe(false);
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function makeContext(overrides: Partial<{ runId: string; role: WorkItem["role"] }> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const requirement: Requirement = {
    id: "req_test",
    title: "Test requirement",
    rawInput: "Ship a test feature",
    template: "feature",
    status: "approved",
    simpleSummary: "Ship a test feature",
    clarificationQuestions: [],
    clarificationTurns: [],
    createdAt: now,
    updatedAt: now
  };
  const prd: Prd = {
    id: "prd_test",
    requirementId: requirement.id,
    version: 1,
    status: "approved",
    title: "Test PRD",
    bodyMarkdown: "## PRD\nImplement the feature.",
    acceptanceCriteria: ["Feature works"]
  };
  const workItem: WorkItem = {
    id: "wi_test",
    prdId: prd.id,
    title: "Backend slice",
    status: "ready",
    role: overrides.role ?? "backend",
    scope: "Implement backend behavior",
    nonGoals: [],
    acceptanceCriteria: ["API returns data"],
    testSuggestions: ["pnpm test"]
  };
  return {
    runId: overrides.runId ?? "run_12345678",
    requirement,
    prd,
    workItem
  };
}

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "patchpilot-workspace-manager-"));
  const repo = join(root, "repo");
  const workspaceRoot = join(root, "worktrees");
  await runGit(["init", "--initial-branch=main", repo], root);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "PatchPilot Test"], repo);
  await writeFile(join(repo, "README.md"), "# fixture\n");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root, repo, workspaceRoot };
}

function runGit(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}
