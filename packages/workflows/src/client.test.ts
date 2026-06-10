import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import {
  approvalWorkflowId,
  approvalWorkflowStartOptions,
  readTemporalConfig,
  requirementIntakeWorkflowId,
  requirementIntakeWorkflowStartOptions,
  temporalCanaryWorkflowId,
  temporalCanaryWorkflowStartOptions,
  workItemExecutionWorkflowId,
  workItemExecutionWorkflowStartOptions,
  workItemPlanningWorkflowId,
  workItemPlanningWorkflowStartOptions
} from "./client";

describe("Temporal client helpers", () => {
  it("reads Temporal connection config from the environment", () => {
    expect(
      readTemporalConfig({
        PATCHPILOT_TEMPORAL_ADDRESS: "temporal.test:7233",
        PATCHPILOT_TEMPORAL_NAMESPACE: "patchpilot",
        PATCHPILOT_TEMPORAL_TASK_QUEUE: "patchpilot-test"
      })
    ).toEqual({
      address: "temporal.test:7233",
      namespace: "patchpilot",
      taskQueue: "patchpilot-test"
    });
  });

  it("derives a stable workflow id from the idempotency key", () => {
    expect(temporalCanaryWorkflowId("TD-204 / Temporal SDK!")).toMatch(
      /^patchpilot-canary-td-204-temporal-sdk-[a-f0-9]{12}$/
    );
  });

  it("rejects duplicate Temporal workflow id reuse for idempotency keys", () => {
    const input = {
      idempotencyKey: "TD-204 / Temporal SDK!",
      label: "Temporal canary",
      waitForSignal: true
    };

    expect(
      temporalCanaryWorkflowStartOptions(input, {
        address: "temporal.test:7233",
        namespace: "default",
        taskQueue: "patchpilot-test"
      })
    ).toEqual({
      taskQueue: "patchpilot-test",
      workflowId: temporalCanaryWorkflowId(input.idempotencyKey),
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [input]
    });
  });

  it("derives idempotent start options for requirement intake workflows", () => {
    const input = {
      idempotencyKey: "TD-205 / Requirement Intake!",
      rawInput: "用户信号回答澄清问题后生成 PRD",
      template: "feature" as const,
      maxClarificationTurns: 2
    };

    expect(requirementIntakeWorkflowId(input.idempotencyKey)).toMatch(
      /^patchpilot-requirement-intake-td-205-requirement-intake-[a-f0-9]{12}$/
    );
    expect(
      requirementIntakeWorkflowStartOptions(input, {
        address: "temporal.test:7233",
        namespace: "default",
        taskQueue: "patchpilot-test"
      })
    ).toEqual({
      taskQueue: "patchpilot-test",
      workflowId: requirementIntakeWorkflowId(input.idempotencyKey),
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [input]
    });
  });

  it("derives idempotent start options for approval workflows", () => {
    const input = {
      idempotencyKey: "TD-208 / Approval Workflow!",
      kind: "budget_exceeded" as const,
      targetType: "agent_run" as const,
      targetId: "run_td_208",
      requestedBy: "budget-governor",
      requestedReason: "Run requires budget approval.",
      riskLevel: "high" as const,
      expiresAt: "2999-01-01T00:00:00.000Z",
      runId: "run_td_208"
    };

    expect(approvalWorkflowId(input.idempotencyKey)).toMatch(
      /^patchpilot-approval-td-208-approval-workflow-[a-f0-9]{12}$/
    );
    expect(
      approvalWorkflowStartOptions(input, {
        address: "temporal.test:7233",
        namespace: "default",
        taskQueue: "patchpilot-test"
      })
    ).toEqual({
      taskQueue: "patchpilot-test",
      workflowId: approvalWorkflowId(input.idempotencyKey),
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [input]
    });
  });

  it("derives idempotent start options for work item planning workflows", () => {
    const input = {
      idempotencyKey: "TD-206 / Work Item Planning!",
      prd: {
        id: "prd_req_td_206",
        requirementId: "req_td_206",
        version: 1,
        status: "approved" as const,
        title: "Planning workflow",
        bodyMarkdown: "# Planning workflow",
        acceptanceCriteria: ["Plans 1-4 vertical work items"]
      },
      maxWorkItems: 4
    };

    expect(workItemPlanningWorkflowId(input.idempotencyKey)).toMatch(
      /^patchpilot-work-item-planning-td-206-work-item-planning-[a-f0-9]{12}$/
    );
    expect(
      workItemPlanningWorkflowStartOptions(input, {
        address: "temporal.test:7233",
        namespace: "default",
        taskQueue: "patchpilot-test"
      })
    ).toEqual({
      taskQueue: "patchpilot-test",
      workflowId: workItemPlanningWorkflowId(input.idempotencyKey),
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [input]
    });
  });

  it("derives idempotent start options for work item execution workflows", () => {
    const input = {
      idempotencyKey: "TD-207 / Work Item Execution!",
      prd: {
        id: "prd_req_td_207",
        requirementId: "req_td_207",
        version: 1,
        status: "approved" as const,
        title: "Execution workflow",
        bodyMarkdown: "# Execution workflow",
        acceptanceCriteria: ["Records execution evidence chain"]
      },
      workItem: {
        id: "wi_td_207_backend",
        prdId: "prd_req_td_207",
        title: "WorkItemExecutionWorkflow",
        status: "ready" as const,
        role: "backend" as const,
        scope: "Execute claim, workspace, CodexRun, test, PR, review, and archive.",
        nonGoals: ["No approval workflow"],
        acceptanceCriteria: ["Records execution evidence chain"],
        testSuggestions: ["Run workflow tests"],
        version: 1
      }
    };

    expect(workItemExecutionWorkflowId(input.idempotencyKey)).toMatch(
      /^patchpilot-work-item-execution-td-207-work-item-execution-[a-f0-9]{12}$/
    );
    expect(
      workItemExecutionWorkflowStartOptions(input, {
        address: "temporal.test:7233",
        namespace: "default",
        taskQueue: "patchpilot-test"
      })
    ).toEqual({
      taskQueue: "patchpilot-test",
      workflowId: workItemExecutionWorkflowId(input.idempotencyKey),
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [input]
    });
  });
});
