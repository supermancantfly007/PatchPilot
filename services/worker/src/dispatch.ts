import type { AgentProfile, AgentRole, AgentRun, PatchPilotSnapshot, WorkItem } from "@patchpilot/domain";

export interface DispatchAssignment {
  workItemId: string;
  workItemTitle: string;
  prdId: string;
  agentId: string;
  agentName: string;
  role: AgentRole;
}

interface DispatchContext {
  nowMs: number;
  plannedConcurrency: Map<string, number>;
}

const activeRunStatuses = new Set<AgentRun["status"]>(["queued", "running", "needs_approval"]);

export function planDispatch(snapshot: PatchPilotSnapshot, options: { now?: Date } = {}): DispatchAssignment[] {
  const assignedAgentIds = new Set<string>();
  const idleAgentsByRole = groupIdleAgentsByRole(snapshot.agents);
  const assignments: DispatchAssignment[] = [];
  const context: DispatchContext = {
    nowMs: (options.now ?? new Date()).getTime(),
    plannedConcurrency: new Map()
  };

  for (const workItem of snapshot.workItems) {
    if (!isDispatchable(workItem, snapshot, context)) continue;

    const agent = findAgentForWorkItem(workItem, idleAgentsByRole, assignedAgentIds);
    if (!agent) continue;

    assignedAgentIds.add(agent.id);
    trackPlannedConcurrency(workItem, context);
    assignments.push({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      prdId: workItem.prdId,
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
    (candidate) => !assignedAgentIds.has(candidate.id) && agentHasCapabilities(candidate, workItem)
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

function isDispatchable(workItem: WorkItem, snapshot: PatchPilotSnapshot, context: DispatchContext) {
  if (!isReadyToDispatch(workItem, context.nowMs)) return false;
  if (!dependenciesSatisfied(workItem, snapshot)) return false;
  if (!hasBudget(workItem, snapshot)) return false;
  if (!withinConcurrencyLimit(workItem, snapshot, context)) return false;
  if (hasActiveRun(workItem, snapshot)) return false;
  return true;
}

function isReadyToDispatch(workItem: WorkItem, nowMs: number) {
  return (workItem.status === "ready" && !workItem.assignedAgentId) || isExpiredClaim(workItem, nowMs);
}

function dependenciesSatisfied(workItem: WorkItem, snapshot: PatchPilotSnapshot) {
  const dependencies = workItem.dependsOn ?? [];
  if (dependencies.length === 0) return true;
  return dependencies.every((dependencyId) => {
    const dependency = snapshot.workItems.find((candidate) => candidate.id === dependencyId);
    return dependency?.status === "done";
  });
}

function hasBudget(workItem: WorkItem, snapshot: PatchPilotSnapshot) {
  if (workItem.budgetUsd === undefined) return true;
  if (workItem.budgetUsd <= 0) return false;
  const spent = snapshot.agentRuns
    .filter((run) => run.workItemId === workItem.id && run.status !== "cancelled")
    .reduce((total, run) => total + (run.costActualUsd ?? run.costEstimateUsd ?? 0), 0);
  return spent < workItem.budgetUsd;
}

function withinConcurrencyLimit(workItem: WorkItem, snapshot: PatchPilotSnapshot, context: DispatchContext) {
  const maxConcurrent = workItem.maxConcurrent;
  if (maxConcurrent === undefined) return true;
  if (maxConcurrent <= 0) return false;
  const key = concurrencyKeyFor(workItem);
  const activeCount = snapshot.workItems.filter((candidate) => {
    if (candidate.id === workItem.id || concurrencyKeyFor(candidate) !== key) return false;
    return candidate.status === "running" || isActiveClaim(candidate, context.nowMs);
  }).length;
  const plannedCount = context.plannedConcurrency.get(key) ?? 0;
  return activeCount + plannedCount < maxConcurrent;
}

function trackPlannedConcurrency(workItem: WorkItem, context: DispatchContext) {
  if (workItem.maxConcurrent === undefined) return;
  const key = concurrencyKeyFor(workItem);
  context.plannedConcurrency.set(key, (context.plannedConcurrency.get(key) ?? 0) + 1);
}

function hasActiveRun(workItem: WorkItem, snapshot: PatchPilotSnapshot) {
  return snapshot.agentRuns.some((run) => run.workItemId === workItem.id && activeRunStatuses.has(run.status));
}

function agentHasCapabilities(agent: AgentProfile, workItem: WorkItem) {
  const requiredCapabilities = workItem.requiredCapabilities ?? [];
  if (requiredCapabilities.length === 0) return true;
  const capabilities = new Set([agent.role, ...(agent.capabilities ?? [])]);
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}

function concurrencyKeyFor(workItem: WorkItem) {
  return workItem.concurrencyKey ?? workItem.prdId;
}

function isActiveClaim(workItem: WorkItem, nowMs: number) {
  return workItem.status === "claimed" && !isExpiredClaim(workItem, nowMs);
}

function isExpiredClaim(workItem: WorkItem, nowMs: number) {
  if (workItem.status !== "claimed") return false;
  if (!workItem.leaseExpiresAt) return true;
  const expiresAt = Date.parse(workItem.leaseExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}
