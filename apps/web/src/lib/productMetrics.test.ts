import { describe, expect, it } from "vitest";
import { createTimeline, emptySnapshot, type AgentRun, type AuditEvent, type PatchPilotSnapshot, type TestRun } from "@patchpilot/domain";
import { computeProductMetrics, formatDurationCompact, formatMetricPercent } from "./productMetrics";

describe("product metrics", () => {
  it("returns empty rates instead of static placeholder numbers", () => {
    const metrics = computeProductMetrics(emptySnapshot());

    expect(metrics.requirementToPr.averageMs).toBeNull();
    expect(metrics.autonomousCompletion).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(metrics.costPerAcceptedPr.valueUsd).toBeNull();
    expect(metrics.failureReasons).toEqual([]);
    expect(formatMetricPercent(metrics.finalAcceptance)).toBe("暂无");
  });

  it("computes cost and product metrics from snapshot evidence", () => {
    const snapshot = metricsFixture();
    const metrics = computeProductMetrics(snapshot, {
      auditVerification: {
        valid: false,
        checkedEvents: snapshot.auditEvents.length,
        headHash: "hash_latest",
        errors: ["run_cancelled hash mismatch"]
      }
    });

    expect(metrics.requirementToPr.count).toBe(1);
    expect(formatDurationCompact(metrics.requirementToPr.averageMs)).toBe("1 天");
    expect(metrics.autonomousCompletion).toMatchObject({ numerator: 1, denominator: 4, rate: 25 });
    expect(metrics.firstTestPass).toMatchObject({ numerator: 1, denominator: 2, rate: 50 });
    expect(metrics.humanInterventions).toMatchObject({
      total: 3,
      approvalCount: 1,
      acceptanceDecisionCount: 2,
      rejectionCount: 1
    });
    expect(metrics.failureReasons).toEqual([
      { key: "cancelled", count: 1, costUsd: 0.4 },
      { key: "test_failed", count: 1, costUsd: 0.5 }
    ]);
    expect(metrics.costPerAcceptedPr).toMatchObject({
      acceptedPrCount: 1,
      totalCostUsd: 3.9,
      valueUsd: 3.9
    });
    expect(metrics.reproductionSuccess).toMatchObject({ numerator: 1, denominator: 2, rate: 50 });
    expect(metrics.reworkRounds).toMatchObject({ total: 1, average: 0.5, max: 1, workItemCount: 2 });
    expect(metrics.finalAcceptance).toMatchObject({ numerator: 1, denominator: 1, rate: 100 });
    expect(metrics.auditCompleteness.chainValid).toBe(false);
    expect(metrics.auditCompleteness.missingTargets).toContainEqual({ type: "agent_run", id: "run_cancelled" });
  });
});

function metricsFixture(): PatchPilotSnapshot {
  const snapshot = emptySnapshot();
  snapshot.requirements = [
    {
      id: "req_1",
      title: "Metrics dashboard",
      rawInput: "Build a real metrics dashboard",
      template: "feature",
      status: "approved",
      simpleSummary: "新功能：Build a real metrics dashboard",
      clarificationQuestions: [],
      clarificationTurns: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T01:00:00.000Z"
    }
  ];
  snapshot.prds = [
    {
      id: "prd_1",
      requirementId: "req_1",
      version: 1,
      status: "approved",
      title: "Metrics dashboard",
      bodyMarkdown: "# Metrics dashboard",
      acceptanceCriteria: ["Metrics are real"],
      approvedAt: "2026-06-01T02:00:00.000Z"
    }
  ];
  snapshot.workItems = [
    {
      id: "wi_1",
      prdId: "prd_1",
      title: "Frontend metrics",
      status: "done",
      role: "frontend",
      scope: "Show metrics",
      nonGoals: [],
      acceptanceCriteria: ["Metrics are real"],
      testSuggestions: [],
      reworkCount: 1
    },
    {
      id: "wi_2",
      prdId: "prd_1",
      title: "Backend evidence",
      status: "blocked",
      role: "backend",
      scope: "Fail once",
      nonGoals: [],
      acceptanceCriteria: ["Metrics are real"],
      testSuggestions: [],
      reworkCount: 0
    }
  ];
  snapshot.agentRuns = [
    agentRun({
      id: "run_initial",
      workItemId: "wi_1",
      status: "succeeded",
      costActualUsd: 1,
      startedAt: "2026-06-01T03:00:00.000Z",
      endedAt: "2026-06-01T04:00:00.000Z"
    }),
    agentRun({
      id: "run_rework",
      workItemId: "wi_1",
      status: "succeeded",
      costActualUsd: 2,
      startedAt: "2026-06-03T03:00:00.000Z",
      endedAt: "2026-06-03T04:00:00.000Z"
    }),
    agentRun({
      id: "run_failed",
      workItemId: "wi_2",
      status: "failed",
      failureType: "test_failed",
      costActualUsd: 0.5,
      startedAt: "2026-06-02T03:00:00.000Z",
      endedAt: "2026-06-02T04:00:00.000Z"
    }),
    agentRun({
      id: "run_cancelled",
      workItemId: "wi_2",
      status: "cancelled",
      costEstimateUsd: 0.4,
      startedAt: "2026-06-04T03:00:00.000Z",
      endedAt: "2026-06-04T04:00:00.000Z"
    })
  ];
  snapshot.testRuns = [
    testRun({
      id: "tr_initial",
      testCaseId: "tc_1",
      runId: "run_initial",
      workItemId: "wi_1",
      status: "failed",
      startedAt: "2026-06-01T03:30:00.000Z"
    }),
    testRun({
      id: "tr_rework",
      testCaseId: "tc_1",
      runId: "run_rework",
      workItemId: "wi_1",
      status: "passed",
      startedAt: "2026-06-03T03:30:00.000Z"
    }),
    testRun({
      id: "tr_backend",
      testCaseId: "tc_2",
      runId: "run_failed",
      workItemId: "wi_2",
      status: "passed",
      startedAt: "2026-06-02T03:30:00.000Z"
    })
  ];
  snapshot.pullRequests = [
    {
      id: "pr_initial",
      provider: "local",
      status: "ready_for_review",
      title: "Initial metrics dashboard",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      runId: "run_initial",
      branchName: "agent/initial",
      baseBranch: "main",
      url: "local://pull-requests/run_initial",
      bodyMarkdown: "Initial PR",
      reviewerSummary: "Approved",
      testSummary: "Failed first test",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z"
    },
    {
      id: "pr_rework",
      provider: "local",
      status: "ready_for_review",
      title: "Reworked metrics dashboard",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      runId: "run_rework",
      branchName: "agent/rework",
      baseBranch: "main",
      url: "local://pull-requests/run_rework",
      bodyMarkdown: "Rework PR",
      reviewerSummary: "Approved",
      testSummary: "Passed",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z"
    }
  ];
  snapshot.approvals = [
    {
      id: "approval_1",
      kind: "budget_exceeded",
      status: "approved",
      targetType: "agent_run",
      targetId: "run_failed",
      requestedBy: "budget_policy",
      requestedReason: "Run exceeded budget",
      riskLevel: "high",
      expiresAt: "2026-06-03T00:00:00.000Z",
      runId: "run_failed",
      createdAt: "2026-06-02T03:00:00.000Z",
      updatedAt: "2026-06-02T03:10:00.000Z"
    }
  ];
  snapshot.acceptances = [
    {
      runId: "run_initial",
      status: "rejected",
      reason: "Needs rework",
      decidedAt: "2026-06-02T05:00:00.000Z"
    },
    {
      runId: "run_rework",
      status: "accepted",
      decidedAt: "2026-06-04T05:00:00.000Z"
    }
  ];
  snapshot.bugs = [
    {
      id: "bug_repro",
      title: "Bug reproduced",
      description: "Fails",
      reproductionSteps: "Run test",
      expectedBehavior: "Pass",
      actualBehavior: "Fail",
      severity: "high",
      status: "reproduced",
      reporter: "user",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_2",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T01:00:00.000Z"
    },
    {
      id: "bug_unrepro",
      title: "Bug unreproducible",
      description: "Maybe flaky",
      reproductionSteps: "Run test",
      expectedBehavior: "Pass",
      actualBehavior: "Sometimes fails",
      severity: "medium",
      status: "unreproducible",
      reporter: "user",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_2",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T01:00:00.000Z"
    },
    {
      id: "bug_open",
      title: "Bug waiting for repro",
      description: "Open",
      reproductionSteps: "Run test",
      expectedBehavior: "Pass",
      actualBehavior: "Unknown",
      severity: "low",
      status: "needs_repro",
      reporter: "user",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_2",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T01:00:00.000Z"
    }
  ];
  snapshot.auditEvents = [
    auditEvent("audit_prd", "prd", "prd_1"),
    auditEvent("audit_wi_1", "work_item", "wi_1"),
    auditEvent("audit_wi_2", "work_item", "wi_2"),
    auditEvent("audit_run_initial", "agent_run", "run_initial"),
    auditEvent("audit_run_rework", "agent_run", "run_rework"),
    auditEvent("audit_run_failed", "agent_run", "run_failed"),
    auditEvent("audit_tr_initial", "test_run", "tr_initial"),
    auditEvent("audit_tr_rework", "test_run", "tr_rework"),
    auditEvent("audit_tr_backend", "test_run", "tr_backend"),
    auditEvent("audit_pr_initial", "pull_request", "pr_initial"),
    auditEvent("audit_pr_rework", "pull_request", "pr_rework"),
    auditEvent("audit_approval", "approval", "approval_1"),
    auditEvent("audit_accept_initial", "acceptance", "run_initial"),
    auditEvent("audit_accept_rework", "acceptance", "run_rework"),
    auditEvent("audit_bug_repro", "bug", "bug_repro"),
    auditEvent("audit_bug_unrepro", "bug", "bug_unrepro"),
    auditEvent("audit_bug_open", "bug", "bug_open")
  ];

  return snapshot;
}

function agentRun(input: Partial<AgentRun> & Pick<AgentRun, "id" | "workItemId" | "status" | "startedAt">): AgentRun {
  return {
    requirementId: "req_1",
    prdId: "prd_1",
    runner: "simulated",
    currentStep: "confirming",
    timeline: createTimeline(),
    events: [],
    costEstimateUsd: input.costEstimateUsd ?? input.costActualUsd ?? 0,
    ...input
  };
}

function testRun(input: Partial<TestRun> & Pick<TestRun, "id" | "runId" | "status" | "startedAt">): TestRun {
  return {
    prdId: "prd_1",
    command: "pnpm test",
    summary: "Test evidence",
    durationMs: 1000,
    ...input
  };
}

function auditEvent(id: string, targetType: AuditEvent["targetType"], targetId: string): AuditEvent {
  return {
    id,
    traceId: "trace_1",
    actorType: "system",
    actorId: "system",
    action: `${targetType}.changed`,
    targetType,
    targetId,
    message: `${targetType} changed`,
    beforeJson: null,
    afterJson: null,
    metadataJson: null,
    hash: `hash_${id}`,
    previousHash: null,
    requirementId: "req_1",
    prdId: "prd_1",
    createdAt: "2026-06-02T00:00:00.000Z"
  };
}
