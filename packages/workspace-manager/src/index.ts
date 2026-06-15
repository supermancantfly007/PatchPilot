import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeCommand } from "@patchpilot/command-executor";
import type { Prd, Requirement, WorkItem } from "@patchpilot/domain";
import {
  assertValidCapabilityManifest,
  enforceWorkspaceWritePolicy,
  type CapabilityManifest
} from "@patchpilot/policy";
import { redactSecrets } from "@patchpilot/security";

export interface WorkspaceContext {
  runId: string;
  requirement: Requirement;
  prd: Prd;
  workItem: WorkItem;
}

export interface WorkspaceManagerConfig {
  repositoryRoot?: string;
  workspaceRoot: string;
  baseRef?: string;
  taskFileName?: string;
  capabilityManifest?: CapabilityManifest;
}

export interface PreparedWorkspace {
  runId: string;
  path: string;
  taskFilePath: string;
  branchName: string;
  baseRef: string;
  baseBranch: string;
  baseCommit: string;
  repositoryRoot: string;
  status: "active";
  capabilityManifest?: CapabilityManifest;
}

export type WorkspaceStatus = "clean" | "dirty" | "missing" | "unavailable";

export interface WorkspaceArtifacts {
  changedFiles: string[];
  summary: string;
  status: WorkspaceStatus;
  artifactPaths: string[];
}

export interface WorkspaceCommit {
  status: "committed" | "unchanged";
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: string[];
}

export interface WorkspaceManager {
  isGitWorkspaceAvailable(cwd?: string): Promise<boolean>;
  prepareWorkspace(context: WorkspaceContext, config: WorkspaceManagerConfig): Promise<PreparedWorkspace>;
  getWorkspaceStatus(workspacePath: string): Promise<WorkspaceStatus>;
  collectArtifacts(
    workspace: PreparedWorkspace,
    options?: { summaryPath?: string; capabilityManifest?: CapabilityManifest }
  ): Promise<WorkspaceArtifacts>;
  commitWorkspace(
    workspace: PreparedWorkspace,
    options: { message: string; capabilityManifest?: CapabilityManifest }
  ): Promise<WorkspaceCommit>;
  cleanupWorkspace(workspace: Pick<PreparedWorkspace, "path"> & Partial<Pick<PreparedWorkspace, "repositoryRoot">>): Promise<void>;
}

export class GitWorkspaceManager implements WorkspaceManager {
  async isGitWorkspaceAvailable(cwd = process.cwd()) {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, 5000);
    return result.exitCode === 0 && result.output.trim() === "true";
  }

  async prepareWorkspace(
    context: WorkspaceContext,
    config: WorkspaceManagerConfig
  ): Promise<PreparedWorkspace> {
    const repositoryRoot = config.repositoryRoot ?? process.cwd();
    const root = config.workspaceRoot;
    await mkdir(root, { recursive: true });

    const workspacePath = join(root, buildWorkspaceName(context));
    const baseRef = config.baseRef || "HEAD";
    const base = await resolveBaseInfo(baseRef, repositoryRoot, config.capabilityManifest);
    const branchName = buildWorkspaceBranchName(context);
    const taskFilePath = join(workspacePath, config.taskFileName || "PATCHPILOT_TASK.md");
    let worktreeCreated = false;
    if (config.capabilityManifest) assertValidCapabilityManifest(config.capabilityManifest);

    try {
      await ensureBranchAtRef(branchName, base.baseCommit, config.capabilityManifest, repositoryRoot);
      const worktreeResult = await runGit(
        ["worktree", "add", workspacePath, branchName],
        repositoryRoot,
        30000,
        config.capabilityManifest
      );
      if (worktreeResult.exitCode !== 0) {
        throw new Error(`无法创建隔离 git worktree：${tail(worktreeResult.output, 1200)}`);
      }
      worktreeCreated = true;
      await writeFile(taskFilePath, redactSecrets(buildTaskMarkdown(context)).redacted);
    } catch (error) {
      if (worktreeCreated) await this.cleanupWorkspace({ path: workspacePath, repositoryRoot });
      throw error;
    }

    return {
      runId: context.runId,
      path: workspacePath,
      taskFilePath,
      branchName,
      baseRef,
      baseBranch: base.baseBranch,
      baseCommit: base.baseCommit,
      repositoryRoot,
      status: "active",
      ...(config.capabilityManifest ? { capabilityManifest: config.capabilityManifest } : {})
    };
  }

  async getWorkspaceStatus(workspacePath: string): Promise<WorkspaceStatus> {
    if (!existsSync(workspacePath)) return "missing";
    const result = await runGit(["status", "--short", "--untracked-files=all"], workspacePath, 30000);
    if (result.exitCode !== 0) return "unavailable";
    return parseChangedFiles(result.output).length > 0 ? "dirty" : "clean";
  }

  async collectArtifacts(
    workspace: PreparedWorkspace,
    options: { summaryPath?: string; capabilityManifest?: CapabilityManifest } = {}
  ): Promise<WorkspaceArtifacts> {
    const changedFiles = await listChangedFiles(workspace.path, options.capabilityManifest ?? workspace.capabilityManifest);
    const manifest = options.capabilityManifest ?? workspace.capabilityManifest;
    if (manifest) enforceWorkspaceWritePolicy(manifest, changedFiles);
    const summary = await readSummary(options.summaryPath, changedFiles);
    return {
      changedFiles,
      summary,
      status: await this.getWorkspaceStatus(workspace.path),
      artifactPaths: options.summaryPath ? [options.summaryPath] : []
    };
  }

  async commitWorkspace(
    workspace: PreparedWorkspace,
    options: { message: string; capabilityManifest?: CapabilityManifest }
  ): Promise<WorkspaceCommit> {
    const changedFiles = await listChangedFiles(workspace.path, options.capabilityManifest ?? workspace.capabilityManifest);
    const manifest = options.capabilityManifest ?? workspace.capabilityManifest;
    if (manifest) enforceWorkspaceWritePolicy(manifest, changedFiles);
    if (changedFiles.length === 0) {
      return {
        status: "unchanged",
        branchName: workspace.branchName,
        baseBranch: workspace.baseBranch,
        baseCommit: workspace.baseCommit,
        headCommit: await readGitValue(["rev-parse", "HEAD"], workspace.path, 5000, workspace.baseCommit, manifest),
        changedFiles
      };
    }

    const addResult = await runGit(["add", "--", ...changedFiles], workspace.path, 30000, manifest);
    if (addResult.exitCode !== 0) {
      throw new Error(`无法暂存 worktree 变更：${tail(addResult.output, 1200)}`);
    }

    const staged = await runGit(["diff", "--cached", "--quiet"], workspace.path, 30000, manifest);
    if (staged.exitCode === 0) {
      return {
        status: "unchanged",
        branchName: workspace.branchName,
        baseBranch: workspace.baseBranch,
        baseCommit: workspace.baseCommit,
        headCommit: await readGitValue(["rev-parse", "HEAD"], workspace.path, 5000, workspace.baseCommit, manifest),
        changedFiles
      };
    }

    const commitResult = await runGit(
      ["commit", "-m", options.message],
      workspace.path,
      30000,
      manifest,
      {
        GIT_AUTHOR_NAME: "PatchPilot",
        GIT_AUTHOR_EMAIL: "patchpilot@example.local",
        GIT_COMMITTER_NAME: "PatchPilot",
        GIT_COMMITTER_EMAIL: "patchpilot@example.local"
      }
    );
    if (commitResult.exitCode !== 0) {
      throw new Error(`无法创建本地提交边界：${tail(commitResult.output, 1200)}`);
    }

    return {
      status: "committed",
      branchName: workspace.branchName,
      baseBranch: workspace.baseBranch,
      baseCommit: workspace.baseCommit,
      headCommit: await readGitValue(["rev-parse", "HEAD"], workspace.path, 5000, workspace.baseCommit, manifest),
      changedFiles
    };
  }

  async cleanupWorkspace(workspace: Pick<PreparedWorkspace, "path"> & Partial<Pick<PreparedWorkspace, "repositoryRoot">>) {
    const result = await runGit(["worktree", "remove", "--force", workspace.path], workspace.repositoryRoot ?? process.cwd(), 30000);
    if (result.exitCode !== 0) {
      await rm(workspace.path, { recursive: true, force: true });
    }
  }
}

export function buildWorkspaceName(context: Pick<WorkspaceContext, "runId">) {
  return context.runId;
}

export function buildWorkspaceBranchName(context: Pick<WorkspaceContext, "runId" | "workItem">) {
  const workItemId = slugSegment(context.workItem.id).slice(0, 80);
  const titleSlug = slugSegment(redactSecrets(context.workItem.title).redacted).slice(0, 48);
  return `patchpilot/${workItemId}-${titleSlug}`;
}

async function listChangedFiles(workspacePath: string, capabilityManifest?: CapabilityManifest) {
  const result = await runGit(["status", "--short", "--untracked-files=all"], workspacePath, 30000, capabilityManifest);
  if (result.exitCode !== 0) return ["PATCHPILOT_TASK.md"];
  return parseChangedFiles(result.output);
}

function parseChangedFiles(output: string) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const file = line.slice(3).trim();
      return file.includes(" -> ") ? file.split(" -> ").pop() || file : file;
    })
    .map((file) => redactSecrets(file).redacted)
    .filter((file) =>
      file !== "PATCHPILOT_TASK.md" &&
      !file.startsWith(".patchpilot-codex-") &&
      !file.startsWith(".patchpilot-pi-")
    );
}

async function resolveBaseInfo(baseRef: string, cwd: string, capabilityManifest?: CapabilityManifest) {
  const baseCommit = await readGitValue(
    ["rev-parse", baseRef],
    cwd,
    5000,
    baseRef,
    capabilityManifest
  );
  const baseBranch = await readGitValue(
    ["rev-parse", "--abbrev-ref", baseRef],
    cwd,
    5000,
    baseRef,
    capabilityManifest
  );
  return {
    baseCommit,
    baseBranch: baseBranch === "HEAD" ? baseRef : baseBranch
  };
}

async function ensureBranchAtRef(
  branchName: string,
  ref: string,
  capabilityManifest?: CapabilityManifest,
  repositoryRoot = process.cwd()
) {
  const exists = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    repositoryRoot,
    5000,
    capabilityManifest
  );
  const args = exists.exitCode === 0
    ? ["branch", "-f", branchName, ref]
    : ["branch", branchName, ref];
  const result = await runGit(args, repositoryRoot, 30000, capabilityManifest);
  if (result.exitCode !== 0) {
    throw new Error(`无法准备任务分支 ${branchName}：${tail(result.output, 1200)}`);
  }
}

async function readGitValue(
  args: string[],
  cwd: string,
  timeoutMs: number,
  fallback: string,
  capabilityManifest?: CapabilityManifest
) {
  const result = await runGit(args, cwd, timeoutMs, capabilityManifest);
  if (result.exitCode !== 0) return fallback;
  return result.output.trim() || fallback;
}

async function readSummary(summaryPath: string | undefined, changedFiles: string[]) {
  if (summaryPath) {
    try {
      const summary = (await readFile(summaryPath, "utf8")).trim();
      if (summary) return redactSecrets(summary).redacted.slice(0, 2000);
    } catch {
      // The JSONL stream is still authoritative if Codex did not write the optional summary file.
    }
  }
  if (changedFiles.length === 0) return "Codex 执行完成，但没有产生文件变更。";
  return `Codex 执行完成，产生 ${changedFiles.length} 个变更文件。`;
}

function buildTaskMarkdown(context: WorkspaceContext) {
  return [
    `# PatchPilot Task ${context.runId}`,
    "",
    "Workspace: git worktree",
    `Branch: ${buildWorkspaceBranchName(context)}`,
    "",
    "## Requirement",
    context.requirement.rawInput,
    "",
    "## PRD",
    context.prd.bodyMarkdown,
    "",
    "## Work Item",
    `- Title: ${context.workItem.title}`,
    `- Scope: ${context.workItem.scope}`,
    "",
    "## Acceptance Criteria",
    ...context.workItem.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Test Suggestions",
    ...context.workItem.testSuggestions.map((suggestion) => `- ${suggestion}`)
  ].join("\n");
}

function slugSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  capabilityManifest?: CapabilityManifest,
  env?: NodeJS.ProcessEnv
) {
  return executeCommand({
    kind: "git",
    command: "git",
    args,
    cwd,
    timeoutMs,
    maxOutputBytes: 256 * 1024,
    ...(env ? { env } : {}),
    ...(capabilityManifest ? { capabilityManifest } : {})
  });
}

function tail(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}
