import { describe, expect, it } from "vitest";
import { temporalCanaryActivityOptions, workItemPlanningActivityOptions } from "./policies";

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
});
