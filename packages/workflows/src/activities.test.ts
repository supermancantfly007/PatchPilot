import { describe, expect, it } from "vitest";
import {
  createRequirementIntakeActivities,
  InMemoryRequirementIntakeActivityStore,
  InMemoryTemporalCanaryActivityStore,
  InMemoryWorkItemPlanningActivityStore
} from "./activities";
import type { Prd } from "@patchpilot/domain";

describe("Temporal canary activities", () => {
  it("deduplicates activity completion by idempotency key", async () => {
    const store = new InMemoryTemporalCanaryActivityStore();
    const first = await store.complete({
      workflowId: "workflow-1",
      idempotencyKey: "td-204-key",
      label: "first"
    });
    const second = await store.complete({
      workflowId: "workflow-1",
      idempotencyKey: "td-204-key",
      label: "second"
    });

    expect(second).toBe(first);
    expect(second.label).toBe("first");
    expect(store.completed.size).toBe(1);
  });
});

describe("Requirement intake activities", () => {
  it("records a clarification answer and creates a PRD draft idempotently", async () => {
    const store = new InMemoryRequirementIntakeActivityStore();
    const activities = createRequirementIntakeActivities(store);
    const started = await activities.startRequirementIntakeActivity({
      workflowId: "workflow-td-205",
      idempotencyKey: "td-205:requirement",
      rawInput: "Build requirement intake over Temporal",
      template: "feature"
    });

    expect(started.requirement.status).toBe("clarifying");
    expect(started.currentQuestion?.question).toContain("用户可见结果");

    const recorded = await activities.recordRequirementClarificationAnswerActivity({
      workflowId: "workflow-td-205",
      idempotencyKey: "td-205:clarification:1",
      requirementId: started.requirement.id,
      questionId: started.currentQuestion?.id,
      answer: {
        actor: "product",
        answer: "The workflow should resume from a user signal and draft a PRD."
      },
      shouldDraftPrd: true
    });
    expect(recorded.readyForPrd).toBe(true);
    expect(recorded.requirement.status).toBe("prd_draft");
    expect(recorded.clarificationAnswerCount).toBe(1);

    const draft = await activities.draftRequirementPrdActivity({
      workflowId: "workflow-td-205",
      idempotencyKey: "td-205:prd",
      requirementId: started.requirement.id
    });
    const duplicateDraft = await activities.draftRequirementPrdActivity({
      workflowId: "workflow-td-205",
      idempotencyKey: "td-205:prd",
      requirementId: started.requirement.id
    });

    expect(draft.prd.id).toBe(`prd_${started.requirement.id}`);
    expect(draft.prd.bodyMarkdown).toContain("The workflow should resume from a user signal");
    expect(duplicateDraft).toEqual(draft);
  });

  it("supports another clarification round before drafting the PRD", async () => {
    const store = new InMemoryRequirementIntakeActivityStore();
    const activities = createRequirementIntakeActivities(store);
    const started = await activities.startRequirementIntakeActivity({
      workflowId: "workflow-td-205",
      idempotencyKey: "td-205:iterative:requirement",
      rawInput: "Improve the Simple Mode intake flow",
      template: "ui"
    });

    const recorded = await activities.recordRequirementClarificationAnswerActivity({
      workflowId: "workflow-td-205",
      idempotencyKey: "td-205:iterative:clarification:1",
      requirementId: started.requirement.id,
      questionId: started.currentQuestion?.id,
      answer: {
        actor: "product",
        answer: "The first visible outcome is a clear PRD preview.",
        continueClarification: true
      },
      shouldDraftPrd: false
    });

    expect(recorded.readyForPrd).toBe(false);
    expect(recorded.requirement.status).toBe("clarifying");
    expect(recorded.nextQuestion?.id).toBe("visual_style");
    expect(recorded.requirement.clarificationTurns.at(-1)?.speaker).toBe("agent");
  });
});

describe("Work item planning activities", () => {
  it("creates vertical work items, test cases, and a contract baseline", async () => {
    const store = new InMemoryWorkItemPlanningActivityStore();
    const result = await store.planWorkItems({
      workflowId: "workflow-td-206",
      idempotencyKey: "td-206:plan",
      prd: planningPrd(),
      maxWorkItems: 4
    });

    expect(result.workItems).toHaveLength(3);
    expect(result.workItems.every((item) => item.status === "ready")).toBe(true);
    expect(result.workItems.every((item) => item.scope.includes("垂直切片"))).toBe(true);
    expect(result.workItems.every((item) => item.testSuggestions.length >= 3)).toBe(true);
    expect(result.workItems.map((item) => item.role)).toEqual(["backend", "frontend", "test"]);
    expect(new Set(result.workItems.map((item) => item.id)).size).toBe(result.workItems.length);
    expect(result.testCases.map((testCase) => testCase.workItemId)).toEqual(result.workItems.map((item) => item.id));
    expect(result.testCases.every((testCase) => testCase.status === "ready")).toBe(true);
    expect(result.interfaceContracts).toHaveLength(3);
    expect(result.interfaceContracts.every((contract) => contract.status === "approved")).toBe(true);
  });

  it("deduplicates planning by activity key and PRD id", async () => {
    const store = new InMemoryWorkItemPlanningActivityStore();
    const prd = planningPrd();
    const first = await store.planWorkItems({
      workflowId: "workflow-td-206",
      idempotencyKey: "td-206:plan",
      prd,
      maxWorkItems: 4
    });
    const sameActivity = await store.planWorkItems({
      workflowId: "workflow-td-206",
      idempotencyKey: "td-206:plan",
      prd,
      maxWorkItems: 1
    });
    const samePrd = await store.planWorkItems({
      workflowId: "workflow-td-206-retry",
      idempotencyKey: "td-206:plan:duplicate-start",
      prd,
      maxWorkItems: 1
    });

    expect(sameActivity).toEqual(first);
    expect(samePrd).toEqual(first);
    expect(store.plansByPrdId.size).toBe(1);
    expect(store.planned.size).toBe(2);
  });

  it("clamps planning to four work items", async () => {
    const store = new InMemoryWorkItemPlanningActivityStore();
    const result = await store.planWorkItems({
      workflowId: "workflow-td-206",
      idempotencyKey: "td-206:plan:many",
      prd: planningPrd([
        "Criterion 1 passes",
        "Criterion 2 passes",
        "Criterion 3 passes",
        "Criterion 4 passes",
        "Criterion 5 passes"
      ]),
      maxWorkItems: 9
    });

    expect(result.workItems).toHaveLength(4);
    expect(result.workItems[0]?.acceptanceCriteria).toEqual(["Criterion 1 passes", "Criterion 5 passes"]);
  });
});

function planningPrd(acceptanceCriteria = ["Submit requirement", "Generate PRD", "Plan work items"]): Prd {
  return {
    id: "prd_req_td_206",
    requirementId: "req_td_206",
    version: 1,
    status: "approved",
    title: "Temporal work item planning",
    bodyMarkdown: "# Temporal work item planning\n\n## 如何验收\n" + acceptanceCriteria.map((item) => `- ${item}`).join("\n"),
    acceptanceCriteria,
    approvedAt: "2026-06-10T00:00:00.000Z"
  };
}
