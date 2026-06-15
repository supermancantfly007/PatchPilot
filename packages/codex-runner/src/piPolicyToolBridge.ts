import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { executeCommand, type CommandExecutionResult } from "@patchpilot/command-executor";
import type { AgentRunToolCall } from "@patchpilot/domain";
import {
  evaluateCommandPolicy,
  evaluateNetworkPolicy,
  evaluateSecretPolicy,
  evaluateWorkspaceWritePolicy,
  type CapabilityManifest,
  type PolicyDecision
} from "@patchpilot/policy";
import { redactJsonValue, redactSecrets, type SecretRedactionOptions } from "@patchpilot/security";

export type PiPolicyToolKind = "shell" | "file_write" | "file_edit" | "network" | "secret";
export type PiPolicyToolEvidenceAction =
  | "policy_allowed"
  | "policy_denied"
  | "tool.started"
  | "tool.completed"
  | "tool.failed";

export interface PiPolicyToolEvidence {
  id: string;
  action: PiPolicyToolEvidenceAction;
  kind: PiPolicyToolKind;
  toolCallId: string;
  toolName: string;
  runId: string;
  workItemId: string;
  workspacePath: string;
  manifestId: string;
  target: string;
  policyDecision?: PolicyDecision;
  message?: string;
  at: string;
}

export interface FakePiPolicyToolBridgeOptions {
  runId: string;
  workItemId: string;
  workspacePath: string;
  capabilityManifest: CapabilityManifest;
  env?: NodeJS.ProcessEnv;
  secretGrants?: Record<string, string | undefined>;
  redaction?: SecretRedactionOptions;
  timeoutMs?: number;
}

export class PiPolicyToolDeniedError extends Error {
  readonly failureType = "policy_denied";

  constructor(
    message: string,
    public readonly evidence: PiPolicyToolEvidence,
    public readonly decision: PolicyDecision
  ) {
    super(message);
    this.name = "PiPolicyToolDeniedError";
  }
}

export class FakePiPolicyToolBridge {
  readonly toolCalls: AgentRunToolCall[] = [];
  readonly policyEvidence: PiPolicyToolEvidence[] = [];
  private readonly redaction: SecretRedactionOptions;

  constructor(private readonly options: FakePiPolicyToolBridgeOptions) {
    this.redaction = {
      ...options.redaction,
      knownSecrets: [
        ...(options.redaction?.knownSecrets ?? []),
        ...Object.values(options.secretGrants ?? {})
      ]
    };
  }

  async shell(command: string): Promise<CommandExecutionResult> {
    const toolCall = this.startToolCall("pi.shell", "shell", command, command);
    try {
      this.assertAllowed("shell", toolCall.id, "pi.shell", command, evaluateCommandPolicy(this.options.capabilityManifest, command));
      const result = await executeCommand({
        kind: "shell",
        command,
        cwd: this.options.workspacePath,
        timeoutMs: this.options.timeoutMs ?? 30_000,
        env: this.options.env,
        inheritEnv: false,
        capabilityManifest: this.options.capabilityManifest,
        redaction: this.redaction,
        maxOutputBytes: 64 * 1024
      });
      this.completeToolCall(toolCall, result.exitCode === 0 ? "completed" : "failed", {
        summary: `shell exited ${result.exitCode}`,
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });
      return result;
    } catch (error) {
      this.failToolCall(toolCall, error);
      throw error;
    }
  }

  async writeFile(relativePath: string, content: string) {
    const toolCall = this.startToolCall("pi.file_write", "file_write", relativePath);
    try {
      this.assertAllowed(
        "file_write",
        toolCall.id,
        "pi.file_write",
        relativePath,
        evaluateWorkspaceWritePolicy(this.options.capabilityManifest, [relativePath])
      );
      const targetPath = this.resolveWorkspacePath(relativePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, "utf8");
      this.completeToolCall(toolCall, "completed", { summary: `wrote ${relativePath}` });
    } catch (error) {
      this.failToolCall(toolCall, error);
      throw error;
    }
  }

  async editFile(relativePath: string, edit: (content: string) => string) {
    const toolCall = this.startToolCall("pi.file_edit", "file_edit", relativePath);
    try {
      this.assertAllowed(
        "file_edit",
        toolCall.id,
        "pi.file_edit",
        relativePath,
        evaluateWorkspaceWritePolicy(this.options.capabilityManifest, [relativePath])
      );
      const targetPath = this.resolveWorkspacePath(relativePath);
      const current = await readFile(targetPath, "utf8");
      await writeFile(targetPath, edit(current), "utf8");
      this.completeToolCall(toolCall, "completed", { summary: `edited ${relativePath}` });
    } catch (error) {
      this.failToolCall(toolCall, error);
      throw error;
    }
  }

  async networkRequest<T>(target: string, request: () => Promise<T> | T): Promise<T> {
    const toolCall = this.startToolCall("pi.network", "network", target);
    try {
      this.assertAllowed("network", toolCall.id, "pi.network", target, evaluateNetworkPolicy(this.options.capabilityManifest, target));
      const result = await request();
      this.completeToolCall(toolCall, "completed", { summary: `network allowed ${target}` });
      return result;
    } catch (error) {
      this.failToolCall(toolCall, error);
      throw error;
    }
  }

  async readSecret(secretId: string): Promise<string> {
    const toolCall = this.startToolCall("pi.secret", "secret", secretId);
    try {
      this.assertAllowed("secret", toolCall.id, "pi.secret", secretId, evaluateSecretPolicy(this.options.capabilityManifest, secretId));
      const secret = this.options.secretGrants?.[secretId];
      if (!secret?.trim()) {
        this.deny("secret", toolCall.id, "pi.secret", secretId, {
          decision: "denied",
          reason: "secret_grant_missing",
          target: secretId
        });
      }
      this.completeToolCall(toolCall, "completed", { summary: `secret grant available: ${secretId}` });
      return secret;
    } catch (error) {
      this.failToolCall(toolCall, error);
      throw error;
    }
  }

  private assertAllowed(
    kind: PiPolicyToolKind,
    toolCallId: string,
    toolName: string,
    target: string,
    decision: PolicyDecision
  ) {
    if (decision.decision === "denied") {
      this.deny(kind, toolCallId, toolName, target, decision);
    }
    this.recordEvidence({
      action: "policy_allowed",
      kind,
      toolCallId,
      toolName,
      target,
      policyDecision: decision
    });
  }

  private deny(
    kind: PiPolicyToolKind,
    toolCallId: string,
    toolName: string,
    target: string,
    decision: PolicyDecision
  ): never {
    const evidence = this.recordEvidence({
      action: "policy_denied",
      kind,
      toolCallId,
      toolName,
      target,
      policyDecision: decision,
      message: `Pi tool action denied before execution: ${decision.reason}`
    });
    throw new PiPolicyToolDeniedError(
      `Pi ${kind} tool action denied before execution: ${decision.reason}`,
      evidence,
      decision
    );
  }

  private startToolCall(name: string, kind: PiPolicyToolKind, target: string, command?: string): AgentRunToolCall {
    const now = new Date().toISOString();
    const toolCall: AgentRunToolCall = {
      id: `pi_tool_${randomUUID()}`,
      name,
      status: "started",
      summary: `${kind} requested ${redactSecrets(target, this.redaction).redacted}`,
      ...(command ? { command: redactSecrets(command, this.redaction).redacted } : {}),
      startedAt: now
    };
    this.toolCalls.push(toolCall);
    this.recordEvidence({
      action: "tool.started",
      kind,
      toolCallId: toolCall.id,
      toolName: name,
      target
    });
    return toolCall;
  }

  private completeToolCall(
    toolCall: AgentRunToolCall,
    status: "completed" | "failed",
    details: { summary: string; exitCode?: number | null; durationMs?: number }
  ) {
    toolCall.status = status;
    toolCall.summary = redactSecrets(details.summary, this.redaction).redacted;
    toolCall.endedAt = new Date().toISOString();
    if (details.exitCode !== undefined) toolCall.exitCode = details.exitCode;
    if (details.durationMs !== undefined) toolCall.durationMs = details.durationMs;
    this.recordEvidence({
      action: status === "completed" ? "tool.completed" : "tool.failed",
      kind: toolKindFromToolName(toolCall.name),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      target: toolCall.command ?? toolCall.summary,
      message: toolCall.summary
    });
  }

  private failToolCall(toolCall: AgentRunToolCall, error: unknown) {
    if (toolCall.status !== "started") return;
    const message = error instanceof Error ? error.message : "tool failed";
    this.completeToolCall(toolCall, "failed", { summary: message });
  }

  private recordEvidence(input: Omit<PiPolicyToolEvidence, "id" | "runId" | "workItemId" | "workspacePath" | "manifestId" | "at">) {
    const evidence = redactJsonValue({
      id: `pi_policy_${randomUUID()}`,
      runId: this.options.runId,
      workItemId: this.options.workItemId,
      workspacePath: this.options.workspacePath,
      manifestId: this.options.capabilityManifest.id,
      at: new Date().toISOString(),
      ...input
    }, this.redaction);
    this.policyEvidence.push(evidence);
    return evidence;
  }

  private resolveWorkspacePath(path: string) {
    const workspaceRoot = resolve(this.options.workspacePath);
    const targetPath = resolve(workspaceRoot, path);
    const relativePath = relative(workspaceRoot, targetPath);
    if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
      throw new Error(`Path escapes workspace: ${path}`);
    }
    return targetPath;
  }
}

function toolKindFromToolName(name: string): PiPolicyToolKind {
  if (name === "pi.file_write") return "file_write";
  if (name === "pi.file_edit") return "file_edit";
  if (name === "pi.network") return "network";
  if (name === "pi.secret") return "secret";
  return "shell";
}
