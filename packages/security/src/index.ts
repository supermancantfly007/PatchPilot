import { createHash } from "node:crypto";

export const secretRedactionPolicyVersion = "td-214-secret-redaction-v1";

export type SecretFindingKind =
  | "known_secret"
  | "private_key"
  | "authorization_header"
  | "cookie_header"
  | "secret_assignment"
  | "url_credential"
  | "sensitive_query"
  | "api_token";

export interface SecretFinding {
  kind: SecretFindingKind;
  fingerprint: string;
}

export interface SecretRedactionOptions {
  knownSecrets?: Array<string | null | undefined>;
}

export interface SecretRedactionResult {
  redacted: string;
  findings: SecretFinding[];
  changed: boolean;
}

const redactionMarkers: Record<SecretFindingKind, string> = {
  known_secret: "[REDACTED:secret]",
  private_key: "[REDACTED:private-key]",
  authorization_header: "[REDACTED:token]",
  cookie_header: "[REDACTED:cookie]",
  secret_assignment: "[REDACTED:secret]",
  url_credential: "[REDACTED:credential]",
  sensitive_query: "[REDACTED:secret]",
  api_token: "[REDACTED:token]"
};

const secretKeyPattern =
  /(?:^|[_.-])(?:password|passwd|pwd|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|authorization|cookie|credential)(?:$|[_.-])/iu;

const secretKeyLoosePattern =
  /(?:password|passwd|pwd|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|authorization|cookie|credential)/iu;

const commonTokenPatterns: Array<{ kind: SecretFindingKind; pattern: RegExp }> = [
  { kind: "api_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { kind: "api_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/gu },
  { kind: "api_token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { kind: "api_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu },
  { kind: "api_token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/gu },
  { kind: "api_token", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { kind: "api_token", pattern: /\b(?:pp|patchpilot)[_-]fixture[_-]secret[_-][A-Za-z0-9._-]+\b/giu },
  { kind: "api_token", pattern: /\bfixture[_-]secret[_-][A-Za-z0-9._-]+\b/giu },
  { kind: "api_token", pattern: /\bsecret[_-]fixture[_-][A-Za-z0-9._-]+\b/giu }
];

export function scanSecrets(value: string, options: SecretRedactionOptions = {}): SecretFinding[] {
  return redactSecrets(value, options).findings;
}

export function redactSecrets(value: string, options: SecretRedactionOptions = {}): SecretRedactionResult {
  const findings: SecretFinding[] = [];
  let redacted = value;

  for (const secret of normalizeKnownSecrets(options.knownSecrets)) {
    redacted = replaceAll(redacted, new RegExp(escapeRegExp(secret), "gu"), "known_secret", findings);
  }

  redacted = replaceAll(
    redacted,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    "private_key",
    findings
  );

  redacted = replaceGroups(
    redacted,
    /(\bAuthorization\s*[:=]\s*)(Bearer|Basic|Token)?\s*([^\s"',;]+)/giu,
    "authorization_header",
    findings,
    (match, prefix, scheme, secret) => {
      if (isAlreadyRedacted(secret)) return match;
      const schemePrefix = scheme ? `${scheme} ` : "";
      return `${prefix}${schemePrefix}${redactionMarkers.authorization_header}`;
    },
    3
  );

  redacted = replaceGroups(
    redacted,
    /(\bCookie\s*[:=]\s*)([^\n\r]+)/giu,
    "cookie_header",
    findings,
    (match, prefix, secret) => isAlreadyRedacted(secret) ? match : `${prefix}${redactionMarkers.cookie_header}`,
    2
  );

  redacted = replaceGroups(
    redacted,
    /("[^"]*(?:password|passwd|pwd|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|authorization|cookie|credential)[^"]*"\s*:\s*")([^"]+)(")/giu,
    "secret_assignment",
    findings,
    (match, prefix, secret, suffix) => isAlreadyRedacted(secret) ? match : `${prefix}${redactionMarkers.secret_assignment}${suffix}`,
    2
  );

  redacted = replaceGroups(
    redacted,
    /(\b[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^"'\s,;&]+)(["']?)/giu,
    "secret_assignment",
    findings,
    (match, prefix, quote, secret, suffixQuote) => {
      if (isAlreadyRedacted(secret)) return match;
      const closingQuote = quote && suffixQuote === quote ? suffixQuote : quote;
      return `${prefix}${quote}${redactionMarkers.secret_assignment}${closingQuote}`;
    },
    3
  );

  redacted = replaceGroups(
    redacted,
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/giu,
    "url_credential",
    findings,
    (match, prefix, _user, secret) =>
      isAlreadyRedacted(secret) ? match : `${prefix}${redactionMarkers.url_credential}@`,
    3
  );

  redacted = replaceGroups(
    redacted,
    /([?&](?:access_token|refresh_token|id_token|api_key|apikey|token|password|secret|client_secret|auth)=)([^&#\s]+)/giu,
    "sensitive_query",
    findings,
    (match, prefix, secret) => isAlreadyRedacted(secret) ? match : `${prefix}${redactionMarkers.sensitive_query}`,
    2
  );

  for (const item of commonTokenPatterns) {
    redacted = replaceAll(redacted, item.pattern, item.kind, findings);
  }

  return {
    redacted,
    findings,
    changed: redacted !== value
  };
}

export function redactJsonValue<T>(value: T, options: SecretRedactionOptions = {}): T {
  return redactJsonValueInner(value, options) as T;
}

export function redactRecordValues(
  value: Record<string, string> | undefined,
  options: SecretRedactionOptions = {}
): Record<string, string> | undefined {
  if (!value) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactValueForKey(key, item, options);
  }
  return redacted;
}

export function knownSecretsFromEnv(env: Record<string, string | undefined> | undefined) {
  if (!env) return [];
  return normalizeKnownSecrets(
    Object.entries(env)
      .filter(([key]) => isSecretBearingKey(key))
      .map(([, value]) => value)
  );
}

export function isSecretBearingKey(key: string) {
  return secretKeyPattern.test(normalizeKey(key)) || secretKeyLoosePattern.test(key);
}

function redactJsonValueInner(
  value: unknown,
  options: SecretRedactionOptions,
  parentKey?: string
): unknown {
  if (typeof value === "string") {
    return parentKey ? redactValueForKey(parentKey, value, options) : redactSecrets(value, options).redacted;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValueInner(item, options, parentKey));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = redactJsonValueInner(item, options, key);
  }
  return output;
}

function redactValueForKey(key: string, value: string, options: SecretRedactionOptions) {
  if (!value.trim() || isAlreadyRedacted(value)) return value;
  if (isSecretBearingKey(key)) return redactionMarkers.secret_assignment;
  return redactSecrets(value, options).redacted;
}

function replaceAll(
  value: string,
  pattern: RegExp,
  kind: SecretFindingKind,
  findings: SecretFinding[]
) {
  return value.replace(pattern, (match: string) => {
    if (isAlreadyRedacted(match)) return match;
    findings.push(finding(kind, match));
    return redactionMarkers[kind];
  });
}

function replaceGroups(
  value: string,
  pattern: RegExp,
  kind: SecretFindingKind,
  findings: SecretFinding[],
  replacement: (...groups: string[]) => string,
  secretGroupIndex: number
) {
  return value.replace(pattern, (...args: Array<string | number>) => {
    const match = String(args[0] ?? "");
    const secret = String(args[secretGroupIndex] ?? match);
    const groupArgs = args.slice(0, -2).map((item) => String(item));
    const next = replacement(...groupArgs);
    if (next !== match) findings.push(finding(kind, secret));
    return next;
  });
}

function normalizeKnownSecrets(secrets: Array<string | null | undefined> | undefined) {
  return [...new Set(
    (secrets ?? [])
      .map((secret) => secret?.trim() ?? "")
      .filter((secret) => secret.length >= 4 && !isLowSignalSecret(secret))
  )].sort((left, right) => right.length - left.length);
}

function isLowSignalSecret(value: string) {
  return /^(?:true|false|null|undefined|none|test|token|secret|password|changeme|example)$/iu.test(value);
}

function isAlreadyRedacted(value: string) {
  return value.includes("[REDACTED:");
}

function finding(kind: SecretFindingKind, value: string): SecretFinding {
  return {
    kind,
    fingerprint: createHash("sha256").update(value).digest("hex").slice(0, 12)
  };
}

function normalizeKey(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[^a-zA-Z0-9]+/gu, "_").toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
