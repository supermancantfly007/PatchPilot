import { createHash } from "node:crypto";
import type {
  SecretBrokerDeniedSecretEvidence,
  SecretBrokerEvidence,
  SecretBrokerGrantOperationEvidence,
  SecretBrokerInjectedSecretEvidence,
  SecretBrokerRuntimeConfig,
  SecretBrokerSecretConfig,
  SecretBrokerSecretProviderConfig,
  SecretBrokerSecretProviderKind,
  SecretBrokerVaultProviderConfig,
  WorkItem
} from "@patchpilot/domain";
import type { CapabilityManifest } from "@patchpilot/policy";

export interface SecretBrokerResolution {
  env: Record<string, string>;
  evidence: SecretBrokerEvidence;
  authorized: boolean;
  grants: SecretBrokerResolvedGrant[];
}

export const secretCapabilityPrefix = "secret:";
export const defaultSecretBrokerGrantTtlSeconds = 15 * 60;

export type SecretBrokerProviderErrorCode = SecretBrokerDeniedSecretEvidence["reason"];

export interface SecretBrokerResolvedGrant {
  id: string;
  envVar: string;
  provider: SecretBrokerSecretProviderKind;
  leaseId?: string;
  providerLeaseId?: string;
}

export interface SecretBrokerProviderGrant {
  value: string;
  sourceEnv?: string;
  leaseId?: string;
  providerLeaseId?: string;
  issuedAt: string;
  expiresAt?: string;
  ttlSeconds?: number;
  renewable: boolean;
  rotationSupported: boolean;
  revocationSupported: boolean;
  providerAuditId?: string;
  rotationVersion?: string;
}

export interface SecretBrokerProviderReadInput {
  secret: SecretBrokerSecretConfig;
  env: Record<string, string | undefined>;
  now: Date;
}

export interface SecretBrokerProviderOperationInput {
  secret: SecretBrokerSecretConfig;
  env: Record<string, string | undefined>;
  now: Date;
  leaseId?: string;
  providerLeaseId?: string;
}

export interface SecretBrokerProvider {
  kind: SecretBrokerSecretProviderKind;
  read(input: SecretBrokerProviderReadInput): Promise<SecretBrokerProviderGrant>;
  rotate?(input: SecretBrokerProviderOperationInput): Promise<SecretBrokerGrantOperationEvidence>;
  revoke?(input: SecretBrokerProviderOperationInput): Promise<SecretBrokerGrantOperationEvidence>;
}

export interface SecretBrokerProviderRegistry {
  env?: SecretBrokerProvider;
  local_fake?: SecretBrokerProvider;
  vault?: SecretBrokerProvider;
}

export class SecretBrokerProviderError extends Error {
  constructor(
    public readonly code: SecretBrokerProviderErrorCode,
    message: string,
    public readonly provider?: SecretBrokerSecretProviderKind
  ) {
    super(message);
    this.name = "SecretBrokerProviderError";
  }
}

export function requestedSecretIdsForWorkItem(workItem: Pick<WorkItem, "requiredCapabilities">) {
  return uniqueStrings(
    (workItem.requiredCapabilities ?? [])
      .map((capability) => capability.trim())
      .filter((capability) => capability.startsWith(secretCapabilityPrefix))
      .map((capability) => capability.slice(secretCapabilityPrefix.length).trim())
      .filter(Boolean)
  );
}

export async function resolveSecretBrokerGrants(input: {
  config: SecretBrokerRuntimeConfig;
  workItem: Pick<WorkItem, "requiredCapabilities">;
  env?: Record<string, string | undefined>;
  capabilityManifest?: CapabilityManifest;
  providers?: SecretBrokerProviderRegistry;
  now?: Date;
}): Promise<SecretBrokerResolution> {
  const now = input.now ?? new Date();
  const env = input.env ?? {};
  const providers = input.providers ?? createSecretBrokerProviderRegistry();
  const requestedSecretIds = requestedSecretIdsForWorkItem(input.workItem);
  const evidence: SecretBrokerEvidence = {
    enabled: input.config.enabled,
    mode: "env",
    requestedSecretIds,
    injected: [],
    denied: [],
    revoked: []
  };
  const candidateEnv: Record<string, string> = {};
  const candidateInjected: SecretBrokerInjectedSecretEvidence[] = [];
  const candidateGrants: SecretBrokerResolvedGrant[] = [];

  if (requestedSecretIds.length === 0) {
    return { env: candidateEnv, evidence, authorized: true, grants: [] };
  }

  if (!input.config.enabled) {
    evidence.denied = requestedSecretIds.map((id) => ({ id, reason: "broker_disabled" }));
    return { env: {}, evidence, authorized: false, grants: [] };
  }

  const allowedSecrets = new Map(input.config.allowedSecrets.map((secret) => [secret.id, secret]));
  const manifestAllowedSecrets = input.capabilityManifest
    ? new Set(input.capabilityManifest.secrets.allow)
    : undefined;
  for (const secretId of requestedSecretIds) {
    if (manifestAllowedSecrets && !manifestAllowedSecrets.has(secretId)) {
      evidence.denied.push({ id: secretId, reason: "not_configured" });
      continue;
    }
    const secret = allowedSecrets.get(secretId);
    if (!secret) {
      evidence.denied.push({ id: secretId, reason: "not_configured" });
      continue;
    }
    const providerKind = providerKindForSecret(secret);
    if (providerKind !== "env") evidence.mode = "adapter";
    if (!isNonProductionSecret(secret)) {
      evidence.denied.push({ id: secret.id, reason: "production_secret_denied", provider: providerKind });
      continue;
    }
    const provider = providers[providerKind];
    if (!provider) {
      evidence.denied.push({ id: secret.id, reason: "not_configured", provider: providerKind });
      continue;
    }
    try {
      const grant = await provider.read({ secret, env, now });
      const leaseId = grant.leaseId ?? brokerLeaseId(secret.id, providerKind, grant.value, grant.issuedAt);
      candidateInjected.push({
        id: secret.id,
        envVar: secret.envVar,
        ...(grant.sourceEnv ? { sourceEnv: grant.sourceEnv } : {}),
        environment: secret.environment,
        provider: providerKind,
        leaseId,
        issuedAt: grant.issuedAt,
        ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
        ...(grant.ttlSeconds ? { ttlSeconds: grant.ttlSeconds } : {}),
        renewable: grant.renewable,
        rotationSupported: grant.rotationSupported,
        revocationSupported: grant.revocationSupported,
        valueFingerprint: secretValueFingerprint(grant.value),
        ...(grant.providerAuditId ? { providerAuditId: grant.providerAuditId } : {})
      });
      candidateGrants.push({
        id: secret.id,
        envVar: secret.envVar,
        provider: providerKind,
        leaseId,
        ...(grant.providerLeaseId ? { providerLeaseId: grant.providerLeaseId } : {})
      });
      candidateEnv[secret.envVar] = grant.value;
    } catch (error) {
      const brokerError = asProviderError(error, providerKind);
      evidence.denied.push({ id: secret.id, reason: brokerError.code, provider: brokerError.provider });
    }
  }

  if (evidence.denied.length > 0) {
    evidence.revoked = await revokeSecretBrokerGrants({
      config: input.config,
      grants: candidateGrants,
      env,
      providers,
      now
    });
    return { env: {}, evidence, authorized: false, grants: [] };
  }
  evidence.injected = candidateInjected;
  return { env: candidateEnv, evidence, authorized: true, grants: candidateGrants };
}

export async function rotateSecretBrokerSecret(input: {
  config: SecretBrokerRuntimeConfig;
  secretId: string;
  env?: Record<string, string | undefined>;
  providers?: SecretBrokerProviderRegistry;
  now?: Date;
}): Promise<SecretBrokerGrantOperationEvidence> {
  const now = input.now ?? new Date();
  const secret = input.config.allowedSecrets.find((candidate) => candidate.id === input.secretId);
  if (!secret) {
    return unsupportedOperation(input.secretId, "env", "rotate", now, "secret_not_configured");
  }
  const providerKind = providerKindForSecret(secret);
  const provider = (input.providers ?? createSecretBrokerProviderRegistry())[providerKind];
  if (!provider?.rotate) return unsupportedOperation(secret.id, providerKind, "rotate", now);
  try {
    return await provider.rotate({ secret, env: input.env ?? {}, now });
  } catch (error) {
    return failedOperation(secret.id, providerKind, "rotate", now, error);
  }
}

export async function revokeSecretBrokerGrants(input: {
  config: SecretBrokerRuntimeConfig;
  grants: SecretBrokerResolvedGrant[];
  env?: Record<string, string | undefined>;
  providers?: SecretBrokerProviderRegistry;
  now?: Date;
}): Promise<SecretBrokerGrantOperationEvidence[]> {
  if (input.grants.length === 0) return [];
  const now = input.now ?? new Date();
  const env = input.env ?? {};
  const providers = input.providers ?? createSecretBrokerProviderRegistry();
  const secrets = new Map(input.config.allowedSecrets.map((secret) => [secret.id, secret]));
  const evidence: SecretBrokerGrantOperationEvidence[] = [];
  for (const grant of input.grants) {
    const secret = secrets.get(grant.id);
    const providerKind = secret ? providerKindForSecret(secret) : grant.provider;
    const provider = providers[providerKind];
    if (!secret || !provider?.revoke) {
      evidence.push(unsupportedOperation(grant.id, providerKind, "revoke", now, undefined, grant.leaseId));
      continue;
    }
    try {
      evidence.push(await provider.revoke({
        secret,
        env,
        now,
        leaseId: grant.leaseId,
        providerLeaseId: grant.providerLeaseId
      }));
    } catch (error) {
      evidence.push(failedOperation(grant.id, providerKind, "revoke", now, error, grant.leaseId));
    }
  }
  return evidence;
}

export function createSecretBrokerProviderRegistry(input: {
  fetch?: VaultFetch;
  localFake?: LocalFakeSecretProvider;
} = {}): SecretBrokerProviderRegistry {
  return {
    env: new EnvSecretProvider(),
    local_fake: input.localFake ?? new LocalFakeSecretProvider(),
    vault: new VaultSecretProvider(input.fetch)
  };
}

export class EnvSecretProvider implements SecretBrokerProvider {
  readonly kind = "env" as const;

  async read(input: SecretBrokerProviderReadInput): Promise<SecretBrokerProviderGrant> {
    const provider = envProviderConfigForSecret(input.secret);
    if (!provider.sourceEnv.trim()) {
      throw new SecretBrokerProviderError("source_env_missing", "Secret env provider has no source env.", this.kind);
    }
    const sourceValue = input.env[provider.sourceEnv];
    if (!sourceValue || !sourceValue.trim()) {
      throw new SecretBrokerProviderError("source_env_missing", "Secret source environment variable is missing.", this.kind);
    }
    const ttlSeconds = ttlSecondsForSecret(input.secret, provider);
    return {
      value: sourceValue,
      sourceEnv: provider.sourceEnv,
      leaseId: brokerLeaseId(input.secret.id, this.kind, provider.sourceEnv, input.now.toISOString()),
      issuedAt: input.now.toISOString(),
      expiresAt: addSeconds(input.now, ttlSeconds),
      ttlSeconds,
      renewable: false,
      rotationSupported: false,
      revocationSupported: false
    };
  }
}

export class LocalFakeSecretProvider implements SecretBrokerProvider {
  readonly kind = "local_fake" as const;
  private readonly versions = new Map<string, number>();
  private readonly grantCounters = new Map<string, number>();
  private readonly revokedLeaseIds = new Set<string>();

  async read(input: SecretBrokerProviderReadInput): Promise<SecretBrokerProviderGrant> {
    const provider = localFakeProviderConfigForSecret(input.secret);
    const version = this.versions.get(input.secret.id) ?? 1;
    const counter = (this.grantCounters.get(input.secret.id) ?? 0) + 1;
    this.grantCounters.set(input.secret.id, counter);
    const seed = provider.seedEnv ? input.env[provider.seedEnv] || "patchpilot-local-fake" : "patchpilot-local-fake";
    const issuedAt = input.now.toISOString();
    const value = `patchpilot_fake_${input.secret.id}_${version}_${sha256(`${seed}:${input.secret.id}:${version}`).slice(0, 24)}`;
    const leaseId = `local-fake:${input.secret.id}:${version}:${counter}:${secretValueFingerprint(value).slice(7, 19)}`;
    if (this.revokedLeaseIds.has(leaseId)) {
      throw new SecretBrokerProviderError("provider_revoked", "Local fake grant has been revoked.", this.kind);
    }
    const ttlSeconds = ttlSecondsForSecret(input.secret, provider);
    return {
      value,
      leaseId,
      issuedAt,
      expiresAt: addSeconds(input.now, ttlSeconds),
      ttlSeconds,
      renewable: false,
      rotationSupported: true,
      revocationSupported: true,
      providerAuditId: `local-fake:${input.secret.id}:${version}`
    };
  }

  async rotate(input: SecretBrokerProviderOperationInput): Promise<SecretBrokerGrantOperationEvidence> {
    const nextVersion = (this.versions.get(input.secret.id) ?? 1) + 1;
    this.versions.set(input.secret.id, nextVersion);
    return {
      id: input.secret.id,
      provider: this.kind,
      action: "rotate",
      status: "succeeded",
      occurredAt: input.now.toISOString(),
      rotationVersion: String(nextVersion),
      providerAuditId: `local-fake:${input.secret.id}:${nextVersion}`
    };
  }

  async revoke(input: SecretBrokerProviderOperationInput): Promise<SecretBrokerGrantOperationEvidence> {
    if (!input.leaseId) return unsupportedOperation(input.secret.id, this.kind, "revoke", input.now);
    this.revokedLeaseIds.add(input.leaseId);
    return {
      id: input.secret.id,
      provider: this.kind,
      action: "revoke",
      status: "succeeded",
      occurredAt: input.now.toISOString(),
      leaseId: input.leaseId,
      providerAuditId: `local-fake:revoke:${input.leaseId}`
    };
  }
}

interface VaultFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

export type VaultFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<VaultFetchResponse>;

export class VaultSecretProvider implements SecretBrokerProvider {
  readonly kind = "vault" as const;
  private readonly fetchImpl: VaultFetch;

  constructor(fetchImpl: VaultFetch = defaultVaultFetch) {
    this.fetchImpl = fetchImpl;
  }

  async read(input: SecretBrokerProviderReadInput): Promise<SecretBrokerProviderGrant> {
    const provider = vaultProviderConfigForSecret(input.secret);
    const body = await this.vaultRequest(provider, input.env, "GET", vaultReadPath(provider));
    const value = vaultSecretValue(body, provider);
    const bodyRecord = asRecord(body);
    const leaseDuration = positiveNumber(bodyRecord?.lease_duration);
    const providerLeaseId = stringValue(bodyRecord?.lease_id);
    const ttlSeconds = leaseDuration ?? ttlSecondsForSecret(input.secret, provider);
    const issuedAt = input.now.toISOString();
    return {
      value,
      leaseId: brokerLeaseId(input.secret.id, this.kind, provider.path, issuedAt),
      ...(providerLeaseId ? { providerLeaseId } : {}),
      issuedAt,
      expiresAt: ttlSeconds ? addSeconds(input.now, ttlSeconds) : undefined,
      ttlSeconds,
      renewable: Boolean(bodyRecord?.renewable),
      rotationSupported: Boolean(provider.rotatePath),
      revocationSupported: Boolean(provider.revokePath || providerLeaseId),
      providerAuditId: stringValue(bodyRecord?.request_id) ?? responseHeaderAuditId(bodyRecord)
    };
  }

  async rotate(input: SecretBrokerProviderOperationInput): Promise<SecretBrokerGrantOperationEvidence> {
    const provider = vaultProviderConfigForSecret(input.secret);
    if (!provider.rotatePath) return unsupportedOperation(input.secret.id, this.kind, "rotate", input.now);
    const body = await this.vaultRequest(provider, input.env, "POST", provider.rotatePath);
    const data = asRecord(asRecord(body)?.data);
    return {
      id: input.secret.id,
      provider: this.kind,
      action: "rotate",
      status: "succeeded",
      occurredAt: input.now.toISOString(),
      rotationVersion: stringValue(data?.version) ?? numberString(data?.version),
      providerAuditId: stringValue(asRecord(body)?.request_id)
    };
  }

  async revoke(input: SecretBrokerProviderOperationInput): Promise<SecretBrokerGrantOperationEvidence> {
    const provider = vaultProviderConfigForSecret(input.secret);
    const revokePath = provider.revokePath ?? (input.providerLeaseId ? "sys/leases/revoke" : undefined);
    if (!revokePath) return unsupportedOperation(input.secret.id, this.kind, "revoke", input.now, undefined, input.leaseId);
    const body = await this.vaultRequest(provider, input.env, "POST", revokePath, {
      lease_id: input.providerLeaseId ?? input.leaseId
    });
    return {
      id: input.secret.id,
      provider: this.kind,
      action: "revoke",
      status: "succeeded",
      occurredAt: input.now.toISOString(),
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      providerAuditId: stringValue(asRecord(body)?.request_id)
    };
  }

  private async vaultRequest(
    provider: SecretBrokerVaultProviderConfig,
    env: Record<string, string | undefined>,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ) {
    const token = env[provider.tokenEnv]?.trim();
    if (!token) {
      throw new SecretBrokerProviderError("provider_auth_missing", "Vault token environment variable is missing.", this.kind);
    }
    const headers: Record<string, string> = {
      "X-Vault-Token": token
    };
    const namespace = provider.namespaceEnv ? env[provider.namespaceEnv]?.trim() : undefined;
    if (namespace) headers["X-Vault-Namespace"] = namespace;
    if (body) headers["Content-Type"] = "application/json";
    const response = await this.fetchImpl(vaultUrl(provider.address, path), {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      throw new SecretBrokerProviderError(
        "provider_read_failed",
        `Vault request failed with status ${response.status}.`,
        this.kind
      );
    }
    try {
      return await response.json();
    } catch {
      throw new SecretBrokerProviderError("provider_read_failed", "Vault response was not valid JSON.", this.kind);
    }
  }
}

function isNonProductionSecret(secret: SecretBrokerSecretConfig) {
  return secret.environment === "dev" || secret.environment === "ci";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function providerKindForSecret(secret: SecretBrokerSecretConfig): SecretBrokerSecretProviderKind {
  return providerConfigForSecret(secret)?.kind ?? "env";
}

function providerConfigForSecret(secret: SecretBrokerSecretConfig): SecretBrokerSecretProviderConfig | undefined {
  if (secret.provider) return secret.provider;
  if (secret.sourceEnv) {
    return {
      kind: "env",
      sourceEnv: secret.sourceEnv,
      ...(secret.ttlSeconds ? { ttlSeconds: secret.ttlSeconds } : {})
    };
  }
  return undefined;
}

function envProviderConfigForSecret(secret: SecretBrokerSecretConfig) {
  const provider = providerConfigForSecret(secret);
  if (!provider || provider.kind !== "env") {
    throw new SecretBrokerProviderError("not_configured", "Secret is not configured for env provider.", "env");
  }
  return provider;
}

function localFakeProviderConfigForSecret(secret: SecretBrokerSecretConfig) {
  const provider = providerConfigForSecret(secret);
  if (!provider || provider.kind !== "local_fake") {
    throw new SecretBrokerProviderError("not_configured", "Secret is not configured for local fake provider.", "local_fake");
  }
  return provider;
}

function vaultProviderConfigForSecret(secret: SecretBrokerSecretConfig) {
  const provider = providerConfigForSecret(secret);
  if (!provider || provider.kind !== "vault") {
    throw new SecretBrokerProviderError("not_configured", "Secret is not configured for Vault provider.", "vault");
  }
  return provider;
}

function asProviderError(error: unknown, provider: SecretBrokerSecretProviderKind) {
  if (error instanceof SecretBrokerProviderError) return error;
  return new SecretBrokerProviderError("provider_read_failed", error instanceof Error ? error.message : String(error), provider);
}

function ttlSecondsForSecret(secret: SecretBrokerSecretConfig, provider: SecretBrokerSecretProviderConfig) {
  const ttlSeconds = secret.ttlSeconds ?? provider.ttlSeconds ?? defaultSecretBrokerGrantTtlSeconds;
  return Math.max(1, Math.floor(ttlSeconds));
}

function secretValueFingerprint(value: string) {
  return `sha256:${sha256(value)}`;
}

function brokerLeaseId(id: string, provider: SecretBrokerSecretProviderKind, material: string, issuedAt: string) {
  return `${provider}:${id}:${sha256(`${material}:${issuedAt}`).slice(0, 16)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function unsupportedOperation(
  id: string,
  provider: SecretBrokerSecretProviderKind,
  action: SecretBrokerGrantOperationEvidence["action"],
  now: Date,
  reason = "provider_operation_unsupported",
  leaseId?: string
): SecretBrokerGrantOperationEvidence {
  return {
    id,
    provider,
    action,
    status: "unsupported",
    occurredAt: now.toISOString(),
    ...(leaseId ? { leaseId } : {}),
    reason
  };
}

function failedOperation(
  id: string,
  provider: SecretBrokerSecretProviderKind,
  action: SecretBrokerGrantOperationEvidence["action"],
  now: Date,
  error: unknown,
  leaseId?: string
): SecretBrokerGrantOperationEvidence {
  return {
    id,
    provider,
    action,
    status: "failed",
    occurredAt: now.toISOString(),
    ...(leaseId ? { leaseId } : {}),
    reason: error instanceof Error ? error.message : String(error)
  };
}

function vaultReadPath(provider: SecretBrokerVaultProviderConfig) {
  const kvVersion = provider.kvVersion ?? 2;
  return kvVersion === 2
    ? `${provider.mount}/data/${provider.path}`
    : `${provider.mount}/${provider.path}`;
}

function vaultUrl(address: string, path: string) {
  const base = address.replace(/\/+$/u, "");
  const normalizedPath = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${base}/v1/${normalizedPath}`;
}

function vaultSecretValue(body: unknown, provider: SecretBrokerVaultProviderConfig) {
  const bodyRecord = asRecord(body);
  const dataRecord = asRecord(bodyRecord?.data);
  const valueContainer = (provider.kvVersion ?? 2) === 2
    ? asRecord(dataRecord?.data)
    : dataRecord;
  const value = valueContainer?.[provider.key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SecretBrokerProviderError("provider_read_failed", "Vault secret value is missing.", "vault");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberString(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function responseHeaderAuditId(bodyRecord: Record<string, unknown> | undefined) {
  const headers = asRecord(bodyRecord?.headers);
  return stringValue(headers?.["x-vault-request"]);
}

async function defaultVaultFetch(...args: Parameters<VaultFetch>) {
  if (typeof globalThis.fetch !== "function") {
    throw new SecretBrokerProviderError("provider_read_failed", "Global fetch is unavailable.", "vault");
  }
  return globalThis.fetch(args[0], args[1]);
}
