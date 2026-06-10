import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Prd, Requirement, WorkItem } from "@patchpilot/domain";
import { buildWorkspaceBranchName, GitWorkspaceManager } from "./index";

describe("GitWorkspaceManager", () => {
  it("builds stable PatchPilot branch names", () => {
    expect(buildWorkspaceBranchName(makeContext())).toBe("patchpilot/backend/12345678");
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
      expect(workspace.branchName).toBe("patchpilot/backend/12345678");
      expect(existsSync(workspace.taskFilePath)).toBe(true);
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
  await runGit(["init", repo], root);
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
