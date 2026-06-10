import type {
  SecretBrokerEvidence,
  SecretBrokerRuntimeConfig,
  SecretBrokerSecretConfig,
  WorkItem
} from "@patchpilot/domain";
import type { CapabilityManifest } from "@patchpilot/policy";

export interface SecretBrokerResolution {
  env: Record<string, string>;
  evidence: SecretBrokerEvidence;
  authorized: boolean;
}

export const secretCapabilityPrefix = "secret:";

export function requestedSecretIdsForWorkItem(workItem: Pick<WorkItem, "requiredCapabilities">) {
  return uniqueStrings(
    (workItem.requiredCapabilities ?? [])
      .map((capability) => capability.trim())
      .filter((capability) => capability.startsWith(secretCapabilityPrefix))
      .map((capability) => capability.slice(secretCapabilityPrefix.length).trim())
      .filter(Boolean)
  );
}

export function resolveSecretBrokerGrants(input: {
  config: SecretBrokerRuntimeConfig;
  workItem: Pick<WorkItem, "requiredCapabilities">;
  env?: Record<string, string | undefined>;
  capabilityManifest?: CapabilityManifest;
}): SecretBrokerResolution {
  const requestedSecretIds = requestedSecretIdsForWorkItem(input.workItem);
  const evidence: SecretBrokerEvidence = {
    enabled: input.config.enabled,
    mode: "env",
    requestedSecretIds,
    injected: [],
    denied: []
  };
  const candidateEnv: Record<string, string> = {};
  const candidateInjected: SecretBrokerEvidence["injected"] = [];

  if (requestedSecretIds.length === 0) {
    return { env: candidateEnv, evidence, authorized: true };
  }

  if (!input.config.enabled) {
    evidence.denied = requestedSecretIds.map((id) => ({ id, reason: "broker_disabled" }));
    return { env: {}, evidence, authorized: false };
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
    if (!isNonProductionSecret(secret)) {
      evidence.denied.push({ id: secret.id, reason: "production_secret_denied" });
      continue;
    }
    const sourceValue = input.env?.[secret.sourceEnv];
    if (!sourceValue || !sourceValue.trim()) {
      evidence.denied.push({ id: secret.id, reason: "source_env_missing" });
      continue;
    }
    candidateInjected.push({
      id: secret.id,
      envVar: secret.envVar,
      sourceEnv: secret.sourceEnv,
      environment: secret.environment
    });
    candidateEnv[secret.envVar] = sourceValue;
  }

  if (evidence.denied.length > 0) return { env: {}, evidence, authorized: false };
  evidence.injected = candidateInjected;
  return { env: candidateEnv, evidence, authorized: true };
}

function isNonProductionSecret(secret: SecretBrokerSecretConfig) {
  return secret.environment === "dev" || secret.environment === "ci";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
