import { afterEach, describe, expect, it } from "vitest";
import { createDefaultAgents, type PatchPilotSnapshot } from "@patchpilot/domain";
import { createPglitePatchPilotRepository, type PatchPilotRepository } from ".";

const now = "2026-06-10T00:00:00.000Z";

describe("PatchPilot Postgres repository", () => {
  let repository: PatchPilotRepository | undefined;

  afterEach(async () => {
    await repository?.close();
    repository = undefined;
  });

  it("imports and exports JSON-shaped product state through Postgres tables", async () => {
    repository = await createPglitePatchPilotRepository();
    const fixture = snapshotFixture();

    await repository.replaceSnapshot(fixture);
    const loaded = await repository.loadSnapshot();

    expect(loaded.requirements).toHaveLength(1);
    expect(loaded.prds).toHaveLength(1);
    expect(loaded.workItems).toHaveLength(1);
    expect(loaded.agentRuns.map((run) => run.id).sort()).toEqual(["run_1", "run_2"]);
    expect(loaded.pullRequests.map((pullRequest) => pullRequest.workItemId)).toEqual(["wi_1", "wi_1"]);
    expect(loaded.reviewRecords.map((review) => review.linkedPullRequestId).sort()).toEqual(["pr_1", "pr_2"]);
    expect(loaded.acceptances).toEqual([
      {
        runId: "run_2",
        status: "accepted",
        reason: "Accepted latest rework.",
        decidedAt: now
      }
    ]);
    expect(loaded.auditEvents.map((event) => event.id)).toEqual(["audit_2", "audit_1"]);
  });
});

function snapshotFixture(): PatchPilotSnapshot {
  return {
    requirements: [
      {
        id: "req_1",
        title: "Feature: repository",
        rawInput: "Move product state to Postgres",
        template: "feature",
        status: "approved",
        simpleSummary: "Feature: repository",
        clarificationQuestions: [],
        clarificationTurns: [],
        createdAt: now,
        updatedAt: now
      }
    ],
    prds: [
      {
        id: "prd_1",
        requirementId: "req_1",
        version: 1,
        status: "approved",
        title: "Repository PRD",
        bodyMarkdown: "# Repository PRD",
        acceptanceCriteria: ["State persists in Postgres"],
        approvedAt: now
      }
    ],
    workItems: [
      {
        id: "wi_1",
        prdId: "prd_1",
        title: "Repository layer",
        status: "review",
        role: "backend",
        scope: "Persist API state in Postgres",
        nonGoals: ["Temporal workflows"],
        acceptanceCriteria: ["State persists in Postgres"],
        testSuggestions: ["Run API tests against PGlite"],
        version: 3,
        reworkCount: 1,
        createdAt: now,
        updatedAt: now
      }
    ],
    interfaceContracts: [],
    agentRuns: [
      {
        id: "run_2",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runner: "simulated",
        status: "succeeded",
        currentStep: "confirming",
        timeline: [],
        events: [],
        result: {
          summary: "Second attempt passed",
          previewUrl: "http://localhost:3000",
          riskLevel: "low",
          changedFiles: ["services/api/src/store.ts"],
          tests: [],
          reviewerSummary: "Approved",
          runner: "simulated"
        },
        costEstimateUsd: 0.42,
        costActualUsd: 0.38,
        startedAt: "2026-06-10T00:02:00.000Z",
        endedAt: "2026-06-10T00:03:00.000Z"
      },
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
        costEstimateUsd: 0.42,
        costActualUsd: 0.38,
        startedAt: now,
        endedAt: "2026-06-10T00:01:00.000Z"
      }
    ],
    workspaceRuns: [],
    testCases: [
      {
        id: "tc_1",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        title: "Repository API test",
        kind: "contract",
        status: "passed",
        priority: "high",
        steps: ["Run API tests"],
        expectedResult: "API uses test database",
        linkedAcceptanceCriteria: ["State persists in Postgres"],
        lastRunId: "run_2",
        lastTestRunId: "test_1",
        flaky: false,
        createdAt: now,
        updatedAt: now
      }
    ],
    testRuns: [
      {
        id: "test_1",
        testCaseId: "tc_1",
        runId: "run_2",
        prdId: "prd_1",
        workItemId: "wi_1",
        status: "passed",
        command: "pnpm --filter @patchpilot/api test",
        summary: "passed",
        durationMs: 120,
        startedAt: now,
        endedAt: now,
        artifactIds: []
      }
    ],
    artifacts: [],
    pullRequests: [
      {
        id: "pr_2",
        provider: "local",
        status: "ready_for_review",
        title: "Repository layer rework",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_2",
        branchName: "patchpilot/repo-2",
        baseBranch: "main",
        url: "local://pull-requests/run_2",
        bodyMarkdown: "# PR 2",
        reviewerSummary: "Approved",
        testSummary: "passed",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "pr_1",
        provider: "local",
        status: "ready_for_review",
        title: "Repository layer",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_1",
        branchName: "patchpilot/repo-1",
        baseBranch: "main",
        url: "local://pull-requests/run_1",
        bodyMarkdown: "# PR 1",
        reviewerSummary: "Approved",
        testSummary: "passed",
        createdAt: now,
        updatedAt: now
      }
    ],
    reviewRecords: [
      {
        id: "review_2",
        status: "approved",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_2",
        linkedPullRequestId: "pr_2",
        reviewerAgentId: "agent_reviewer",
        summary: "Approved",
        testSummary: "passed",
        riskLevel: "low",
        findings: ["No blockers"],
        createdAt: now,
        updatedAt: now
      },
      {
        id: "review_1",
        status: "approved",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_1",
        linkedPullRequestId: "pr_1",
        reviewerAgentId: "agent_reviewer",
        summary: "Approved",
        testSummary: "passed",
        riskLevel: "low",
        findings: ["No blockers"],
        createdAt: now,
        updatedAt: now
      }
    ],
    auditEvents: [
      {
        id: "audit_2",
        traceId: "run_2",
        actorType: "agent",
        actorId: "agent_backend",
        actor: "agent_backend",
        action: "agent_run.succeeded",
        targetType: "agent_run",
        targetId: "run_2",
        message: "Run 2 succeeded.",
        beforeJson: null,
        afterJson: {},
        metadataJson: {},
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        previousHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_2",
        createdAt: "2026-06-10T00:03:00.000Z"
      },
      {
        id: "audit_1",
        traceId: "run_1",
        actorType: "agent",
        actorId: "agent_backend",
        actor: "agent_backend",
        action: "agent_run.succeeded",
        targetType: "agent_run",
        targetId: "run_1",
        message: "Run 1 succeeded.",
        beforeJson: null,
        afterJson: {},
        metadataJson: {},
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        previousHash: null,
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_1",
        createdAt: "2026-06-10T00:01:00.000Z"
      }
    ],
    acceptances: [
      {
        runId: "run_2",
        status: "accepted",
        reason: "Accepted latest rework.",
        decidedAt: now
      }
    ],
    approvals: [],
    bugs: [],
    agents: createDefaultAgents(now)
  };
}
