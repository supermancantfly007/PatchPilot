import { describe, expect, it } from "vitest";
import {
  advanceTimeline,
  completeTimeline,
  createPrd,
  createBugFixWorkItem,
  createBugWorkItem,
  createTimeline,
  createTestCasesForWorkItems,
  createWorkItems,
  emptySnapshot,
  createInitialClarificationTurn,
  generateClarificationQuestions,
  makeSimpleSummary,
  testCaseStatusFromTestRunStatus,
  type Requirement
} from "./index";

describe("domain helpers", () => {
  it("creates grill-me style clarification prompts with recommended answers", () => {
    const turn = createInitialClarificationTurn("做一个 agent 平台", "feature", "2026-06-09T00:00:00.000Z");
    const legacyQuestions = generateClarificationQuestions("做一个 agent 平台", "feature");

    expect(turn.speaker).toBe("agent");
    expect(turn.message).toContain("用户可见结果");
    expect(turn.recommendedAnswer).toContain("agent 平台");
    expect(legacyQuestions[0]?.recommendedAnswer).toContain("agent 平台");
  });

  it("advances the simple timeline in order", () => {
    const timeline = advanceTimeline(createTimeline(), "testing");
    expect(timeline.find((step) => step.key === "developing")?.status).toBe("done");
    expect(timeline.find((step) => step.key === "testing")?.status).toBe("active");
    expect(timeline.find((step) => step.key === "confirming")?.status).toBe("waiting");
  });

  it("creates a PRD and team work items", () => {
    const requirement: Requirement = {
      id: "req_1",
      title: "Agent 平台",
      rawInput: "构建一个可用 agent 平台",
      template: "feature",
      status: "prd_draft",
      simpleSummary: makeSimpleSummary("构建一个可用 agent 平台", "feature"),
      clarificationQuestions: [],
      clarificationTurns: [
        createInitialClarificationTurn("构建一个可用 agent 平台", "feature", "2026-06-09T00:00:00.000Z")
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const prd = createPrd(requirement);
    const workItems = createWorkItems(prd);

    expect(prd.bodyMarkdown).toContain("## 如何验收");
    expect(workItems).toHaveLength(4);
    expect(workItems.map((item) => item.role)).toEqual(["backend", "frontend", "test", "ops"]);
    expect(workItems.every((item) => item.acceptanceCriteria === prd.acceptanceCriteria)).toBe(true);

    const testCases = createTestCasesForWorkItems(prd, workItems, "2026-06-09T00:00:00.000Z");
    expect(testCases).toHaveLength(4);
    expect(testCases[0]?.workItemId).toBe(workItems[0]?.id);
    expect(testCases.every((testCase) => testCase.status === "ready")).toBe(true);
    expect(testCases.every((testCase) => testCase.linkedAcceptanceCriteria === prd.acceptanceCriteria)).toBe(true);
  });

  it("can mark the full timeline complete", () => {
    expect(completeTimeline(createTimeline()).every((step) => step.status === "done")).toBe(true);
  });

  it("creates separate bug reproduction and fix work items", () => {
    const base = {
      bugId: "bug_1",
      requirementId: "req_bug_1",
      prdId: "prd_req_bug_1",
      title: "按钮没有反应",
      now: "2026-06-09T00:00:00.000Z"
    };
    const repro = createBugWorkItem(base);
    const fix = createBugFixWorkItem(base);

    expect(repro.role).toBe("test");
    expect(repro.id).toContain("bugrepro");
    expect(fix.role).toBe("backend");
    expect(fix.id).toContain("devfix");
    expect(repro.sourceBugId).toBe(base.bugId);
    expect(fix.sourceBugId).toBe(base.bugId);
  });

  it("maps test run states back to reusable test cases", () => {
    expect(testCaseStatusFromTestRunStatus("passed")).toBe("passed");
    expect(testCaseStatusFromTestRunStatus("failed")).toBe("failed");
    expect(testCaseStatusFromTestRunStatus("blocked")).toBe("blocked");
    expect(testCaseStatusFromTestRunStatus("skipped")).toBe("blocked");
    expect(testCaseStatusFromTestRunStatus("running")).toBe("ready");
  });

  it("initializes approval records in empty snapshots", () => {
    expect(emptySnapshot().approvals).toEqual([]);
  });
});
