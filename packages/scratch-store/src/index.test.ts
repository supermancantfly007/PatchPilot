import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ScratchMarkdownStore,
  ScratchStoreError,
  parseScratchRunReport,
  parseScratchWorkItem,
  serializeScratchRunReport,
  serializeScratchWorkItem,
  type ScratchWorkItem
} from "./index";

describe("ScratchMarkdownStore", () => {
  it("round-trips work items and run reports as markdown with structured metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-scratch-store-"));
    const store = new ScratchMarkdownStore({ rootDir });
    const workItem = exampleWorkItem({ id: "wi_backend" });

    const workItemPath = await store.exportWorkItem(workItem);
    const importedWorkItems = await store.importWorkItems();
    expect(importedWorkItems).toMatchObject([
      {
        id: "wi_backend",
        status: "ready",
        bodyMarkdown: "Implement the backend path.",
        sourcePath: workItemPath
      }
    ]);

    const reportPath = await store.exportRunReport({
      id: "run_backend",
      workItemId: "wi_backend",
      status: "succeeded",
      title: "Backend run",
      summary: "Implemented backend path",
      testSummary: "pnpm test passed",
      artifacts: ["artifact://logs/run_backend"],
      createdAt: "2026-06-10T00:00:00.000Z",
      completedAt: "2026-06-10T00:05:00.000Z",
      bodyMarkdown: "## Evidence\n\n- Tests passed"
    });
    const reports = await store.importRunReports();
    expect(reports).toMatchObject([
      {
        id: "run_backend",
        workItemId: "wi_backend",
        status: "succeeded",
        sourcePath: reportPath
      }
    ]);
  });

  it("fences concurrent claims with a file lock", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-scratch-store-"));
    const firstStore = new ScratchMarkdownStore({ rootDir });
    const secondStore = new ScratchMarkdownStore({ rootDir });
    await firstStore.exportWorkItem(exampleWorkItem({ id: "wi_claim" }));

    const claims = await Promise.all([
      firstStore.claimWorkItem("wi_claim", "agent_backend"),
      secondStore.claimWorkItem("wi_claim", "agent_reviewer")
    ]);

    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.claimed)).toMatchObject([{ reason: "active_claim" }]);
    const finalWorkItem = await firstStore.readWorkItem("wi_claim");
    expect(finalWorkItem.status).toBe("claimed");
    expect(finalWorkItem.claimOwner).toMatch(/^agent_/u);
    expect(finalWorkItem.claimToken).toEqual(expect.any(String));
    expect(finalWorkItem.version).toBe(2);
  });

  it("allows an expired scratch markdown lease to be reclaimed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-scratch-store-"));
    const store = new ScratchMarkdownStore({ rootDir });
    await store.exportWorkItem(exampleWorkItem({ id: "wi_reclaim" }));

    const firstClaim = await store.claimWorkItem("wi_reclaim", "agent_backend", { leaseDurationMs: 1 });
    expect(firstClaim.claimed).toBe(true);
    await delay(10);
    const secondClaim = await store.claimWorkItem("wi_reclaim", "agent_reviewer");

    expect(secondClaim.claimed).toBe(true);
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(secondClaim.workItem).toMatchObject({
      claimOwner: "agent_reviewer",
      status: "claimed",
      version: 3
    });
  });

  it("requires a matching claim token when releasing scratch work", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-scratch-store-"));
    const store = new ScratchMarkdownStore({ rootDir });
    await store.exportWorkItem(exampleWorkItem({ id: "wi_release" }));
    const claim = await store.claimWorkItem("wi_release", "agent_backend");

    await expect(store.releaseWorkItem("wi_release", { claimToken: "stale" })).rejects.toMatchObject({
      code: "INVALID_STATE"
    });
    const released = await store.releaseWorkItem("wi_release", { claimToken: claim.claimToken });

    expect(released).toMatchObject({
      status: "ready",
      claimOwner: undefined,
      claimToken: undefined,
      leaseExpiresAt: undefined,
      version: 3
    });
  });

  it("reaps stale lock directories before claiming", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-scratch-store-"));
    const store = new ScratchMarkdownStore({ rootDir, staleLockMs: 0 });
    await store.exportWorkItem(exampleWorkItem({ id: "wi_stale_lock" }));
    await mkdir(join(rootDir, ".patchpilot", "locks", "work-items", "wi_stale_lock.lock"), { recursive: true });

    const claim = await store.claimWorkItem("wi_stale_lock", "agent_backend");

    expect(claim.claimed).toBe(true);
  });

  it("parses serialized markdown without relying on file paths", () => {
    const workItem = parseScratchWorkItem(serializeScratchWorkItem(exampleWorkItem({ id: "wi_parse" })));
    const report = parseScratchRunReport(
      serializeScratchRunReport({
        id: "run_parse",
        workItemId: "wi_parse",
        status: "failed",
        title: "Failed run",
        summary: "Tests failed",
        createdAt: "2026-06-10T00:00:00.000Z"
      })
    );

    expect(workItem.id).toBe("wi_parse");
    expect(report).toMatchObject({ id: "run_parse", status: "failed" });
  });

  it("fails clearly for invalid markdown metadata", () => {
    expect(() => parseScratchWorkItem("# Missing metadata")).toThrow(ScratchStoreError);
  });
});

function exampleWorkItem(input: Partial<ScratchWorkItem> = {}): ScratchWorkItem {
  return {
    id: input.id ?? "wi_example",
    title: input.title ?? "Backend work",
    role: input.role ?? "backend",
    status: input.status ?? "ready",
    scope: input.scope ?? "Implement backend path.",
    nonGoals: input.nonGoals ?? ["No production deploy"],
    acceptanceCriteria: input.acceptanceCriteria ?? ["Tests pass"],
    testSuggestions: input.testSuggestions ?? ["pnpm test"],
    version: input.version ?? 1,
    createdAt: input.createdAt ?? "2026-06-10T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-10T00:00:00.000Z",
    bodyMarkdown: input.bodyMarkdown ?? "Implement the backend path."
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
