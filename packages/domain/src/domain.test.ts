import { describe, expect, it } from "vitest";
import {
  advanceTimeline,
  completeTimeline,
  computeAuditEventHash,
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
  verifyAuditChain,
  type AuditEvent,
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

  it("computes stable audit hashes for equivalent JSON payloads", () => {
    const base = auditEvent({
      beforeJson: { status: "ready", nested: { b: 2, a: 1 } },
      afterJson: { nested: { z: false, a: true }, status: "running" }
    });
    const reordered = auditEvent({
      beforeJson: { nested: { a: 1, b: 2 }, status: "ready" },
      afterJson: { status: "running", nested: { a: true, z: false } }
    });

    expect(computeAuditEventHash(base)).toBe(computeAuditEventHash(reordered));
  });

  it("verifies audit hash chains and detects tampering", () => {
    const first = auditEvent({ id: "audit_1", action: "work_item.claimed" });
    first.hash = computeAuditEventHash(first);
    const second = auditEvent({
      id: "audit_2",
      action: "work_item.started",
      previousHash: first.hash
    });
    second.hash = computeAuditEventHash(second);

    const valid = verifyAuditChain([second, first]);
    expect(valid).toMatchObject({
      valid: true,
      checkedEvents: 2,
      headHash: second.hash,
      errors: []
    });

    const tampered = { ...second, afterJson: { status: "tampered" } };
    expect(verifyAuditChain([tampered, first])).toMatchObject({
      valid: false,
      checkedEvents: 2
    });
  });
});

function auditEvent(input: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "audit_1",
    traceId: "trace_1",
    actorType: "agent",
    actorId: "agent_backend",
    actor: "agent_backend",
    action: "work_item.updated",
    targetType: "work_item",
    targetId: "wi_1",
    message: "Work item changed.",
    beforeJson: null,
    afterJson: null,
    metadataJson: {},
    previousHash: null,
    hash: "",
    createdAt: "2026-06-10T00:00:00.000Z",
    ...input
  };
}
