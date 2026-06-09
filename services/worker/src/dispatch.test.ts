import { describe, expect, it } from "vitest";
import type { AgentProfile, AgentRole, AgentStatus, PatchPilotSnapshot, WorkItem, WorkItemStatus } from "@patchpilot/domain";
import { planDispatch } from "./dispatch";

describe("planDispatch", () => {
  it("matches ready work items to idle agents with the same role", () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent({ id: "agent_frontend", role: "frontend" }),
          agent({ id: "agent_backend", role: "backend" })
        ],
        workItems: [workItem({ id: "wi_backend", role: "backend" })]
      })
    );

    expect(plan).toEqual([
      {
        workItemId: "wi_backend",
        workItemTitle: "backend work",
        agentId: "agent_backend",
        agentName: "backend agent",
        role: "backend"
      }
    ]);
  });

  it("does not dispatch to busy agents", () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent({
            id: "agent_backend",
            role: "backend",
            status: "busy",
            currentWorkItemId: "wi_existing"
          })
        ],
        workItems: [workItem({ id: "wi_backend", role: "backend" })]
      })
    );

    expect(plan).toEqual([]);
  });

  it("dispatches ready work items and ignores work that is not ready", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_test", role: "test" })],
        workItems: [
          workItem({ id: "wi_running", role: "test", status: "running" }),
          workItem({ id: "wi_ready", role: "test" })
        ]
      })
    );

    expect(plan.map((assignment) => assignment.workItemId)).toEqual(["wi_ready"]);
    expect(plan[0]?.agentId).toBe("agent_test");
  });

  it("uses an idle reviewer as fallback when the role agent is busy", () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent({ id: "agent_backend", role: "backend", status: "busy", currentWorkItemId: "wi_existing" }),
          agent({ id: "agent_reviewer", role: "reviewer" })
        ],
        workItems: [workItem({ id: "wi_backend", role: "backend" })]
      })
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]?.agentId).toBe("agent_reviewer");
  });
});

function snapshot(input: {
  agents: AgentProfile[];
  workItems: WorkItem[];
}): PatchPilotSnapshot {
  return {
    requirements: [],
    prds: [],
    workItems: input.workItems,
    agentRuns: [],
    interfaceContracts: [],
    workspaceRuns: [],
    testRuns: [],
    auditEvents: [],
    acceptances: [],
    bugs: [],
    agents: input.agents
  };
}

function agent(input: {
  id: string;
  role: AgentRole;
  status?: AgentStatus;
  currentWorkItemId?: string;
}): AgentProfile {
  return {
    id: input.id,
    name: `${input.role} agent`,
    role: input.role,
    status: input.status ?? "idle",
    currentWorkItemId: input.currentWorkItemId,
    lastSeenAt: "2026-06-09T00:00:00.000Z"
  };
}

function workItem(input: {
  id: string;
  role: AgentRole;
  status?: WorkItemStatus;
}): WorkItem {
  return {
    id: input.id,
    prdId: "prd_1",
    title: `${input.role} work`,
    status: input.status ?? "ready",
    role: input.role,
    scope: "scope",
    nonGoals: [],
    acceptanceCriteria: [],
    testSuggestions: []
  };
}
