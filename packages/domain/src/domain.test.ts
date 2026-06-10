import { describe, expect, it } from "vitest";
import {
  advanceTimeline,
  completeTimeline,
  computeAuditEventHash,
  createPrd,
  createBugFixWorkItem,
  createBugWorkItem,
  createTimeline,
  evaluateAcceptanceQualityGate,
  createTestCasesForWorkItems,
  createWorkItems,
  emptySnapshot,
  createInitialClarificationTurn,
  generateClarificationQuestions,
  makeSimpleSummary,
  renderArtifactReferencesMarkdown,
  testCaseStatusFromTestRunStatus,
  verifyAuditChain,
  type AuditEvent,
  type PatchPilotSnapshot,
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

  it("renders intake artifact references into PRDs", () => {
    const requirement: Requirement = {
      id: "req_with_artifacts",
      title: "Agent 平台",
      rawInput: "根据截图和链接调整首页",
      template: "ui",
      status: "prd_draft",
      simpleSummary: makeSimpleSummary("根据截图和链接调整首页", "ui"),
      artifactReferences: [
        {
          id: "input_screenshot",
          kind: "screenshot",
          label: "首页错误截图",
          contentType: "image/png",
          sizeBytes: 4096,
          artifactId: "artifact_intake_input_screenshot",
          createdAt: "2026-06-10T00:00:00.000Z"
        },
        {
          id: "input_link",
          kind: "link",
          label: "客户反馈链接",
          uri: "https://example.com/feedback/123",
          artifactId: "artifact_intake_input_link",
          createdAt: "2026-06-10T00:00:00.000Z"
        }
      ],
      clarificationQuestions: [],
      clarificationTurns: [],
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    };

    const prd = createPrd(requirement);

    expect(renderArtifactReferencesMarkdown(requirement.artifactReferences)).toContain("首页错误截图");
    expect(prd.bodyMarkdown).toContain("## 关联资料");
    expect(prd.bodyMarkdown).toContain("首页错误截图");
    expect(prd.bodyMarkdown).toContain("artifact_intake_input_screenshot");
    expect(prd.bodyMarkdown).toContain("[客户反馈链接](https://example.com/feedback/123)");
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

  it("passes the acceptance quality gate when delivery evidence is complete", () => {
    const snapshot = acceptanceGateSnapshot();

    const gate = evaluateAcceptanceQualityGate({
      snapshot,
      prdId: "prd_1",
      runIds: ["run_1"],
      workItemIds: ["wi_1"],
      scope: "run"
    });

    expect(gate.passed).toBe(true);
    expect(gate.metrics).toMatchObject({
      acceptanceCriteriaCovered: 2,
      acceptanceCriteriaTotal: 2,
      testCasePassRate: 100,
      unresolvedDefectCount: 0,
      flakyCount: 0,
      contractCompatible: 1,
      pullRequestReady: 1,
      auditEventCount: 1
    });
    expect(gate.blockingReasons).toEqual([]);
  });

  it("reports every unmet acceptance quality gate check", () => {
    const snapshot = acceptanceGateSnapshot();
    snapshot.testCases[0]!.linkedAcceptanceCriteria = ["Criterion A"];
    snapshot.testCases[0]!.status = "failed";
    snapshot.testCases[0]!.flaky = true;
    snapshot.interfaceContracts[0]!.status = "breaking_change_pending";
    snapshot.pullRequests[0]!.status = "changes_requested";
    snapshot.bugs.push({
      id: "bug_1",
      title: "Failed verification",
      description: "A failed TestRun created a defect.",
      reproductionSteps: "Run the failing test.",
      expectedBehavior: "The gate passes.",
      actualBehavior: "The gate fails.",
      severity: "high",
      status: "reported",
      reporter: "test-runner",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      sourceRunId: "run_1",
      sourceTestRunId: "test_1",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    });
    snapshot.auditEvents[0]!.message = "Tampered audit message.";

    const gate = evaluateAcceptanceQualityGate({
      snapshot,
      prdId: "prd_1",
      runIds: ["run_1"],
      workItemIds: ["wi_1"],
      scope: "run"
    });

    expect(gate.passed).toBe(false);
    expect(gate.checks.filter((check) => !check.passed).map((check) => check.key)).toEqual([
      "acceptance_criteria_coverage",
      "test_case_pass_rate",
      "unresolved_defects",
      "flaky_tests",
      "contract_compatibility",
      "pr_status",
      "audit_integrity"
    ]);
    expect(gate.metrics).toMatchObject({
      acceptanceCriteriaCovered: 1,
      testCasePassed: 0,
      unresolvedDefectCount: 1,
      flakyCount: 1,
      contractCompatible: 0,
      pullRequestReady: 0
    });
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

function acceptanceGateSnapshot(): PatchPilotSnapshot {
  const now = "2026-06-10T00:00:00.000Z";
  const snapshot = emptySnapshot();
  const testRun = {
    id: "test_1",
    testCaseId: "tc_1",
    runId: "run_1",
    prdId: "prd_1",
    workItemId: "wi_1",
    status: "passed" as const,
    command: "pnpm test",
    summary: "All assertions passed.",
    durationMs: 1200,
    startedAt: now,
    endedAt: now,
    flakySignal: false
  };
  const audit = auditEvent({
    id: "audit_1",
    action: "agent_run.succeeded",
    targetType: "agent_run",
    targetId: "run_1",
    requirementId: "req_1",
    prdId: "prd_1",
    workItemId: "wi_1",
    runId: "run_1"
  });
  audit.hash = computeAuditEventHash(audit);

  snapshot.requirements = [
    {
      id: "req_1",
      title: "Acceptance gate",
      rawInput: "Ship a gated acceptance flow.",
      template: "feature",
      status: "approved",
      simpleSummary: "Acceptance gate",
      clarificationQuestions: [],
      clarificationTurns: [],
      createdAt: now,
      updatedAt: now
    }
  ];
  snapshot.prds = [
    {
      id: "prd_1",
      requirementId: "req_1",
      version: 1,
      status: "approved",
      title: "Acceptance gate",
      bodyMarkdown: "# Acceptance gate",
      acceptanceCriteria: ["Criterion A", "Criterion B"],
      approvedAt: now
    }
  ];
  snapshot.workItems = [
    {
      id: "wi_1",
      prdId: "prd_1",
      title: "Build gate",
      status: "review",
      role: "backend",
      scope: "Gate accepted decisions.",
      nonGoals: [],
      acceptanceCriteria: ["Criterion A", "Criterion B"],
      testSuggestions: ["Run unit tests"],
      createdAt: now,
      updatedAt: now
    }
  ];
  snapshot.interfaceContracts = [
    {
      id: "contract_1",
      prdId: "prd_1",
      name: "HTTP API",
      kind: "http",
      status: "approved",
      version: 1,
      summary: "Contract remains compatible.",
      providerRole: "backend",
      consumerRoles: ["frontend"],
      specMarkdown: "Compatible.",
      testSuggestions: [],
      createdAt: now,
      updatedAt: now
    }
  ];
  snapshot.agentRuns = [
    {
      id: "run_1",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      runner: "simulated",
      status: "succeeded",
      currentStep: "confirming",
      timeline: completeTimeline(createTimeline()),
      events: [],
      result: {
        summary: "Gate delivered.",
        previewUrl: "http://localhost:3000",
        riskLevel: "low",
        changedFiles: ["services/api/src/store.ts"],
        tests: [testRun],
        reviewerSummary: "Approved.",
        runner: "simulated"
      },
      costEstimateUsd: 0.42,
      startedAt: now,
      endedAt: now
    }
  ];
  snapshot.testCases = [
    {
      id: "tc_1",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      title: "Acceptance gate TestCase",
      kind: "acceptance",
      status: "passed",
      priority: "high",
      steps: ["Run unit tests"],
      expectedResult: "Gate passes.",
      linkedAcceptanceCriteria: ["Criterion A", "Criterion B"],
      lastRunId: "run_1",
      lastTestRunId: "test_1",
      flaky: false,
      createdAt: now,
      updatedAt: now
    }
  ];
  snapshot.testRuns = [testRun];
  snapshot.pullRequests = [
    {
      id: "pr_1",
      provider: "local",
      status: "ready_for_review",
      title: "Acceptance gate PR",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      runId: "run_1",
      branchName: "patchpilot/wi_1",
      baseBranch: "main",
      url: "local://pull-requests/run_1",
      bodyMarkdown: "## 测试结果\npassed",
      reviewerSummary: "Approved.",
      testSummary: "passed",
      createdAt: now,
      updatedAt: now
    }
  ];
  snapshot.reviewRecords = [
    {
      id: "review_1",
      status: "approved",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      runId: "run_1",
      linkedPullRequestId: "pr_1",
      reviewerAgentId: "agent_reviewer",
      summary: "Reviewer approved.",
      testSummary: "passed",
      riskLevel: "low",
      findings: [],
      createdAt: now,
      updatedAt: now
    }
  ];
  snapshot.auditEvents = [audit];
  return snapshot;
}

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
