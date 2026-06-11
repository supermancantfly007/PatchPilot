import { describe, expect, it } from "vitest";
import type { AuditChainVerification, PatchPilotSnapshot } from "@patchpilot/domain";
import { evaluateAcceptancePageQualityGate } from "./acceptanceQualityGate";

const validAudit: AuditChainVerification = {
  valid: true,
  checkedEvents: 8,
  headHash: "hash_head",
  errors: []
};

describe("acceptance page quality gate helper", () => {
  it("summarizes every acceptance gate metric for a ready run", () => {
    const gate = evaluateAcceptancePageQualityGate({
      snapshot: acceptanceSnapshot(),
      prdId: "prd_1",
      runIds: ["run_1"],
      workItemIds: ["wi_1"],
      scope: "run",
      auditVerification: validAudit
    });

    expect(gate.passed).toBe(true);
    expect(gate.metrics).toMatchObject({
      acceptanceCriteriaCoverageRate: 100,
      testCasePassRate: 100,
      unresolvedDefectCount: 0,
      flakyCount: 0,
      contractCompatible: 1,
      pullRequestReady: 1,
      auditEventCount: 8
    });
  });

  it("blocks accepted state when page evidence is missing or unsafe", () => {
    const snapshot = acceptanceSnapshot();
    snapshot.testCases[0]!.status = "failed";
    snapshot.testCases[0]!.flaky = true;
    snapshot.pullRequests = [];
    snapshot.interfaceContracts[0]!.status = "breaking_change_pending";
    snapshot.bugs.push({
      id: "bug_1",
      title: "Open defect",
      description: "Defect remains open.",
      reproductionSteps: "Run test.",
      expectedBehavior: "Pass.",
      actualBehavior: "Fail.",
      severity: "high",
      status: "reported",
      reporter: "qa",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      sourceRunId: "run_1",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    });

    const gate = evaluateAcceptancePageQualityGate({
      snapshot,
      prdId: "prd_1",
      runIds: ["run_1"],
      workItemIds: ["wi_1"],
      scope: "run",
      auditVerification: {
        valid: false,
        checkedEvents: 8,
        headHash: "hash_head",
        errors: ["audit hash mismatch"]
      }
    });

    expect(gate.passed).toBe(false);
    expect(gate.checks.filter((check) => !check.passed).map((check) => check.key)).toEqual([
      "test_case_pass_rate",
      "unresolved_defects",
      "flaky_tests",
      "contract_compatibility",
      "pr_status",
      "audit_integrity"
    ]);
    expect(gate.blockingReasons.join("\n")).toContain("Defect");
  });
});

function acceptanceSnapshot(): PatchPilotSnapshot {
  const now = "2026-06-10T00:00:00.000Z";
  return {
    repositories: [],
    githubInstallations: [],
    requirements: [],
    prds: [
      {
        id: "prd_1",
        requirementId: "req_1",
        version: 1,
        status: "approved",
        title: "Acceptance",
        bodyMarkdown: "# Acceptance",
        acceptanceCriteria: ["Criterion A"],
        approvedAt: now
      }
    ],
    workItems: [
      {
        id: "wi_1",
        prdId: "prd_1",
        title: "Delivery",
        status: "review",
        role: "backend",
        scope: "Deliver evidence.",
        nonGoals: [],
        acceptanceCriteria: ["Criterion A"],
        testSuggestions: ["Run tests"],
        createdAt: now,
        updatedAt: now
      }
    ],
    interfaceContracts: [
      {
        id: "contract_1",
        prdId: "prd_1",
        name: "HTTP",
        kind: "http",
        status: "approved",
        version: 1,
        summary: "Compatible",
        providerRole: "backend",
        consumerRoles: ["frontend"],
        specMarkdown: "Compatible",
        testSuggestions: [],
        registry: {
          artifactId: "control-api",
          generatorVersion: "test",
          revisionId: "cr_control-api_r1",
          revision: 1,
          contentHash: "hash_control_api",
          sourceRef: "packages/contracts/openapi/patchpilot.openapi.json",
          providerRole: "backend",
          consumerRoles: ["frontend"],
          status: "approved",
          normalizedContent: {},
          approvedRevisionId: "cr_control-api_r1",
          approvedAt: now,
          testRunIds: ["test_contract_1"]
        },
        createdAt: now,
        updatedAt: now
      }
    ],
    agentRuns: [
      {
        id: "run_1",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runner: "simulated",
        status: "succeeded",
        currentStep: "confirming",
        timeline: [],
        events: [],
        result: {
          summary: "Done",
          previewUrl: "http://localhost:3000",
          riskLevel: "low",
          changedFiles: ["services/api/src/store.ts"],
          tests: [],
          reviewerSummary: "Approved",
          runner: "simulated"
        },
        costEstimateUsd: 0.42,
        startedAt: now,
        endedAt: now
      }
    ],
    workspaceRuns: [],
    testCases: [
      {
        id: "tc_1",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        title: "Acceptance TestCase",
        kind: "acceptance",
        status: "passed",
        priority: "high",
        steps: ["Run tests"],
        expectedResult: "Pass",
        linkedAcceptanceCriteria: ["Criterion A"],
        lastRunId: "run_1",
        lastTestRunId: "test_1",
        flaky: false,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "tc_contract_1",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        title: "HTTP API registry diff",
        kind: "contract",
        status: "passed",
        priority: "high",
        steps: ["Diff the registered contract"],
        expectedResult: "Contract TestRun passes.",
        linkedAcceptanceCriteria: ["Criterion A"],
        lastTestRunId: "test_contract_1",
        flaky: false,
        createdAt: now,
        updatedAt: now
      }
    ],
    testRuns: [
      {
        id: "test_1",
        testCaseId: "tc_1",
        runId: "run_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        status: "passed",
        command: "pnpm test",
        summary: "Passed",
        durationMs: 1200,
        flakySignal: false
      },
      {
        id: "test_contract_1",
        testCaseId: "tc_contract_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        status: "passed",
        command: "patchpilot contract-registry diff --artifact control-api",
        summary: "Contract evidence passed.",
        durationMs: 0,
        startedAt: now,
        endedAt: now,
        runner: "patchpilot-contract-registry",
        environmentImage: "local",
        exitCode: 0,
        flakySignal: false
      }
    ],
    artifacts: [],
    pullRequests: [
      {
        id: "pr_1",
        provider: "local",
        status: "ready_for_review",
        title: "Delivery PR",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_1",
        branchName: "patchpilot/wi_1",
        baseBranch: "main",
        url: "local://pull-requests/run_1",
        bodyMarkdown: "## Tests\npassed",
        reviewerSummary: "Approved",
        testSummary: "passed",
        createdAt: now,
        updatedAt: now
      }
    ],
    reviewRecords: [],
    auditEvents: [],
    acceptances: [],
    approvals: [],
    bugs: [],
    agents: []
  };
}
