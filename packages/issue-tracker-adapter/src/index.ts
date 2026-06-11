import type {
  BugReport,
  ExternalIssueLink,
  ExternalIssueProvider,
  ExternalIssueStatusCategory,
  WorkItem
} from "@patchpilot/domain";

export interface ExternalIssueRecord {
  provider: ExternalIssueProvider;
  externalIssueId: string;
  externalKey?: string;
  externalUrl?: string;
  title: string;
  statusName: string;
  statusCategory: ExternalIssueStatusCategory;
  labels: string[];
  updatedAt: string;
}

export interface ExternalIssueUpsertInput {
  link: ExternalIssueLink;
  entity: WorkItem | BugReport;
  entityType: "work_item" | "defect";
  now?: string;
}

export interface ExternalIssueTrackerAdapter {
  provider: ExternalIssueProvider;
  upsertIssue(input: ExternalIssueUpsertInput): Promise<ExternalIssueRecord>;
}

export type ExternalIssueAdapterRegistry = Partial<Record<ExternalIssueProvider, ExternalIssueTrackerAdapter>>;

const terminalWorkItemStatuses = new Set<WorkItem["status"]>(["done", "cancelled"]);
const terminalBugStatuses = new Set<BugReport["status"]>(["closed", "unreproducible"]);

const statusAliases: Record<ExternalIssueProvider, Record<string, ExternalIssueStatusCategory>> = {
  linear: {
    backlog: "todo",
    todo: "todo",
    triage: "todo",
    unstarted: "todo",
    ready: "ready",
    started: "in_progress",
    "in progress": "in_progress",
    in_progress: "in_progress",
    blocked: "blocked",
    done: "done",
    completed: "done",
    closed: "done",
    canceled: "cancelled",
    cancelled: "cancelled"
  },
  jira: {
    backlog: "todo",
    open: "todo",
    todo: "todo",
    "to do": "todo",
    "selected for development": "ready",
    ready: "ready",
    "in progress": "in_progress",
    in_progress: "in_progress",
    blocked: "blocked",
    impediment: "blocked",
    done: "done",
    resolved: "done",
    closed: "done",
    canceled: "cancelled",
    cancelled: "cancelled",
    "won't do": "cancelled",
    "wont do": "cancelled"
  }
};

export function normalizeExternalIssueStatus(input: {
  provider: ExternalIssueProvider;
  statusName: string;
  statusCategory?: ExternalIssueStatusCategory;
}): { statusName: string; statusCategory: ExternalIssueStatusCategory } {
  const statusName = input.statusName.trim();
  if (input.statusCategory) return { statusName, statusCategory: input.statusCategory };
  const normalized = statusName.toLowerCase().replace(/\s+/g, " ");
  return {
    statusName,
    statusCategory: statusAliases[input.provider][normalized] ?? "todo"
  };
}

export function patchPilotWorkItemStatusCategory(status: WorkItem["status"]): ExternalIssueStatusCategory {
  if (status === "blocked") return "blocked";
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "running" || status === "claimed" || status === "review") return "in_progress";
  return "ready";
}

export function patchPilotBugStatusCategory(status: BugReport["status"]): ExternalIssueStatusCategory {
  if (status === "closed") return "done";
  if (status === "unreproducible") return "cancelled";
  if (status === "fixing" || status === "verifying") return "in_progress";
  if (status === "reproduced") return "ready";
  return "todo";
}

export function shouldExternalStatusTriggerWork(category: ExternalIssueStatusCategory) {
  return category === "todo" || category === "ready" || category === "in_progress";
}

export function shouldExternalStatusBlockWork(category: ExternalIssueStatusCategory) {
  return category === "blocked";
}

export function isPatchPilotTerminalEntity(entity: WorkItem | BugReport, entityType: "work_item" | "defect") {
  return entityType === "work_item"
    ? terminalWorkItemStatuses.has((entity as WorkItem).status)
    : terminalBugStatuses.has((entity as BugReport).status);
}

export function createMemoryIssueTrackerAdapter(provider: ExternalIssueProvider): ExternalIssueTrackerAdapter & {
  readonly issues: Map<string, ExternalIssueRecord>;
  readonly upserts: ExternalIssueRecord[];
} {
  const issues = new Map<string, ExternalIssueRecord>();
  const upserts: ExternalIssueRecord[] = [];
  return {
    provider,
    issues,
    upserts,
    async upsertIssue(input) {
      const updatedAt = input.now ?? new Date().toISOString();
      const statusCategory = input.entityType === "work_item"
        ? patchPilotWorkItemStatusCategory((input.entity as WorkItem).status)
        : patchPilotBugStatusCategory((input.entity as BugReport).status);
      const statusName = statusNameForCategory(provider, statusCategory);
      const record: ExternalIssueRecord = {
        provider,
        externalIssueId: input.link.externalIssueId,
        ...(input.link.externalKey ? { externalKey: input.link.externalKey } : {}),
        ...(input.link.externalUrl ? { externalUrl: input.link.externalUrl } : {}),
        title: input.entity.title,
        statusName,
        statusCategory,
        labels: [
          "patchpilot",
          input.entityType,
          input.entityType === "work_item" ? (input.entity as WorkItem).role : (input.entity as BugReport).severity
        ],
        updatedAt
      };
      issues.set(issueMapKey(provider, input.link), record);
      upserts.push(record);
      return record;
    }
  };
}

export function createMemoryIssueTrackerAdapters(): Record<ExternalIssueProvider, ExternalIssueTrackerAdapter> {
  return {
    linear: createMemoryIssueTrackerAdapter("linear"),
    jira: createMemoryIssueTrackerAdapter("jira")
  };
}

export function issueMapKey(provider: ExternalIssueProvider, input: Pick<ExternalIssueLink, "externalIssueId" | "externalKey">) {
  return `${provider}:${input.externalIssueId || input.externalKey || "unknown"}`;
}

function statusNameForCategory(provider: ExternalIssueProvider, category: ExternalIssueStatusCategory) {
  const names: Record<ExternalIssueProvider, Record<ExternalIssueStatusCategory, string>> = {
    linear: {
      todo: "Todo",
      ready: "Ready",
      in_progress: "In Progress",
      blocked: "Blocked",
      done: "Done",
      cancelled: "Canceled"
    },
    jira: {
      todo: "To Do",
      ready: "Selected for Development",
      in_progress: "In Progress",
      blocked: "Blocked",
      done: "Done",
      cancelled: "Cancelled"
    }
  };
  return names[provider][category];
}
