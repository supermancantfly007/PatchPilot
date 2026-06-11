import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

const emptyJsonArray = sql`'[]'::jsonb`;
const emptyJsonObject = sql`'{}'::jsonb`;

export const requirementInputType = pgEnum("requirement_input_type", ["feature", "bug", "ui", "document"]);
export const requirementStatus = pgEnum("requirement_status", [
  "submitted",
  "clarifying",
  "prd_draft",
  "approved",
  "rejected"
]);
export const prdStatus = pgEnum("prd_status", ["draft", "approved"]);
export const workItemStatus = pgEnum("work_item_status", [
  "proposed",
  "ready",
  "claimed",
  "running",
  "review",
  "blocked",
  "done",
  "cancelled"
]);
export const agentRole = pgEnum("agent_role", ["product", "frontend", "backend", "test", "ops", "reviewer"]);
export const agentStatus = pgEnum("agent_status", ["idle", "busy", "offline"]);
export const agentRunnerKind = pgEnum("agent_runner_kind", ["simulated", "codex"]);
export const agentRunStatus = pgEnum("agent_run_status", [
  "queued",
  "running",
  "needs_approval",
  "succeeded",
  "failed",
  "cancelled"
]);
export const timelineStepKey = pgEnum("timeline_step_key", [
  "understanding",
  "planning",
  "developing",
  "testing",
  "confirming"
]);
export const failureType = pgEnum("failure_type", [
  "transient",
  "deterministic",
  "test_failed",
  "policy_denied",
  "budget_exhausted",
  "environment_failed"
]);
export const interfaceContractKind = pgEnum("interface_contract_kind", ["http", "event", "schema"]);
export const interfaceContractStatus = pgEnum("interface_contract_status", [
  "draft",
  "approved",
  "breaking_change_pending",
  "deprecated"
]);
export const testCaseKind = pgEnum("test_case_kind", ["acceptance", "regression", "contract", "smoke"]);
export const testCaseStatus = pgEnum("test_case_status", ["draft", "ready", "passed", "failed", "blocked"]);
export const testCasePriority = pgEnum("test_case_priority", ["low", "medium", "high"]);
export const testRunStatus = pgEnum("test_run_status", [
  "queued",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped"
]);
export const workspaceRunStatus = pgEnum("workspace_run_status", [
  "preparing",
  "ready",
  "active",
  "archived",
  "failed",
  "destroyed"
]);
export const workspaceIsolation = pgEnum("workspace_isolation", ["simulated", "git_worktree"]);
export const pullRequestProvider = pgEnum("pull_request_provider", ["local", "github"]);
export const pullRequestStatus = pgEnum("pull_request_status", [
  "draft",
  "ready_for_review",
  "changes_requested",
  "approved",
  "merged",
  "closed"
]);
export const reviewStatus = pgEnum("review_status", ["approved", "changes_requested", "blocked"]);
export const acceptanceStatus = pgEnum("acceptance_status", ["pending", "accepted", "rejected"]);
export const defectSeverity = pgEnum("defect_severity", ["low", "medium", "high", "critical"]);
export const defectStatus = pgEnum("defect_status", [
  "reported",
  "needs_repro",
  "reproduced",
  "unreproducible",
  "fixing",
  "verifying",
  "closed"
]);
export const approvalKind = pgEnum("approval_kind", [
  "prd_approval",
  "budget_exceeded",
  "dangerous_operation",
  "breaking_contract",
  "network_allowlist_change",
  "secret_grant",
  "production_data_access"
]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "denied", "expired"]);
export const approvalRiskLevel = pgEnum("approval_risk_level", ["low", "medium", "high", "critical"]);
export const approvalTargetType = pgEnum("approval_target_type", [
  "prd",
  "work_item",
  "agent_run",
  "interface_contract",
  "budget",
  "policy",
  "secret",
  "network",
  "repository"
]);
export const artifactKind = pgEnum("artifact_kind", [
  "log",
  "trace",
  "diff",
  "test_report",
  "screenshot",
  "preview_metadata",
  "retrospective",
  "intake_attachment"
]);
export const artifactStorageProvider = pgEnum("artifact_storage_provider", ["local_fs", "s3"]);
export const capabilityManifestStatus = pgEnum("capability_manifest_status", [
  "draft",
  "active",
  "revoked",
  "expired"
]);
export const budgetScopeType = pgEnum("budget_scope_type", [
  "project",
  "requirement",
  "prd",
  "work_item",
  "agent_run"
]);
export const budgetStatus = pgEnum("budget_status", ["active", "exhausted", "paused", "closed"]);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("organizations_slug_unique").on(table.slug),
    check("organizations_slug_not_empty", sql`length(${table.slug}) > 0`),
    check("organizations_name_not_empty", sql`length(${table.name}) > 0`)
  ]
);
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("projects_organization_slug_unique").on(table.organizationId, table.slug),
    index("projects_organization_id_idx").on(table.organizationId),
    check("projects_slug_not_empty", sql`length(${table.slug}) > 0`),
    check("projects_name_not_empty", sql`length(${table.name}) > 0`)
  ]
);

export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("git"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    remoteUrl: text("remote_url").notNull(),
    htmlUrl: text("html_url"),
    defaultBranch: text("default_branch").notNull().default("main"),
    githubInstallationId: text("github_installation_id"),
    githubRepositoryId: text("github_repository_id"),
    private: boolean("private").notNull().default(false),
    selected: boolean("selected").notNull().default(false),
    permissions: jsonb("permissions").$type<Record<string, boolean>>().notNull().default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("repositories_project_provider_owner_name_unique").on(
      table.projectId,
      table.provider,
      table.owner,
      table.name
    ),
    index("repositories_project_id_idx").on(table.projectId),
    index("repositories_github_installation_id_idx").on(table.githubInstallationId),
    index("repositories_selected_idx").on(table.projectId, table.selected),
    check("repositories_provider_not_empty", sql`length(${table.provider}) > 0`),
    check("repositories_owner_not_empty", sql`length(${table.owner}) > 0`),
    check("repositories_name_not_empty", sql`length(${table.name}) > 0`),
    check("repositories_remote_url_not_empty", sql`length(${table.remoteUrl}) > 0`),
    check("repositories_default_branch_not_empty", sql`length(${table.defaultBranch}) > 0`)
  ]
);

export const githubAppInstallations = pgTable(
  "github_app_installations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type"),
    repositorySelection: text("repository_selection").notNull().default("selected"),
    permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default(emptyJsonObject),
    selectedRepositoryId: text("selected_repository_id"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("github_app_installations_project_installation_unique").on(table.projectId, table.installationId),
    index("github_app_installations_project_id_idx").on(table.projectId),
    check("github_app_installations_installation_id_not_empty", sql`length(${table.installationId}) > 0`),
    check("github_app_installations_account_login_not_empty", sql`length(${table.accountLogin}) > 0`),
    check("github_app_installations_repository_selection_valid", sql`${table.repositorySelection} in ('all', 'selected')`)
  ]
);

export const requirements = pgTable(
  "requirements",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    rawInput: text("raw_input").notNull(),
    inputType: requirementInputType("input_type").notNull(),
    status: requirementStatus("status").notNull().default("submitted"),
    simpleSummary: text("simple_summary").notNull(),
    createdBy: text("created_by").notNull(),
    artifactReferences: jsonb("artifact_references").$type<unknown[]>().notNull().default(emptyJsonArray),
    clarificationQuestions: jsonb("clarification_questions").$type<unknown[]>().notNull().default(emptyJsonArray),
    clarificationTurns: jsonb("clarification_turns").$type<unknown[]>().notNull().default(emptyJsonArray),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("requirements_project_id_idx").on(table.projectId),
    index("requirements_status_idx").on(table.status),
    check("requirements_title_not_empty", sql`length(${table.title}) > 0`),
    check("requirements_created_by_not_empty", sql`length(${table.createdBy}) > 0`)
  ]
);

export const prdVersions = pgTable(
  "prd_versions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: prdStatus("status").notNull().default("draft"),
    title: text("title").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default(emptyJsonArray),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 2 }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("prd_versions_requirement_version_unique").on(table.requirementId, table.version),
    index("prd_versions_project_id_idx").on(table.projectId),
    index("prd_versions_requirement_id_idx").on(table.requirementId),
    index("prd_versions_status_idx").on(table.status),
    check("prd_versions_version_positive", sql`${table.version} > 0`),
    check("prd_versions_title_not_empty", sql`length(${table.title}) > 0`),
    check("prd_versions_budget_usd_nonnegative", sql`${table.budgetUsd} is null or ${table.budgetUsd} >= 0`)
  ]
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: agentRole("role").notNull(),
    status: agentStatus("status").notNull().default("idle"),
    currentWorkItemId: text("current_work_item_id"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default(emptyJsonArray),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("agents_project_id_idx").on(table.projectId),
    index("agents_role_idx").on(table.role),
    index("agents_status_idx").on(table.status),
    check("agents_name_not_empty", sql`length(${table.name}) > 0`)
  ]
);

export const workItems = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: workItemStatus("status").notNull().default("proposed"),
    role: agentRole("role").notNull(),
    scope: text("scope").notNull(),
    nonGoals: jsonb("non_goals").$type<string[]>().notNull().default(emptyJsonArray),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default(emptyJsonArray),
    testSuggestions: jsonb("test_suggestions").$type<string[]>().notNull().default(emptyJsonArray),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default(emptyJsonArray),
    requiredCapabilities: jsonb("required_capabilities").$type<string[]>().notNull().default(emptyJsonArray),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 2 }),
    concurrencyKey: text("concurrency_key"),
    maxConcurrent: integer("max_concurrent"),
    assignedAgentId: text("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    sourceDefectId: text("source_defect_id"),
    externalIssueLinks: jsonb("external_issue_links").$type<unknown[]>().notNull().default(emptyJsonArray),
    externalIssueSyncEvidence: jsonb("external_issue_sync_evidence").$type<unknown[]>().notNull().default(emptyJsonArray),
    externalBlocker: jsonb("external_blocker").$type<unknown>(),
    reworkCount: integer("rework_count").notNull().default(0),
    lastRejectionReason: text("last_rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("work_items_project_id_idx").on(table.projectId),
    index("work_items_requirement_id_idx").on(table.requirementId),
    index("work_items_prd_version_id_idx").on(table.prdVersionId),
    index("work_items_assigned_agent_id_idx").on(table.assignedAgentId),
    index("work_items_status_idx").on(table.status),
    index("work_items_status_lease_expires_at_idx").on(table.status, table.leaseExpiresAt),
    uniqueIndex("work_items_active_claim_token_unique")
      .on(table.claimToken)
      .where(sql`${table.claimToken} is not null and ${table.status} in ('claimed', 'running')`),
    uniqueIndex("work_items_active_agent_claim_unique")
      .on(table.assignedAgentId)
      .where(sql`${table.assignedAgentId} is not null and ${table.status} in ('claimed', 'running')`),
    check("work_items_title_not_empty", sql`length(${table.title}) > 0`),
    check("work_items_scope_not_empty", sql`length(${table.scope}) > 0`),
    check("work_items_budget_usd_nonnegative", sql`${table.budgetUsd} is null or ${table.budgetUsd} >= 0`),
    check("work_items_max_concurrent_positive", sql`${table.maxConcurrent} is null or ${table.maxConcurrent} > 0`),
    check("work_items_version_positive", sql`${table.version} > 0`),
    check("work_items_rework_count_nonnegative", sql`${table.reworkCount} >= 0`),
    check("work_items_claim_token_not_empty", sql`${table.claimToken} is null or length(${table.claimToken}) > 0`),
    check(
      "work_items_claim_fields_consistent",
      sql`(
        ${table.status} in ('claimed', 'running')
        and ${table.claimToken} is not null
        and ${table.claimedAt} is not null
        and ${table.leaseExpiresAt} is not null
      ) or (
        ${table.status} not in ('claimed', 'running')
        and ${table.claimToken} is null
        and ${table.claimedAt} is null
        and ${table.leaseExpiresAt} is null
      )`
    ),
    check(
      "work_items_claim_lease_after_claimed",
      sql`${table.leaseExpiresAt} is null or ${table.claimedAt} is null or ${table.leaseExpiresAt} > ${table.claimedAt}`
    ),
    check(
      "work_items_heartbeat_after_claimed",
      sql`${table.heartbeatAt} is null or ${table.claimedAt} is null or ${table.heartbeatAt} >= ${table.claimedAt}`
    )
  ]
);

export const interfaceContracts = pgTable(
  "interface_contracts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: interfaceContractKind("kind").notNull(),
    status: interfaceContractStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    summary: text("summary").notNull(),
    providerRole: agentRole("provider_role").notNull(),
    consumerRoles: jsonb("consumer_roles").$type<string[]>().notNull().default(emptyJsonArray),
    specMarkdown: text("spec_markdown").notNull(),
    specJson: jsonb("spec_json").$type<unknown>().notNull().default(emptyJsonObject),
    testSuggestions: jsonb("test_suggestions").$type<string[]>().notNull().default(emptyJsonArray),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("interface_contracts_prd_name_version_unique").on(table.prdVersionId, table.name, table.version),
    index("interface_contracts_project_id_idx").on(table.projectId),
    index("interface_contracts_requirement_id_idx").on(table.requirementId),
    index("interface_contracts_kind_idx").on(table.kind),
    index("interface_contracts_status_idx").on(table.status),
    check("interface_contracts_name_not_empty", sql`length(${table.name}) > 0`),
    check("interface_contracts_version_positive", sql`${table.version} > 0`)
  ]
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runner: agentRunnerKind("runner").notNull(),
    status: agentRunStatus("status").notNull().default("queued"),
    currentStep: timelineStepKey("current_step").notNull().default("understanding"),
    timeline: jsonb("timeline").$type<unknown[]>().notNull().default(emptyJsonArray),
    events: jsonb("events").$type<unknown[]>().notNull().default(emptyJsonArray),
    result: jsonb("result").$type<unknown>(),
    failureType: failureType("failure_type"),
    failureSummary: text("failure_summary"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 2 }),
    budgetSoftThresholdUsd: numeric("budget_soft_threshold_usd", { precision: 12, scale: 2 }),
    budgetApprovalId: text("budget_approval_id"),
    costEstimateUsd: numeric("cost_estimate_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    costActualUsd: numeric("cost_actual_usd", { precision: 12, scale: 4 }),
    artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default(emptyJsonArray),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("agent_runs_project_id_idx").on(table.projectId),
    index("agent_runs_requirement_id_idx").on(table.requirementId),
    index("agent_runs_prd_version_id_idx").on(table.prdVersionId),
    index("agent_runs_work_item_id_idx").on(table.workItemId),
    index("agent_runs_work_item_status_idx").on(table.workItemId, table.status),
    index("agent_runs_agent_id_idx").on(table.agentId),
    index("agent_runs_status_idx").on(table.status),
    uniqueIndex("agent_runs_active_work_item_unique")
      .on(table.workItemId)
      .where(sql`${table.status} in ('queued', 'running', 'needs_approval')`),
    check("agent_runs_budget_usd_nonnegative", sql`${table.budgetUsd} is null or ${table.budgetUsd} >= 0`),
    check(
      "agent_runs_budget_soft_threshold_usd_nonnegative",
      sql`${table.budgetSoftThresholdUsd} is null or ${table.budgetSoftThresholdUsd} >= 0`
    ),
    check("agent_runs_cost_estimate_usd_nonnegative", sql`${table.costEstimateUsd} >= 0`),
    check("agent_runs_cost_actual_usd_nonnegative", sql`${table.costActualUsd} is null or ${table.costActualUsd} >= 0`),
    check("agent_runs_time_order", sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`)
  ]
);

export const workspaceRuns = pgTable(
  "workspace_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    agentRunId: text("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    runner: agentRunnerKind("runner").notNull(),
    status: workspaceRunStatus("status").notNull().default("preparing"),
    isolation: workspaceIsolation("isolation").notNull(),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("workspace_runs_agent_run_unique").on(table.agentRunId),
    index("workspace_runs_project_id_idx").on(table.projectId),
    index("workspace_runs_work_item_id_idx").on(table.workItemId),
    index("workspace_runs_status_idx").on(table.status),
    check("workspace_runs_path_not_empty", sql`length(${table.path}) > 0`)
  ]
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: pullRequestProvider("provider").notNull().default("local"),
    status: pullRequestStatus("status").notNull().default("draft"),
    title: text("title").notNull(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    agentRunId: text("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    branchName: text("branch_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    baseCommit: text("base_commit"),
    headCommit: text("head_commit"),
    url: text("url").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    reviewerSummary: text("reviewer_summary").notNull(),
    testSummary: text("test_summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("pull_requests_provider_url_unique").on(table.provider, table.url),
    uniqueIndex("pull_requests_agent_run_id_unique").on(table.agentRunId),
    index("pull_requests_project_id_idx").on(table.projectId),
    index("pull_requests_work_item_id_idx").on(table.workItemId),
    index("pull_requests_agent_run_id_idx").on(table.agentRunId),
    index("pull_requests_status_idx").on(table.status),
    check("pull_requests_title_not_empty", sql`length(${table.title}) > 0`),
    check("pull_requests_branch_name_not_empty", sql`length(${table.branchName}) > 0`),
    check("pull_requests_base_branch_not_empty", sql`length(${table.baseBranch}) > 0`),
    check("pull_requests_url_not_empty", sql`length(${table.url}) > 0`)
  ]
);

export const reviewRecords = pgTable(
  "review_records",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: reviewStatus("status").notNull(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    agentRunId: text("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    linkedPullRequestId: text("linked_pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    reviewerAgentId: text("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    testSummary: text("test_summary").notNull(),
    riskLevel: text("risk_level").notNull(),
    findings: jsonb("findings").$type<string[]>().notNull().default(emptyJsonArray),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("review_records_agent_run_id_unique").on(table.agentRunId),
    index("review_records_project_id_idx").on(table.projectId),
    index("review_records_prd_version_id_idx").on(table.prdVersionId),
    index("review_records_work_item_id_idx").on(table.workItemId),
    index("review_records_linked_pull_request_id_idx").on(table.linkedPullRequestId),
    index("review_records_status_idx").on(table.status),
    check("review_records_summary_not_empty", sql`length(${table.summary}) > 0`),
    check("review_records_test_summary_not_empty", sql`length(${table.testSummary}) > 0`),
    check("review_records_risk_level_valid", sql`${table.riskLevel} in ('low', 'medium', 'high')`)
  ]
);

export const acceptanceDecisions = pgTable(
  "acceptance_decisions",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: acceptanceStatus("status").notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("acceptance_decisions_project_id_idx").on(table.projectId),
    index("acceptance_decisions_status_idx").on(table.status),
    index("acceptance_decisions_decided_at_idx").on(table.decidedAt)
  ]
);

export const testCases = pgTable(
  "test_cases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    sourceDefectId: text("source_defect_id"),
    title: text("title").notNull(),
    kind: testCaseKind("kind").notNull(),
    status: testCaseStatus("status").notNull().default("draft"),
    priority: testCasePriority("priority").notNull().default("medium"),
    steps: jsonb("steps").$type<string[]>().notNull().default(emptyJsonArray),
    expectedResult: text("expected_result").notNull(),
    linkedAcceptanceCriteria: jsonb("linked_acceptance_criteria").$type<string[]>().notNull().default(emptyJsonArray),
    lastRunId: text("last_run_id"),
    lastTestRunId: text("last_test_run_id"),
    flaky: boolean("flaky").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("test_cases_project_id_idx").on(table.projectId),
    index("test_cases_requirement_id_idx").on(table.requirementId),
    index("test_cases_prd_version_id_idx").on(table.prdVersionId),
    index("test_cases_work_item_id_idx").on(table.workItemId),
    index("test_cases_status_idx").on(table.status),
    check("test_cases_title_not_empty", sql`length(${table.title}) > 0`),
    check("test_cases_expected_result_not_empty", sql`length(${table.expectedResult}) > 0`)
  ]
);

export const testRuns = pgTable(
  "test_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id").references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id").references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id").references(() => workItems.id, { onDelete: "cascade" }),
    testCaseId: text("test_case_id").references(() => testCases.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    pullRequestId: text("pull_request_id").references(() => pullRequests.id, { onDelete: "set null" }),
    status: testRunStatus("status").notNull().default("queued"),
    command: text("command").notNull(),
    summary: text("summary").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    commit: text("commit"),
    branch: text("branch"),
    workspacePath: text("workspace_path"),
    runner: text("runner"),
    environmentImage: text("environment_image"),
    exitCode: integer("exit_code"),
    failureSummary: text("failure_summary"),
    logArtifactId: text("log_artifact_id"),
    artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default(emptyJsonArray),
    retryCount: integer("retry_count").notNull().default(0),
    attempt: integer("attempt"),
    maxAttempts: integer("max_attempts"),
    flakySignal: boolean("flaky_signal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("test_runs_project_id_idx").on(table.projectId),
    index("test_runs_work_item_id_created_at_idx").on(table.workItemId, table.createdAt),
    index("test_runs_test_case_id_idx").on(table.testCaseId),
    index("test_runs_agent_run_id_idx").on(table.agentRunId),
    index("test_runs_pull_request_id_idx").on(table.pullRequestId),
    index("test_runs_status_idx").on(table.status),
    check("test_runs_command_not_empty", sql`length(${table.command}) > 0`),
    check("test_runs_duration_ms_nonnegative", sql`${table.durationMs} >= 0`),
    check("test_runs_retry_count_nonnegative", sql`${table.retryCount} >= 0`),
    check("test_runs_attempt_positive", sql`${table.attempt} is null or ${table.attempt} > 0`),
    check("test_runs_max_attempts_positive", sql`${table.maxAttempts} is null or ${table.maxAttempts} > 0`),
    check("test_runs_time_order", sql`${table.endedAt} is null or ${table.startedAt} is null or ${table.endedAt} >= ${table.startedAt}`)
  ]
);

export const defects = pgTable(
  "defects",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    prdVersionId: text("prd_version_id")
      .notNull()
      .references(() => prdVersions.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    sourceAgentRunId: text("source_agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    sourceTestRunId: text("source_test_run_id").references(() => testRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    reproductionSteps: text("reproduction_steps").notNull(),
    expectedBehavior: text("expected_behavior").notNull(),
    actualBehavior: text("actual_behavior").notNull(),
    severity: defectSeverity("severity").notNull().default("medium"),
    status: defectStatus("status").notNull().default("reported"),
    reporter: text("reporter").notNull(),
    artifactReferences: jsonb("artifact_references").$type<unknown[]>().notNull().default(emptyJsonArray),
    externalIssueLinks: jsonb("external_issue_links").$type<unknown[]>().notNull().default(emptyJsonArray),
    externalIssueSyncEvidence: jsonb("external_issue_sync_evidence").$type<unknown[]>().notNull().default(emptyJsonArray),
    externalBlocker: jsonb("external_blocker").$type<unknown>(),
    sourceFailureType: failureType("source_failure_type"),
    sourceCommit: text("source_commit"),
    sourceBranch: text("source_branch"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("defects_project_id_idx").on(table.projectId),
    index("defects_requirement_id_idx").on(table.requirementId),
    index("defects_work_item_id_idx").on(table.workItemId),
    index("defects_source_agent_run_id_idx").on(table.sourceAgentRunId),
    index("defects_source_test_run_id_idx").on(table.sourceTestRunId),
    index("defects_status_idx").on(table.status),
    index("defects_severity_idx").on(table.severity),
    check("defects_title_not_empty", sql`length(${table.title}) > 0`),
    check("defects_reporter_not_empty", sql`length(${table.reporter}) > 0`)
  ]
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: approvalKind("kind").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    targetType: approvalTargetType("target_type").notNull(),
    targetId: text("target_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedReason: text("requested_reason").notNull(),
    riskLevel: approvalRiskLevel("risk_level").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedBy: text("approved_by"),
    deniedBy: text("denied_by"),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    requirementId: text("requirement_id").references(() => requirements.id, { onDelete: "set null" }),
    prdVersionId: text("prd_version_id").references(() => prdVersions.id, { onDelete: "set null" }),
    workItemId: text("work_item_id").references(() => workItems.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("approvals_project_id_idx").on(table.projectId),
    index("approvals_status_idx").on(table.status),
    index("approvals_kind_idx").on(table.kind),
    index("approvals_target_idx").on(table.targetType, table.targetId),
    index("approvals_expires_at_idx").on(table.expiresAt),
    check("approvals_target_id_not_empty", sql`length(${table.targetId}) > 0`),
    check("approvals_requested_by_not_empty", sql`length(${table.requestedBy}) > 0`),
    check("approvals_requested_reason_not_empty", sql`length(${table.requestedReason}) > 0`)
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    traceId: text("trace_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorDisplay: text("actor_display"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    message: text("message").notNull(),
    beforeJson: jsonb("before_json").$type<unknown>(),
    afterJson: jsonb("after_json").$type<unknown>(),
    metadataJson: jsonb("metadata_json").$type<unknown>(),
    hash: text("hash").notNull(),
    previousHash: text("previous_hash"),
    requirementId: text("requirement_id").references(() => requirements.id, { onDelete: "set null" }),
    prdVersionId: text("prd_version_id").references(() => prdVersions.id, { onDelete: "set null" }),
    workItemId: text("work_item_id").references(() => workItems.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("audit_events_hash_unique").on(table.hash),
    index("audit_events_project_id_idx").on(table.projectId),
    index("audit_events_trace_id_idx").on(table.traceId),
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_trace_id_created_at_idx").on(table.traceId, table.createdAt),
    index("audit_events_target_idx").on(table.targetType, table.targetId),
    index("audit_events_agent_run_id_idx").on(table.agentRunId),
    check("audit_events_trace_id_not_empty", sql`length(${table.traceId}) > 0`),
    check("audit_events_actor_type_not_empty", sql`length(${table.actorType}) > 0`),
    check("audit_events_actor_id_not_empty", sql`length(${table.actorId}) > 0`),
    check("audit_events_action_not_empty", sql`length(${table.action}) > 0`),
    check("audit_events_target_type_not_empty", sql`length(${table.targetType}) > 0`),
    check("audit_events_target_id_not_empty", sql`length(${table.targetId}) > 0`),
    check("audit_events_hash_not_empty", sql`length(${table.hash}) > 0`)
  ]
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: artifactKind("kind").notNull(),
    storage: artifactStorageProvider("storage").notNull(),
    uri: text("uri").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default(emptyJsonObject),
    requirementId: text("requirement_id").references(() => requirements.id, { onDelete: "set null" }),
    prdVersionId: text("prd_version_id").references(() => prdVersions.id, { onDelete: "set null" }),
    workItemId: text("work_item_id").references(() => workItems.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    testRunId: text("test_run_id").references(() => testRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("artifacts_project_id_idx").on(table.projectId),
    index("artifacts_kind_idx").on(table.kind),
    index("artifacts_requirement_id_idx").on(table.requirementId),
    index("artifacts_work_item_id_idx").on(table.workItemId),
    index("artifacts_agent_run_id_idx").on(table.agentRunId),
    index("artifacts_test_run_id_idx").on(table.testRunId),
    index("artifacts_checksum_sha256_idx").on(table.checksumSha256),
    check("artifacts_uri_not_empty", sql`length(${table.uri}) > 0`),
    check("artifacts_content_type_not_empty", sql`length(${table.contentType}) > 0`),
    check("artifacts_size_bytes_nonnegative", sql`${table.sizeBytes} >= 0`),
    check("artifacts_checksum_sha256_not_empty", sql`length(${table.checksumSha256}) > 0`)
  ]
);

export const capabilityManifests = pgTable(
  "capability_manifests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: capabilityManifestStatus("status").notNull().default("draft"),
    manifestJson: jsonb("manifest_json").$type<unknown>().notNull(),
    allowedPaths: jsonb("allowed_paths").$type<string[]>().notNull().default(emptyJsonArray),
    deniedPaths: jsonb("denied_paths").$type<string[]>().notNull().default(emptyJsonArray),
    allowedCommands: jsonb("allowed_commands").$type<string[]>().notNull().default(emptyJsonArray),
    deniedCommands: jsonb("denied_commands").$type<string[]>().notNull().default(emptyJsonArray),
    allowedNetwork: jsonb("allowed_network").$type<string[]>().notNull().default(emptyJsonArray),
    secretRefs: jsonb("secret_refs").$type<string[]>().notNull().default(emptyJsonArray),
    maxCostUsd: numeric("max_cost_usd", { precision: 12, scale: 2 }),
    maxRuntimeMs: integer("max_runtime_ms"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("capability_manifests_project_id_idx").on(table.projectId),
    index("capability_manifests_agent_run_id_idx").on(table.agentRunId),
    index("capability_manifests_status_idx").on(table.status),
    check("capability_manifests_version_positive", sql`${table.version} > 0`),
    check("capability_manifests_max_cost_usd_nonnegative", sql`${table.maxCostUsd} is null or ${table.maxCostUsd} >= 0`),
    check("capability_manifests_max_runtime_ms_positive", sql`${table.maxRuntimeMs} is null or ${table.maxRuntimeMs} > 0`),
    check("capability_manifests_created_by_not_empty", sql`length(${table.createdBy}) > 0`)
  ]
);

export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scopeType: budgetScopeType("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    limitUsd: numeric("limit_usd", { precision: 12, scale: 2 }).notNull(),
    softThresholdUsd: numeric("soft_threshold_usd", { precision: 12, scale: 2 }),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    status: budgetStatus("status").notNull().default("active"),
    approvalId: text("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("budgets_scope_unique").on(table.scopeType, table.scopeId),
    index("budgets_project_id_idx").on(table.projectId),
    index("budgets_status_idx").on(table.status),
    check("budgets_scope_id_not_empty", sql`length(${table.scopeId}) > 0`),
    check("budgets_limit_usd_nonnegative", sql`${table.limitUsd} >= 0`),
    check("budgets_soft_threshold_usd_nonnegative", sql`${table.softThresholdUsd} is null or ${table.softThresholdUsd} >= 0`),
    check("budgets_spent_usd_nonnegative", sql`${table.spentUsd} >= 0`),
    check("budgets_currency_not_empty", sql`length(${table.currency}) > 0`),
    check("budgets_created_by_not_empty", sql`length(${table.createdBy}) > 0`)
  ]
);
