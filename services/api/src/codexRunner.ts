import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type {
  AgentRunEvent,
  AgentRunResult,
  Prd,
  Requirement,
  TestRun,
  TimelineStepKey,
  WorkItem
} from "@patchpilot/domain";

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

const commandTimeoutMs = () => Number(process.env.PATCHPILOT_CODEX_TIMEOUT_MS || 10 * 60 * 1000);
const testTimeoutMs = () => Number(process.env.PATCHPILOT_TEST_TIMEOUT_MS || 2 * 60 * 1000);

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
  const workspace = await prepareWorkspace(context);
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

  const firstCodexRun = await runCodexExec(workspace.path, prompt, emit);
  await emit({
    step: "testing",
    type: "test.started",
    message: "Codex 执行结束，开始运行项目测试"
  });

  let testRun = await runProjectTests(workspace.path);
  const repairAttempts = Number(process.env.PATCHPILOT_MAX_REPAIR_ATTEMPTS || 1);

  for (let attempt = 1; testRun.status === "failed" && attempt <= repairAttempts; attempt += 1) {
    await emit({
      step: "developing",
      type: "test.failed",
      message: `测试未通过，启动第 ${attempt} 次 Codex 修复回合`
    });
    await runCodexExec(workspace.path, buildRepairPrompt(context, testRun.summary), emit);
    await emit({
      step: "testing",
      type: "test.started",
      message: `第 ${attempt} 次修复完成，重新运行测试`
    });
    testRun = await runProjectTests(workspace.path);
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
    previewUrl: process.env.PATCHPILOT_PREVIEW_URL || "http://localhost:3000",
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

async function prepareWorkspace(context: CodexRunContext) {
  const root = process.env.PATCHPILOT_WORKSPACE_ROOT || join(process.cwd(), ".patchpilot", "worktrees");
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

async function runCodexExec(workspacePath: string, prompt: string, emit: EmitRunnerEvent) {
  const lastMessagePath = join(workspacePath, `.patchpilot-codex-${randomUUID()}.md`);
  const sandbox = process.env.PATCHPILOT_CODEX_SANDBOX || "workspace-write";
  const args = ["exec", "--json", "--sandbox", sandbox, "-C", workspacePath, "-o", lastMessagePath, "-"];
  const useBypass = process.env.PATCHPILOT_CODEX_BYPASS === "true";
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

  const timeout = setTimeout(() => child.kill("SIGTERM"), commandTimeoutMs());
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

async function runProjectTests(workspacePath: string): Promise<TestRun> {
  const command = process.env.PATCHPILOT_TEST_COMMAND || "pnpm -r --if-present test";
  const startedAt = Date.now();
  const result = await runShell(command, workspacePath, testTimeoutMs());
  return {
    id: `test_${randomUUID()}`,
    status: result.exitCode === 0 ? "passed" : "failed",
    command,
    summary: result.exitCode === 0 ? "项目测试通过" : tail(result.output, 1600),
    durationMs: Date.now() - startedAt
  };
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
  return [
    "你是 PatchPilot 平台启动的本地 Codex 开发 agent。",
    `请在当前隔离工作区完成 ${context.workItem.title}。`,
    `任务说明文件：${taskFilePath}`,
    "",
    "要求：",
    "- 只修改当前工作区内的文件。",
    "- 不访问生产密钥或生产数据。",
    "- 优先做能端到端验收的最小垂直切片。",
    "- 开发完成后运行相关测试；如果测试失败，先修复再结束。",
    "- 最终回复必须包含变更摘要、测试命令和剩余风险。"
  ].join("\n");
}

function buildRepairPrompt(context: CodexRunContext, testSummary: string) {
  return [
    "上一轮实现后的测试没有通过，请在当前隔离工作区修复。",
    `任务：${context.workItem.title}`,
    "",
    "测试失败摘要：",
    testSummary,
    "",
    "请只做必要修改，重新运行相关测试，并在最终回复说明修复点。"
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
