import { describe, expect, it } from "vitest";
import {
  createApprovalActivities,
  createDefectReproductionActivities,
  createRetrospectiveActivities,
  createWorkItemExecutionActivities,
  InMemoryApprovalActivityStore,
  InMemoryDefectReproductionActivityStore,
  createRequirementIntakeActivities,
  InMemoryRequirementIntakeActivityStore,
  InMemoryRetrospectiveActivityStore,
  InMemoryTemporalCanaryActivityStore,
  InMemoryWorkItemExecutionActivityStore,
  InMemoryWorkItemPlanningActivityStore
} from "./activities";
import {
  createTimeline,
  type AgentRun,
  type ArtifactRecord,
  type AuditEvent,
  type BugReport,
  type Prd,
  type TestCase,
  type TestRun,
  type WorkItem
} from "@patchpilot/domain";

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

describe("Defect reproduction activities", () => {
  it("records /diagnose reproduction evidence before creating a developer fix task", async () => {
    const store = new InMemoryDefectReproductionActivityStore();
    const activities = createDefectReproductionActivities(store);
    const bug = defectBug();
    const workItem = defectReproductionWorkItem(bug);
    const workflowId = "workflow-td-209";

    const claim = await activities.claimDefectReproductionActivity({
      workflowId,
      idempotencyKey: "td-209:claim",
      bug,
      workItem,
      agentId: "agent_test"
    });
    const duplicateClaim = await activities.claimDefectReproductionActivity({
      workflowId,
      idempotencyKey: "td-209:claim",
      bug,
      workItem,
      agentId: "agent_backend"
    });
    expect(duplicateClaim).toEqual(claim);
    expect(claim.bug.status).toBe("needs_repro");
    expect(claim.workItem.status).toBe("claimed");
    expect(claim.workItem.claimToken).toBe(claim.claimToken);

    store.failNext("runDiagnose");
    await expect(
      activities.runDefectDiagnoseActivity({
        workflowId,
        idempotencyKey: "td-209:diagnose",
        bug: claim.bug,
        workItem: claim.workItem,
        agentId: claim.agentId,
        claimToken: claim.claimToken,
        runner: "codex",
        workspaceRoot: "/tmp/patchpilot-workflows",
        diagnoseCommand: "/diagnose bug_td_209"
      })
    ).rejects.toThrow("Injected transient runDiagnose activity failure");

    const diagnosed = await activities.runDefectDiagnoseActivity({
      workflowId,
      idempotencyKey: "td-209:diagnose",
      bug: claim.bug,
      workItem: claim.workItem,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      runner: "codex",
      workspaceRoot: "/tmp/patchpilot-workflows",
      diagnoseCommand: "/diagnose bug_td_209"
    });
    expect(store.getAttemptCount("runDiagnose")).toBe(2);
    expect(diagnosed.reproductionEvidence).toMatchObject({
      reproduced: true,
      diagnosePrompt: "/diagnose",
      testRunId: diagnosed.testRun.id
    });
    expect(diagnosed.testRun.status).toBe("failed");
    expect(diagnosed.reproductionTestCase.status).toBe("failed");
    expect(diagnosed.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["log", "test_report", "trace"]);

    const recorded = await activities.recordDefectReproductionActivity({
      workflowId,
      idempotencyKey: "td-209:record",
      bug: claim.bug,
      workItem: claim.workItem,
      agentRun: diagnosed.agentRun,
      workspaceRun: diagnosed.workspaceRun,
      testRun: diagnosed.testRun,
      reproductionTestCase: diagnosed.reproductionTestCase,
      reproductionEvidence: diagnosed.reproductionEvidence,
      artifacts: diagnosed.artifacts
    });

    expect(recorded.bug.status).toBe("reproduced");
    expect(recorded.reproductionWorkItem.status).toBe("review");
    expect(recorded.reproductionWorkItem.claimToken).toBeUndefined();
    expect(recorded.agentRun.status).toBe("succeeded");
    expect(recorded.workspaceRun.status).toBe("archived");
    expect(recorded.fixWorkItem).toMatchObject({
      role: "backend",
      sourceBugId: bug.id,
      status: "ready"
    });
    expect(recorded.regressionTestCase).toMatchObject({
      workItemId: recorded.fixWorkItem?.id,
      sourceBugId: bug.id,
      status: "ready"
    });
    expect(recorded.evidenceChain).toMatchObject({
      workflowId,
      bugId: bug.id,
      reproductionWorkItemId: workItem.id,
      agentRunId: diagnosed.agentRun.id,
      workspaceRunId: diagnosed.workspaceRun.id,
      testRunId: diagnosed.testRun.id,
      fixWorkItemId: recorded.fixWorkItem?.id,
      regressionTestCaseId: recorded.regressionTestCase?.id,
      status: "reproduced"
    });
    expect(recorded.evidenceChain.auditEventIds).toEqual(recorded.auditEvents.map((event) => event.id));
    expect(recorded.auditEvents.map((event) => event.action)).toEqual([
      "work_item.claimed",
      "work_item.started",
      "workspace_run.created",
      "diagnose.completed",
      "test_run.failed",
      "bug.reproduced",
      "agent_run.succeeded"
    ]);
    expect(recorded.auditEvents.every((event, index, events) =>
      index === 0 ? event.previousHash === null : event.previousHash === events[index - 1]?.hash
    )).toBe(true);
  });

  it("does not create a fix task when /diagnose cannot reproduce the defect", async () => {
    const store = new InMemoryDefectReproductionActivityStore();
    const activities = createDefectReproductionActivities(store);
    const bug = defectBug({ id: "bug_td_209_unreproducible", status: "needs_repro" });
    const workItem = defectReproductionWorkItem(bug);
    const workflowId = "workflow-td-209-unreproducible";

    const claim = await activities.claimDefectReproductionActivity({
      workflowId,
      idempotencyKey: "td-209-unrepro:claim",
      bug,
      workItem
    });
    const diagnosed = await activities.runDefectDiagnoseActivity({
      workflowId,
      idempotencyKey: "td-209-unrepro:diagnose",
      bug: claim.bug,
      workItem: claim.workItem,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      runner: "simulated",
      reproductionExpected: false
    });
    const recorded = await activities.recordDefectReproductionActivity({
      workflowId,
      idempotencyKey: "td-209-unrepro:record",
      bug: claim.bug,
      workItem: claim.workItem,
      agentRun: diagnosed.agentRun,
      workspaceRun: diagnosed.workspaceRun,
      testRun: diagnosed.testRun,
      reproductionTestCase: diagnosed.reproductionTestCase,
      reproductionEvidence: diagnosed.reproductionEvidence,
      artifacts: diagnosed.artifacts
    });

    expect(diagnosed.testRun.status).toBe("blocked");
    expect(recorded.bug.status).toBe("unreproducible");
    expect(recorded.fixWorkItem).toBeUndefined();
    expect(recorded.regressionTestCase).toBeUndefined();
    expect(recorded.evidenceChain.fixWorkItemId).toBeUndefined();
    expect(recorded.auditEvents.map((event) => event.action)).toContain("bug.unreproducible");
  });
});

describe("Retrospective activities", () => {
  it("creates a PRD retrospective artifact from terminal delivery evidence", async () => {
    const store = new InMemoryRetrospectiveActivityStore();
    const activities = createRetrospectiveActivities(store);
    const prd = executionPrd();
    const workItem = { ...executionWorkItem(prd), status: "review" as const };
    const run = retrospectiveRun(prd, workItem);
    const testRun = retrospectiveTestRun(prd, workItem, run);
    const artifacts = retrospectiveArtifacts(prd, workItem, run, testRun);
    const auditEvents = retrospectiveAuditEvents(prd, workItem, run);

    const result = await activities.createRetrospectiveActivity({
      workflowId: "workflow-td-210",
      idempotencyKey: "td-210:retrospective",
      prd,
      workItems: [workItem],
      agentRuns: [run],
      workspaceRuns: [
        {
          id: `ws_${run.id}`,
          runId: run.id,
          requirementId: prd.requirementId,
          prdId: prd.id,
          workItemId: workItem.id,
          runner: run.runner,
          status: "archived",
          isolation: "git_worktree",
          path: "/tmp/patchpilot-workflows/run_td_210",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:01:00.000Z",
          archivedAt: "2026-06-10T00:01:00.000Z"
        }
      ],
      testRuns: [testRun],
      pullRequests: [
        {
          id: "pr_run_td_210",
          provider: "local",
          status: "ready_for_review",
          title: "[PatchPilot] Retrospective",
          requirementId: prd.requirementId,
          prdId: prd.id,
          workItemId: workItem.id,
          runId: run.id,
          branchName: "patchpilot/retrospective",
          baseBranch: "main",
          baseCommit: "base-td210",
          headCommit: "head-td210",
          url: "local://pull-requests/run_td_210",
          bodyMarkdown: "PR body",
          reviewerSummary: "Low risk",
          testSummary: "passed",
          createdAt: "2026-06-10T00:01:00.000Z",
          updatedAt: "2026-06-10T00:01:00.000Z"
        }
      ],
      reviewRecords: [
        {
          id: "review_run_td_210",
          status: "approved",
          requirementId: prd.requirementId,
          prdId: prd.id,
          workItemId: workItem.id,
          runId: run.id,
          linkedPullRequestId: "pr_run_td_210",
          reviewerAgentId: "agent_reviewer",
          summary: "Approved",
          testSummary: "passed",
          riskLevel: "medium",
          findings: ["Retrospective evidence is complete"],
          createdAt: "2026-06-10T00:01:00.000Z",
          updatedAt: "2026-06-10T00:01:00.000Z"
        }
      ],
      auditEvents,
      artifacts,
      acceptances: [{ runId: run.id, status: "accepted", decidedAt: "2026-06-10T00:02:00.000Z" }],
      bugs: []
    });
    const duplicate = await activities.createRetrospectiveActivity({
      workflowId: "workflow-td-210",
      idempotencyKey: "td-210:retrospective",
      prd,
      workItems: [],
      agentRuns: [],
      testRuns: [],
      auditEvents: []
    });
    const duplicatePrd = await activities.createRetrospectiveActivity({
      workflowId: "workflow-td-210-duplicate",
      idempotencyKey: "td-210:retrospective:duplicate-prd",
      prd,
      workItems: [],
      agentRuns: [],
      testRuns: [],
      auditEvents: []
    });

    expect(duplicate).toEqual(result);
    expect(duplicatePrd).toEqual(result);
    expect(result.artifact.kind).toBe("retrospective");
    expect(result.artifact.prdId).toBe(prd.id);
    expect(result.summary).toMatchObject({
      prdId: prd.id,
      workItemCount: 1,
      completedWorkItemCount: 1,
      cost: {
        estimatedUsd: 0.4,
        actualUsd: 0.31,
        runCount: 1,
        acceptedRunCount: 1,
        costPerAcceptedRunUsd: 0.31
      },
      tests: {
        total: 1,
        passed: 1,
        passRate: 100
      },
      risk: {
        highestRisk: "medium",
        medium: 1,
        failedRunIds: []
      },
      audit: {
        eventCount: 2,
        chainValid: true,
        headHash: "hash_td_210_2"
      },
      artifacts: {
        total: 2,
        byKind: { log: 1, test_report: 1 }
      },
      acceptance: {
        accepted: 1,
        rejected: 0,
        pending: 0,
        terminal: true
      }
    });
    expect(result.auditEvents.map((event) => event.action)).toEqual(["retrospective.created"]);
    expect(result.auditEvents[0]?.afterJson).toMatchObject({
      retrospective: {
        artifactId: result.artifact.id,
        acceptance: { terminal: true }
      }
    });
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

function defectBug(overrides: Partial<BugReport> = {}): BugReport {
  return {
    id: "bug_td_209",
    title: "保存按钮没有反馈",
    description: "点击保存后页面没有任何反馈。",
    reproductionSteps: "打开设置页\n修改标题\n点击保存",
    expectedBehavior: "展示保存成功提示。",
    actualBehavior: "页面没有变化。",
    severity: "high",
    status: "reported",
    reporter: "human",
    requirementId: "req_bug_td_209",
    prdId: "prd_req_bug_td_209",
    workItemId: "wi_req_bug_td_209_bugrepro",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides
  };
}

function defectReproductionWorkItem(bug: BugReport): WorkItem {
  return {
    id: bug.workItemId,
    prdId: bug.prdId,
    title: `复现 bug：${bug.title}`,
    status: "ready",
    role: "test",
    sourceBugId: bug.id,
    scope: "测试 agent 根据复现步骤确认问题存在，记录最小复现和回归测试建议，然后交给开发 agent 修复。",
    nonGoals: ["不自动发布", "不修改无关模块", "不访问生产数据"],
    acceptanceCriteria: [
      "复现步骤被记录并给出确认结果",
      "失败现象、期望行为和实际行为被整理成可执行修复上下文",
      "生成后续开发修复任务"
    ],
    testSuggestions: ["用 bug 复现步骤写回归检查", "记录最小复现路径", "给开发 agent 留下回归测试建议"],
    version: 1,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}

function retrospectiveRun(prd: Prd, workItem: WorkItem): AgentRun {
  return {
    id: "run_td_210",
    requirementId: prd.requirementId,
    prdId: prd.id,
    workItemId: workItem.id,
    runner: "codex",
    status: "succeeded",
    currentStep: "confirming",
    timeline: createTimeline(),
    events: [],
    result: {
      summary: "Retrospective run completed.",
      previewUrl: "http://localhost:3000",
      riskLevel: "medium",
      changedFiles: ["packages/workflows/src/workflows.ts"],
      tests: [],
      reviewerSummary: "Medium risk due to workflow evidence aggregation.",
      runner: "codex"
    },
    costEstimateUsd: 0.4,
    costActualUsd: 0.31,
    startedAt: "2026-06-10T00:00:00.000Z",
    endedAt: "2026-06-10T00:01:00.000Z"
  };
}

function retrospectiveTestRun(prd: Prd, workItem: WorkItem, run: AgentRun): TestRun {
  return {
    id: "test_td_210",
    testCaseId: `tc_${workItem.id}`,
    runId: run.id,
    prdId: prd.id,
    workItemId: workItem.id,
    status: "passed",
    command: "pnpm --filter @patchpilot/workflows test",
    summary: "Retrospective tests passed.",
    durationMs: 420,
    startedAt: "2026-06-10T00:00:30.000Z",
    endedAt: "2026-06-10T00:00:31.000Z",
    commit: "head-td210",
    branch: "patchpilot/retrospective",
    artifactIds: ["artifact_td_210_log", "artifact_td_210_report"],
    retryCount: 0,
    attempt: 1,
    maxAttempts: 1,
    flakySignal: false
  };
}

function retrospectiveArtifacts(
  prd: Prd,
  workItem: WorkItem,
  run: AgentRun,
  testRun: TestRun
): ArtifactRecord[] {
  return [
    {
      id: "artifact_td_210_log",
      kind: "log",
      storage: "local_fs",
      uri: "file:///tmp/td-210.log",
      contentType: "text/plain",
      sizeBytes: 10,
      checksumSha256: "0".repeat(64),
      prdId: prd.id,
      workItemId: workItem.id,
      runId: run.id,
      testRunId: testRun.id,
      createdAt: "2026-06-10T00:00:31.000Z"
    },
    {
      id: "artifact_td_210_report",
      kind: "test_report",
      storage: "local_fs",
      uri: "file:///tmp/td-210.json",
      contentType: "application/json",
      sizeBytes: 20,
      checksumSha256: "1".repeat(64),
      prdId: prd.id,
      workItemId: workItem.id,
      runId: run.id,
      testRunId: testRun.id,
      createdAt: "2026-06-10T00:00:31.000Z"
    }
  ];
}

function retrospectiveAuditEvents(prd: Prd, workItem: WorkItem, run: AgentRun): AuditEvent[] {
  return [
    {
      id: "audit_td_210_1",
      traceId: "workflow-td-210-source",
      actorType: "agent",
      actorId: "agent_backend",
      actor: "agent_backend",
      action: "agent_run.succeeded",
      targetType: "agent_run",
      targetId: run.id,
      message: "Run succeeded.",
      beforeJson: null,
      afterJson: { run: { id: run.id, status: run.status } },
      metadataJson: {},
      hash: "hash_td_210_1",
      previousHash: null,
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: "2026-06-10T00:01:00.000Z"
    },
    {
      id: "audit_td_210_2",
      traceId: "workflow-td-210-source",
      actorType: "human",
      actorId: "human",
      actor: "human",
      action: "acceptance.accepted",
      targetType: "acceptance",
      targetId: run.id,
      message: "Run accepted.",
      beforeJson: null,
      afterJson: { acceptance: { runId: run.id, status: "accepted" } },
      metadataJson: {},
      hash: "hash_td_210_2",
      previousHash: "hash_td_210_1",
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: "2026-06-10T00:02:00.000Z"
    }
  ];
}
