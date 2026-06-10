import { describe, expect, it } from "vitest";
import type { PatchPilotSnapshot } from "@patchpilot/domain";
import { buildReport, parseCliArgs, summarizeSnapshot } from "./index";

describe("PatchPilot CLI", () => {
  it("parses command options and flags", () => {
    expect(parseCliArgs(["happy-path", "--input", "ship it", "--template=feature", "--runner", "simulated", "--json"])).toEqual({
      command: "happy-path",
      options: {
        input: "ship it",
        template: "feature",
        runner: "simulated",
        json: true
      },
      positionals: []
    });

    expect(parseCliArgs(["--", "help"])).toEqual({
      command: "help",
      options: {},
      positionals: []
    });
  });

  it("summarizes a snapshot for console output", () => {
    expect(summarizeSnapshot(snapshot)).toMatchObject({
      requirements: 1,
      prds: 1,
      workItems: 2,
      agentRuns: 2,
      testRuns: 2,
      pullRequests: 1,
      reviewRecords: 1,
      auditEvents: 1
    });
  });

  it("builds a filtered markdown report", () => {
    const report = buildReport(snapshot, { prdId: "prd_1" });

    expect(report).toContain("# PatchPilot Delivery Report");
    expect(report).toContain("Work items: 2");
    expect(report).toContain("Runs: succeeded=2");
    expect(report).toContain("Passed test runs: 1/2");
    expect(report).toContain("Accepted runs: 2/2");
    expect(report).toContain("Decisions: accepted=2");
  });
});

const snapshot: PatchPilotSnapshot = {
  requirements: [
    {
      id: "req_1",
      title: "Ship CLI",
      rawInput: "Ship CLI",
      template: "feature",
      status: "approved",
      simpleSummary: "Ship CLI",
      clarificationQuestions: [],
      clarificationTurns: [],
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  prds: [
    {
      id: "prd_1",
      requirementId: "req_1",
      version: 1,
      status: "approved",
      title: "Ship CLI",
      bodyMarkdown: "# Ship CLI",
      acceptanceCriteria: ["Happy path works"],
      approvedAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  workItems: [
    {
      id: "wi_1",
      prdId: "prd_1",
      title: "Backend",
      status: "review",
      role: "backend",
      scope: "API",
      nonGoals: [],
      acceptanceCriteria: [],
      testSuggestions: []
    },
    {
      id: "wi_2",
      prdId: "prd_1",
      title: "Ops",
      status: "review",
      role: "ops",
      scope: "CLI",
      nonGoals: [],
      acceptanceCriteria: [],
      testSuggestions: []
    }
  ],
  interfaceContracts: [],
  testCases: [],
  testRuns: [
    {
      id: "test_1",
      prdId: "prd_1",
      status: "passed",
      command: "pnpm test",
      summary: "passed",
      durationMs: 10
    },
    {
      id: "test_2",
      prdId: "prd_1",
      status: "failed",
      command: "pnpm e2e",
      summary: "failed",
      durationMs: 10
    }
  ],
  workspaceRuns: [],
  artifacts: [],
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
      costEstimateUsd: 0,
      startedAt: "2026-06-10T00:00:00.000Z"
    },
    {
      id: "run_2",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_2",
      runner: "simulated",
      status: "succeeded",
      currentStep: "confirming",
      timeline: [],
      events: [],
      costEstimateUsd: 0,
      startedAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  pullRequests: [
    {
      id: "pr_1",
      provider: "local",
      status: "ready_for_review",
      title: "Ship CLI",
      runId: "run_1",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      branchName: "patchpilot/wi-1",
      baseBranch: "main",
      url: "local://pull-requests/run_1",
      bodyMarkdown: "Ready",
      reviewerSummary: "Approved",
      testSummary: "Tests passed",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  reviewRecords: [
    {
      id: "review_1",
      linkedPullRequestId: "pr_1",
      runId: "run_1",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      status: "approved",
      reviewerAgentId: "agent_reviewer",
      summary: "Approved",
      testSummary: "Tests passed",
      riskLevel: "low",
      findings: [],
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  auditEvents: [
    {
      id: "audit_1",
      actor: "cli",
      action: "acceptance.accepted",
      targetType: "prd",
      targetId: "prd_1",
      message: "Accepted",
      requirementId: "req_1",
      prdId: "prd_1",
      traceId: "prd_1",
      createdAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  acceptances: [
    {
      runId: "run_1",
      status: "accepted",
      decidedAt: "2026-06-10T00:00:00.000Z"
    },
    {
      runId: "run_2",
      status: "accepted",
      decidedAt: "2026-06-10T00:00:00.000Z"
    }
  ],
  approvals: [],
  bugs: [],
  agents: []
};
