import { isIP } from "node:net";
import {
  defaultEgressAllowedHosts,
  defaultEgressAuditLogPath,
  type AgentProfile,
  type ContainerRuntimeKind,
  type EgressPolicyRuntimeConfig,
  type SecretBrokerRuntimeConfig,
  type WorkItem
} from "@patchpilot/domain";

export type CapabilityManifestStatus = "draft" | "active" | "revoked" | "expired";
export type CapabilityPolicyDecision = "allowed" | "denied";

export interface CapabilityManifest {
  id: string;
  version: 1;
  status: CapabilityManifestStatus;
  createdBy: string;
  createdAt: string;
  scope: {
    runId?: string;
    prdId?: string;
    workItemId?: string;
  };
  capabilities: {
    required: string[];
  };
  repo: {
    read: {
      allow: string[];
    };
    write: {
      allow: string[];
      deny: string[];
    };
  };
  commands: {
    allow: string[];
    deny: string[];
  };
  network: {
    allow: string[];
    allowGitRemotes: boolean;
    auditLogPath: string;
    denyPrivateNetworks: true;
    denyMetadataEndpoints: true;
  };
  secrets: {
    requested: string[];
    allow: string[];
    allowProductionSecrets: false;
  };
  runtime: {
    codexSandbox: string;
    codexBypass: boolean;
    container: {
      enabled: boolean;
      runtime: ContainerRuntimeKind;
      image: string;
      cpus: number;
      memoryMb: number;
      workspaceDiskMb: number;
      tmpfsMb: number;
      pidsLimit: number;
      uid: number;
      gid: number;
    };
    maxRuntimeMs: number;
  };
  cost: {
    maxCostUsd?: number;
    softThresholdRatio?: number;
  };
}

export interface CapabilityPolicyIssue {
  path: string;
  message: string;
}

export interface CapabilityManifestValidation {
  valid: boolean;
  issues: CapabilityPolicyIssue[];
}

export interface PolicyDecision {
  decision: CapabilityPolicyDecision;
  reason: string;
  target: string;
  matchedPattern?: string;
}

export interface GenerateCapabilityManifestInput {
  id?: string;
  runId?: string;
  prdId?: string;
  workItem?: Pick<WorkItem, "id" | "prdId" | "requiredCapabilities" | "budgetUsd">;
  createdBy?: string;
  createdAt?: string;
  repo?: {
    readAllow?: string[];
    writeAllow?: string[];
    writeDeny?: string[];
  };
  commands?: {
    allow?: string[];
    deny?: string[];
  };
  network?: {
    allow?: string[];
  };
  testCommand?: string;
  testTimeoutMs?: number;
  security?: {
    codexSandbox?: string;
    codexBypass?: boolean;
    containerSandbox?: Partial<CapabilityManifest["runtime"]["container"]>;
    egressPolicy?: Partial<EgressPolicyRuntimeConfig>;
    secretBroker?: Partial<SecretBrokerRuntimeConfig>;
  };
  budget?: {
    codexTimeoutMs?: number;
    maxCostUsd?: number;
    prdUsd?: number;
    workItemUsd?: number;
    runUsd?: number;
    softThresholdRatio?: number;
  };
}

export class CapabilityPolicyViolation extends Error {
  constructor(
    message: string,
    public readonly decision: PolicyDecision
  ) {
    super(message);
    this.name = "CapabilityPolicyViolation";
  }
}

export const secretCapabilityPrefix = "secret:";

const defaultRepoWriteDeny = [
  ".git",
  ".git/**",
  "../**",
  "/**",
  "~/**"
];

const defaultCommandDeny = [
  "sudo",
  "su",
  "ssh",
  "scp",
  "rsync",
  "docker",
  "podman",
  "kubectl",
  "terraform",
  "vault",
  "op",
  "security"
];

const defaultCommandAllow = [
  "codex exec*",
  "codex --version",
  "pi --mode json*",
  "pi --mode rpc*",
  "pi --version",
  "git branch*",
  "git show-ref*",
  "git status*",
  "git diff*",
  "git rev-parse*",
  "git worktree*",
  "git add*",
  "git commit*"
];

const defaultContainer = {
  enabled: false,
  runtime: "auto" as const,
  image: "node:24-alpine",
  cpus: 2,
  memoryMb: 4096,
  workspaceDiskMb: 8192,
  tmpfsMb: 256,
  pidsLimit: 512,
  uid: 1000,
  gid: 1000
};

export function generateCapabilityManifest(input: GenerateCapabilityManifestInput = {}): CapabilityManifest {
  const requiredCapabilities = uniqueStrings(input.workItem?.requiredCapabilities ?? []);
  const requestedSecrets = requestedSecretIds(requiredCapabilities);
  const configuredSecrets = input.security?.secretBroker?.allowedSecrets?.map((secret) => secret.id) ?? [];
  const runCostLimit = positiveNumber(input.budget?.runUsd);
  const workItemCostLimit = positiveNumber(input.workItem?.budgetUsd) ?? positiveNumber(input.budget?.workItemUsd);
  const maxCostLimit = positiveNumber(input.budget?.maxCostUsd) ?? positiveNumber(input.budget?.prdUsd);
  const maxCostUsd = runCostLimit ?? workItemCostLimit ?? maxCostLimit;
  const container = {
    ...defaultContainer,
    ...(input.security?.containerSandbox ?? {})
  };
  const runtimeLimit = positiveNumber(input.testTimeoutMs) ??
    positiveNumber(input.budget?.codexTimeoutMs) ??
    10 * 60 * 1000;
  const commandAllow = uniqueStrings([
    ...defaultCommandAllow,
    ...(input.testCommand?.trim() ? [input.testCommand.trim()] : []),
    ...(input.commands?.allow ?? [])
  ]);
  const networkAllow = uniqueStrings([
    ...(input.security?.egressPolicy?.allowedHosts ?? defaultEgressAllowedHosts),
    ...(input.network?.allow ?? [])
  ]);

  return {
    id: input.id ?? buildManifestId(input.runId, input.workItem?.id),
    version: 1,
    status: "active",
    createdBy: input.createdBy ?? "policy",
    createdAt: input.createdAt ?? new Date().toISOString(),
    scope: {
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.prdId ?? input.workItem?.prdId ? { prdId: input.prdId ?? input.workItem?.prdId } : {}),
      ...(input.workItem?.id ? { workItemId: input.workItem.id } : {})
    },
    capabilities: {
      required: requiredCapabilities
    },
    repo: {
      read: {
        allow: normalizeStringList(input.repo?.readAllow ?? ["**"])
      },
      write: {
        allow: normalizeStringList(input.repo?.writeAllow ?? ["**"]),
        deny: normalizeStringList([...defaultRepoWriteDeny, ...(input.repo?.writeDeny ?? [])])
      }
    },
    commands: {
      allow: commandAllow,
      deny: normalizeStringList([...defaultCommandDeny, ...(input.commands?.deny ?? [])])
    },
    network: {
      allow: normalizeStringList(networkAllow.map(normalizeHostPattern)),
      allowGitRemotes: input.security?.egressPolicy?.allowGitRemotes ?? true,
      auditLogPath: input.security?.egressPolicy?.auditLogPath ?? defaultEgressAuditLogPath,
      denyPrivateNetworks: true,
      denyMetadataEndpoints: true
    },
    secrets: {
      requested: requestedSecrets,
      allow: uniqueStrings([...configuredSecrets, ...requestedSecrets]),
      allowProductionSecrets: false
    },
    runtime: {
      codexSandbox: input.security?.codexSandbox?.trim() || "workspace-write",
      codexBypass: input.security?.codexBypass ?? false,
      container,
      maxRuntimeMs: runtimeLimit
    },
    cost: {
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(input.budget?.softThresholdRatio !== undefined
        ? { softThresholdRatio: input.budget.softThresholdRatio }
        : {})
    }
  };
}

export function validateCapabilityManifest(manifest: CapabilityManifest): CapabilityManifestValidation {
  const issues: CapabilityPolicyIssue[] = [];

  if (manifest.version !== 1) pushIssue(issues, "version", "Capability manifest version must be 1.");
  if (!manifest.id.trim()) pushIssue(issues, "id", "Capability manifest id must not be empty.");
  if (manifest.status !== "active") pushIssue(issues, "status", "Only active manifests can be enforced.");
  validateStringList(issues, "capabilities.required", manifest.capabilities.required);
  validateStringList(issues, "repo.read.allow", manifest.repo.read.allow);
  validateStringList(issues, "repo.write.allow", manifest.repo.write.allow);
  validateStringList(issues, "repo.write.deny", manifest.repo.write.deny);
  validateStringList(issues, "commands.allow", manifest.commands.allow);
  validateStringList(issues, "commands.deny", manifest.commands.deny);
  validateStringList(issues, "network.allow", manifest.network.allow);
  validateStringList(issues, "secrets.requested", manifest.secrets.requested);
  validateStringList(issues, "secrets.allow", manifest.secrets.allow);

  if (intersects(manifest.repo.write.allow, manifest.repo.write.deny)) {
    pushIssue(issues, "repo.write", "Repository write allow and deny policies must not contain the same pattern.");
  }
  if (intersects(manifest.commands.allow, manifest.commands.deny)) {
    pushIssue(issues, "commands", "Command allow and deny policies must not contain the same pattern.");
  }
  if (!manifest.network.denyPrivateNetworks) {
    pushIssue(issues, "network.denyPrivateNetworks", "Private network denial must stay enabled.");
  }
  if (!manifest.network.denyMetadataEndpoints) {
    pushIssue(issues, "network.denyMetadataEndpoints", "Cloud metadata endpoint denial must stay enabled.");
  }
  if (manifest.secrets.allowProductionSecrets) {
    pushIssue(issues, "secrets.allowProductionSecrets", "Production secrets cannot be allowed by this manifest version.");
  }
  if (!Number.isFinite(manifest.runtime.maxRuntimeMs) || manifest.runtime.maxRuntimeMs <= 0) {
    pushIssue(issues, "runtime.maxRuntimeMs", "Runtime limit must be positive.");
  }
  if (manifest.runtime.container.workspaceDiskMb <= 0) {
    pushIssue(issues, "runtime.container.workspaceDiskMb", "Workspace disk limit must be positive.");
  }
  if (manifest.cost.maxCostUsd !== undefined && manifest.cost.maxCostUsd < 0) {
    pushIssue(issues, "cost.maxCostUsd", "Cost limit must be nonnegative.");
  }
  if (
    manifest.cost.softThresholdRatio !== undefined &&
    (manifest.cost.softThresholdRatio < 0 || manifest.cost.softThresholdRatio > 1)
  ) {
    pushIssue(issues, "cost.softThresholdRatio", "Cost soft threshold ratio must be between 0 and 1.");
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidCapabilityManifest(manifest: CapabilityManifest) {
  const validation = validateCapabilityManifest(manifest);
  if (validation.valid) return;
  throw new CapabilityPolicyViolation(
    `Capability manifest is invalid: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    {
      decision: "denied",
      reason: "manifest_invalid",
      target: manifest.id
    }
  );
}

export function evaluateCommandPolicy(manifest: CapabilityManifest, command: string): PolicyDecision {
  assertValidCapabilityManifest(manifest);
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return { decision: "denied", reason: "command_empty", target: command };
  }
  const deniedPattern = manifest.commands.deny.find((pattern) => matchesCommandPattern(normalized, pattern));
  if (deniedPattern) {
    return {
      decision: "denied",
      reason: "command_denylisted",
      target: normalized,
      matchedPattern: deniedPattern
    };
  }
  const allowedPattern = manifest.commands.allow.find((pattern) => matchesCommandPattern(normalized, pattern));
  if (!allowedPattern) {
    return {
      decision: "denied",
      reason: "command_not_allowlisted",
      target: normalized
    };
  }
  return {
    decision: "allowed",
    reason: "command_allowlisted",
    target: normalized,
    matchedPattern: allowedPattern
  };
}

export function enforceCommandPolicy(manifest: CapabilityManifest, command: string) {
  const decision = evaluateCommandPolicy(manifest, command);
  if (decision.decision === "allowed") return decision;
  throw new CapabilityPolicyViolation(
    `Capability policy denied command "${decision.target}": ${decision.reason}`,
    decision
  );
}

export function evaluateWorkspaceWritePolicy(manifest: CapabilityManifest, changedFiles: string[]): PolicyDecision {
  assertValidCapabilityManifest(manifest);
  for (const changedFile of changedFiles) {
    const path = normalizeRepoPath(changedFile);
    if (isUnsafeRepoPath(path)) {
      return {
        decision: "denied",
        reason: "repo_write_path_escape",
        target: changedFile
      };
    }
    const deniedPattern = manifest.repo.write.deny.find((pattern) => matchesRepoPattern(path, pattern));
    if (deniedPattern) {
      return {
        decision: "denied",
        reason: "repo_write_denylisted",
        target: path,
        matchedPattern: deniedPattern
      };
    }
    const allowedPattern = manifest.repo.write.allow.find((pattern) => matchesRepoPattern(path, pattern));
    if (!allowedPattern) {
      return {
        decision: "denied",
        reason: "repo_write_not_allowlisted",
        target: path
      };
    }
  }
  return {
    decision: "allowed",
    reason: "repo_write_allowlisted",
    target: changedFiles.length === 0 ? "<none>" : changedFiles.join(", ")
  };
}

export function enforceWorkspaceWritePolicy(manifest: CapabilityManifest, changedFiles: string[]) {
  const decision = evaluateWorkspaceWritePolicy(manifest, changedFiles);
  if (decision.decision === "allowed") return decision;
  throw new CapabilityPolicyViolation(
    `Capability policy denied repository write "${decision.target}": ${decision.reason}`,
    decision
  );
}

export function evaluateNetworkPolicy(manifest: CapabilityManifest, target: string): PolicyDecision {
  assertValidCapabilityManifest(manifest);
  const host = normalizeNetworkHost(target);
  if (!host) {
    return { decision: "denied", reason: "network_target_invalid", target };
  }
  if (manifest.network.denyMetadataEndpoints && isMetadataHost(host)) {
    return { decision: "denied", reason: "network_metadata_denied", target: host };
  }
  if (manifest.network.denyPrivateNetworks && isPrivateNetworkHost(host)) {
    return { decision: "denied", reason: "network_private_denied", target: host };
  }
  const allowedPattern = manifest.network.allow.find((pattern) => matchesNetworkHost(host, pattern));
  if (!allowedPattern) {
    return {
      decision: "denied",
      reason: "network_not_allowlisted",
      target: host
    };
  }
  return {
    decision: "allowed",
    reason: "network_allowlisted",
    target: host,
    matchedPattern: allowedPattern
  };
}

export function enforceNetworkPolicy(manifest: CapabilityManifest, target: string) {
  const decision = evaluateNetworkPolicy(manifest, target);
  if (decision.decision === "allowed") return decision;
  throw new CapabilityPolicyViolation(
    `Capability policy denied network target "${decision.target}": ${decision.reason}`,
    decision
  );
}

export function evaluateSecretPolicy(manifest: CapabilityManifest, secretId: string): PolicyDecision {
  assertValidCapabilityManifest(manifest);
  const normalized = secretId.trim();
  if (!normalized) {
    return { decision: "denied", reason: "secret_ref_empty", target: secretId };
  }
  if (!manifest.secrets.requested.includes(normalized)) {
    return { decision: "denied", reason: "secret_not_requested", target: normalized };
  }
  if (!manifest.secrets.allow.includes(normalized)) {
    return { decision: "denied", reason: "secret_not_allowlisted", target: normalized };
  }
  return {
    decision: "allowed",
    reason: "secret_allowlisted",
    target: normalized,
    matchedPattern: normalized
  };
}

export function enforceSecretPolicy(manifest: CapabilityManifest, secretId: string) {
  const decision = evaluateSecretPolicy(manifest, secretId);
  if (decision.decision === "allowed") return decision;
  throw new CapabilityPolicyViolation(
    `Capability policy denied secret "${decision.target}": ${decision.reason}`,
    decision
  );
}

export function agentSatisfiesCapabilityManifest(
  agent: Pick<AgentProfile, "role" | "capabilities">,
  manifest: CapabilityManifest
) {
  assertValidCapabilityManifest(manifest);
  const available = new Set([agent.role, ...(agent.capabilities ?? [])]);
  return manifest.capabilities.required.every((capability) => available.has(capability));
}

export function isCostWithinCapabilityManifest(
  manifest: CapabilityManifest,
  spentUsd: number,
  nextCostUsd = 0
) {
  assertValidCapabilityManifest(manifest);
  const limit = manifest.cost.maxCostUsd;
  if (limit === undefined) return true;
  if (limit <= 0) return false;
  return spentUsd + nextCostUsd < limit;
}

export function applyManifestToEgressPolicyConfig(
  config: EgressPolicyRuntimeConfig,
  manifest: CapabilityManifest
): EgressPolicyRuntimeConfig {
  assertValidCapabilityManifest(manifest);
  return {
    ...config,
    allowedHosts: manifest.network.allow,
    allowGitRemotes: manifest.network.allowGitRemotes,
    auditLogPath: manifest.network.auditLogPath,
    denyPrivateNetworks: true,
    denyMetadataEndpoints: true
  };
}

export function requestedSecretIds(capabilities: string[]) {
  return uniqueStrings(
    capabilities
      .map((capability) => capability.trim())
      .filter((capability) => capability.startsWith(secretCapabilityPrefix))
      .map((capability) => capability.slice(secretCapabilityPrefix.length).trim())
      .filter(Boolean)
  );
}

export function summarizeCapabilityManifest(manifest: CapabilityManifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    status: manifest.status,
    scope: manifest.scope,
    requiredCapabilities: manifest.capabilities.required,
    repoWriteAllow: manifest.repo.write.allow,
    repoWriteDeny: manifest.repo.write.deny,
    commandAllow: manifest.commands.allow,
    commandDeny: manifest.commands.deny,
    networkAllow: manifest.network.allow,
    secretRefs: manifest.secrets.allow,
    runtime: {
      codexSandbox: manifest.runtime.codexSandbox,
      codexBypass: manifest.runtime.codexBypass,
      container: {
        enabled: manifest.runtime.container.enabled,
        runtime: manifest.runtime.container.runtime,
        image: manifest.runtime.container.image,
        cpus: manifest.runtime.container.cpus,
        memoryMb: manifest.runtime.container.memoryMb,
        workspaceDiskMb: manifest.runtime.container.workspaceDiskMb,
        tmpfsMb: manifest.runtime.container.tmpfsMb,
        pidsLimit: manifest.runtime.container.pidsLimit
      },
      maxRuntimeMs: manifest.runtime.maxRuntimeMs
    },
    cost: manifest.cost,
    secretValuesStored: false
  };
}

function buildManifestId(runId: string | undefined, workItemId: string | undefined) {
  const scope = runId ?? workItemId ?? "unscoped";
  return `manifest_${safeId(scope)}`;
}

function validateStringList(issues: CapabilityPolicyIssue[], path: string, values: string[]) {
  values.forEach((value, index) => {
    if (!value.trim()) pushIssue(issues, `${path}[${index}]`, "Policy list entries must not be empty.");
  });
}

function pushIssue(issues: CapabilityPolicyIssue[], path: string, message: string) {
  issues.push({ path, message });
}

function intersects(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function positiveNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeStringList(values: readonly string[]) {
  return uniqueStrings(values.map((value) => value.trim()).filter(Boolean));
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeHostPattern(value: string) {
  return value.toLowerCase().trim().replace(/^\.+/u, ".");
}

function normalizeNetworkHost(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/u, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/\.+$/u, "");
    } catch {
      return undefined;
    }
  }
  if (trimmed.includes("@") && trimmed.includes(":") && !trimmed.includes("/")) {
    return trimmed.split("@").pop()?.split(":")[0]?.toLowerCase().replace(/\.+$/u, "");
  }
  if (trimmed.includes(":") && !isIP(trimmed)) return trimmed.split(":")[0]?.toLowerCase().replace(/\.+$/u, "");
  return trimmed;
}

function matchesNetworkHost(host: string, rawPattern: string) {
  const pattern = normalizeNetworkHost(rawPattern);
  if (!pattern) return false;
  if (pattern === "*" || pattern === "**") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function isMetadataHost(host: string) {
  return (
    host === "metadata.google.internal" ||
    host === "metadata.azure.com" ||
    host === "metadata.oraclecloud.com" ||
    host === "169.254.169.254" ||
    host.endsWith(".metadata.google.internal")
  );
}

function isPrivateNetworkHost(host: string) {
  if (!isIP(host)) return false;
  if (host === "169.254.169.254") return true;
  const maybeV4 = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const v4 = ipv4ToInt(maybeV4);
  if (v4 !== undefined) {
    return (
      inV4Range(v4, "0.0.0.0", 8) ||
      inV4Range(v4, "10.0.0.0", 8) ||
      inV4Range(v4, "100.64.0.0", 10) ||
      inV4Range(v4, "127.0.0.0", 8) ||
      inV4Range(v4, "169.254.0.0", 16) ||
      inV4Range(v4, "172.16.0.0", 12) ||
      inV4Range(v4, "192.168.0.0", 16)
    );
  }
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  );
}

function ipv4ToInt(ip: string) {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) return undefined;
    value = (value << 8) + number;
  }
  return value >>> 0;
}

function inV4Range(ip: number, cidrBase: string, prefixLength: number) {
  const base = ipv4ToInt(cidrBase);
  if (base === undefined) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ip & mask) === (base & mask);
}

function normalizeRepoPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+/g, "/").trim();
}

function isUnsafeRepoPath(value: string) {
  return value.startsWith("/") || value === ".." || value.startsWith("../") || value.includes("\0");
}

function matchesRepoPattern(path: string, rawPattern: string) {
  const pattern = normalizeRepoPath(rawPattern);
  if (pattern === "**" || pattern === "*") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!pattern.includes("*")) return path === pattern;
  return globToRegExp(pattern).test(path);
}

function normalizeCommand(command: string) {
  return command.trim().replace(/\s+/g, " ");
}

function matchesCommandPattern(command: string, rawPattern: string) {
  const pattern = normalizeCommand(rawPattern);
  if (!pattern) return false;
  if (pattern === "*" || pattern === "**") return true;
  if (pattern.endsWith("*") && !pattern.includes("/")) {
    return command.startsWith(pattern.slice(0, -1));
  }
  if (pattern.includes("*")) return globToRegExp(pattern).test(command);
  if (pattern.includes(" ")) return command === pattern || command.startsWith(`${pattern} `);
  return firstCommandToken(command) === pattern;
}

function firstCommandToken(command: string) {
  const match = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function globToRegExp(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/\\s]*";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source, "u");
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unscoped";
}
