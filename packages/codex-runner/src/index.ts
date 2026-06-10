import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  executeCommand,
  shellJoin,
  spawnCommand,
  type CommandAuditEvidence
} from "@patchpilot/command-executor";
import { runTestCommand } from "@patchpilot/testing";
import { GitWorkspaceManager, type WorkspaceManager } from "@patchpilot/workspace-manager";
import { redactJsonValue, redactSecrets, type SecretRedactionOptions } from "@patchpilot/security";
import {
  applyManifestToEgressPolicyConfig,
  generateCapabilityManifest,
  type CapabilityManifest
} from "@patchpilot/policy";
import {
  RootlessContainerSandbox,
  toContainerWorkspacePath,
  type ContainerSandboxConfig
} from "./containerSandbox";
import type {
  AgentRunDiffSummary,
  AgentRunEvent,
  AgentRunResult,
  AgentRunToolCall,
  EgressPolicyEvidence,
  EgressPolicyRuntimeConfig,
  FailureType,
  Prd,
  Requirement,
  SecretBrokerEvidence,
  SecretBrokerRuntimeConfig,
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

export interface CodexRunnerEvent {
  step?: TimelineStepKey;
  type: AgentRunEvent["type"];
  message: string;
}

export type EmitCodexRunnerEvent = (event: CodexRunnerEvent) => Promise<void>;

export interface CodexRunnerConfig {
  test: {
    command: string;
    timeoutMs: number;
    maxRepairAttempts: number;
  };
  dev: {
    workspaceRoot: string;
    previewUrl: string;
  };
  security: {
    codexSandbox: string;
    codexBypass: boolean;
    containerSandbox: ContainerSandboxConfig;
    egressPolicy: EgressPolicyRuntimeConfig;
    secretBroker: SecretBrokerRuntimeConfig;
    secretEnv?: Record<string, string>;
  };
  budget: {
    codexTimeoutMs: number;
    maxCostUsd?: number;
    prdUsd?: number;
    workItemUsd?: number;
    runUsd?: number;
    softThresholdRatio?: number;
  };
  policyManifest?: CapabilityManifest;
}

export interface CodexRunner {
  isAvailable(): Promise<boolean>;
  isGitWorkspaceAvailable(cwd?: string): Promise<boolean>;
  run(context: CodexRunContext, emit: EmitCodexRunnerEvent, config: CodexRunnerConfig): Promise<AgentRunResult>;
}

export class CodexRunError extends Error {
  constructor(
    message: string,
    public readonly failureType: FailureType,
    public readonly testRun?: TestRun,
    public readonly egressPolicyEvidence?: EgressPolicyEvidence,
    public readonly secretBrokerEvidence?: SecretBrokerEvidence,
    public readonly commandAuditEvents: CommandAuditEvidence[] = []
  ) {
    super(message);
    this.name = "CodexRunError";
  }
}

interface ParsedCodexEvent {
  message?: string;
  sessionId?: string;
  agentMessage?: string;
  reasoningSummary?: string;
  toolCall?: AgentRunToolCall;
}

interface CodexExecCapture {
  eventCount: number;
  agentMessages: string[];
  reasoningSummaries: string[];
  toolCalls: AgentRunToolCall[];
}

interface CodexExecResult {
  lastMessagePath: string;
  sessionId?: string;
  capture: CodexExecCapture;
  egressPolicyEvidence?: EgressPolicyEvidence;
}

export {
  RootlessContainerSandbox,
  buildEgressProxyRunArgs,
  buildRootlessContainerRunArgs,
  defaultContainerSandboxConfig,
  defaultEgressPolicyConfig,
  resolveContainerRuntime,
  toContainerWorkspacePath,
  type ContainerRuntimeKind,
  type ContainerSandboxConfig,
  type RootlessContainerSandboxConfig
} from "./containerSandbox";
export {
  EnvSecretProvider,
  LocalFakeSecretProvider,
  SecretBrokerProviderError,
  VaultSecretProvider,
  createSecretBrokerProviderRegistry,
  defaultSecretBrokerGrantTtlSeconds,
  requestedSecretIdsForWorkItem,
  resolveSecretBrokerGrants,
  revokeSecretBrokerGrants,
  rotateSecretBrokerSecret,
  secretCapabilityPrefix,
  type SecretBrokerProvider,
  type SecretBrokerProviderGrant,
  type SecretBrokerProviderReadInput,
  type SecretBrokerProviderRegistry,
  type SecretBrokerResolvedGrant,
  type SecretBrokerResolution
} from "./secretBroker";

export class LocalCodexRunner implements CodexRunner {
  constructor(private readonly workspaceManager: WorkspaceManager = new GitWorkspaceManager()) {}

  async isAvailable() {
    try {
      const result = await executeCommand({
        kind: "codex",
        command: "codex",
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxOutputBytes: 4096
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async isGitWorkspaceAvailable(cwd = process.cwd()) {
    return this.workspaceManager.isGitWorkspaceAvailable(cwd);
  }

  async run(
    context: CodexRunContext,
    emit: EmitCodexRunnerEvent,
    config: CodexRunnerConfig
  ): Promise<AgentRunResult> {
    const capabilityManifest = config.policyManifest ?? generateCapabilityManifest({
      runId: context.runId,
      prdId: context.prd.id,
      workItem: context.workItem,
      testCommand: config.test.command,
      testTimeoutMs: config.test.timeoutMs,
      security: config.security,
      budget: config.budget,
      createdBy: "codex-runner"
    });
    const effectiveConfig: CodexRunnerConfig = {
      ...config,
      policyManifest: capabilityManifest,
      security: {
        ...config.security,
        egressPolicy: applyManifestToEgressPolicyConfig(config.security.egressPolicy, capabilityManifest)
      }
    };
    const workspace = await this.workspaceManager.prepareWorkspace(context, {
      workspaceRoot: effectiveConfig.dev.workspaceRoot,
      capabilityManifest
    });
    await emit({
      step: "developing",
      type: "workspace.created",
      message: `已创建隔离 worktree：${workspace.path}`
    });

    const containerSandbox = config.security.containerSandbox.enabled
      ? new RootlessContainerSandbox({
          ...effectiveConfig.security.containerSandbox,
          egressPolicy: effectiveConfig.security.egressPolicy
        })
      : undefined;
    if (containerSandbox) {
      await emit({
        step: "developing",
        type: "workspace.created",
        message: `已启用 rootless container sandbox：${effectiveConfig.security.containerSandbox.runtime}/${effectiveConfig.security.containerSandbox.image}`
      });
      if (effectiveConfig.security.egressPolicy.enabled) {
        await emit({
          step: "developing",
          type: "workspace.created",
          message: `已启用网络 egress allowlist：${effectiveConfig.security.egressPolicy.allowedHosts.length} 个静态目的地，Git remote 动态放行=${effectiveConfig.security.egressPolicy.allowGitRemotes}`
        });
      }
    }

    const taskFilePath = containerSandbox
      ? toContainerWorkspacePath(workspace.path, workspace.taskFilePath)
      : workspace.taskFilePath;
    const redactionOptions = redactionOptionsForConfig(config);
    const prompt = redactSecrets(buildCodexPrompt(context, taskFilePath), redactionOptions).redacted;
    await emit({
      step: "developing",
      type: "codex.started",
      message: "本地 Codex agent 已启动，正在隔离 worktree 中开发"
    });

    const codexExecResults: CodexExecResult[] = [];
    const firstCodexRun = await runCodexExec(
      workspace.path,
      prompt,
      emit,
      effectiveConfig,
      containerSandbox,
      capabilityManifest
    );
    codexExecResults.push(firstCodexRun);
    await emit({
      step: "testing",
      type: "test.started",
      message: "Codex 执行结束，开始运行项目测试"
    });

    let testRun = await runConfiguredTests(context, workspace.path, effectiveConfig, containerSandbox, capabilityManifest);
    const repairAttempts = effectiveConfig.test.maxRepairAttempts;

    for (let attempt = 1; testRun.status === "failed" && attempt <= repairAttempts; attempt += 1) {
      await emit({
        step: "developing",
        type: "test.failed",
        message: `测试未通过，启动第 ${attempt} 次 Codex 修复回合`
      });
      const repairCodexRun = await runCodexExec(
        workspace.path,
        redactSecrets(buildRepairPrompt(context, testRun.summary), redactionOptions).redacted,
        emit,
        effectiveConfig,
        containerSandbox,
        capabilityManifest
      );
      codexExecResults.push(repairCodexRun);
      await emit({
        step: "testing",
        type: "test.started",
        message: `第 ${attempt} 次修复完成，重新运行测试`
      });
      testRun = await runConfiguredTests(context, workspace.path, effectiveConfig, containerSandbox, capabilityManifest);
    }

    if (testRun.status !== "passed") {
      throw new CodexRunError(`测试未通过：${testRun.summary}`, "test_failed", testRun);
    }

    await emit({
      step: "testing",
      type: "test.passed",
      message: "目标测试通过，正在整理 diff 和审查摘要"
    });

    const artifacts = await this.workspaceManager.collectArtifacts(workspace, {
      summaryPath: firstCodexRun.lastMessagePath,
      capabilityManifest
    });
    const changedFiles = artifacts.changedFiles;
    await emit({
      step: "confirming",
      type: "git.diff.created",
      message: changedFiles.length > 0 ? `已发现 ${changedFiles.length} 个变更文件` : "Codex 没有产生文件变更"
    });
    const commit = await this.workspaceManager.commitWorkspace(workspace, {
      message: buildCommitMessage(context),
      capabilityManifest
    });
    const diffSummary = buildDiffSummary(changedFiles, commit);
    const finalizedTests = [testRun].map((test) => ({
      ...test,
      branch: test.branch || commit.branchName,
      commit: commit.headCommit
    }));
    const codexCapture = mergeCodexCaptures(codexExecResults.map((result) => result.capture));
    const egressPolicyEvidence = containerSandbox
      ? await containerSandbox.collectEgressPolicyEvidence(workspace.path)
      : undefined;

    return {
      summary: artifacts.summary,
      previewUrl: effectiveConfig.dev.previewUrl,
      riskLevel: changedFiles.length > 12 ? "medium" : "low",
      changedFiles,
      tests: finalizedTests,
      reviewerSummary:
        "本次交付在隔离 worktree 中完成，平台已收集变更文件、测试命令和执行摘要。验收通过后仍需人工按仓库规则合并。",
      runner: "codex",
      agentMessages: codexCapture.agentMessages,
      reasoningSummaries: codexCapture.reasoningSummaries,
      toolCalls: codexCapture.toolCalls,
      diffSummary,
      testOutputSummary: summarizeTestOutput(finalizedTests),
      workspacePath: workspace.path,
      branchName: commit.branchName,
      baseBranch: commit.baseBranch,
      baseCommit: commit.baseCommit,
      headCommit: commit.headCommit,
      codexSessionId: firstCodexRun.sessionId,
      ...(egressPolicyEvidence ? { egressPolicyEvidence } : {})
    };
  }
}

async function runConfiguredTests(
  context: CodexRunContext,
  workspacePath: string,
  config: CodexRunnerConfig,
  containerSandbox: RootlessContainerSandbox | undefined,
  capabilityManifest: CapabilityManifest
): Promise<TestRun> {
  let egressPolicyEvidence: EgressPolicyEvidence | undefined;
  const testRun = await runTestCommand({
    command: config.test.command,
    cwd: workspacePath,
    timeoutMs: config.test.timeoutMs,
    runId: context.runId,
    prdId: context.prd.id,
    workItemId: context.workItem.id,
    workspacePath,
    env: buildCommandEnv(config.security.secretEnv),
    inheritEnv: false,
    capabilityManifest,
    ...(containerSandbox
      ? {
          runner: "patchpilot-container-test-runner",
          environmentImage: config.security.containerSandbox.image,
          executor: async (options) => {
            const result = await containerSandbox.run({
              workspacePath: options.cwd,
              command: options.command,
              timeoutMs: options.timeoutMs,
              env: options.env,
              maxOutputBytes: options.maxOutputBytes
            });
            egressPolicyEvidence = result.egressPolicyEvidence;
            const quotaOutput = result.diskLimitExceeded
              ? `${result.output}\nContainer sandbox workspace disk quota exceeded.`
              : result.output;
            return {
              exitCode: result.diskLimitExceeded && result.exitCode === 0 ? 1 : result.exitCode,
              output: quotaOutput,
              timedOut: result.timedOut,
              durationMs: result.durationMs
            };
          }
        }
      : {})
  });
  return egressPolicyEvidence ? { ...testRun, egressPolicyEvidence } : testRun;
}

async function runCodexExec(
  workspacePath: string,
  prompt: string,
  emit: EmitCodexRunnerEvent,
  config: CodexRunnerConfig,
  containerSandbox: RootlessContainerSandbox | undefined,
  capabilityManifest: CapabilityManifest
): Promise<CodexExecResult> {
  const lastMessageFileName = `.patchpilot-codex-${randomUUID()}.md`;
  const lastMessagePath = join(workspacePath, lastMessageFileName);
  const codexWorkspacePath = containerSandbox ? "/workspace" : workspacePath;
  const codexLastMessagePath = containerSandbox ? `/workspace/${lastMessageFileName}` : lastMessagePath;
  const sandbox = config.security.codexSandbox;
  const args = ["exec", "--json", "--sandbox", sandbox, "-C", codexWorkspacePath, "-o", codexLastMessagePath, "-"];
  const useBypass = config.security.codexBypass;
  const redactionOptions = redactionOptionsForConfig(config);
  if (useBypass) {
    args.splice(2, 2, "--dangerously-bypass-approvals-and-sandbox");
  }
  if (containerSandbox || !existsSync(join(workspacePath, ".git"))) {
    args.splice(args.length - 1, 0, "--skip-git-repo-check");
  }
  const timeoutMs = resolveCapabilityRuntimeTimeoutMs(config.budget.codexTimeoutMs, capabilityManifest);

  const commandProcess = await spawnCommand({
    kind: "codex",
    command: "codex",
    args,
    cwd: workspacePath,
    timeoutMs,
    env: buildCommandEnv(config.security.secretEnv),
    inheritEnv: false,
    capabilityManifest,
    redaction: redactionOptions,
    ...(containerSandbox
      ? {
          spawnDelegate: async (options) => {
            const sandboxedProcess = await containerSandbox.spawn({
              workspacePath,
              command: shellJoin([options.command, ...(options.args ?? [])]),
              timeoutMs: options.timeoutMs,
              env: options.env
            });
            return {
              child: sandboxedProcess.child,
              done: sandboxedProcess.done
            };
          }
        }
      : {})
  });
  const child = commandProcess.child;

  child.stdin.end(redactSecrets(prompt, redactionOptions).redacted);

  let stdoutBuffer = "";
  let sessionId: string | undefined;
  let emitted = 0;
  let pendingEmit = Promise.resolve();
  const capture = emptyCodexCapture();

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseCodexEvent(line, redactionOptions);
      if (event.sessionId) sessionId = event.sessionId;
      recordCodexCapture(capture, event);
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
  const commandResult = await commandProcess.done;
  const sandboxCompletion = commandResult.delegateResult as
    | {
        timedOut: boolean;
        diskLimitExceeded: boolean;
        durationMs: number;
        egressPolicyEvidence?: EgressPolicyEvidence;
      }
    | undefined;
  await pendingEmit;

  if (commandResult.exitCode !== 0 || sandboxCompletion?.diskLimitExceeded) {
    const egressPolicyEvidence = sandboxCompletion?.egressPolicyEvidence;
    const message = summarizeCodexExecFailure({
      stderr: sandboxCompletion?.diskLimitExceeded
        ? `${commandResult.stderr}\nContainer sandbox workspace disk quota exceeded.`
        : commandResult.stderr,
      stdoutRemainder: stdoutBuffer,
      exitCode: commandResult.exitCode
    }, redactionOptions);
    throw new CodexRunError(
      message,
      classifyFailureMessage(message),
      undefined,
      egressPolicyEvidence,
      undefined,
      commandResult.auditEvents
    );
  }

  return {
    lastMessagePath,
    sessionId,
    capture,
    ...(sandboxCompletion?.egressPolicyEvidence ? { egressPolicyEvidence: sandboxCompletion.egressPolicyEvidence } : {})
  };
}

export function resolveCapabilityRuntimeTimeoutMs(
  configuredTimeoutMs: number,
  capabilityManifest: Pick<CapabilityManifest, "runtime">
) {
  return Math.min(configuredTimeoutMs, capabilityManifest.runtime.maxRuntimeMs);
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

function buildCommitMessage(context: CodexRunContext) {
  const title = redactSecrets(context.workItem.title).redacted.replace(/\s+/g, " ").trim();
  return `PatchPilot ${context.workItem.id}: ${title}`.slice(0, 160);
}

export function parseCodexEvent(line: string, options: SecretRedactionOptions = {}): ParsedCodexEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "codex.event";
    const item = asRecord(event.item);
    const sessionId =
      typeof event.session_id === "string"
        ? event.session_id
        : typeof event.sessionId === "string"
          ? event.sessionId
          : undefined;
    const agentMessage = extractAgentMessage(event, item, type);
    const reasoningSummary = extractReasoningSummary(event, item, type);
    const toolCall = extractToolCall(event, item, type, line);
    const rawMessage =
      agentMessage ||
      reasoningSummary ||
      toolCall?.summary ||
      stringValue(event.message) ||
      stringValue(event.msg) ||
      stringValue(event.delta) ||
      stringValue(event.text) ||
      stringValue(event.summary);
    const message = rawMessage ? `Codex：${rawMessage.slice(0, 180)}` : `Codex event：${type}`;
    return redactJsonValue({
      message,
      sessionId,
      ...(agentMessage ? { agentMessage } : {}),
      ...(reasoningSummary ? { reasoningSummary } : {}),
      ...(toolCall ? { toolCall } : {})
    }, options);
  } catch {
    const trimmed = line.trim();
    return {
      message: trimmed ? `Codex：${redactSecrets(trimmed.slice(0, 180), options).redacted}` : undefined,
      sessionId: undefined
    };
  }
}

export function summarizeCodexExecFailure(input: {
  stderr?: string;
  stdoutRemainder?: string;
  exitCode: number | null;
}, options: SecretRedactionOptions = {}) {
  const summary = tail(input.stderr || input.stdoutRemainder || `exit ${input.exitCode}`, 1600);
  return `Codex 执行失败：${redactSecrets(summary, options).redacted}`;
}

export function classifyFailureMessage(message: string): FailureType {
  const normalized = message.toLowerCase();
  if (/budget|quota|cost|余额|预算|额度/u.test(normalized)) return "budget_exhausted";
  if (/policy|denied|approval|sandbox|permission|not allowed|unauthorized|拒绝|权限|策略/u.test(normalized)) {
    return "policy_denied";
  }
  if (/test|assert|expect|failed tests?|测试|断言/u.test(normalized)) return "test_failed";
  if (/timeout|timed out|econnreset|etimedout|rate limit|429|network|temporar|超时|网络|限流/u.test(normalized)) {
    return "transient";
  }
  if (/enoent|eacces|command not found|not found|module not found|workspace|worktree|git|环境/u.test(normalized)) {
    return "environment_failed";
  }
  return "deterministic";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractAgentMessage(
  event: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  type: string
) {
  const itemType = stringValue(item?.type);
  const role = stringValue(event.role) || stringValue(item?.role);
  const looksLikeAgentMessage =
    /agent_message|assistant_message/u.test(type) ||
    /assistant_message/u.test(itemType || "") ||
    (itemType === "message" && role === "assistant");
  if (!looksLikeAgentMessage) return undefined;
  return firstText([
    event.message,
    event.text,
    event.delta,
    event.content,
    item?.message,
    item?.text,
    item?.content
  ]);
}

function extractReasoningSummary(
  event: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  type: string
) {
  const itemType = stringValue(item?.type);
  const looksLikeReasoning =
    /reasoning|reasoning_summary/u.test(type) ||
    /reasoning|reasoning_summary/u.test(itemType || "");
  if (!looksLikeReasoning) return undefined;
  return firstText([
    event.summary,
    event.reasoning,
    event.message,
    event.text,
    item?.summary,
    item?.reasoning,
    item?.text,
    item?.content
  ]);
}

function extractToolCall(
  event: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  type: string,
  rawLine: string
): AgentRunToolCall | undefined {
  const itemType = stringValue(item?.type);
  const command = firstText([
    event.command,
    event.cmd,
    event.command_line,
    event.shell_command,
    item?.command,
    item?.cmd,
    item?.command_line,
    item?.shell_command
  ]);
  const name =
    stringValue(event.tool) ||
    stringValue(event.name) ||
    stringValue(event.tool_name) ||
    stringValue(item?.tool) ||
    stringValue(item?.name) ||
    stringValue(item?.tool_name) ||
    (command ? "exec_command" : undefined);
  const looksLikeTool =
    /tool|exec|command|function_call/u.test(type) ||
    /tool|exec|command|function_call/u.test(itemType || "") ||
    Boolean(command);
  if (!looksLikeTool || !name) return undefined;

  const status = normalizeToolCallStatus(
    stringValue(event.status) ||
    stringValue(item?.status) ||
    type
  );
  const exitCode =
    numberValue(event.exit_code) ??
    numberValue(event.exitCode) ??
    numberValue(item?.exit_code) ??
    numberValue(item?.exitCode);
  const startedAt =
    stringValue(event.started_at) ||
    stringValue(event.startedAt) ||
    stringValue(item?.started_at) ||
    stringValue(item?.startedAt);
  const endedAt =
    stringValue(event.ended_at) ||
    stringValue(event.endedAt) ||
    stringValue(item?.ended_at) ||
    stringValue(item?.endedAt);
  const durationMs =
    numberValue(event.duration_ms) ??
    numberValue(event.durationMs) ??
    numberValue(item?.duration_ms) ??
    numberValue(item?.durationMs);
  const summary = firstText([
    event.summary,
    event.message,
    event.text,
    item?.summary,
    item?.message,
    item?.text
  ]) || (command ? `执行命令：${command}` : `调用工具：${name}`);
  const id =
    stringValue(event.id) ||
    stringValue(event.call_id) ||
    stringValue(event.callId) ||
    stringValue(item?.id) ||
    stringValue(item?.call_id) ||
    stringValue(item?.callId) ||
    stableToolCallId(name, command, rawLine);

  return redactJsonValue({
    id,
    name,
    status,
    summary: tail(summary, 500),
    ...(command ? { command } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  });
}

function firstText(values: unknown[]) {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const parts = value.map((item) => textValue(item)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join("\n").trim() : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return firstText([
    record.text,
    record.summary,
    record.message,
    record.content,
    record.delta,
    record.output
  ]);
}

function normalizeToolCallStatus(value: string): AgentRunToolCall["status"] {
  const normalized = value.toLowerCase();
  if (/fail|error|cancel|denied|timeout/u.test(normalized)) return "failed";
  if (/complete|completed|success|succeeded|finished|done/u.test(normalized)) return "completed";
  if (/start|started|running|in_progress|progress/u.test(normalized)) return "started";
  return "unknown";
}

function stableToolCallId(name: string, command: string | undefined, rawLine: string) {
  const source = `${name}\n${command || ""}\n${rawLine}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return `tool_${Math.abs(hash).toString(36)}`;
}

function emptyCodexCapture(): CodexExecCapture {
  return {
    eventCount: 0,
    agentMessages: [],
    reasoningSummaries: [],
    toolCalls: []
  };
}

function recordCodexCapture(capture: CodexExecCapture, event: ParsedCodexEvent) {
  capture.eventCount += 1;
  appendUnique(capture.agentMessages, event.agentMessage, 20);
  appendUnique(capture.reasoningSummaries, event.reasoningSummary, 20);
  if (event.toolCall) {
    capture.toolCalls = mergeToolCalls([...capture.toolCalls, event.toolCall]);
  }
}

function mergeCodexCaptures(captures: CodexExecCapture[]) {
  return captures.reduce((merged, capture) => ({
    eventCount: merged.eventCount + capture.eventCount,
    agentMessages: mergeUnique(merged.agentMessages, capture.agentMessages, 40),
    reasoningSummaries: mergeUnique(merged.reasoningSummaries, capture.reasoningSummaries, 40),
    toolCalls: mergeToolCalls([...merged.toolCalls, ...capture.toolCalls])
  }), emptyCodexCapture());
}

function appendUnique(values: string[], value: string | undefined, limit: number) {
  if (!value || values.includes(value)) return;
  values.push(tail(value, 2000));
  if (values.length > limit) values.splice(0, values.length - limit);
}

function mergeUnique(left: string[], right: string[], limit: number) {
  const merged: string[] = [];
  for (const value of [...left, ...right]) appendUnique(merged, value, limit);
  return merged;
}

function mergeToolCalls(toolCalls: AgentRunToolCall[]) {
  const byId = new Map<string, AgentRunToolCall>();
  for (const toolCall of toolCalls) {
    const existing = byId.get(toolCall.id);
    if (!existing) {
      byId.set(toolCall.id, toolCall);
      continue;
    }
    byId.set(toolCall.id, {
      ...existing,
      ...toolCall,
      status: chooseToolCallStatus(existing.status, toolCall.status),
      summary: toolCall.summary || existing.summary,
      command: toolCall.command || existing.command,
      startedAt: existing.startedAt || toolCall.startedAt,
      endedAt: toolCall.endedAt || existing.endedAt,
      exitCode: toolCall.exitCode ?? existing.exitCode,
      durationMs: toolCall.durationMs ?? existing.durationMs
    });
  }
  return [...byId.values()].slice(-50);
}

function chooseToolCallStatus(
  existing: AgentRunToolCall["status"],
  next: AgentRunToolCall["status"]
) {
  if (next !== "unknown") return next;
  return existing;
}

function buildDiffSummary(
  changedFiles: string[],
  git: {
    branchName?: string;
    baseBranch?: string;
    baseCommit?: string;
    headCommit?: string;
  }
): AgentRunDiffSummary {
  return {
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.map((file) => redactSecrets(file).redacted),
    hasChanges: changedFiles.length > 0,
    ...(git.branchName ? { branchName: git.branchName } : {}),
    ...(git.baseBranch ? { baseBranch: git.baseBranch } : {}),
    ...(git.baseCommit ? { baseCommit: git.baseCommit } : {}),
    ...(git.headCommit ? { headCommit: git.headCommit } : {})
  };
}

function redactionOptionsForConfig(config: CodexRunnerConfig): SecretRedactionOptions {
  return { knownSecrets: Object.values(config.security.secretEnv ?? {}) };
}

function summarizeTestOutput(tests: TestRun[]) {
  return tail(
    tests.map((test) => {
      const failure = test.failureSummary ? `；失败摘要：${test.failureSummary}` : "";
      return `${test.status}: ${test.command} (${test.durationMs}ms)：${test.summary}${failure}`;
    }).join("\n"),
    4000
  );
}

function buildCommandEnv(secretEnv: Record<string, string> = {}) {
  return compactEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CI: "1",
    ...secretEnv
  });
}

function compactEnv(env: Record<string, string | undefined>) {
  const compacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/^[A-Z_][A-Z0-9_]*$/u.test(key)) continue;
    compacted[key] = value;
  }
  return compacted;
}

function tail(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}
