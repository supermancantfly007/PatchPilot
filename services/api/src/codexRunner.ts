import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runTestCommand } from "@patchpilot/testing";
import type {
  AgentRunEvent,
  AgentRunResult,
  Prd,
  Requirement,
  TestRun,
  TimelineStepKey,
  WorkItem
} from "@patchpilot/domain";
import { readPatchPilotConfig, type ResolvedPatchPilotConfig } from "./config";

export interface CodexRunContext {
  runId: string;
  requirement: Requirement;
  prd: Prd;
  workItem: WorkItem;
}

export interface RunnerEvent {
  step?: TimelineStepKey;
  type: AgentRunEvent["type"];
  message: string;
}

export type EmitRunnerEvent = (event: RunnerEvent) => Promise<void>;

export async function isCodexAvailable() {
  try {
    const result = await runShell("codex --version", process.cwd(), 5000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function isGitWorkspaceAvailable(cwd = process.cwd()) {
  const result = await runShell("git rev-parse --is-inside-work-tree", cwd, 5000);
  return result.exitCode === 0 && result.output.trim() === "true";
}

export async function runCodexAgent(
  context: CodexRunContext,
  emit: EmitRunnerEvent
): Promise<AgentRunResult> {
  const config = readPatchPilotConfig();
  const workspace = await prepareWorkspace(context, config);
  await emit({
    step: "developing",
    type: "workspace.created",
    message: `已创建隔离 worktree：${workspace.path}`
  });

  const prompt = buildCodexPrompt(context, workspace.taskFilePath);
  await emit({
    step: "developing",
    type: "codex.started",
    message: "本地 Codex agent 已启动，正在隔离 worktree 中开发"
  });

  const firstCodexRun = await runCodexExec(workspace.path, prompt, emit, config);
  await emit({
    step: "testing",
    type: "test.started",
    message: "Codex 执行结束，开始运行项目测试"
  });

  let testRun = await runConfiguredTests(context, workspace.path, config);
  const repairAttempts = config.test.maxRepairAttempts;

  for (let attempt = 1; testRun.status === "failed" && attempt <= repairAttempts; attempt += 1) {
    await emit({
      step: "developing",
      type: "test.failed",
      message: `测试未通过，启动第 ${attempt} 次 Codex 修复回合`
    });
    await runCodexExec(workspace.path, buildRepairPrompt(context, testRun.summary), emit, config);
    await emit({
      step: "testing",
      type: "test.started",
      message: `第 ${attempt} 次修复完成，重新运行测试`
    });
    testRun = await runConfiguredTests(context, workspace.path, config);
  }

  if (testRun.status !== "passed") {
    throw new Error(`测试未通过：${testRun.summary}`);
  }

  await emit({
    step: "testing",
    type: "test.passed",
    message: "目标测试通过，正在整理 diff 和审查摘要"
  });

  const changedFiles = await listChangedFiles(workspace.path);
  await emit({
    step: "confirming",
    type: "git.diff.created",
    message: changedFiles.length > 0 ? `已发现 ${changedFiles.length} 个变更文件` : "Codex 没有产生文件变更"
  });

  return {
    summary: await readSummary(firstCodexRun.lastMessagePath, changedFiles),
    previewUrl: config.dev.previewUrl,
    riskLevel: changedFiles.length > 12 ? "medium" : "low",
    changedFiles,
    tests: [testRun],
    reviewerSummary:
      "本次交付在隔离 worktree 中完成，平台已收集变更文件、测试命令和执行摘要。验收通过后仍需人工按仓库规则合并。",
    runner: "codex",
    workspacePath: workspace.path,
    codexSessionId: firstCodexRun.sessionId
  };
}

async function prepareWorkspace(context: CodexRunContext, config: ResolvedPatchPilotConfig) {
  const root = config.dev.workspaceRoot;
  await mkdir(root, { recursive: true });

  const workspacePath = join(root, context.runId);
  const worktreeResult = await runShell(`git worktree add --detach ${shellQuote(workspacePath)} HEAD`, process.cwd(), 30000);

  if (worktreeResult.exitCode !== 0) {
    throw new Error(`无法创建隔离 git worktree：${tail(worktreeResult.output, 1200)}`);
  }

  const taskFilePath = join(workspacePath, "PATCHPILOT_TASK.md");
  await writeFile(taskFilePath, buildTaskMarkdown(context));

  return {
    path: workspacePath,
    taskFilePath
  };
}

async function runConfiguredTests(
  context: CodexRunContext,
  workspacePath: string,
  config: ResolvedPatchPilotConfig
): Promise<TestRun> {
  return runTestCommand({
    command: config.test.command,
    cwd: workspacePath,
    timeoutMs: config.test.timeoutMs,
    runId: context.runId,
    prdId: context.prd.id,
    workItemId: context.workItem.id,
    workspacePath
  });
}

async function runCodexExec(
  workspacePath: string,
  prompt: string,
  emit: EmitRunnerEvent,
  config: ResolvedPatchPilotConfig
) {
  const lastMessagePath = join(workspacePath, `.patchpilot-codex-${randomUUID()}.md`);
  const sandbox = config.security.codexSandbox;
  const args = ["exec", "--json", "--sandbox", sandbox, "-C", workspacePath, "-o", lastMessagePath, "-"];
  const useBypass = config.security.codexBypass;
  if (useBypass) {
    args.splice(2, 2, "--dangerously-bypass-approvals-and-sandbox");
  }
  if (!existsSync(join(workspacePath, ".git"))) {
    args.splice(args.length - 1, 0, "--skip-git-repo-check");
  }

  const child = spawn("codex", args, {
    cwd: workspacePath,
    env: { ...process.env, CI: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdin.end(prompt);

  const timeout = setTimeout(() => child.kill("SIGTERM"), config.budget.codexTimeoutMs);
  let stdoutBuffer = "";
  let stderr = "";
  let sessionId: string | undefined;
  let emitted = 0;
  let pendingEmit = Promise.resolve();

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseCodexEvent(line);
      if (event.sessionId) sessionId = event.sessionId;
      const message = event.message;
      if (message && emitted < 30) {
        emitted += 1;
        pendingEmit = pendingEmit.then(() =>
          emit({
            step: "developing",
            type: "codex.output",
            message
          })
        );
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  await pendingEmit;

  if (exitCode !== 0) {
    throw new Error(`Codex 执行失败：${tail(stderr || stdoutBuffer || `exit ${exitCode}`, 1600)}`);
  }

  return { lastMessagePath, sessionId };
}

async function listChangedFiles(workspacePath: string) {
  const result = await runShell("git status --short", workspacePath, 30000);
  if (result.exitCode !== 0) return ["PATCHPILOT_TASK.md"];
  return result.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^..?\s+/, ""))
    .filter((file) => file !== "PATCHPILOT_TASK.md" && !file.startsWith(".patchpilot-codex-"));
}

async function readSummary(path: string, changedFiles: string[]) {
  try {
    const summary = (await readFile(path, "utf8")).trim();
    if (summary) return summary.slice(0, 2000);
  } catch {
    // The JSONL stream is still authoritative if Codex did not write the optional summary file.
  }
  if (changedFiles.length === 0) return "Codex 执行完成，但没有产生文件变更。";
  return `Codex 执行完成，产生 ${changedFiles.length} 个变更文件。`;
}

function buildTaskMarkdown(context: CodexRunContext) {
  return [
    `# PatchPilot Task ${context.runId}`,
    "",
    "Workspace: git worktree",
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

function buildCodexPrompt(context: CodexRunContext, taskFilePath: string) {
  const method = context.workItem.sourceBugId ? "使用 /diagnose。" : "使用 /tdd。";

  return [
    `完成任务：${context.workItem.title}`,
    `读任务文件：${taskFilePath}`,
    method,
    "只改当前工作区。不要碰生产密钥或生产数据。",
    "完成后说明：变更、测试、风险。"
  ].join("\n");
}

function buildRepairPrompt(context: CodexRunContext, testSummary: string) {
  const method = context.workItem.sourceBugId ? "继续使用 /diagnose。" : "继续使用 /tdd。";

  return [
    `测试失败，修复任务：${context.workItem.title}`,
    method,
    "",
    "失败摘要：",
    testSummary,
    "",
    "完成后说明：修复、测试、风险。"
  ].join("\n");
}

function parseCodexEvent(line: string) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "codex.event";
    const sessionId =
      typeof event.session_id === "string"
        ? event.session_id
        : typeof event.sessionId === "string"
          ? event.sessionId
          : undefined;
    const rawMessage =
      stringValue(event.message) ||
      stringValue(event.msg) ||
      stringValue(event.delta) ||
      stringValue(event.text) ||
      stringValue(event.summary);
    const message = rawMessage ? `Codex：${rawMessage.slice(0, 180)}` : `Codex event：${type}`;
    return { message, sessionId };
  } catch {
    const trimmed = line.trim();
    return { message: trimmed ? `Codex：${trimmed.slice(0, 180)}` : undefined, sessionId: undefined };
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
