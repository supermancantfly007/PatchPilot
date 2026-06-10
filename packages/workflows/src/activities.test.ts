import { describe, expect, it } from "vitest";
import { InMemoryTemporalCanaryActivityStore } from "./activities";

describe("Temporal canary activities", () => {
  it("deduplicates activity completion by idempotency key", async () => {
    const store = new InMemoryTemporalCanaryActivityStore();
    const first = await store.complete({
      workflowId: "workflow-1",
      idempotencyKey: "td-204-key",
      label: "first"
    });
    const second = await store.complete({
      workflowId: "workflow-1",
      idempotencyKey: "td-204-key",
      label: "second"
    });

    expect(second).toBe(first);
    expect(second.label).toBe("first");
    expect(store.completed.size).toBe(1);
  });
});
