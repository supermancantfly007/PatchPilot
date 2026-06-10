import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Prd, Requirement, WorkItem } from "@patchpilot/domain";

export interface WorkspaceContext {
  runId: string;
  requirement: Requirement;
  prd: Prd;
  workItem: WorkItem;
}

export interface WorkspaceManagerConfig {
  workspaceRoot: string;
  baseRef?: string;
  taskFileName?: string;
}

export interface PreparedWorkspace {
  runId: string;
  path: string;
  taskFilePath: string;
  branchName: string;
  baseRef: string;
  status: "active";
}

export type WorkspaceStatus = "clean" | "dirty" | "missing" | "unavailable";

export interface WorkspaceArtifacts {
  changedFiles: string[];
  summary: string;
  status: WorkspaceStatus;
  artifactPaths: string[];
}

export interface WorkspaceManager {
  isGitWorkspaceAvailable(cwd?: string): Promise<boolean>;
  prepareWorkspace(context: WorkspaceContext, config: WorkspaceManagerConfig): Promise<PreparedWorkspace>;
  getWorkspaceStatus(workspacePath: string): Promise<WorkspaceStatus>;
  collectArtifacts(workspace: PreparedWorkspace, options?: { summaryPath?: string }): Promise<WorkspaceArtifacts>;
  cleanupWorkspace(workspace: Pick<PreparedWorkspace, "path">): Promise<void>;
}

export class GitWorkspaceManager implements WorkspaceManager {
  async isGitWorkspaceAvailable(cwd = process.cwd()) {
    const result = await runShell("git rev-parse --is-inside-work-tree", cwd, 5000);
    return result.exitCode === 0 && result.output.trim() === "true";
  }

  async prepareWorkspace(
    context: WorkspaceContext,
    config: WorkspaceManagerConfig
  ): Promise<PreparedWorkspace> {
    const root = config.workspaceRoot;
    await mkdir(root, { recursive: true });

    const workspacePath = join(root, buildWorkspaceName(context));
    const baseRef = config.baseRef || "HEAD";
    const taskFilePath = join(workspacePath, config.taskFileName || "PATCHPILOT_TASK.md");
    let worktreeCreated = false;

    try {
      const worktreeResult = await runShell(
        `git worktree add --detach ${shellQuote(workspacePath)} ${shellQuote(baseRef)}`,
        process.cwd(),
        30000
      );
      if (worktreeResult.exitCode !== 0) {
        throw new Error(`无法创建隔离 git worktree：${tail(worktreeResult.output, 1200)}`);
      }
      worktreeCreated = true;
      await writeFile(taskFilePath, buildTaskMarkdown(context));
    } catch (error) {
      if (worktreeCreated) await this.cleanupWorkspace({ path: workspacePath });
      throw error;
    }

    return {
      runId: context.runId,
      path: workspacePath,
      taskFilePath,
      branchName: buildWorkspaceBranchName(context),
      baseRef,
      status: "active"
    };
  }

  async getWorkspaceStatus(workspacePath: string): Promise<WorkspaceStatus> {
    if (!existsSync(workspacePath)) return "missing";
    const result = await runShell("git status --short", workspacePath, 30000);
    if (result.exitCode !== 0) return "unavailable";
    return parseChangedFiles(result.output).length > 0 ? "dirty" : "clean";
  }

  async collectArtifacts(
    workspace: PreparedWorkspace,
    options: { summaryPath?: string } = {}
  ): Promise<WorkspaceArtifacts> {
    const changedFiles = await listChangedFiles(workspace.path);
    const summary = await readSummary(options.summaryPath, changedFiles);
    return {
      changedFiles,
      summary,
      status: await this.getWorkspaceStatus(workspace.path),
      artifactPaths: options.summaryPath ? [options.summaryPath] : []
    };
  }

  async cleanupWorkspace(workspace: Pick<PreparedWorkspace, "path">) {
    const result = await runShell(`git worktree remove --force ${shellQuote(workspace.path)}`, process.cwd(), 30000);
    if (result.exitCode !== 0) {
      await rm(workspace.path, { recursive: true, force: true });
    }
  }
}

export function buildWorkspaceName(context: Pick<WorkspaceContext, "runId">) {
  return context.runId;
}

export function buildWorkspaceBranchName(context: Pick<WorkspaceContext, "runId" | "workItem">) {
  const runSlug = context.runId.replace(/^run_/, "").slice(0, 8) || "run";
  return `patchpilot/${slugSegment(context.workItem.role)}/${slugSegment(runSlug)}`;
}

async function listChangedFiles(workspacePath: string) {
  const result = await runShell("git status --short", workspacePath, 30000);
  if (result.exitCode !== 0) return ["PATCHPILOT_TASK.md"];
  return parseChangedFiles(result.output);
}

function parseChangedFiles(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^..?\s+/, ""))
    .filter((file) => file !== "PATCHPILOT_TASK.md" && !file.startsWith(".patchpilot-codex-"));
}

async function readSummary(summaryPath: string | undefined, changedFiles: string[]) {
  if (summaryPath) {
    try {
      const summary = (await readFile(summaryPath, "utf8")).trim();
      if (summary) return summary.slice(0, 2000);
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

function runShell(command: string, cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn("sh", ["-lc", command], {
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tail(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}
