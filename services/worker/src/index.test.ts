import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, PatchPilotSnapshot, WorkItem } from "@patchpilot/domain";
import { readWorkerConfig, runWorkerTick } from "./index";

describe("worker runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads an optional runner override from the worker environment", () => {
    expect(
      readWorkerConfig({
        PATCHPILOT_API_BASE_URL: "http://localhost:4999/",
        PATCHPILOT_WORKER_INTERVAL_MS: "25",
        PATCHPILOT_WORKER_ONCE: "true",
        PATCHPILOT_WORKER_RUNNER: "codex"
      })
    ).toEqual({
      apiBaseUrl: "http://localhost:4999",
      intervalMs: 25,
      once: true,
      runner: "codex"
    });
  });

  it("accepts pi runner overrides and rejects unknown runner values", () => {
    expect(
      readWorkerConfig({
        PATCHPILOT_WORKER_RUNNER: "pi"
      }).runner
    ).toBe("pi");

    expect(() =>
      readWorkerConfig({
        PATCHPILOT_WORKER_RUNNER: "not-a-runner"
      })
    ).toThrow('Invalid runner "not-a-runner". Expected one of: codex, pi');
  });

  it("dispatches planned assignments and passes the runner override to start", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/api/snapshot")) return jsonResponse(snapshot());
        if (url.endsWith("/api/work-items/wi_backend/claim")) {
          return jsonResponse({ claimToken: "claim-token-123" });
        }
        return jsonResponse({ ok: true });
      })
    );

    const result = await runWorkerTick(
      { apiBaseUrl: "http://patchpilot.test", intervalMs: 1, once: true, runner: "codex" },
      { throwOnError: true }
    );

    expect(result).toEqual({ planned: 1, dispatched: 1, failed: 0, errors: [] });
    const startCall = calls.find((call) => call.url.endsWith("/api/work-items/wi_backend/start"));
    expect(JSON.parse(String(startCall?.init?.body))).toEqual({
      runner: "codex",
      claimToken: "claim-token-123"
    });
  });

  it("can fail loudly when a dispatch assignment cannot be started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/snapshot")) return jsonResponse(snapshot());
        return jsonResponse({ error: "claim conflict" }, 409);
      })
    );

    await expect(
      runWorkerTick(
        { apiBaseUrl: "http://patchpilot.test", intervalMs: 1, once: true },
        { throwOnError: true }
      )
    ).rejects.toThrow("Worker tick failed for 1/1 assignment");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function snapshot(): PatchPilotSnapshot {
  return {
    repositories: [],
    githubInstallations: [],
    requirements: [],
    prds: [],
    workItems: [workItem()],
    interfaceContracts: [],
    agentRuns: [],
    workspaceRuns: [],
    testCases: [],
    testRuns: [],
    artifacts: [],
    pullRequests: [],
    reviewRecords: [],
    auditEvents: [],
    acceptances: [],
    approvals: [],
    releaseGates: [],
    bugs: [],
    agents: [agent()]
  };
}

function workItem(): WorkItem {
  return {
    id: "wi_backend",
    prdId: "prd_1",
    title: "Backend work",
    status: "ready",
    role: "backend",
    scope: "API",
    nonGoals: [],
    acceptanceCriteria: [],
    testSuggestions: []
  };
}

function agent(): AgentProfile {
  return {
    id: "agent_backend",
    name: "Backend agent",
    role: "backend",
    status: "idle",
    lastSeenAt: "2026-06-10T00:00:00.000Z"
  };
}
