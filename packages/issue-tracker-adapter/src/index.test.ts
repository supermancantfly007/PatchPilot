import { describe, expect, it } from "vitest";
import type { BugReport, WorkItem } from "@patchpilot/domain";
import {
  createMemoryIssueTrackerAdapter,
  normalizeExternalIssueStatus,
  patchPilotBugStatusCategory,
  patchPilotWorkItemStatusCategory
} from ".";

const now = "2026-06-11T00:00:00.000Z";

describe("issue tracker adapter", () => {
  it("normalizes Linear and Jira status names into PatchPilot trigger/block categories", () => {
    expect(normalizeExternalIssueStatus({ provider: "linear", statusName: "Started" })).toEqual({
      statusName: "Started",
      statusCategory: "in_progress"
    });
    expect(normalizeExternalIssueStatus({ provider: "linear", statusName: "Blocked" })).toEqual({
      statusName: "Blocked",
      statusCategory: "blocked"
    });
    expect(normalizeExternalIssueStatus({ provider: "jira", statusName: "Selected for Development" })).toEqual({
      statusName: "Selected for Development",
      statusCategory: "ready"
    });
    expect(normalizeExternalIssueStatus({ provider: "jira", statusName: "Impediment" })).toEqual({
      statusName: "Impediment",
      statusCategory: "blocked"
    });
  });

  it("maps PatchPilot WorkItem and Defect states outbound without making external state authoritative", () => {
    expect(patchPilotWorkItemStatusCategory("ready")).toBe("ready");
    expect(patchPilotWorkItemStatusCategory("blocked")).toBe("blocked");
    expect(patchPilotWorkItemStatusCategory("done")).toBe("done");
    expect(patchPilotBugStatusCategory("reported")).toBe("todo");
    expect(patchPilotBugStatusCategory("reproduced")).toBe("ready");
    expect(patchPilotBugStatusCategory("closed")).toBe("done");
  });

  it("uses fixture-backed adapters for deterministic Linear and Jira upsert evidence", async () => {
    const adapter = createMemoryIssueTrackerAdapter("jira");
    const workItem: WorkItem = {
      id: "wi_1",
      prdId: "prd_1",
      title: "Build adapter",
      status: "blocked",
      role: "backend",
      scope: "Sync Jira issues",
      nonGoals: [],
      acceptanceCriteria: [],
      testSuggestions: []
    };

    const record = await adapter.upsertIssue({
      entityType: "work_item",
      entity: workItem,
      link: {
        id: "ext_1",
        provider: "jira",
        externalIssueId: "10001",
        externalKey: "PP-305",
        statusName: "To Do",
        statusCategory: "todo",
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now
      },
      now
    });

    expect(record).toMatchObject({
      provider: "jira",
      externalIssueId: "10001",
      externalKey: "PP-305",
      statusName: "Blocked",
      statusCategory: "blocked",
      labels: ["patchpilot", "work_item", "backend"]
    });
    expect(adapter.upserts).toHaveLength(1);
    expect(adapter.issues.get("jira:10001")).toEqual(record);
  });

  it("mirrors Defect severity as issue metadata labels", async () => {
    const adapter = createMemoryIssueTrackerAdapter("linear");
    const bug: BugReport = {
      id: "bug_1",
      title: "Regression",
      description: "Regression description",
      reproductionSteps: "Open page",
      expectedBehavior: "Works",
      actualBehavior: "Fails",
      severity: "high",
      status: "reproduced",
      reporter: "qa",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      createdAt: now,
      updatedAt: now
    };

    const record = await adapter.upsertIssue({
      entityType: "defect",
      entity: bug,
      link: {
        id: "ext_bug_1",
        provider: "linear",
        externalIssueId: "LIN-1",
        externalKey: "LIN-1",
        statusName: "Todo",
        statusCategory: "todo",
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now
      },
      now
    });

    expect(record).toMatchObject({
      statusName: "Ready",
      statusCategory: "ready",
      labels: ["patchpilot", "defect", "high"]
    });
  });
});
