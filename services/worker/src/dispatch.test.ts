import { describe, expect, it } from "vitest";
import type {
  AgentProfile,
  AgentRole,
  AgentRun,
  AgentRunStatus,
  AgentStatus,
  PatchPilotSnapshot,
  WorkItem,
  WorkItemStatus
} from "@patchpilot/domain";
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
        prdId: "prd_1",
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

  it("dispatches work items whose claim lease has expired", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [
          workItem({
            id: "wi_expired",
            role: "backend",
            status: "claimed",
            assignedAgentId: "agent_previous",
            leaseExpiresAt: "2026-06-09T00:00:00.000Z"
          })
        ]
      }),
      { now: new Date("2026-06-10T00:00:00.000Z") }
    );

    expect(plan.map((assignment) => assignment.workItemId)).toEqual(["wi_expired"]);
  });

  it("waits until work item dependencies are done", () => {
    const blockedPlan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [
          workItem({ id: "wi_dependency", role: "backend", status: "running" }),
          workItem({ id: "wi_dependent", role: "backend", dependsOn: ["wi_dependency"] })
        ]
      })
    );

    const readyPlan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [
          workItem({ id: "wi_dependency", role: "backend", status: "done" }),
          workItem({ id: "wi_dependent", role: "backend", dependsOn: ["wi_dependency"] })
        ]
      })
    );

    expect(blockedPlan.map((assignment) => assignment.workItemId)).toEqual([]);
    expect(readyPlan.map((assignment) => assignment.workItemId)).toEqual(["wi_dependent"]);
  });

  it("does not dispatch work that has exhausted its budget", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [workItem({ id: "wi_backend", role: "backend", budgetUsd: 1 })],
        agentRuns: [agentRun({ workItemId: "wi_backend", status: "failed", costActualUsd: 1 })]
      })
    );

    expect(plan).toEqual([]);
  });

  it("allows cancelled runs to release budget back to the item", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [workItem({ id: "wi_backend", role: "backend", budgetUsd: 1 })],
        agentRuns: [agentRun({ workItemId: "wi_backend", status: "cancelled", costActualUsd: 1 })]
      })
    );

    expect(plan.map((assignment) => assignment.workItemId)).toEqual(["wi_backend"]);
  });

  it("requires matching agent capabilities when a work item declares them", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend", capabilities: ["api"] })],
        workItems: [workItem({ id: "wi_backend", role: "backend", requiredCapabilities: ["database-migration"] })]
      })
    );

    expect(plan).toEqual([]);
  });

  it("matches required capabilities from the agent capability list", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend", capabilities: ["database-migration"] })],
        workItems: [workItem({ id: "wi_backend", role: "backend", requiredCapabilities: ["database-migration"] })]
      })
    );

    expect(plan.map((assignment) => assignment.agentId)).toEqual(["agent_backend"]);
  });

  it("allows the agent role itself to satisfy a required capability", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [workItem({ id: "wi_backend", role: "backend", requiredCapabilities: ["backend"] })]
      })
    );

    expect(plan.map((assignment) => assignment.agentId)).toEqual(["agent_backend"]);
  });

  it("only uses reviewer fallback agents when their capabilities match", () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent({ id: "agent_backend", role: "backend", status: "busy", currentWorkItemId: "wi_existing" }),
          agent({ id: "agent_reviewer", role: "reviewer", capabilities: ["api-review"] })
        ],
        workItems: [workItem({ id: "wi_backend", role: "backend", requiredCapabilities: ["database-migration"] })]
      })
    );

    expect(plan).toEqual([]);
  });

  it("does not exceed a work item concurrency limit across planned assignments", () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent({ id: "agent_backend_1", role: "backend" }),
          agent({ id: "agent_backend_2", role: "backend" })
        ],
        workItems: [
          workItem({ id: "wi_first", role: "backend", concurrencyKey: "db", maxConcurrent: 1 }),
          workItem({ id: "wi_second", role: "backend", concurrencyKey: "db", maxConcurrent: 1 })
        ]
      })
    );

    expect(plan.map((assignment) => assignment.workItemId)).toEqual(["wi_first"]);
  });

  it("counts running work and active claims against the concurrency limit", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [
          workItem({ id: "wi_running", role: "backend", status: "running", concurrencyKey: "db", maxConcurrent: 1 }),
          workItem({
            id: "wi_claimed",
            role: "backend",
            status: "claimed",
            assignedAgentId: "agent_previous",
            leaseExpiresAt: "2026-06-11T00:00:00.000Z",
            concurrencyKey: "db",
            maxConcurrent: 1
          }),
          workItem({ id: "wi_ready", role: "backend", concurrencyKey: "db", maxConcurrent: 1 })
        ]
      }),
      { now: new Date("2026-06-10T00:00:00.000Z") }
    );

    expect(plan).toEqual([]);
  });

  it("does not count expired claims against the concurrency limit", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [
          workItem({
            id: "wi_expired",
            role: "backend",
            status: "claimed",
            assignedAgentId: "agent_previous",
            leaseExpiresAt: "2026-06-09T00:00:00.000Z",
            concurrencyKey: "db",
            maxConcurrent: 1
          }),
          workItem({ id: "wi_ready", role: "backend", concurrencyKey: "db", maxConcurrent: 1 })
        ]
      }),
      { now: new Date("2026-06-10T00:00:00.000Z") }
    );

    expect(plan.map((assignment) => assignment.workItemId)).toEqual(["wi_expired"]);
  });

  it("does not start a duplicate dispatch when an active run already exists", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [workItem({ id: "wi_backend", role: "backend" })],
        agentRuns: [agentRun({ workItemId: "wi_backend", status: "running" })]
      })
    );

    expect(plan).toEqual([]);
  });

  it("allows dispatch after a failed run has returned the item to ready", () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent({ id: "agent_backend", role: "backend" })],
        workItems: [workItem({ id: "wi_backend", role: "backend" })],
        agentRuns: [agentRun({ workItemId: "wi_backend", status: "failed" })]
      })
    );

    expect(plan.map((assignment) => assignment.workItemId)).toEqual(["wi_backend"]);
  });
});

function snapshot(input: {
  agents: AgentProfile[];
  workItems: WorkItem[];
  agentRuns?: AgentRun[];
}): PatchPilotSnapshot {
  return {
    requirements: [],
    prds: [],
    workItems: input.workItems,
    agentRuns: input.agentRuns ?? [],
    interfaceContracts: [],
    workspaceRuns: [],
    testCases: [],
    testRuns: [],
    artifacts: [],
    pullRequests: [],
    reviewRecords: [],
    auditEvents: [],
    acceptances: [],
    approvals: [],
    bugs: [],
    agents: input.agents
  };
}

function agent(input: {
  id: string;
  role: AgentRole;
  status?: AgentStatus;
  currentWorkItemId?: string;
  capabilities?: string[];
}): AgentProfile {
  return {
    id: input.id,
    name: `${input.role} agent`,
    role: input.role,
    status: input.status ?? "idle",
    currentWorkItemId: input.currentWorkItemId,
    capabilities: input.capabilities,
    lastSeenAt: "2026-06-09T00:00:00.000Z"
  };
}

function workItem(input: {
  id: string;
  role: AgentRole;
  status?: WorkItemStatus;
  assignedAgentId?: string;
  leaseExpiresAt?: string;
  dependsOn?: string[];
  requiredCapabilities?: string[];
  budgetUsd?: number;
  concurrencyKey?: string;
  maxConcurrent?: number;
}): WorkItem {
  return {
    id: input.id,
    prdId: "prd_1",
    title: `${input.role} work`,
    status: input.status ?? "ready",
    role: input.role,
    assignedAgentId: input.assignedAgentId,
    leaseExpiresAt: input.leaseExpiresAt,
    dependsOn: input.dependsOn,
    requiredCapabilities: input.requiredCapabilities,
    budgetUsd: input.budgetUsd,
    concurrencyKey: input.concurrencyKey,
    maxConcurrent: input.maxConcurrent,
    scope: "scope",
    nonGoals: [],
    acceptanceCriteria: [],
    testSuggestions: []
  };
}

function agentRun(input: {
  workItemId: string;
  status: AgentRunStatus;
  costActualUsd?: number;
  costEstimateUsd?: number;
}): AgentRun {
  return {
    id: `run_${input.workItemId}_${input.status}`,
    requirementId: "req_1",
    prdId: "prd_1",
    workItemId: input.workItemId,
    runner: "simulated",
    status: input.status,
    currentStep: "understanding",
    timeline: [],
    events: [],
    costEstimateUsd: input.costEstimateUsd ?? 0,
    costActualUsd: input.costActualUsd,
    startedAt: "2026-06-09T00:00:00.000Z"
  };
}
