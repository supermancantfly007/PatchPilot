import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import { readTemporalConfig, temporalCanaryWorkflowId, temporalCanaryWorkflowStartOptions } from "./client";

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
});
