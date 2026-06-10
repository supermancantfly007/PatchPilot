import { describe, expect, it } from "vitest";
import {
  createRequirementIntakeActivities,
  InMemoryRequirementIntakeActivityStore,
  InMemoryTemporalCanaryActivityStore
} from "./activities";

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
