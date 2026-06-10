import { describe, expect, it } from "vitest";
import { temporalCanaryActivityOptions } from "./policies";

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
});
