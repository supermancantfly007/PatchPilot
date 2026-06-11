import { describe, expect, it } from "vitest";
import {
  approvalActivityOptions,
  defectReproductionActivityOptions,
  temporalCanaryActivityOptions,
  workItemExecutionActivityOptions,
  workItemPlanningActivityOptions
} from "./policies";

describe("Temporal workflow policies", () => {
  it("keeps a bounded retry policy on the canary activity", () => {
    expect(temporalCanaryActivityOptions).toEqual({
      startToCloseTimeout: "10 seconds",
      retry: {
        initialInterval: "200 milliseconds",
        backoffCoefficient: 2,
        maximumInterval: "2 seconds",
        maximumAttempts: 3
      }
    });
  });

  it("keeps a bounded retry policy on approval activities", () => {
    expect(approvalActivityOptions).toEqual({
      startToCloseTimeout: "15 seconds",
      retry: {
        initialInterval: "500 milliseconds",
        backoffCoefficient: 2,
        maximumInterval: "5 seconds",
        maximumAttempts: 5
      }
    });
  });

  it("keeps a bounded retry policy on planning activities", () => {
    expect(workItemPlanningActivityOptions).toEqual({
      startToCloseTimeout: "15 seconds",
      retry: {
        initialInterval: "500 milliseconds",
        backoffCoefficient: 2,
        maximumInterval: "5 seconds",
        maximumAttempts: 5
      }
    });
  });

  it("keeps a bounded retry policy on work item execution activities", () => {
    expect(workItemExecutionActivityOptions).toEqual({
      startToCloseTimeout: "30 seconds",
      retry: {
        initialInterval: "500 milliseconds",
        backoffCoefficient: 2,
        maximumInterval: "10 seconds",
        maximumAttempts: 5
      }
    });
  });

  it("keeps a bounded retry policy on defect reproduction activities", () => {
    expect(defectReproductionActivityOptions).toEqual({
      startToCloseTimeout: "30 seconds",
      retry: {
        initialInterval: "500 milliseconds",
        backoffCoefficient: 2,
        maximumInterval: "10 seconds",
        maximumAttempts: 5
      }
    });
  });
});
