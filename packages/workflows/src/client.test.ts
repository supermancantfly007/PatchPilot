import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import {
  readTemporalConfig,
  requirementIntakeWorkflowId,
  requirementIntakeWorkflowStartOptions,
  temporalCanaryWorkflowId,
  temporalCanaryWorkflowStartOptions
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
});
