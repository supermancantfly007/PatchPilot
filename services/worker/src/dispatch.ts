import type { AgentProfile, AgentRole, PatchPilotSnapshot, WorkItem } from "@patchpilot/domain";

export interface DispatchAssignment {
  workItemId: string;
  workItemTitle: string;
  agentId: string;
  agentName: string;
  role: AgentRole;
}

export function planDispatch(snapshot: PatchPilotSnapshot): DispatchAssignment[] {
  const assignedAgentIds = new Set<string>();
  const idleAgentsByRole = groupIdleAgentsByRole(snapshot.agents);
  const assignments: DispatchAssignment[] = [];

  for (const workItem of snapshot.workItems) {
    if (!isReadyToDispatch(workItem)) continue;

    const agent = findAgentForWorkItem(workItem, idleAgentsByRole, assignedAgentIds);
    if (!agent) continue;

    assignedAgentIds.add(agent.id);
    assignments.push({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      agentId: agent.id,
      agentName: agent.name,
      role: workItem.role
    });
  }

  return assignments;
}

function findAgentForWorkItem(
  workItem: WorkItem,
  idleAgentsByRole: Map<AgentRole, AgentProfile[]>,
  assignedAgentIds: Set<string>
) {
  return [...(idleAgentsByRole.get(workItem.role) ?? []), ...(idleAgentsByRole.get("reviewer") ?? [])].find(
    (candidate) => !assignedAgentIds.has(candidate.id)
  );
}

function groupIdleAgentsByRole(agents: AgentProfile[]) {
  const agentsByRole = new Map<AgentRole, AgentProfile[]>();

  for (const agent of agents) {
    if (agent.status !== "idle" || agent.currentWorkItemId) continue;
    const agentsForRole = agentsByRole.get(agent.role) ?? [];
    agentsForRole.push(agent);
    agentsByRole.set(agent.role, agentsForRole);
  }

  return agentsByRole;
}

function isReadyToDispatch(workItem: WorkItem) {
  return workItem.status === "ready" && !workItem.assignedAgentId;
}
