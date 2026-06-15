import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  evaluateCommandPolicy,
  type CapabilityManifest,
  type PolicyDecision
} from "@patchpilot/policy";
import { knownSecretsFromEnv, redactJsonValue, redactSecrets, type SecretRedactionOptions } from "@patchpilot/security";

export type CommandExecutionKind = "shell" | "git" | "codex" | "pi" | "test" | "runtime";

export type CommandAuditAction =
  | "command.policy_allowed"
  | "command.policy_denied"
  | "command.started"
  | "command.completed";

export interface CommandAuditEvidence {
  id: string;
  action: CommandAuditAction;
  kind: CommandExecutionKind;
  command: string;
  cwd: string;
  manifestId?: string;
  policyDecision?: PolicyDecision;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  outputPreview?: string;
  outputBytes?: number;
  maxOutputBytes?: number;
}

export type CommandAuditSink = (event: CommandAuditEvidence) => void | Promise<void>;

export interface CommandExecutionResult {
  exitCode: number | null;
  output: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  auditEvents: CommandAuditEvidence[];
}

export interface SpawnedCommandResult extends CommandExecutionResult {
  delegateResult?: unknown;
}

export interface CommandExecutionOptions {
  kind: CommandExecutionKind;
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  maxOutputBytes?: number;
  capabilityManifest?: CapabilityManifest;
  auditSink?: CommandAuditSink;
  redaction?: SecretRedactionOptions;
  executor?: (options: EffectiveCommandExecutionOptions) => Promise<Omit<CommandExecutionResult, "auditEvents">>;
}

export interface CommandSpawnOptions extends Omit<CommandExecutionOptions, "executor"> {
  spawnDelegate?: (options: EffectiveCommandExecutionOptions) => Promise<{
    child: ChildProcessWithoutNullStreams;
    done?: Promise<unknown>;
  }>;
}

export interface EffectiveCommandExecutionOptions extends Omit<CommandExecutionOptions, "executor" | "auditSink" | "redaction" | "capabilityManifest"> {
  displayCommand: string;
}

export interface SpawnedCommand {
  child: ChildProcessWithoutNullStreams;
  done: Promise<SpawnedCommandResult>;
  auditEvents: CommandAuditEvidence[];
}

export class CommandExecutionPolicyDeniedError extends Error {
  readonly failureType = "policy_denied";

  constructor(
    message: string,
    public readonly decision: PolicyDecision,
    public readonly commandAuditEvents: CommandAuditEvidence[]
  ) {
    super(message);
    this.name = "CommandExecutionPolicyDeniedError";
  }
}

export async function executeCommand(options: CommandExecutionOptions): Promise<CommandExecutionResult> {
  const startedAtMs = Date.now();
  const prepared = await prepareCommand(options);
  const startedAt = new Date(startedAtMs).toISOString();
  const startedEvent = await emitAuditEvent(options, prepared.auditEvents, {
    id: `cmd_${randomUUID()}`,
    action: "command.started",
    kind: options.kind,
    command: prepared.redactedCommand,
    cwd: prepared.redactedCwd,
    ...(options.capabilityManifest ? { manifestId: options.capabilityManifest.id } : {}),
    ...(prepared.policyDecision ? { policyDecision: redactJsonValue(prepared.policyDecision, prepared.redaction) } : {}),
    startedAt,
    maxOutputBytes: prepared.maxOutputBytes
  });

  const result = options.executor
    ? await options.executor(prepared.effectiveOptions)
    : await runSpawnedCommand(prepared);
  const durationMs = result.durationMs || Date.now() - startedAtMs;
  const output = limitCapturedOutput(result.output, prepared.maxOutputBytes);
  const stdout = limitCapturedOutput(result.stdout, prepared.maxOutputBytes);
  const stderr = limitCapturedOutput(result.stderr, prepared.maxOutputBytes);
  const redactedOutput = redactSecrets(output, prepared.redaction).redacted;
  const redactedStdout = redactSecrets(stdout, prepared.redaction).redacted;
  const redactedStderr = redactSecrets(stderr, prepared.redaction).redacted;

  await emitAuditEvent(options, prepared.auditEvents, {
    ...startedEvent,
    id: `cmd_${randomUUID()}`,
    action: "command.completed",
    endedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    outputPreview: tail(redactedOutput, 1600),
    outputBytes: Buffer.byteLength(redactedOutput, "utf8")
  });

  return {
    exitCode: result.exitCode,
    output: redactedOutput,
    stdout: redactedStdout,
    stderr: redactedStderr,
    timedOut: result.timedOut,
    durationMs,
    auditEvents: prepared.auditEvents
  };
}

export async function spawnCommand(options: CommandSpawnOptions): Promise<SpawnedCommand> {
  const startedAtMs = Date.now();
  const prepared = await prepareCommand(options);
  const startedAt = new Date(startedAtMs).toISOString();
  const startedEvent = await emitAuditEvent(options, prepared.auditEvents, {
    id: `cmd_${randomUUID()}`,
    action: "command.started",
    kind: options.kind,
    command: prepared.redactedCommand,
    cwd: prepared.redactedCwd,
    ...(options.capabilityManifest ? { manifestId: options.capabilityManifest.id } : {}),
    ...(prepared.policyDecision ? { policyDecision: redactJsonValue(prepared.policyDecision, prepared.redaction) } : {}),
    startedAt,
    maxOutputBytes: prepared.maxOutputBytes
  });

  const delegated = options.spawnDelegate
    ? await options.spawnDelegate(prepared.effectiveOptions)
    : undefined;
  const child = delegated?.child ?? spawnPreparedCommand(prepared);
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const appendStdout = (chunk: Buffer) => {
    stdout = limitCapturedOutput(stdout + chunk.toString("utf8"), prepared.maxOutputBytes);
  };
  const appendStderr = (chunk: Buffer) => {
    stderr = limitCapturedOutput(stderr + chunk.toString("utf8"), prepared.maxOutputBytes);
  };
  child.stdout.on("data", appendStdout);
  child.stderr.on("data", appendStderr);

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  }, prepared.effectiveOptions.timeoutMs);

  const done = new Promise<SpawnedCommandResult>((resolve) => {
    child.on("error", async (error) => {
      clearTimeout(timeout);
      stderr = limitCapturedOutput(`${stderr}${error.message}`, prepared.maxOutputBytes);
      resolve(await finalizeSpawnedResult({
        options,
        prepared,
        startedEvent,
        startedAtMs,
        exitCode: 1,
        stdout,
        stderr,
        timedOut,
        delegateResult: undefined
      }));
    });
    child.on("close", async (exitCode) => {
      clearTimeout(timeout);
      const delegateResult = delegated?.done ? await delegated.done : undefined;
      const delegatedTimedOut = readBooleanProperty(delegateResult, "timedOut");
      resolve(await finalizeSpawnedResult({
        options,
        prepared,
        startedEvent,
        startedAtMs,
        exitCode,
        stdout,
        stderr,
        timedOut: timedOut || delegatedTimedOut,
        delegateResult
      }));
    });
  });

  return { child, done, auditEvents: prepared.auditEvents };
}

export function isCommandAuditEvidence(value: unknown): value is CommandAuditEvidence {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.action === "string" &&
      typeof record.kind === "string" &&
      typeof record.command === "string" &&
      typeof record.cwd === "string"
  );
}

export function asCommandAuditEvidenceList(value: unknown): CommandAuditEvidence[] {
  return Array.isArray(value) ? value.filter(isCommandAuditEvidence) : [];
}

export function shellJoin(values: string[]) {
  return values.map(shellQuote).join(" ");
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface PreparedCommand {
  displayCommand: string;
  redactedCommand: string;
  redactedCwd: string;
  redaction: SecretRedactionOptions;
  maxOutputBytes: number;
  auditEvents: CommandAuditEvidence[];
  policyDecision?: PolicyDecision;
  effectiveOptions: EffectiveCommandExecutionOptions;
}

async function prepareCommand(options: CommandExecutionOptions | CommandSpawnOptions): Promise<PreparedCommand> {
  const displayCommand = displayCommandForOptions(options);
  const inheritedEnv = options.inheritEnv === false ? {} : process.env;
  const knownSecrets = [
    ...(options.redaction?.knownSecrets ?? []),
    ...knownSecretsFromEnv(inheritedEnv),
    ...knownSecretsFromEnv(options.env)
  ];
  const redaction: SecretRedactionOptions = {
    ...options.redaction,
    knownSecrets
  };
  const redactedCommand = redactSecrets(displayCommand, redaction).redacted;
  const redactedCwd = redactSecrets(options.cwd, redaction).redacted;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  const auditEvents: CommandAuditEvidence[] = [];
  let policyDecision: PolicyDecision | undefined;
  const timeoutMs = Math.min(options.timeoutMs, options.capabilityManifest?.runtime.maxRuntimeMs ?? options.timeoutMs);

  if (options.capabilityManifest) {
    policyDecision = evaluateCommandPolicy(options.capabilityManifest, displayCommand);
    if (policyDecision.decision !== "allowed") {
      const deniedEvent = await emitAuditEvent(options, auditEvents, {
        id: `cmd_${randomUUID()}`,
        action: "command.policy_denied",
        kind: options.kind,
        command: redactedCommand,
        cwd: redactedCwd,
        manifestId: options.capabilityManifest.id,
        policyDecision: redactJsonValue(policyDecision, redaction),
        startedAt: new Date().toISOString(),
        maxOutputBytes
      });
      throw new CommandExecutionPolicyDeniedError(
        `Capability policy denied ${options.kind} command "${redactedCommand}": ${policyDecision.reason}`,
        policyDecision,
        [deniedEvent]
      );
    }
    await emitAuditEvent(options, auditEvents, {
      id: `cmd_${randomUUID()}`,
      action: "command.policy_allowed",
      kind: options.kind,
      command: redactedCommand,
      cwd: redactedCwd,
      manifestId: options.capabilityManifest.id,
      policyDecision: redactJsonValue(policyDecision, redaction),
      startedAt: new Date().toISOString(),
      maxOutputBytes
    });
  }

  return {
    displayCommand,
    redactedCommand,
    redactedCwd,
    redaction,
    maxOutputBytes,
    auditEvents,
    ...(policyDecision ? { policyDecision } : {}),
    effectiveOptions: {
      kind: options.kind,
      command: options.command,
      ...(options.args ? { args: options.args } : {}),
      cwd: options.cwd,
      timeoutMs,
      ...(options.env ? { env: options.env } : {}),
      ...(options.inheritEnv !== undefined ? { inheritEnv: options.inheritEnv } : {}),
      maxOutputBytes,
      displayCommand
    }
  };
}

async function finalizeSpawnedResult(input: {
  options: CommandSpawnOptions;
  prepared: PreparedCommand;
  startedEvent: CommandAuditEvidence;
  startedAtMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  delegateResult: unknown;
}): Promise<SpawnedCommandResult> {
  const durationMs = Date.now() - input.startedAtMs;
  const output = limitCapturedOutput(`${input.stdout}${input.stderr}`, input.prepared.maxOutputBytes);
  const redactedOutput = redactSecrets(output, input.prepared.redaction).redacted;
  const redactedStdout = redactSecrets(input.stdout, input.prepared.redaction).redacted;
  const redactedStderr = redactSecrets(input.stderr, input.prepared.redaction).redacted;

  await emitAuditEvent(input.options, input.prepared.auditEvents, {
    ...input.startedEvent,
    id: `cmd_${randomUUID()}`,
    action: "command.completed",
    endedAt: new Date().toISOString(),
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    durationMs,
    outputPreview: tail(redactedOutput, 1600),
    outputBytes: Buffer.byteLength(redactedOutput, "utf8")
  });

  return {
    exitCode: input.exitCode,
    output: redactedOutput,
    stdout: redactedStdout,
    stderr: redactedStderr,
    timedOut: input.timedOut,
    durationMs,
    auditEvents: input.prepared.auditEvents,
    ...(input.delegateResult !== undefined ? { delegateResult: input.delegateResult } : {})
  };
}

function runSpawnedCommand(prepared: PreparedCommand): Promise<Omit<CommandExecutionResult, "auditEvents">> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawnPreparedCommand(prepared);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendStdout = (chunk: Buffer) => {
      stdout = limitCapturedOutput(stdout + chunk.toString("utf8"), prepared.maxOutputBytes);
    };
    const appendStderr = (chunk: Buffer) => {
      stderr = limitCapturedOutput(stderr + chunk.toString("utf8"), prepared.maxOutputBytes);
    };
    child.stdout.on("data", appendStdout);
    child.stderr.on("data", appendStderr);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }, prepared.effectiveOptions.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      stderr = limitCapturedOutput(`${stderr}${error.message}`, prepared.maxOutputBytes);
      resolve({
        exitCode: 1,
        output: `${stdout}${stderr}`,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        output: `${stdout}${stderr}`,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function spawnPreparedCommand(prepared: PreparedCommand) {
  const options = prepared.effectiveOptions;
  if (options.args) {
    return spawn(options.command, options.args, {
      cwd: options.cwd,
      env: buildEnv(options),
      stdio: ["pipe", "pipe", "pipe"]
    });
  }
  return spawn("sh", ["-lc", options.command], {
    cwd: options.cwd,
    env: buildEnv(options),
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function buildEnv(options: EffectiveCommandExecutionOptions) {
  return options.inheritEnv === false
    ? options.env ?? {}
    : { ...process.env, ...options.env };
}

function displayCommandForOptions(options: Pick<CommandExecutionOptions, "command" | "args">) {
  return options.args ? shellDisplay([options.command, ...options.args]) : normalizeShellCommand(options.command);
}

function normalizeShellCommand(command: string) {
  return command.trim().replace(/\s+/g, " ");
}

function shellDisplay(values: string[]) {
  return values.map((value) => (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(value) ? value : shellQuote(value))).join(" ");
}

async function emitAuditEvent(
  options: Pick<CommandExecutionOptions, "auditSink">,
  auditEvents: CommandAuditEvidence[],
  event: CommandAuditEvidence
) {
  const redacted = redactJsonValue(event);
  auditEvents.push(redacted);
  await options.auditSink?.(redacted);
  return redacted;
}

function limitCapturedOutput(output: string, maxOutputBytes: number) {
  if (Buffer.byteLength(output, "utf8") <= maxOutputBytes) return output;
  return output.slice(output.length - maxOutputBytes);
}

function tail(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}

function readBooleanProperty(value: unknown, key: string) {
  const record = asRecord(value);
  const property = record?.[key];
  return typeof property === "boolean" ? property : false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
