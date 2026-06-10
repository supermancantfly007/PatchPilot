import { describe, expect, it } from "vitest";
import {
  createApprovalActivities,
  createWorkItemExecutionActivities,
  InMemoryApprovalActivityStore,
  createRequirementIntakeActivities,
  InMemoryRequirementIntakeActivityStore,
  InMemoryTemporalCanaryActivityStore,
  InMemoryWorkItemExecutionActivityStore,
  InMemoryWorkItemPlanningActivityStore
} from "./activities";
import { createTimeline, type AgentRun, type Prd, type TestCase, type WorkItem } from "@patchpilot/domain";

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

describe("Approval activities", () => {
  it("requests approval idempotently and resumes a paused run when approved", async () => {
    const store = new InMemoryApprovalActivityStore();
    const activities = createApprovalActivities(store);
    const pausedRun = approvalPausedRun();

    const requested = await activities.requestApprovalActivity({
      workflowId: "workflow-td-208",
      idempotencyKey: "td-208:approval:request",
      kind: "budget_exceeded",
      targetType: "agent_run",
      targetId: pausedRun.id,
      requestedBy: "budget-governor",
      requestedReason: "Run cost exceeds the configured budget.",
      riskLevel: "high",
      expiresAt: "2999-01-01T00:00:00.000Z",
      requirementId: pausedRun.requirementId,
      prdId: pausedRun.prdId,
      workItemId: pausedRun.workItemId,
      runId: pausedRun.id,
      pausedRun
    });
    const duplicate = await activities.requestApprovalActivity({
      workflowId: "workflow-td-208",
      idempotencyKey: "td-208:approval:request",
      kind: "budget_exceeded",
      targetType: "agent_run",
      targetId: pausedRun.id,
      requestedBy: "other-requester",
      requestedReason: "Duplicate request should not replace the first one.",
      riskLevel: "critical",
      expiresAt: "2999-01-01T00:00:00.000Z",
      pausedRun
    });

    expect(duplicate).toEqual(requested);
    expect(requested.approval.status).toBe("pending");
    expect(requested.run?.status).toBe("needs_approval");
    expect(requested.run?.budgetApprovalId).toBe(requested.approval.id);
    expect(requested.auditEvents.map((event) => event.action)).toEqual(["approval.requested"]);

    const approved = await activities.recordApprovalDecisionActivity({
      workflowId: "workflow-td-208",
      idempotencyKey: "td-208:approval:decision",
      approval: requested.approval,
      decision: {
        status: "approved",
        decidedBy: "human-reviewer",
        decisionReason: "Approved for the Temporal workflow acceptance test."
      },
      pausedRun: requested.run
    });

    expect(approved.approval.status).toBe("approved");
    expect(approved.approval.approvedBy).toBe("human-reviewer");
    expect(approved.run?.status).toBe("running");
    expect(approved.run?.events.at(-1)?.message).toContain("run resumed");
    expect(approved.auditEvents.map((event) => event.action)).toEqual(["approval.approved", "agent_run.resumed"]);
  });

  it("records deny and expire decisions without resuming the paused run", async () => {
    const store = new InMemoryApprovalActivityStore();
    const activities = createApprovalActivities(store);
    const pausedRun = approvalPausedRun();
    const deniedRequest = await activities.requestApprovalActivity({
      workflowId: "workflow-td-208-deny",
      idempotencyKey: "td-208:deny:request",
      kind: "dangerous_operation",
      targetType: "agent_run",
      targetId: pausedRun.id,
      requestedBy: "policy",
      requestedReason: "Dangerous operation requires a human decision.",
      riskLevel: "critical",
      expiresAt: "2999-01-01T00:00:00.000Z",
      pausedRun
    });
    const denied = await activities.recordApprovalDecisionActivity({
      workflowId: "workflow-td-208-deny",
      idempotencyKey: "td-208:deny:decision",
      approval: deniedRequest.approval,
      decision: {
        status: "denied",
        decidedBy: "human-reviewer",
        decisionReason: "The operation is not acceptable."
      },
      pausedRun: deniedRequest.run
    });
    expect(denied.approval.status).toBe("denied");
    expect(denied.run?.status).toBe("needs_approval");
    expect(denied.auditEvents.map((event) => event.action)).toEqual(["approval.denied"]);

    const expiredRequest = await activities.requestApprovalActivity({
      workflowId: "workflow-td-208-expire",
      idempotencyKey: "td-208:expire:request",
      kind: "network_allowlist_change",
      targetType: "network",
      targetId: "network-prod-egress",
      requestedBy: "policy",
      requestedReason: "Network allowlist change timed out.",
      riskLevel: "high",
      expiresAt: "2999-01-01T00:00:00.000Z",
      pausedRun
    });
    const expired = await activities.recordApprovalDecisionActivity({
      workflowId: "workflow-td-208-expire",
      idempotencyKey: "td-208:expire:decision",
      approval: expiredRequest.approval,
      decision: {
        status: "expired",
        decidedBy: "workflow",
        decisionReason: "Approval timed out before a decision."
      },
      pausedRun: expiredRequest.run
    });
    expect(expired.approval.status).toBe("expired");
    expect(expired.run?.status).toBe("needs_approval");
    expect(expired.auditEvents.map((event) => event.action)).toEqual(["approval.expired"]);
  });
});

describe("Work item execution activities", () => {
  it("claims, executes, reviews, archives, and completes with a terminal evidence chain", async () => {
    const store = new InMemoryWorkItemExecutionActivityStore();
    const activities = createWorkItemExecutionActivities(store);
    const prd = executionPrd();
    const workItem = executionWorkItem(prd);
    const workflowId = "workflow-td-207";

    const claim = await activities.claimWorkItemExecutionActivity({
      workflowId,
      idempotencyKey: "td-207:claim",
      workItem,
      agentId: "agent_backend"
    });
    const duplicateClaim = await activities.claimWorkItemExecutionActivity({
      workflowId,
      idempotencyKey: "td-207:claim",
      workItem,
      agentId: "agent_frontend"
    });
    expect(duplicateClaim).toEqual(claim);
    expect(claim.workItem.status).toBe("claimed");
    expect(claim.workItem.claimToken).toBe(claim.claimToken);

    const prepared = await activities.prepareWorkItemWorkspaceActivity({
      workflowId,
      idempotencyKey: "td-207:workspace",
      prd,
      workItem: claim.workItem,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      runner: "codex",
      workspaceRoot: "/tmp/patchpilot-workflows"
    });
    expect(prepared.workItem.status).toBe("running");
    expect(prepared.agentRun.status).toBe("running");
    expect(prepared.workspaceRun.isolation).toBe("git_worktree");

    store.failNext("runCodex");
    await expect(
      activities.runWorkItemCodexActivity({
        workflowId,
        idempotencyKey: "td-207:codex",
        prd,
        workItem: prepared.workItem,
        agentRun: prepared.agentRun,
        workspaceRun: prepared.workspaceRun,
        baseBranch: "main",
        baseCommit: "base-td207",
        previewUrl: "http://localhost:3000"
      })
    ).rejects.toThrow("Injected transient runCodex activity failure");
    const codex = await activities.runWorkItemCodexActivity({
      workflowId,
      idempotencyKey: "td-207:codex",
      prd,
      workItem: prepared.workItem,
      agentRun: prepared.agentRun,
      workspaceRun: prepared.workspaceRun,
      baseBranch: "main",
      baseCommit: "base-td207",
      previewUrl: "http://localhost:3000"
    });
    expect(store.getAttemptCount("runCodex")).toBe(2);
    expect(codex.codex.changedFiles.length).toBeGreaterThan(0);

    const tested = await activities.runWorkItemTestsActivity({
      workflowId,
      idempotencyKey: "td-207:tests",
      prd,
      workItem: prepared.workItem,
      agentRun: codex.agentRun,
      workspaceRun: prepared.workspaceRun,
      codex: codex.codex,
      testCases: [executionTestCase(prd, workItem)],
      testCommand: "pnpm --filter @patchpilot/workflows test"
    });
    expect(tested.testRuns[0]?.status).toBe("passed");
    expect(tested.testCases[0]?.status).toBe("passed");
    expect(tested.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["log", "test_report"]);

    const pullRequest = await activities.createWorkItemPullRequestActivity({
      workflowId,
      idempotencyKey: "td-207:pr",
      workItem: prepared.workItem,
      agentRun: tested.agentRun,
      codex: codex.codex,
      testRuns: tested.testRuns
    });
    const review = await activities.reviewWorkItemExecutionActivity({
      workflowId,
      idempotencyKey: "td-207:review",
      workItem: prepared.workItem,
      agentRun: tested.agentRun,
      codex: codex.codex,
      testRuns: tested.testRuns,
      pullRequest: pullRequest.pullRequest
    });
    const archived = await activities.archiveWorkItemWorkspaceActivity({
      workflowId,
      idempotencyKey: "td-207:archive",
      workspaceRun: prepared.workspaceRun,
      agentRun: tested.agentRun
    });
    const completed = await activities.completeWorkItemExecutionActivity({
      workflowId,
      idempotencyKey: "td-207:terminal",
      workItem: prepared.workItem,
      agentRun: tested.agentRun,
      workspaceRun: archived.workspaceRun,
      codex: codex.codex,
      testRuns: tested.testRuns,
      testCases: tested.testCases,
      artifacts: tested.artifacts,
      pullRequest: pullRequest.pullRequest,
      reviewRecord: review.reviewRecord
    });

    expect(pullRequest.pullRequest.status).toBe("ready_for_review");
    expect(review.reviewRecord.status).toBe("approved");
    expect(completed.workspaceRun.status).toBe("archived");
    expect(completed.workItem.status).toBe("review");
    expect(completed.workItem.claimToken).toBeUndefined();
    expect(completed.agentRun.status).toBe("succeeded");
    expect(completed.agentRun.result?.tests[0]?.pullRequestId).toBe(pullRequest.pullRequest.id);
    expect(completed.evidenceChain).toMatchObject({
      workflowId,
      workItemId: workItem.id,
      agentRunId: prepared.agentRun.id,
      workspaceRunId: prepared.workspaceRun.id,
      pullRequestId: pullRequest.pullRequest.id,
      reviewRecordId: review.reviewRecord.id
    });
    expect(completed.evidenceChain.testRunIds).toEqual([tested.testRuns[0]?.id]);
    expect(completed.evidenceChain.artifactIds.length).toBeGreaterThanOrEqual(5);
    expect(completed.evidenceChain.auditEventIds).toEqual(completed.auditEvents.map((event) => event.id));
    expect(completed.auditEvents.map((event) => event.action)).toEqual([
      "work_item.claimed",
      "work_item.started",
      "workspace_run.created",
      "codex_run.completed",
      "test_run.passed",
      "pull_request.ready_for_review",
      "review.approved",
      "workspace_run.archived",
      "agent_run.succeeded"
    ]);
    expect(completed.auditEvents.every((event, index, events) =>
      index === 0 ? event.previousHash === null : event.previousHash === events[index - 1]?.hash
    )).toBe(true);
  });
});

function approvalPausedRun(): AgentRun {
  return {
    id: "run_td_208",
    requirementId: "req_td_208",
    prdId: "prd_req_td_208",
    workItemId: "wi_td_208_backend",
    runner: "codex",
    status: "needs_approval",
    currentStep: "developing",
    timeline: createTimeline(),
    events: [],
    costEstimateUsd: 1.25,
    startedAt: "2026-06-10T00:00:00.000Z"
  };
}

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

function executionPrd(): Prd {
  return {
    id: "prd_req_td_207",
    requirementId: "req_td_207",
    version: 1,
    status: "approved",
    title: "Temporal work item execution",
    bodyMarkdown: "# Temporal work item execution",
    acceptanceCriteria: ["Execution workflow records claim, workspace, Codex, test, PR, review, and archive evidence"],
    approvedAt: "2026-06-10T00:00:00.000Z"
  };
}

function executionWorkItem(prd: Prd): WorkItem {
  return {
    id: "wi_td_207_backend",
    prdId: prd.id,
    title: "Implement WorkItemExecutionWorkflow",
    status: "ready",
    role: "backend",
    scope: "Implement claim, workspace, CodexRun, test, PR, review, and archive workflow orchestration.",
    nonGoals: ["Do not implement approval or defect workflows"],
    acceptanceCriteria: prd.acceptanceCriteria,
    testSuggestions: ["Run workflow tests", "Run Temporal E2E"],
    requiredCapabilities: ["repo:write", "test:run"],
    version: 1,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}

function executionTestCase(prd: Prd, workItem: WorkItem): TestCase {
  return {
    id: `tc_${workItem.id}`,
    requirementId: prd.requirementId,
    prdId: prd.id,
    workItemId: workItem.id,
    title: "Work item execution evidence chain",
    kind: "acceptance",
    status: "ready",
    priority: "high",
    steps: workItem.testSuggestions,
    expectedResult: "The execution workflow reaches review with a complete evidence chain.",
    linkedAcceptanceCriteria: workItem.acceptanceCriteria,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}
