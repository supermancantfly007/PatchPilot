import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  resolveContainerRuntime,
  toContainerWorkspacePath,
  type ContainerSandboxConfig
} from "./containerSandbox";
import type {
  AgentRunDiffSummary,
  AgentRunEvent,
  AgentRunResult,
  AgentRunToolCall,
  AgentRunnerKind,
  AgentRunnerAvailability,
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
    repositoryRoot: string;
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
  pi?: PiRunnerConfig;
  policyManifest?: CapabilityManifest;
}

export interface CodexRunner {
  availability?(cwd?: string): Promise<AgentRunnerAvailability>;
  isAvailable(): Promise<boolean>;
  isGitWorkspaceAvailable(cwd?: string): Promise<boolean>;
  run(context: CodexRunContext, emit: EmitCodexRunnerEvent, config: CodexRunnerConfig): Promise<AgentRunResult>;
}

export type DurableRunnerSurface =
  | "codex-exec-json"
  | "codex-sdk"
  | "codex-mcp"
  | "pi-json-cli"
  | "pi-rpc"
  | "pi-sdk"
  | "fake";

export type DurableRunnerStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface DurableRunnerCapabilities {
  resume: boolean;
  cancel: boolean;
  stateInspection: boolean;
  artifactCollection: boolean;
}

export interface DurableRunnerProviderOptions {
  provider?: string;
  model?: string;
  thinking?: string;
  [key: string]: unknown;
}

export interface DurableRunnerStartInput {
  runner: AgentRunnerKind;
  surface: DurableRunnerSurface;
  runId: string;
  workspaceRunId: string;
  workItemId: string;
  workspacePath: string;
  taskFilePath: string;
  idempotencyKey: string;
  prompt: string;
  capabilities: DurableRunnerCapabilities;
  capabilityManifestId?: string;
  providerOptions?: DurableRunnerProviderOptions;
  artifactIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface DurableRunnerHandle {
  runner: AgentRunnerKind;
  surface: DurableRunnerSurface;
  runId: string;
  workspaceRunId: string;
  workItemId: string;
  idempotencyKey: string;
  providerRunId: string;
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  processId?: number;
  parentProviderRunId?: string;
  status: DurableRunnerStatus;
  startedAt: string;
  endedAt?: string;
  supportsResume: boolean;
  supportsCancel: boolean;
  supportsStateInspection: boolean;
  artifactIds: string[];
  resumeCount?: number;
  metadata?: Record<string, unknown>;
}

export interface DurableRunnerHandleInput {
  handle: DurableRunnerHandle;
}

export interface DurableRunnerResumeInput extends DurableRunnerHandleInput {
  idempotencyKey: string;
  prompt: string;
  capabilityManifestId?: string;
  metadata?: Record<string, unknown>;
}

export interface DurableRunnerCancelInput extends DurableRunnerHandleInput {
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface DurableRunnerCancelResult {
  handle: DurableRunnerHandle;
  acknowledged: boolean;
  processTerminated: boolean;
  workspaceRetained: boolean;
  reason?: string;
  artifactIds?: string[];
}

export interface DurableRunnerEvent extends CodexRunnerEvent {
  at?: string;
  providerEventId?: string;
  status?: DurableRunnerStatus;
  artifactIds?: string[];
}

export interface DurableRunnerState extends DurableRunnerHandleInput {
  status: DurableRunnerStatus;
  lastAssistantMessage?: string;
  pendingAction?: string;
  failureSummary?: string;
  artifactIds: string[];
  metadata?: Record<string, unknown>;
}

export interface DurableRunnerArtifacts extends DurableRunnerHandleInput {
  artifactIds: string[];
  summaryArtifactId?: string;
  transcriptArtifactId?: string;
  rawProviderEventArtifactId?: string;
  sessionExportArtifactId?: string;
  debugArtifactIds?: string[];
}

export interface DurableRunnerFailureSummary {
  failureType?: FailureType;
  message: string;
  retryable?: boolean;
  artifactIds: string[];
}

export interface DurableAgentRunner {
  start(input: DurableRunnerStartInput): Promise<DurableRunnerHandle>;
  resume(input: DurableRunnerResumeInput): Promise<DurableRunnerHandle>;
  cancel(input: DurableRunnerCancelInput): Promise<DurableRunnerCancelResult>;
  streamEvents(input: DurableRunnerHandleInput): AsyncIterable<DurableRunnerEvent>;
  inspectState(input: DurableRunnerHandleInput): Promise<DurableRunnerState>;
  collectArtifacts(input: DurableRunnerHandleInput): Promise<DurableRunnerArtifacts>;
  summarizeFailure(input: DurableRunnerHandleInput): Promise<DurableRunnerFailureSummary>;
}

export class CodexRunError extends Error {
  constructor(
    message: string,
    public readonly failureType: FailureType,
    public readonly testRun?: TestRun,
    public readonly egressPolicyEvidence?: EgressPolicyEvidence,
    public readonly secretBrokerEvidence?: SecretBrokerEvidence,
    public readonly commandAuditEvents: CommandAuditEvidence[] = [],
    public readonly securityPreflightEvidence?: PiSecurityPreflightEvidence
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

export interface PiRunnerConfig {
  command: string;
  provider?: string;
  model?: string;
  thinking?: string;
  agentDir?: string;
  sessionDir?: string;
  stateRoot?: string;
  timeoutMs: number;
  skipVersionCheck: boolean;
  disableTelemetry: boolean;
  offline: boolean;
}

interface PiStateDirs {
  home: string;
  agentDir: string;
  sessionDir: string;
}

interface PiRunnerRuntimeOptions {
  nodeVersion?: string;
}

interface ParsedPiEvent {
  type?: AgentRunEvent["type"];
  message?: string;
  sessionId?: string;
  agentMessage?: string;
  reasoningSummary?: string;
  toolCall?: AgentRunToolCall;
}

interface PiExecResult {
  lastMessagePath: string;
  transcriptPath: string;
  sessionId?: string;
  capture: CodexExecCapture;
  egressPolicyEvidence?: EgressPolicyEvidence;
}

const verifiedPiVersion = "0.79.3";
const requiredPiNodeEngine = ">=22.19.0";

type PiSecurityPreflightMode = "production" | "local_unsafe" | "fake";
type PiSecurityPreflightIsolationMode = "rootless_container" | "host_user";
type PiSecurityPreflightEgressPolicy =
  | "proxy_exact_host"
  | "proxy_missing_provider_host"
  | "disabled_explicit_local_degraded"
  | "disabled_unapproved"
  | "disabled_fake";
type PiSecurityPreflightSecretBroker =
  | "broker_injected"
  | "not_required"
  | "broker_disabled"
  | "missing_manifest_grant"
  | "missing_injected_secret";
type PiSecurityPreflightInternalToolCommandPolicy =
  | "observed_after_execution"
  | "requires_pre_execution_enforcement"
  | "not_applicable";
type PiSecurityPreflightPreExecutionCommandPolicy = "pi_process_only" | "not_applicable";

export interface PiSecurityPreflightEvidence {
  mode: PiSecurityPreflightMode;
  provider?: string;
  providerHost?: string;
  providerSecretId?: string;
  providerSecretEnvVar?: string;
  isolationMode: PiSecurityPreflightIsolationMode;
  egressPolicy: PiSecurityPreflightEgressPolicy;
  egressAllowedHosts: string[];
  secretBroker: PiSecurityPreflightSecretBroker;
  internalToolCommandPolicy: PiSecurityPreflightInternalToolCommandPolicy;
  preExecutionCommandPolicy: PiSecurityPreflightPreExecutionCommandPolicy;
  enforcementGaps: string[];
}

export type PiSecurityPreflightResult =
  | { status: "passed"; evidence: PiSecurityPreflightEvidence }
  | { status: "failed"; failureType: FailureType; reason: string; evidence?: PiSecurityPreflightEvidence };

interface PiProviderProfile {
  provider: string;
  host: string;
  secretId: string;
  secretEnvVar: string;
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

  async availability(cwd = process.cwd()): Promise<AgentRunnerAvailability> {
    let runnerAvailable = false;
    let runnerReason: string | undefined;
    try {
      const result = await executeCommand({
        kind: "codex",
        command: "codex",
        args: ["--version"],
        cwd,
        timeoutMs: 5000,
        maxOutputBytes: 4096
      });
      runnerAvailable = result.exitCode === 0;
      if (!runnerAvailable) {
        runnerReason = tail(result.stderr || result.stdout || result.output || `exit ${result.exitCode}`, 600);
      }
    } catch (error) {
      runnerReason = error instanceof Error ? error.message : "Codex availability check failed";
    }

    const gitWorkspaceAvailable = await this.isGitWorkspaceAvailable(cwd).catch(() => false);
    const available = runnerAvailable && gitWorkspaceAvailable;
    return compactAvailability({
      runner: "codex",
      status: available ? "available" : "unavailable",
      available,
      runnerAvailable,
      gitWorkspaceAvailable,
      mode: "local_unsafe",
      ...(!runnerAvailable
        ? { reason: runnerReason || "Codex CLI is not available" }
        : !gitWorkspaceAvailable
          ? { reason: "A git workspace is required for Codex execution" }
          : {})
    });
  }

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
      repositoryRoot: effectiveConfig.dev.repositoryRoot,
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

export class LocalPiRunner implements CodexRunner {
  constructor(
    private readonly workspaceManager: WorkspaceManager = new GitWorkspaceManager(),
    private readonly piDefaults: Partial<PiRunnerConfig> = {},
    private readonly runtime: PiRunnerRuntimeOptions = {}
  ) {}

  async availability(cwd = process.cwd()): Promise<AgentRunnerAvailability> {
    const piConfig = resolvePiAvailabilityConfig(this.piDefaults);
    const gitWorkspaceAvailable = await this.isGitWorkspaceAvailable(cwd).catch(() => false);
    const nodeVersion = this.runtime.nodeVersion ?? process.version;
    const detailsBase = {
      command: piConfig.command,
      nodeVersion,
      requiredNodeEngine: requiredPiNodeEngine,
      verifiedVersion: verifiedPiVersion
    };
    const nodeCheck = checkNodeEngine(nodeVersion);
    if (!nodeCheck.ok) {
      return compactAvailability({
        runner: "pi",
        status: "unavailable",
        available: false,
        runnerAvailable: false,
        gitWorkspaceAvailable,
        mode: "local_unsafe",
        reason: `Node runtime ${nodeVersion} does not satisfy Pi engine requirement ${requiredPiNodeEngine}.`,
        details: detailsBase
      });
    }

    let versionOutput = "";
    let version = "";
    try {
      const result = await executeCommand({
        kind: "pi",
        command: piConfig.command,
        args: ["--version"],
        cwd,
        timeoutMs: 5000,
        env: compactEnv({ PATH: process.env.PATH }),
        inheritEnv: false,
        maxOutputBytes: 4096
      });
      versionOutput = (result.stdout || result.stderr || result.output).trim();
      if (result.exitCode !== 0) {
        const reason = summarizePiVersionCommandFailure(result.stderr || result.stdout || result.output, result.exitCode);
        return compactAvailability({
          runner: "pi",
          status: "unavailable",
          available: false,
          runnerAvailable: false,
          gitWorkspaceAvailable,
          mode: "local_unsafe",
          reason,
          details: {
            ...detailsBase,
            versionOutput
          }
        });
      }
      version = extractSemver(versionOutput) || "";
    } catch (error) {
      return compactAvailability({
        runner: "pi",
        status: "unavailable",
        available: false,
        runnerAvailable: false,
        gitWorkspaceAvailable,
        mode: "local_unsafe",
        reason: isMissingCommandError(error) ? "Pi CLI is not installed" : error instanceof Error ? error.message : "Pi availability check failed",
        details: detailsBase
      });
    }

    const details = {
      ...detailsBase,
      ...(version ? { version } : {}),
      ...(versionOutput ? { versionOutput } : {})
    };
    if (isFakePiMode(piConfig)) {
      return compactAvailability({
        runner: "pi",
        status: "degraded",
        available: gitWorkspaceAvailable,
        runnerAvailable: true,
        gitWorkspaceAvailable,
        mode: "fake",
        reason: "Fake Pi command configured for tests.",
        details: {
          ...details,
          fake: true
        }
      });
    }
    if (!version) {
      return compactAvailability({
        runner: "pi",
        status: "unavailable",
        available: false,
        runnerAvailable: false,
        gitWorkspaceAvailable,
        mode: "local_unsafe",
        reason: `Pi version output did not include a semver version: ${tail(versionOutput, 200) || "<empty>"}`,
        details
      });
    }

    const versionComparison = compareSemver(version, verifiedPiVersion);
    if (versionComparison < 0) {
      return compactAvailability({
        runner: "pi",
        status: "unavailable",
        available: false,
        runnerAvailable: false,
        gitWorkspaceAvailable,
        mode: "local_unsafe",
        reason: `Pi version ${version} is older than verified version ${verifiedPiVersion}.`,
        details
      });
    }
    if (versionComparison > 0) {
      return compactAvailability({
        runner: "pi",
        status: "degraded",
        available: false,
        runnerAvailable: false,
        gitWorkspaceAvailable,
        mode: "preview",
        reason: `Pi version ${version} is newer than verified version ${verifiedPiVersion}; update fixtures before real runs.`,
        details
      });
    }

    const available = gitWorkspaceAvailable;
    return compactAvailability({
      runner: "pi",
      status: available ? "available" : "unavailable",
      available,
      runnerAvailable: true,
      gitWorkspaceAvailable,
      mode: "local_unsafe",
      ...(!gitWorkspaceAvailable ? { reason: "A git workspace is required for Pi execution" } : {}),
      details
    });
  }

  async isAvailable() {
    return (await this.availability(process.cwd())).runnerAvailable;
  }

  async isGitWorkspaceAvailable(cwd = process.cwd()) {
    return this.workspaceManager.isGitWorkspaceAvailable(cwd);
  }

  async run(
    context: CodexRunContext,
    emit: EmitCodexRunnerEvent,
    config: CodexRunnerConfig
  ): Promise<AgentRunResult> {
    const piConfig = resolvePiRunnerConfig(config);
    const capabilityManifest = config.policyManifest ?? generateCapabilityManifest({
      runId: context.runId,
      prdId: context.prd.id,
      workItem: context.workItem,
      testCommand: config.test.command,
      testTimeoutMs: config.test.timeoutMs,
      security: config.security,
      budget: config.budget,
      commands: {
        allow: buildPiCommandPolicyAllow(piConfig.command)
      },
      createdBy: "pi-runner"
    });
    const effectiveConfig: CodexRunnerConfig = {
      ...config,
      pi: piConfig,
      policyManifest: capabilityManifest,
      security: {
        ...config.security,
        egressPolicy: applyManifestToEgressPolicyConfig(config.security.egressPolicy, capabilityManifest)
      }
    };
    const securityPreflight = await evaluatePiSecurityPreflight({
      config: effectiveConfig,
      capabilityManifest,
      containerRuntimeResolver: resolveContainerRuntime
    });
    if (securityPreflight.status === "failed") {
      throw new CodexRunError(
        securityPreflight.reason,
        securityPreflight.failureType,
        undefined,
        undefined,
        undefined,
        [],
        securityPreflight.evidence
      );
    }
    const workspace = await this.workspaceManager.prepareWorkspace(context, {
      repositoryRoot: effectiveConfig.dev.repositoryRoot,
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
    const prompt = redactSecrets(buildPiPrompt(context, taskFilePath), redactionOptions).redacted;
    await emit({
      step: "developing",
      type: "agent.started",
      message: "Pi agent 已启动，正在隔离 worktree 中开发"
    });

    const piRuns: PiExecResult[] = [];
    const firstPiRun = await runPiJson(
      workspace.path,
      prompt,
      context,
      emit,
      effectiveConfig,
      containerSandbox,
      capabilityManifest
    );
    piRuns.push(firstPiRun);

    await emit({
      step: "testing",
      type: "test.started",
      message: "Pi 执行结束，开始运行项目测试"
    });

    let testRun = await runConfiguredTests(context, workspace.path, effectiveConfig, containerSandbox, capabilityManifest);
    const repairAttempts = effectiveConfig.test.maxRepairAttempts;

    for (let attempt = 1; testRun.status === "failed" && attempt <= repairAttempts; attempt += 1) {
      await emit({
        step: "developing",
        type: "test.failed",
        message: `测试未通过，启动第 ${attempt} 次 Pi 修复回合`
      });
      const repairPiRun = await runPiJson(
        workspace.path,
        redactSecrets(buildPiRepairPrompt(context, testRun), redactionOptions).redacted,
        context,
        emit,
        effectiveConfig,
        containerSandbox,
        capabilityManifest
      );
      piRuns.push(repairPiRun);
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
      summaryPath: piRuns.at(-1)?.lastMessagePath ?? firstPiRun.lastMessagePath,
      capabilityManifest
    });
    const changedFiles = artifacts.changedFiles;
    await emit({
      step: "confirming",
      type: "git.diff.created",
      message: changedFiles.length > 0 ? `已发现 ${changedFiles.length} 个变更文件` : "Pi 没有产生文件变更"
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
    const piCapture = mergeCodexCaptures(piRuns.map((result) => result.capture));
    const egressPolicyEvidence = containerSandbox
      ? await containerSandbox.collectEgressPolicyEvidence(workspace.path)
      : undefined;
    const piEgressPolicyEvidence = piRuns.find((result) => result.egressPolicyEvidence)?.egressPolicyEvidence;

    return {
      summary: artifacts.summary,
      previewUrl: effectiveConfig.dev.previewUrl,
      riskLevel: changedFiles.length > 12 ? "medium" : "low",
      changedFiles,
      tests: finalizedTests,
      reviewerSummary:
        "本次交付在隔离 worktree 中完成，平台已收集变更文件、测试命令和执行摘要。验收通过后仍需人工按仓库规则合并。",
      runner: "pi",
      agentMessages: piCapture.agentMessages,
      reasoningSummaries: piCapture.reasoningSummaries,
      toolCalls: piCapture.toolCalls,
      diffSummary,
      testOutputSummary: summarizeTestOutput(finalizedTests),
      workspacePath: workspace.path,
      branchName: commit.branchName,
      baseBranch: commit.baseBranch,
      baseCommit: commit.baseCommit,
      headCommit: commit.headCommit,
      securityPreflightEvidence: securityPreflight.evidence,
      ...(egressPolicyEvidence ?? piEgressPolicyEvidence ? {
        egressPolicyEvidence: egressPolicyEvidence ?? piEgressPolicyEvidence
      } : {})
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
  const recentMessages: string[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseCodexEvent(line, redactionOptions);
      if (event.sessionId) sessionId = event.sessionId;
      recordCodexCapture(capture, event);
      const message = event.message;
      if (message) {
        recentMessages.push(message);
        if (recentMessages.length > 20) recentMessages.shift();
      }
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
      stdoutRemainder: [stdoutBuffer.trim(), ...recentMessages].filter(Boolean).join("\n"),
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

export function buildPiCommandPolicyAllow(command: string) {
  const normalized = command.trim() || "pi";
  const displayToken = /^[A-Za-z0-9_./:=@%+,-]+$/u.test(normalized) ? normalized : shellJoin([normalized]);
  return uniqueStrings([
    `${displayToken} --mode json`,
    `${displayToken} --version`,
    `${normalized} --mode json`,
    `${normalized} --version`
  ]);
}

const piProviderProfiles: Record<string, PiProviderProfile> = {
  openai: {
    provider: "openai",
    host: "api.openai.com",
    secretId: "openai-api-key",
    secretEnvVar: "OPENAI_API_KEY"
  },
  anthropic: {
    provider: "anthropic",
    host: "api.anthropic.com",
    secretId: "anthropic-api-key",
    secretEnvVar: "ANTHROPIC_API_KEY"
  }
};

export async function evaluatePiSecurityPreflight(input: {
  config: CodexRunnerConfig;
  capabilityManifest?: CapabilityManifest;
  containerRuntimeResolver?: (runtime: ContainerSandboxConfig["runtime"]) => Promise<string | undefined>;
  env?: Record<string, string | undefined>;
}): Promise<PiSecurityPreflightResult> {
  const config = input.config;
  const piConfig = resolvePiRunnerConfig(config);
  const env = input.env ?? process.env;
  const runtimeAllowedHosts = uniqueStrings(config.security.egressPolicy.allowedHosts);
  const manifestAllowedHosts = uniqueStrings(input.capabilityManifest?.network.allow ?? []);
  const allAllowedHosts = uniqueStrings([...runtimeAllowedHosts, ...manifestAllowedHosts]);

  if (isFakePiMode(piConfig)) {
    return {
      status: "passed",
      evidence: {
        mode: "fake",
        isolationMode: config.security.containerSandbox.enabled ? "rootless_container" : "host_user",
        egressPolicy: config.security.egressPolicy.enabled ? "proxy_exact_host" : "disabled_fake",
        egressAllowedHosts: runtimeAllowedHosts,
        secretBroker: "not_required",
        internalToolCommandPolicy: "not_applicable",
        preExecutionCommandPolicy: "not_applicable",
        enforcementGaps: []
      }
    };
  }

  const provider = (piConfig.provider ?? "").trim().toLowerCase();
  if (!provider) {
    return failPiSecurityPreflight("Pi provider is required for real Pi runs.", "policy_denied");
  }

  const profile = piProviderProfiles[provider];
  if (!profile) {
    return failPiSecurityPreflight(`Unsupported Pi provider: ${provider}.`, "policy_denied");
  }

  if (!input.capabilityManifest) {
    return failPiSecurityPreflight("Capability Manifest is required before launching a real Pi run.", "policy_denied");
  }
  if (input.capabilityManifest.status !== "active") {
    return failPiSecurityPreflight("Capability Manifest must be active before launching a real Pi run.", "policy_denied");
  }

  const allowLocalUnsafe = env.PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE === "1";
  const allowObservedInternalToolPolicy = env.PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY === "1";
  const reducedIsolation = !config.security.containerSandbox.enabled || !config.security.egressPolicy.enabled;
  const evidence = buildPiSecurityPreflightEvidence({
    config,
    profile,
    mode: allowLocalUnsafe && reducedIsolation ? "local_unsafe" : "production",
    egressAllowedHosts: runtimeAllowedHosts,
    secretBroker: "broker_injected",
    internalToolCommandPolicy: allowObservedInternalToolPolicy
      ? "observed_after_execution"
      : "requires_pre_execution_enforcement"
  });

  if (!config.security.containerSandbox.enabled) {
    evidence.isolationMode = "host_user";
    if (!allowLocalUnsafe) {
      return failPiSecurityPreflight(
        "Pi container sandbox is required for production or unattended real Pi runs.",
        "policy_denied",
        evidence
      );
    }
  } else if (input.containerRuntimeResolver) {
    const runtime = await input.containerRuntimeResolver(config.security.containerSandbox.runtime);
    if (!runtime) {
      return failPiSecurityPreflight(
        `Pi container sandbox runtime is unavailable: ${config.security.containerSandbox.runtime}.`,
        "environment_failed",
        evidence
      );
    }
  }

  if (!config.security.egressPolicy.enabled) {
    evidence.egressPolicy = allowLocalUnsafe ? "disabled_explicit_local_degraded" : "disabled_unapproved";
    if (!allowLocalUnsafe) {
      return failPiSecurityPreflight(
        "Pi egress policy is required for production or unattended real Pi runs.",
        "policy_denied",
        evidence
      );
    }
  }

  if (config.security.egressPolicy.enabled) {
    const broadHostPattern = allAllowedHosts.find(isBroadOrWildcardEgressPattern);
    if (broadHostPattern) {
      return failPiSecurityPreflight(
        `Pi provider egress requires exact host mappings; wildcard or broad host mapping is denied: ${broadHostPattern}.`,
        "policy_denied",
        evidence
      );
    }

    const runtimeHasProviderHost = runtimeAllowedHosts.includes(profile.host);
    const manifestHasProviderHost = manifestAllowedHosts.includes(profile.host);
    if (!runtimeHasProviderHost || !manifestHasProviderHost) {
      evidence.egressPolicy = "proxy_missing_provider_host";
      return failPiSecurityPreflight(
        `Pi provider egress is missing exact host mapping for ${profile.host}.`,
        "policy_denied",
        evidence
      );
    }
  }

  if (
    !input.capabilityManifest.secrets.requested.includes(profile.secretId) ||
    !input.capabilityManifest.secrets.allow.includes(profile.secretId)
  ) {
    evidence.secretBroker = "missing_manifest_grant";
    return failPiSecurityPreflight(
      `Pi provider secret ${profile.secretId} is not authorized by the active Capability Manifest.`,
      "policy_denied",
      evidence
    );
  }
  if (!config.security.secretBroker.enabled) {
    evidence.secretBroker = "broker_disabled";
    return failPiSecurityPreflight(
      `Pi provider secret ${profile.secretId} requires Secret Broker injection before launch.`,
      "policy_denied",
      evidence
    );
  }
  if (!config.security.secretEnv?.[profile.secretEnvVar]?.trim()) {
    evidence.secretBroker = "missing_injected_secret";
    return failPiSecurityPreflight(
      `Pi provider secret ${profile.secretId} was not injected into ${profile.secretEnvVar} by the Secret Broker.`,
      "policy_denied",
      evidence
    );
  }

  if (!allowObservedInternalToolPolicy) {
    return failPiSecurityPreflight(
      "Pi pre-execution command enforcement is required before launch; current Pi internal tool actions are observed after execution only.",
      "policy_denied",
      evidence
    );
  }

  evidence.enforcementGaps = ["pi_internal_tool_pre_execution"];
  return {
    status: "passed",
    evidence
  };
}

function buildPiSecurityPreflightEvidence(input: {
  config: CodexRunnerConfig;
  profile: PiProviderProfile;
  mode: PiSecurityPreflightMode;
  egressAllowedHosts: string[];
  secretBroker: PiSecurityPreflightSecretBroker;
  internalToolCommandPolicy: PiSecurityPreflightInternalToolCommandPolicy;
}): PiSecurityPreflightEvidence {
  return {
    mode: input.mode,
    provider: input.profile.provider,
    providerHost: input.profile.host,
    providerSecretId: input.profile.secretId,
    providerSecretEnvVar: input.profile.secretEnvVar,
    isolationMode: input.config.security.containerSandbox.enabled ? "rootless_container" : "host_user",
    egressPolicy: input.config.security.egressPolicy.enabled ? "proxy_exact_host" : "disabled_unapproved",
    egressAllowedHosts: input.egressAllowedHosts,
    secretBroker: input.secretBroker,
    internalToolCommandPolicy: input.internalToolCommandPolicy,
    preExecutionCommandPolicy: "pi_process_only",
    enforcementGaps: input.internalToolCommandPolicy === "observed_after_execution"
      ? ["pi_internal_tool_pre_execution"]
      : []
  };
}

function failPiSecurityPreflight(
  reason: string,
  failureType: FailureType,
  evidence?: PiSecurityPreflightEvidence
): PiSecurityPreflightResult {
  return {
    status: "failed",
    failureType,
    reason,
    ...(evidence ? { evidence } : {})
  };
}

function isBroadOrWildcardEgressPattern(hostPattern: string) {
  const normalized = hostPattern.trim().toLowerCase();
  return (
    normalized.includes("*") ||
    normalized === "0.0.0.0" ||
    normalized === "0.0.0.0/0" ||
    normalized === "::" ||
    normalized === "::/0" ||
    normalized === "all" ||
    normalized === "internet"
  );
}

function resolvePiRunnerConfig(config: CodexRunnerConfig): PiRunnerConfig {
  const input: Partial<PiRunnerConfig> = config.pi ?? {};
  const stateRoot = pickPiString(
    input.stateRoot,
    process.env.PATCHPILOT_PI_STATE_ROOT,
    join(config.dev.repositoryRoot, ".patchpilot", "runner-state")
  );
  return {
    command: pickPiString(input.command, process.env.PATCHPILOT_PI_COMMAND, "pi"),
    provider: pickPiString(input.provider, process.env.PATCHPILOT_PI_PROVIDER, ""),
    model: pickPiString(input.model, process.env.PATCHPILOT_PI_MODEL, ""),
    thinking: pickPiString(input.thinking, process.env.PATCHPILOT_PI_THINKING, ""),
    agentDir: pickPiString(input.agentDir, process.env.PATCHPILOT_PI_AGENT_DIR, ""),
    sessionDir: pickPiString(input.sessionDir, process.env.PATCHPILOT_PI_SESSION_DIR, ""),
    stateRoot: isAbsolute(stateRoot) ? stateRoot : resolve(config.dev.repositoryRoot, stateRoot),
    timeoutMs: pickPiNumber(input.timeoutMs, process.env.PATCHPILOT_PI_TIMEOUT_MS, config.budget.codexTimeoutMs),
    skipVersionCheck: pickPiBoolean(input.skipVersionCheck, process.env.PATCHPILOT_PI_SKIP_VERSION_CHECK, true),
    disableTelemetry: pickPiBoolean(input.disableTelemetry, process.env.PATCHPILOT_PI_DISABLE_TELEMETRY, true),
    offline: pickPiBoolean(input.offline, process.env.PATCHPILOT_PI_OFFLINE, false)
  };
}

function resolvePiAvailabilityConfig(input: Partial<PiRunnerConfig>) {
  return {
    command: pickPiString(input.command, process.env.PATCHPILOT_PI_COMMAND, "pi"),
    provider: pickPiString(input.provider, process.env.PATCHPILOT_PI_PROVIDER, ""),
    timeoutMs: pickPiNumber(input.timeoutMs, process.env.PATCHPILOT_PI_TIMEOUT_MS, 5000)
  };
}

function compactAvailability(availability: AgentRunnerAvailability): AgentRunnerAvailability {
  return {
    runner: availability.runner,
    status: availability.status,
    available: availability.available,
    runnerAvailable: availability.runnerAvailable,
    gitWorkspaceAvailable: availability.gitWorkspaceAvailable,
    ...(availability.reason ? { reason: availability.reason } : {}),
    ...(availability.mode ? { mode: availability.mode } : {}),
    ...(availability.details ? { details: availability.details } : {})
  };
}

function checkNodeEngine(nodeVersion: string) {
  const current = parseSemver(nodeVersion);
  const required = parseSemver(requiredPiNodeEngine);
  return {
    ok: Boolean(current && required && compareParsedSemver(current, required) >= 0)
  };
}

function summarizePiVersionCommandFailure(output: string | undefined, exitCode: number | null) {
  const summary = tail((output || "").trim(), 600);
  if (/enoent|not found|no such file/i.test(summary)) return "Pi CLI is not installed";
  return summary || `Pi --version failed with exit ${exitCode}`;
}

function isMissingCommandError(error: unknown) {
  return error instanceof Error && /enoent|not found|no such file/i.test(error.message);
}

function isFakePiMode(piConfig: Pick<PiRunnerConfig, "command" | "provider">) {
  const provider = (piConfig.provider ?? "").trim().toLowerCase();
  const command = piConfig.command.trim().toLowerCase();
  return provider === "fake" || process.env.PATCHPILOT_PI_FAKE === "1" || /(^|[/_-])fake-pi|pi-fake/u.test(command);
}

function extractSemver(output: string) {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/u);
  return match?.[0];
}

function compareSemver(left: string, right: string) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return 0;
  return compareParsedSemver(parsedLeft, parsedRight);
}

function parseSemver(value: string) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function compareParsedSemver(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number }
) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

async function runPiJson(
  workspacePath: string,
  prompt: string,
  context: CodexRunContext,
  emit: EmitCodexRunnerEvent,
  config: CodexRunnerConfig,
  containerSandbox: RootlessContainerSandbox | undefined,
  capabilityManifest: CapabilityManifest
): Promise<PiExecResult> {
  const piConfig = resolvePiRunnerConfig(config);
  const lastMessageFileName = `.patchpilot-pi-${randomUUID()}.md`;
  const lastMessagePath = join(workspacePath, lastMessageFileName);
  const transcriptFileName = `.patchpilot-pi-transcript-${randomUUID()}.jsonl`;
  const transcriptPath = join(workspacePath, transcriptFileName);
  const redactionOptions = redactionOptionsForConfig(config);
  const stateDirs = await resolvePiStateDirs(piConfig, context.runId, workspacePath);
  const args = buildPiArgs(piConfig, prompt);
  const timeoutMs = resolveCapabilityRuntimeTimeoutMs(piConfig.timeoutMs, capabilityManifest);
  await writeFile(transcriptPath, "", "utf8");

  const commandProcess = await spawnCommand({
    kind: "pi",
    command: piConfig.command,
    args,
    cwd: workspacePath,
    timeoutMs,
    env: buildPiEnv(piConfig, stateDirs, config.security.secretEnv),
    inheritEnv: false,
    capabilityManifest,
    redaction: redactionOptions,
    maxOutputBytes: 512 * 1024,
    ...(containerSandbox
      ? {
          spawnDelegate: async (options) => {
            const sandboxedProcess = await containerSandbox.spawn({
              workspacePath,
              command: shellJoin([options.command, ...(options.args ?? [])]),
              timeoutMs: options.timeoutMs,
              env: options.env,
              maxOutputBytes: options.maxOutputBytes
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
  child.stdin.end();

  let stdoutBuffer = "";
  let sessionId: string | undefined;
  let emitted = 0;
  let pendingEmit = Promise.resolve();
  let pendingTranscriptWrite = Promise.resolve();
  const capture = emptyCodexCapture();
  const recentMessages: string[] = [];
  const parseErrors: string[] = [];
  let lineNumber = 0;
  let sawAgentStart = false;
  let sawAgentEnd = false;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    lineNumber += 1;
    pendingTranscriptWrite = pendingTranscriptWrite.then(() =>
      appendFile(transcriptPath, `${redactSecrets(trimmed, redactionOptions).redacted}\n`, "utf8")
    );
    let rawEvent: Record<string, unknown>;
    try {
      rawEvent = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parseErrors.push(`line ${lineNumber}: ${tail(trimmed, 240)}`);
      return;
    }
    const rawType = stringValue(rawEvent.type) || "pi.event";
    if (rawType === "agent_start") sawAgentStart = true;
    if (rawType === "agent_end") sawAgentEnd = true;
    const event = parsePiEvent(trimmed, redactionOptions);
    if (event.sessionId) sessionId = event.sessionId;
    recordCodexCapture(capture, event);
    if (event.message) {
      recentMessages.push(event.message);
      if (recentMessages.length > 20) recentMessages.shift();
    }
    const eventType = event.type;
    const eventMessage = event.message;
    if (eventType && eventMessage && emitted < 50) {
      emitted += 1;
      pendingEmit = pendingEmit.then(() =>
        emit({
          step: "developing",
          type: eventType,
          message: eventMessage
        })
      );
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  });

  const commandResult = await commandProcess.done;
  if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
  const sandboxCompletion = commandResult.delegateResult as
    | {
        timedOut: boolean;
        diskLimitExceeded: boolean;
        durationMs: number;
        egressPolicyEvidence?: EgressPolicyEvidence;
      }
    | undefined;
  await pendingTranscriptWrite;
  await pendingEmit;

  if (commandResult.exitCode !== 0 || commandResult.timedOut || sandboxCompletion?.diskLimitExceeded) {
    const egressPolicyEvidence = sandboxCompletion?.egressPolicyEvidence;
    const message = summarizePiExecFailure({
      stderr: sandboxCompletion?.diskLimitExceeded
        ? `${commandResult.stderr}\nContainer sandbox workspace disk quota exceeded.`
        : commandResult.stderr,
      stdoutRemainder: [stdoutBuffer.trim(), ...recentMessages].filter(Boolean).join("\n"),
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut,
      timeoutMs,
      transcriptFileName
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

  if (parseErrors.length > 0 || !sawAgentStart || !sawAgentEnd) {
    throw new CodexRunError(
      summarizePiProtocolFailure({
        parseErrors,
        sawAgentStart,
        sawAgentEnd,
        transcriptFileName
      }, redactionOptions),
      "environment_failed",
      undefined,
      sandboxCompletion?.egressPolicyEvidence,
      undefined,
      commandResult.auditEvents
    );
  }

  const summary = capture.agentMessages.at(-1) ??
    lastPiMessage(recentMessages) ??
    `Pi JSON run completed. Parsed ${capture.eventCount} events.`;
  await writeFile(lastMessagePath, redactSecrets(summary, redactionOptions).redacted, "utf8");

  return {
    lastMessagePath,
    transcriptPath,
    sessionId,
    capture,
    ...(sandboxCompletion?.egressPolicyEvidence ? { egressPolicyEvidence: sandboxCompletion.egressPolicyEvidence } : {})
  };
}

function buildPiArgs(piConfig: PiRunnerConfig, prompt: string) {
  const args = ["--mode", "json", "--no-session"];
  if (piConfig.model?.trim()) args.push("--model", piConfig.model.trim());
  if (piConfig.provider?.trim()) args.push("--provider", piConfig.provider.trim());
  if (piConfig.thinking?.trim()) args.push("--thinking", piConfig.thinking.trim());
  args.push(prompt);
  return args;
}

function buildPiEnv(
  piConfig: PiRunnerConfig,
  stateDirs: PiStateDirs,
  secretEnv: Record<string, string> = {}
) {
  return compactEnv({
    ...secretEnv,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CI: "1",
    HOME: stateDirs.home,
    PI_CODING_AGENT_DIR: stateDirs.agentDir,
    PI_CODING_AGENT_SESSION_DIR: stateDirs.sessionDir,
    PI_SKIP_VERSION_CHECK: piConfig.skipVersionCheck ? "1" : undefined,
    PI_TELEMETRY: piConfig.disableTelemetry ? "0" : undefined,
    PI_OFFLINE: piConfig.offline ? "1" : undefined
  });
}

async function resolvePiStateDirs(
  piConfig: PiRunnerConfig,
  runId: string,
  workspacePath: string
): Promise<PiStateDirs> {
  const stateRoot = resolve(piConfig.stateRoot || ".patchpilot/runner-state");
  assertOutsideWorkspace(stateRoot, workspacePath, "Pi stateRoot");
  const runStateRoot = join(stateRoot, "runner", "pi", slugStateSegment(runId));
  const stateDirs = {
    home: join(runStateRoot, "home"),
    agentDir: resolvePiStateDir(piConfig.agentDir, join(runStateRoot, "agent"), stateRoot, workspacePath, "Pi agentDir"),
    sessionDir: resolvePiStateDir(
      piConfig.sessionDir,
      join(runStateRoot, "sessions"),
      stateRoot,
      workspacePath,
      "Pi sessionDir"
    )
  };
  for (const [label, dir] of Object.entries(stateDirs)) {
    assertOutsideWorkspace(dir, workspacePath, `Pi ${label}`);
    await mkdir(dir, { recursive: true });
  }
  return stateDirs;
}

function resolvePiStateDir(
  configured: string | undefined,
  defaultPath: string,
  stateRoot: string,
  workspacePath: string,
  label: string
) {
  const trimmed = configured?.trim();
  const resolved = trimmed ? (isAbsolute(trimmed) ? trimmed : resolve(stateRoot, trimmed)) : defaultPath;
  assertOutsideWorkspace(resolved, workspacePath, label);
  return resolved;
}

function assertOutsideWorkspace(path: string, workspacePath: string, label: string) {
  const resolvedPath = resolve(path);
  const resolvedWorkspace = resolve(workspacePath);
  const relativePath = relative(resolvedWorkspace, resolvedPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error(`${label} must be outside the prepared worktree: ${resolvedPath}`);
  }
}

function buildPiPrompt(context: CodexRunContext, taskFilePath: string) {
  const method = context.workItem.sourceBugId ? "Use the existing diagnosis workflow for the task." : "Use TDD for the task.";

  return [
    `Complete task: ${context.workItem.title}`,
    `Read the task file: ${taskFilePath}`,
    method,
    "Work only inside the prepared workspace.",
    "Keep full coding-agent capability available; PatchPilot provides isolation, policy, secrets, network, and evidence boundaries externally.",
    "When finished, summarize changes, tests, and risks."
  ].join("\n");
}

export function parsePiEvent(line: string, options: SecretRedactionOptions = {}): ParsedPiEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = stringValue(event.type) || "pi.event";
    const sessionId = extractPiSessionId(event);
    if (type === "session") {
      return redactJsonValue({
        sessionId
      }, options);
    }

    if (type === "agent_start") {
      return redactJsonValue({
        type: "agent.started",
        message: "Pi agent started",
        sessionId
      }, options);
    }

    if (type === "agent_end") {
      return redactJsonValue({
        type: "agent.progress",
        message: "Pi agent completed",
        sessionId
      }, options);
    }

    if (type === "message_update") {
      const reasoningSummary = extractPiReasoningSummary(event, type);
      const output = extractPiMessageText(event);
      return redactJsonValue({
        type: "agent.output",
        message: output ? `Pi：${output.slice(0, 180)}` : "Pi message update",
        sessionId,
        ...(reasoningSummary ? { reasoningSummary } : {})
      }, options);
    }

    if (type === "message_end") {
      const agentMessage = extractPiFinalAssistantMessage(event);
      return redactJsonValue({
        type: agentMessage ? "agent.output" : "agent.progress",
        message: agentMessage ? `Pi：${agentMessage.slice(0, 180)}` : "Pi message completed",
        sessionId,
        ...(agentMessage ? { agentMessage } : {})
      }, options);
    }

    if (type === "tool_execution_start" || type === "tool_execution_end" || type === "tool_execution_update") {
      const toolCall = extractPiToolCall(event, type, line, options);
      const eventType = type === "tool_execution_start"
        ? "agent.tool.started"
        : toolCall?.status === "failed"
          ? "agent.tool.failed"
          : "agent.tool.completed";
      return redactJsonValue({
        type: eventType,
        message: toolCall ? `Pi tool ${toolCall.status}: ${toolCall.name}` : `Pi tool event: ${type}`,
        sessionId,
        ...(toolCall ? { toolCall } : {})
      }, options);
    }

    if (/^(auto_retry|compaction|turn)_/u.test(type)) {
      return redactJsonValue({
        type: "agent.progress",
        message: `Pi progress: ${type}`,
        sessionId
      }, options);
    }

    return redactJsonValue({
      type: "agent.progress",
      message: `Pi event: ${type}`,
      sessionId
    }, options);
  } catch {
    const trimmed = line.trim();
    return {
      type: trimmed ? "agent.output" : undefined,
      message: trimmed ? `Pi：${redactSecrets(trimmed.slice(0, 180), options).redacted}` : undefined,
      sessionId: undefined
    };
  }
}

function summarizePiExecFailure(input: {
  stderr?: string;
  stdoutRemainder?: string;
  exitCode: number | null;
  timedOut?: boolean;
  timeoutMs?: number;
  transcriptFileName?: string;
}, options: SecretRedactionOptions = {}) {
  const reason = input.timedOut
    ? `Pi command timed out after ${input.timeoutMs ?? "configured"}ms.`
    : input.stderr || input.stdoutRemainder || `exit ${input.exitCode}`;
  const transcript = input.transcriptFileName ? `\nTranscript artifact: ${input.transcriptFileName}` : "";
  const summary = tail(`${reason}${transcript}`, 1600);
  return `Pi 执行失败：${redactSecrets(summary, options).redacted}`;
}

function summarizePiProtocolFailure(input: {
  parseErrors: string[];
  sawAgentStart: boolean;
  sawAgentEnd: boolean;
  transcriptFileName: string;
}, options: SecretRedactionOptions = {}) {
  const problems = [
    ...input.parseErrors.slice(0, 5).map((error) => `Invalid JSONL ${error}`),
    ...(input.sawAgentStart ? [] : ["Missing lifecycle event: agent_start"]),
    ...(input.sawAgentEnd ? [] : ["Missing lifecycle event: agent_end"]),
    `Transcript artifact: ${input.transcriptFileName}`
  ];
  return `Pi JSONL evidence invalid：${redactSecrets(tail(problems.join("\n"), 1600), options).redacted}`;
}

function lastPiMessage(messages: string[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.startsWith("Pi：")) return message.replace(/^Pi：/u, "");
  }
  return undefined;
}

function pickPiString(configValue: string | undefined, envValue: string | undefined, defaultValue: string) {
  const normalizedConfig = configValue?.trim();
  if (normalizedConfig !== undefined && normalizedConfig !== "") return normalizedConfig;
  const normalizedEnv = envValue?.trim();
  if (normalizedEnv !== undefined && normalizedEnv !== "") return normalizedEnv;
  return defaultValue;
}

function pickPiNumber(configValue: number | undefined, envValue: string | undefined, defaultValue: number) {
  if (typeof configValue === "number" && Number.isFinite(configValue) && configValue > 0) return configValue;
  const parsedEnv = Number(envValue);
  if (Number.isFinite(parsedEnv) && parsedEnv > 0) return parsedEnv;
  return defaultValue;
}

function pickPiBoolean(configValue: boolean | undefined, envValue: string | undefined, defaultValue: boolean) {
  if (configValue !== undefined) return configValue;
  const normalized = envValue?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function slugStateSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "run";
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractPiSessionId(event: Record<string, unknown>) {
  return stringValue(event.sessionId) ||
    stringValue(event.session_id) ||
    stringValue(event.sessionID) ||
    stringValue(event.threadId) ||
    stringValue(event.thread_id);
}

function extractPiMessageText(event: Record<string, unknown>) {
  const message = asRecord(event.message);
  return firstText([
    event.delta,
    event.text,
    event.content,
    message?.delta,
    message?.text,
    message?.content
  ]);
}

function extractPiFinalAssistantMessage(event: Record<string, unknown>) {
  const message = asRecord(event.message);
  const role = stringValue(message?.role) || stringValue(event.role);
  if (role && role !== "assistant") return undefined;
  return firstText([
    message?.content,
    message?.text,
    event.content,
    event.text,
    event.message
  ]);
}

function extractPiReasoningSummary(event: Record<string, unknown>, type: string) {
  const delta = asRecord(event.delta);
  const message = asRecord(event.message);
  const looksLikeReasoning =
    /thinking|reasoning/u.test(type) ||
    /thinking|reasoning/u.test(stringValue(event.kind) || "") ||
    /thinking|reasoning/u.test(stringValue(event.channel) || "") ||
    /thinking|reasoning/u.test(stringValue(delta?.type) || "") ||
    /thinking|reasoning/u.test(stringValue(message?.type) || "");
  if (!looksLikeReasoning) return undefined;
  return firstText([
    event.delta,
    event.text,
    event.summary,
    event.reasoning,
    delta?.text,
    delta?.content,
    message?.text,
    message?.content
  ]);
}

function extractPiToolCall(
  event: Record<string, unknown>,
  type: string,
  rawLine: string,
  options: SecretRedactionOptions
): AgentRunToolCall | undefined {
  const args = asRecord(event.args) || asRecord(event.input) || asRecord(event.arguments);
  const result = asRecord(event.result) || asRecord(event.output);
  const command = firstText([
    event.command,
    event.cmd,
    event.command_line,
    event.shell_command,
    args?.command,
    args?.cmd,
    args?.command_line,
    args?.shell_command
  ]);
  const name =
    stringValue(event.toolName) ||
    stringValue(event.tool_name) ||
    stringValue(event.tool) ||
    stringValue(event.name) ||
    (command ? "bash" : undefined);
  if (!name) return undefined;

  const status = type === "tool_execution_start"
    ? "started"
    : normalizeToolCallStatus(
        stringValue(event.status) ||
        stringValue(result?.status) ||
        type
      );
  const exitCode =
    numberValue(event.exitCode) ??
    numberValue(event.exit_code) ??
    numberValue(result?.exitCode) ??
    numberValue(result?.exit_code);
  const startedAt =
    stringValue(event.startedAt) ||
    stringValue(event.started_at);
  const endedAt =
    stringValue(event.endedAt) ||
    stringValue(event.ended_at);
  const durationMs =
    numberValue(event.durationMs) ??
    numberValue(event.duration_ms) ??
    numberValue(result?.durationMs) ??
    numberValue(result?.duration_ms);
  const summary = firstText([
    event.summary,
    event.message,
    event.text,
    result?.summary,
    result?.message,
    result?.text
  ]) || (command ? `执行命令：${command}` : `调用工具：${name}`);
  const id =
    stringValue(event.toolCallId) ||
    stringValue(event.tool_call_id) ||
    stringValue(event.callId) ||
    stringValue(event.call_id) ||
    stringValue(event.id) ||
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
  }, options);
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

function buildPiRepairPrompt(context: CodexRunContext, testRun: Pick<TestRun, "command" | "summary" | "failureSummary">) {
  const method = context.workItem.sourceBugId ? "Continue using the diagnosis workflow." : "Continue using TDD.";
  const failureSummary = tail(testRun.failureSummary || testRun.summary, 1600);

  return [
    `Test failed while completing task: ${context.workItem.title}`,
    method,
    "Continue in the same prepared workspace.",
    "Keep full coding-agent capability available; PatchPilot provides isolation, policy, secrets, network, and evidence boundaries externally.",
    "",
    `Test command: ${testRun.command}`,
    "Failure summary:",
    failureSummary,
    "",
    "When finished, summarize the repair, tests, and risks."
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
          : typeof event.thread_id === "string"
            ? event.thread_id
            : typeof event.threadId === "string"
              ? event.threadId
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
  if (/401|unauthorized|invalid api key|authentication|auth failed|未授权|认证|鉴权/u.test(normalized)) {
    return "environment_failed";
  }
  if (/502|503|504|bad gateway|service unavailable|gateway timeout/u.test(normalized)) return "transient";
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
