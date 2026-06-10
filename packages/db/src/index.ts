export * from "./schema";
export {
  agentRuns,
  agents,
  approvals,
  artifacts,
  auditEvents,
  budgets,
  capabilityManifests,
  defects,
  interfaceContracts,
  organizations,
  prdVersions,
  projects,
  pullRequests,
  repositories,
  requirements,
  testCases,
  testRuns,
  workItems,
  workspaceRuns
} from "./schema";

import {
  agentRuns,
  agents,
  approvals,
  artifacts,
  auditEvents,
  budgets,
  capabilityManifests,
  defects,
  interfaceContracts,
  organizations,
  prdVersions,
  projects,
  pullRequests,
  repositories,
  requirements,
  testCases,
  testRuns,
  workItems,
  workspaceRuns
} from "./schema";

export const patchPilotTables = {
  agentRuns,
  agents,
  approvals,
  artifacts,
  auditEvents,
  budgets,
  capabilityManifests,
  defects,
  interfaceContracts,
  organizations,
  prdVersions,
  projects,
  pullRequests,
  repositories,
  requirements,
  testCases,
  testRuns,
  workItems,
  workspaceRuns
} as const;

export const patchPilotTableNames = [
  "agent_runs",
  "agents",
  "approvals",
  "artifacts",
  "audit_events",
  "budgets",
  "capability_manifests",
  "defects",
  "interface_contracts",
  "organizations",
  "prd_versions",
  "projects",
  "pull_requests",
  "repositories",
  "requirements",
  "test_cases",
  "test_runs",
  "work_items",
  "workspace_runs"
] as const;

export type PatchPilotTableName = (typeof patchPilotTableNames)[number];
