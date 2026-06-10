import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRole, AgentRun, WorkItemStatus } from "@patchpilot/domain";

const workItemFence = "patchpilot-work-item-json";
const runReportFence = "patchpilot-run-report-json";
const defaultLockTimeoutMs = 5000;
const defaultStaleLockMs = 30000;
const defaultRetryIntervalMs = 10;
const defaultLeaseMs = 5 * 60 * 1000;

export interface ScratchMarkdownStoreOptions {
  rootDir: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryIntervalMs?: number;
}

export interface ScratchWorkItem {
  id: string;
  title: string;
  role: AgentRole;
  status: WorkItemStatus;
  scope: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  testSuggestions: string[];
  claimOwner?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  bodyMarkdown?: string;
  sourcePath?: string;
}

export interface ScratchRunReport {
  id: string;
  workItemId: string;
  status: AgentRun["status"];
  title: string;
  summary: string;
  testSummary?: string;
  artifacts?: string[];
  createdAt: string;
  completedAt?: string;
  bodyMarkdown?: string;
  sourcePath?: string;
}

export interface ScratchClaimResult {
  claimed: boolean;
  workItem: ScratchWorkItem;
  claimToken?: string;
  leaseExpiresAt?: string;
  reason?: "active_claim" | "not_available";
}

export class ScratchStoreError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_MARKDOWN" | "INVALID_STATE" | "LOCK_TIMEOUT",
    message: string
  ) {
    super(message);
    this.name = "ScratchStoreError";
  }
}

export class ScratchMarkdownStore {
  private readonly rootDir: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryIntervalMs: number;

  constructor(options: ScratchMarkdownStoreOptions) {
    this.rootDir = options.rootDir;
    this.lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeoutMs;
    this.staleLockMs = options.staleLockMs ?? defaultStaleLockMs;
    this.retryIntervalMs = options.retryIntervalMs ?? defaultRetryIntervalMs;
  }

  async importWorkItems(): Promise<ScratchWorkItem[]> {
    const files = await listMarkdownFiles(this.workItemsDir());
    const workItems: ScratchWorkItem[] = [];
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      workItems.push({ ...parseScratchWorkItem(markdown), sourcePath: file });
    }
    return workItems.sort((left, right) => left.id.localeCompare(right.id));
  }

  async readWorkItem(id: string): Promise<ScratchWorkItem> {
    const directPath = this.workItemPath(id);
    try {
      const markdown = await readFile(directPath, "utf8");
      return { ...parseScratchWorkItem(markdown), sourcePath: directPath };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const workItem = (await this.importWorkItems()).find((item) => item.id === id);
    if (!workItem) throw new ScratchStoreError("NOT_FOUND", `Scratch work item ${id} was not found`);
    return workItem;
  }

  async exportWorkItem(workItem: ScratchWorkItem): Promise<string> {
    const filePath = this.workItemPath(workItem.id);
    await writeAtomic(filePath, serializeScratchWorkItem(workItem));
    return filePath;
  }

  async claimWorkItem(
    id: string,
    claimOwner: string,
    options: { leaseDurationMs?: number } = {}
  ): Promise<ScratchClaimResult> {
    return this.withWorkItemLock(id, async () => {
      const workItem = await this.readWorkItem(id);
      const now = new Date().toISOString();
      const expiredClaim = workItem.status === "claimed" && isLeaseExpired(workItem, now);
      if (workItem.status === "claimed" && !expiredClaim) {
        return { claimed: false, workItem, reason: "active_claim" };
      }
      if (!["ready", "blocked"].includes(workItem.status) && !expiredClaim) {
        return { claimed: false, workItem, reason: "not_available" };
      }

      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(now) + (options.leaseDurationMs ?? defaultLeaseMs)).toISOString();
      const claimedWorkItem: ScratchWorkItem = {
        ...workItem,
        status: "claimed",
        claimOwner,
        claimToken,
        leaseExpiresAt,
        heartbeatAt: now,
        version: (workItem.version ?? 0) + 1,
        updatedAt: now
      };
      await this.exportWorkItem(claimedWorkItem);
      return { claimed: true, workItem: claimedWorkItem, claimToken, leaseExpiresAt };
    });
  }

  async releaseWorkItem(id: string, options: { claimToken?: string } = {}): Promise<ScratchWorkItem> {
    return this.withWorkItemLock(id, async () => {
      const workItem = await this.readWorkItem(id);
      if (workItem.status !== "claimed") {
        throw new ScratchStoreError("INVALID_STATE", `Scratch work item ${id} is not claimed`);
      }
      if (workItem.claimToken && workItem.claimToken !== options.claimToken) {
        throw new ScratchStoreError("INVALID_STATE", `Scratch work item ${id} claim token does not match`);
      }

      const released: ScratchWorkItem = {
        ...workItem,
        status: "ready",
        claimOwner: undefined,
        claimToken: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
        version: (workItem.version ?? 0) + 1,
        updatedAt: new Date().toISOString()
      };
      await this.exportWorkItem(released);
      return released;
    });
  }

  async exportRunReport(report: ScratchRunReport): Promise<string> {
    const filePath = this.runReportPath(report.id);
    await writeAtomic(filePath, serializeScratchRunReport(report));
    return filePath;
  }

  async importRunReports(): Promise<ScratchRunReport[]> {
    const files = await listMarkdownFiles(this.runReportsDir());
    const reports: ScratchRunReport[] = [];
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      reports.push({ ...parseScratchRunReport(markdown), sourcePath: file });
    }
    return reports.sort((left, right) => left.id.localeCompare(right.id));
  }

  private workItemsDir() {
    return join(this.rootDir, "work-items");
  }

  private runReportsDir() {
    return join(this.rootDir, "run-reports");
  }

  private workItemPath(id: string) {
    return join(this.workItemsDir(), `${safeFileName(id)}.md`);
  }

  private runReportPath(id: string) {
    return join(this.runReportsDir(), `${safeFileName(id)}.md`);
  }

  private workItemLockPath(id: string) {
    return join(this.rootDir, ".patchpilot", "locks", "work-items", `${safeFileName(id)}.lock`);
  }

  private async withWorkItemLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return withDirectoryLock(
      this.workItemLockPath(id),
      {
        timeoutMs: this.lockTimeoutMs,
        staleLockMs: this.staleLockMs,
        retryIntervalMs: this.retryIntervalMs
      },
      operation
    );
  }
}

export function serializeScratchWorkItem(workItem: ScratchWorkItem) {
  return [
    `# Work Item: ${workItem.title}`,
    "",
    `\`\`\`${workItemFence}`,
    JSON.stringify(workItemMetadata(workItem), null, 2),
    "```",
    "",
    "## Body",
    "",
    workItem.bodyMarkdown?.trim() || workItem.scope,
    ""
  ].join("\n");
}

export function parseScratchWorkItem(markdown: string): ScratchWorkItem {
  const { metadata, bodyMarkdown } = parseJsonFence(markdown, workItemFence);
  return normalizeWorkItemMetadata(metadata, stripBodyHeading(bodyMarkdown));
}

export function serializeScratchRunReport(report: ScratchRunReport) {
  return [
    `# Run Report: ${report.title}`,
    "",
    `\`\`\`${runReportFence}`,
    JSON.stringify(runReportMetadata(report), null, 2),
    "```",
    "",
    "## Body",
    "",
    report.bodyMarkdown?.trim() || report.summary,
    ""
  ].join("\n");
}

export function parseScratchRunReport(markdown: string): ScratchRunReport {
  const { metadata, bodyMarkdown } = parseJsonFence(markdown, runReportFence);
  return normalizeRunReportMetadata(metadata, stripBodyHeading(bodyMarkdown));
}

async function withDirectoryLock<T>(
  lockPath: string,
  options: { timeoutMs: number; staleLockMs: number; retryIntervalMs: number },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const lockToken = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);
      await writeLockOwner(lockPath, lockToken);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const removed = await removeStaleLock(lockPath, options.staleLockMs);
      if (removed) continue;
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new ScratchStoreError("LOCK_TIMEOUT", `Timed out acquiring scratch lock ${lockPath}`);
      }
      await sleep(options.retryIntervalMs);
    }
  }

  try {
    return await operation();
  } finally {
    await releaseDirectoryLock(lockPath, lockToken);
  }
}

async function writeLockOwner(lockPath: string, token: string) {
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }),
    "utf8"
  );
}

async function releaseDirectoryLock(lockPath: string, token: string) {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
    if (owner.token !== token) return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function removeStaleLock(lockPath: string, staleLockMs: number) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < staleLockMs) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

async function listMarkdownFiles(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function parseJsonFence(markdown: string, fenceName: string) {
  const startMarker = `\`\`\`${fenceName}`;
  const start = markdown.indexOf(startMarker);
  if (start < 0) {
    throw new ScratchStoreError("INVALID_MARKDOWN", `Missing ${fenceName} metadata fence`);
  }
  const jsonStart = markdown.indexOf("\n", start);
  if (jsonStart < 0) {
    throw new ScratchStoreError("INVALID_MARKDOWN", `Malformed ${fenceName} metadata fence`);
  }
  const end = markdown.indexOf("\n```", jsonStart + 1);
  if (end < 0) {
    throw new ScratchStoreError("INVALID_MARKDOWN", `Unclosed ${fenceName} metadata fence`);
  }
  const rawJson = markdown.slice(jsonStart + 1, end);
  try {
    return {
      metadata: JSON.parse(rawJson) as Record<string, unknown>,
      bodyMarkdown: markdown.slice(end + "\n```".length).trim()
    };
  } catch (error) {
    throw new ScratchStoreError("INVALID_MARKDOWN", `Invalid ${fenceName} JSON metadata: ${formatError(error)}`);
  }
}

function normalizeWorkItemMetadata(metadata: Record<string, unknown>, bodyMarkdown: string): ScratchWorkItem {
  return {
    id: requiredString(metadata, "id"),
    title: requiredString(metadata, "title"),
    role: normalizeRole(requiredString(metadata, "role")),
    status: normalizeWorkItemStatus(requiredString(metadata, "status")),
    scope: optionalString(metadata, "scope") ?? "",
    nonGoals: stringArray(metadata, "nonGoals"),
    acceptanceCriteria: stringArray(metadata, "acceptanceCriteria"),
    testSuggestions: stringArray(metadata, "testSuggestions"),
    claimOwner: optionalString(metadata, "claimOwner"),
    claimToken: optionalString(metadata, "claimToken"),
    leaseExpiresAt: optionalString(metadata, "leaseExpiresAt"),
    heartbeatAt: optionalString(metadata, "heartbeatAt"),
    version: optionalNumber(metadata, "version") ?? 1,
    createdAt: optionalString(metadata, "createdAt"),
    updatedAt: optionalString(metadata, "updatedAt"),
    bodyMarkdown
  };
}

function normalizeRunReportMetadata(metadata: Record<string, unknown>, bodyMarkdown: string): ScratchRunReport {
  return {
    id: requiredString(metadata, "id"),
    workItemId: requiredString(metadata, "workItemId"),
    status: normalizeRunStatus(requiredString(metadata, "status")),
    title: requiredString(metadata, "title"),
    summary: requiredString(metadata, "summary"),
    testSummary: optionalString(metadata, "testSummary"),
    artifacts: stringArray(metadata, "artifacts"),
    createdAt: requiredString(metadata, "createdAt"),
    completedAt: optionalString(metadata, "completedAt"),
    bodyMarkdown
  };
}

function workItemMetadata(workItem: ScratchWorkItem) {
  return {
    id: workItem.id,
    title: workItem.title,
    role: workItem.role,
    status: workItem.status,
    scope: workItem.scope,
    nonGoals: workItem.nonGoals,
    acceptanceCriteria: workItem.acceptanceCriteria,
    testSuggestions: workItem.testSuggestions,
    claimOwner: workItem.claimOwner,
    claimToken: workItem.claimToken,
    leaseExpiresAt: workItem.leaseExpiresAt,
    heartbeatAt: workItem.heartbeatAt,
    version: workItem.version,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt
  };
}

function runReportMetadata(report: ScratchRunReport) {
  return {
    id: report.id,
    workItemId: report.workItemId,
    status: report.status,
    title: report.title,
    summary: report.summary,
    testSummary: report.testSummary,
    artifacts: report.artifacts ?? [],
    createdAt: report.createdAt,
    completedAt: report.completedAt
  };
}

function stripBodyHeading(bodyMarkdown: string) {
  return bodyMarkdown.replace(/^## Body\s*/u, "").trim();
}

function isLeaseExpired(workItem: Pick<ScratchWorkItem, "leaseExpiresAt">, now: string) {
  if (!workItem.leaseExpiresAt) return true;
  const expiresAt = Date.parse(workItem.leaseExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.parse(now);
}

function requiredString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScratchStoreError("INVALID_MARKDOWN", `Missing required string metadata field ${key}`);
  }
  return value;
}

function optionalString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ScratchStoreError("INVALID_MARKDOWN", `Metadata field ${key} must be a string array`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ScratchStoreError("INVALID_MARKDOWN", `Metadata field ${key} must be a string array`);
    }
    return item;
  });
}

function normalizeRole(value: string): AgentRole {
  const roles = ["product", "backend", "frontend", "test", "ops", "reviewer"] as const;
  if (roles.includes(value as AgentRole)) return value as AgentRole;
  throw new ScratchStoreError("INVALID_MARKDOWN", `Invalid scratch work item role ${value}`);
}

function normalizeWorkItemStatus(value: string): WorkItemStatus {
  const statuses = ["proposed", "ready", "claimed", "running", "review", "blocked", "done", "cancelled"] as const;
  if (statuses.includes(value as WorkItemStatus)) return value as WorkItemStatus;
  throw new ScratchStoreError("INVALID_MARKDOWN", `Invalid scratch work item status ${value}`);
}

function normalizeRunStatus(value: string): AgentRun["status"] {
  const statuses = ["queued", "running", "needs_approval", "succeeded", "failed", "cancelled"] as const;
  if (statuses.includes(value as AgentRun["status"])) return value as AgentRun["status"];
  throw new ScratchStoreError("INVALID_MARKDOWN", `Invalid scratch run report status ${value}`);
}

function safeFileName(id: string) {
  return id.replace(/[^a-zA-Z0-9_.-]+/gu, "_") || "item";
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
