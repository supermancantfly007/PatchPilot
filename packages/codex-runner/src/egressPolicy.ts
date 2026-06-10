import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { executeCommand } from "@patchpilot/command-executor";
import {
  defaultEgressAllowedHosts,
  defaultEgressAuditLogPath,
  type EgressPolicyAuditEntry,
  type EgressPolicyEvidence,
  type EgressPolicyRuntimeConfig
} from "@patchpilot/domain";

export const egressProxyHost = "patchpilot-egress-proxy";
export const privateEgressAuditLogPath = "private://egress-audit.jsonl";

export function defaultEgressPolicyConfig(): EgressPolicyRuntimeConfig {
  return {
    enabled: true,
    allowedHosts: [...defaultEgressAllowedHosts],
    allowGitRemotes: true,
    proxyImage: "node:24-alpine",
    proxyPort: 3128,
    auditLogPath: defaultEgressAuditLogPath,
    denyPrivateNetworks: true,
    denyMetadataEndpoints: true
  };
}

export async function buildEffectiveEgressAllowedHosts(
  config: EgressPolicyRuntimeConfig,
  workspacePath: string
) {
  const gitHosts = config.allowGitRemotes ? await readGitRemoteHosts(workspacePath) : [];
  return normalizeAllowedHosts([...config.allowedHosts, ...gitHosts]);
}

export function normalizeAllowedHosts(hosts: string[]) {
  return [...new Set(hosts.map(normalizeHostPattern).filter((host): host is string => Boolean(host)))].sort();
}

export function isEgressHostAllowed(host: string, allowedHosts: string[]) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost || isMetadataHost(normalizedHost)) return false;
  return normalizeAllowedHosts(allowedHosts).some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
    }
    return normalizedHost === pattern;
  });
}

export function isPrivateOrMetadataIp(value: string) {
  const normalized = normalizeIp(value);
  if (!normalized) return false;
  if (normalized === "169.254.169.254") return true;

  const maybeV4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
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
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}

export function isMetadataHost(host: string) {
  const normalized = normalizeHost(host);
  return Boolean(
    normalized &&
      (
        normalized === "metadata.google.internal" ||
        normalized === "metadata.azure.com" ||
        normalized === "metadata.oraclecloud.com" ||
        normalized === "169.254.169.254" ||
        normalized.endsWith(".metadata.google.internal")
      )
  );
}

export function resolveEgressAuditLogPath(workspacePath: string, auditLogPath: string) {
  return isAbsolute(auditLogPath) ? auditLogPath : join(workspacePath, auditLogPath);
}

export async function readEgressPolicyEvidence(
  config: EgressPolicyRuntimeConfig,
  workspacePath: string,
  allowedHosts: string[] = config.allowedHosts,
  auditLogHostPath?: string
): Promise<EgressPolicyEvidence> {
  if (!config.enabled) {
    return {
      enabled: false,
      mode: "disabled",
      allowedHosts: normalizeAllowedHosts(allowedHosts),
      auditLogPath: auditLogHostPath ? privateEgressAuditLogPath : config.auditLogPath,
      allowedCount: 0,
      deniedCount: 0,
      denied: [],
      recent: []
    };
  }

  const entries = await readEgressAuditEntries(
    auditLogHostPath ?? resolveEgressAuditLogPath(workspacePath, config.auditLogPath)
  );
  const recent = entries.slice(-25);
  const denied = entries.filter((entry) => entry.decision === "denied").slice(-25);
  return {
    enabled: true,
    mode: "proxy_sidecar",
    allowedHosts: normalizeAllowedHosts(allowedHosts),
    auditLogPath: auditLogHostPath ? privateEgressAuditLogPath : config.auditLogPath,
    allowedCount: entries.filter((entry) => entry.decision === "allowed").length,
    deniedCount: entries.filter((entry) => entry.decision === "denied").length,
    denied,
    recent
  };
}

export function mergeEgressPolicyEvidence(
  entries: EgressPolicyEvidence[],
  allowedHosts: string[]
): EgressPolicyEvidence | undefined {
  const enabledEntries = entries.filter((entry) => entry.enabled);
  if (enabledEntries.length === 0) return undefined;
  const recent = enabledEntries.flatMap((entry) => entry.recent).slice(-25);
  const denied = enabledEntries.flatMap((entry) => entry.denied).slice(-25);
  return {
    enabled: true,
    mode: "proxy_sidecar",
    allowedHosts: normalizeAllowedHosts([
      ...allowedHosts,
      ...enabledEntries.flatMap((entry) => entry.allowedHosts)
    ]),
    auditLogPath: privateEgressAuditLogPath,
    allowedCount: enabledEntries.reduce((sum, entry) => sum + entry.allowedCount, 0),
    deniedCount: enabledEntries.reduce((sum, entry) => sum + entry.deniedCount, 0),
    denied,
    recent
  };
}

export async function readEgressAuditEntries(auditLogPath: string): Promise<EgressPolicyAuditEntry[]> {
  try {
    const content = await readFile(auditLogPath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as EgressPolicyAuditEntry;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is EgressPolicyAuditEntry => Boolean(entry?.decision && entry.host));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function buildEgressProxyNodeEvalScript() {
  return `eval(Buffer.from('${Buffer.from(egressProxyScript, "utf8").toString("base64")}', 'base64').toString('utf8'))`;
}

function normalizeHostPattern(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/u, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("*.")) {
    const suffix = normalizeHost(trimmed.slice(2));
    return suffix ? `*.${suffix}` : undefined;
  }
  return normalizeHost(trimmed);
}

function normalizeHost(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/u, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/\.+$/u, "");
    } catch {
      return undefined;
    }
  }
  if (trimmed.includes("@") && trimmed.includes(":") && !trimmed.includes("/")) {
    return trimmed.split("@").pop()?.split(":")[0]?.toLowerCase();
  }
  if (trimmed.includes(":") && !isIP(trimmed)) return trimmed.split(":")[0]?.toLowerCase();
  return trimmed;
}

function normalizeIp(value: string) {
  const normalized = normalizeHost(value);
  return normalized && isIP(normalized) ? normalized : undefined;
}

async function readGitRemoteHosts(workspacePath: string) {
  const result = await runCommand("git", ["-C", workspacePath, "config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (result.exitCode !== 0) return [];
  return result.output
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).slice(1).join(" "))
    .map(parseGitRemoteHost)
    .filter((host): host is string => Boolean(host));
}

function parseGitRemoteHost(remoteUrl: string) {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      return normalizeHost(new URL(trimmed).hostname);
    } catch {
      return undefined;
    }
  }
  const scpLike = trimmed.match(/^(?:[^@]+@)?([^:/]+):/u);
  return scpLike?.[1] ? normalizeHost(scpLike[1]) : normalizeHost(trimmed);
}

function runCommand(command: string, args: string[]) {
  return executeCommand({
    kind: command === "git" ? "git" : "runtime",
    command,
    args,
    cwd: process.cwd(),
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024
  });
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

const egressProxyScript = String.raw`
const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const proxyPort = Number(process.env.PP_EGRESS_PROXY_PORT || "3128");
const auditLogPath = process.env.PP_EGRESS_AUDIT_LOG || "/workspace/.patchpilot/egress-audit.jsonl";
const allowedHosts = normalizeAllowedHosts(JSON.parse(process.env.PP_EGRESS_ALLOWED_HOSTS || "[]"));

fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });

const server = http.createServer(async (request, response) => {
  if (request.url === "/__health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  const target = targetFromRequest(request);
  if (!target) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("PatchPilot egress proxy could not parse target");
    return;
  }

  const decision = await authorizeTarget({
    protocol: target.protocol.replace(":", "") || "http",
    host: target.hostname,
    port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
    target: target.toString()
  });
  writeAudit(decision);
  if (decision.decision === "denied") {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("PatchPilot egress policy denied " + decision.target + ": " + decision.reason + "\n");
    request.resume();
    return;
  }

  const headers = { ...request.headers, host: target.host };
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: decision.resolvedIps && decision.resolvedIps[0] ? decision.resolvedIps[0] : target.hostname,
    servername: target.hostname,
    port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
    method: request.method,
    path: target.pathname + target.search,
    headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("PatchPilot egress proxy upstream error: " + error.message + "\n");
  });
  request.pipe(upstream);
});

server.on("connect", async (request, socket, head) => {
  const target = parseConnectTarget(request.url || "");
  if (!target) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const decision = await authorizeTarget({
    protocol: "https",
    host: target.host,
    port: target.port,
    target: "https://" + target.host + ":" + target.port
  });
  writeAudit(decision);
  if (decision.decision === "denied") {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\nPatchPilot egress policy denied: " + decision.reason + "\n");
    return;
  }

  const upstream = net.connect(target.port, decision.resolvedIps && decision.resolvedIps[0] ? decision.resolvedIps[0] : target.host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
});

server.listen(proxyPort, "0.0.0.0");

function targetFromRequest(request) {
  try {
    if (request.url && /^[a-z][a-z0-9+.-]*:\/\//i.test(request.url)) return new URL(request.url);
    const host = request.headers.host;
    if (!host) return undefined;
    return new URL("http://" + host + (request.url || "/"));
  } catch {
    return undefined;
  }
}

function parseConnectTarget(value) {
  const match = value.match(/^\[?([^\]]+)\]?:([0-9]+)$/);
  if (!match) return undefined;
  return { host: normalizeHost(match[1]), port: Number(match[2]) };
}

async function authorizeTarget(target) {
  const host = normalizeHost(target.host);
  const deniedBase = {
    at: new Date().toISOString(),
    decision: "denied",
    protocol: target.protocol,
    host,
    port: target.port,
    target: target.target
  };

  if (!host) return { ...deniedBase, reason: "invalid_host" };
  if (isMetadataHost(host)) return { ...deniedBase, reason: "metadata_endpoint" };
  if (!isHostAllowed(host, allowedHosts)) return { ...deniedBase, reason: "host_not_allowlisted" };

  const resolvedIps = await resolveHost(host);
  if (resolvedIps.length === 0) return { ...deniedBase, reason: "dns_resolution_failed" };
  if (resolvedIps.some(isPrivateOrMetadataIp)) {
    return { ...deniedBase, reason: "private_or_metadata_network", resolvedIps };
  }

  return {
    at: new Date().toISOString(),
    decision: "allowed",
    reason: "allowlisted",
    protocol: target.protocol,
    host,
    port: target.port,
    target: target.target,
    resolvedIps
  };
}

async function resolveHost(host) {
  if (net.isIP(host)) return [host];
  try {
    return (await dns.lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    return [];
  }
}

function writeAudit(entry) {
  fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n", "utf8");
}

function normalizeAllowedHosts(hosts) {
  return [...new Set(hosts.map(normalizeHostPattern).filter(Boolean))].sort();
}

function normalizeHostPattern(value) {
  const trimmed = String(value || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("*.")) {
    const suffix = normalizeHost(trimmed.slice(2));
    return suffix ? "*." + suffix : undefined;
  }
  return normalizeHost(trimmed);
}

function isHostAllowed(host, hosts) {
  if (isMetadataHost(host)) return false;
  return hosts.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function normalizeHost(value) {
  const trimmed = String(value || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      return undefined;
    }
  }
  if (trimmed.includes("@") && trimmed.includes(":") && !trimmed.includes("/")) {
    const parts = trimmed.split("@");
    return parts[parts.length - 1].split(":")[0].toLowerCase();
  }
  if (trimmed.includes(":") && !net.isIP(trimmed)) return trimmed.split(":")[0].toLowerCase();
  return trimmed;
}

function isMetadataHost(host) {
  return Boolean(
    host === "metadata.google.internal" ||
      host === "metadata.azure.com" ||
      host === "metadata.oraclecloud.com" ||
      host === "169.254.169.254" ||
      host.endsWith(".metadata.google.internal")
  );
}

function isPrivateOrMetadataIp(value) {
  const host = normalizeHost(value);
  if (!host || !net.isIP(host)) return false;
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
  return host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
}

function ipv4ToInt(ip) {
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

function inV4Range(ip, cidrBase, prefixLength) {
  const base = ipv4ToInt(cidrBase);
  if (base === undefined) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ip & mask) === (base & mask);
}
`;
