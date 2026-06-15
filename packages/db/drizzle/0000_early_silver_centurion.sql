CREATE TYPE "public"."agent_role" AS ENUM('product', 'frontend', 'backend', 'test', 'ops', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'needs_approval', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_runner_kind" AS ENUM('codex');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('idle', 'busy', 'offline');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('prd_approval', 'budget_exceeded', 'dangerous_operation', 'breaking_contract', 'network_allowlist_change', 'secret_grant', 'production_data_access');--> statement-breakpoint
CREATE TYPE "public"."approval_risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."approval_target_type" AS ENUM('prd', 'work_item', 'agent_run', 'interface_contract', 'budget', 'policy', 'secret', 'network', 'repository');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('log', 'trace', 'diff', 'test_report', 'screenshot', 'preview_metadata', 'intake_attachment');--> statement-breakpoint
CREATE TYPE "public"."artifact_storage_provider" AS ENUM('local_fs', 's3');--> statement-breakpoint
CREATE TYPE "public"."budget_scope_type" AS ENUM('project', 'requirement', 'prd', 'work_item', 'agent_run');--> statement-breakpoint
CREATE TYPE "public"."budget_status" AS ENUM('active', 'exhausted', 'paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."capability_manifest_status" AS ENUM('draft', 'active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."defect_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."defect_status" AS ENUM('reported', 'needs_repro', 'reproduced', 'unreproducible', 'fixing', 'verifying', 'closed');--> statement-breakpoint
CREATE TYPE "public"."failure_type" AS ENUM('transient', 'deterministic', 'test_failed', 'policy_denied', 'budget_exhausted', 'environment_failed');--> statement-breakpoint
CREATE TYPE "public"."interface_contract_kind" AS ENUM('http', 'event', 'schema');--> statement-breakpoint
CREATE TYPE "public"."interface_contract_status" AS ENUM('draft', 'approved', 'breaking_change_pending', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."prd_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."pull_request_provider" AS ENUM('local', 'github');--> statement-breakpoint
CREATE TYPE "public"."pull_request_status" AS ENUM('draft', 'ready_for_review', 'changes_requested', 'approved', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "public"."requirement_input_type" AS ENUM('feature', 'bug', 'ui', 'document');--> statement-breakpoint
CREATE TYPE "public"."requirement_status" AS ENUM('submitted', 'clarifying', 'prd_draft', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."test_case_kind" AS ENUM('acceptance', 'regression', 'contract', 'smoke');--> statement-breakpoint
CREATE TYPE "public"."test_case_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."test_case_status" AS ENUM('draft', 'ready', 'passed', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."test_run_status" AS ENUM('queued', 'running', 'passed', 'failed', 'blocked', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."timeline_step_key" AS ENUM('understanding', 'planning', 'developing', 'testing', 'confirming');--> statement-breakpoint
CREATE TYPE "public"."work_item_status" AS ENUM('proposed', 'ready', 'claimed', 'running', 'review', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workspace_isolation" AS ENUM('git_worktree');--> statement-breakpoint
CREATE TYPE "public"."workspace_run_status" AS ENUM('preparing', 'ready', 'active', 'archived', 'failed', 'destroyed');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"agent_id" text,
	"runner" "agent_runner_kind" NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"current_step" timeline_step_key DEFAULT 'understanding' NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"failure_type" "failure_type",
	"failure_summary" text,
	"budget_usd" numeric(12, 2),
	"budget_soft_threshold_usd" numeric(12, 2),
	"budget_approval_id" text,
	"cost_estimate_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"cost_actual_usd" numeric(12, 4),
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_budget_usd_nonnegative" CHECK ("agent_runs"."budget_usd" is null or "agent_runs"."budget_usd" >= 0),
	CONSTRAINT "agent_runs_budget_soft_threshold_usd_nonnegative" CHECK ("agent_runs"."budget_soft_threshold_usd" is null or "agent_runs"."budget_soft_threshold_usd" >= 0),
	CONSTRAINT "agent_runs_cost_estimate_usd_nonnegative" CHECK ("agent_runs"."cost_estimate_usd" >= 0),
	CONSTRAINT "agent_runs_cost_actual_usd_nonnegative" CHECK ("agent_runs"."cost_actual_usd" is null or "agent_runs"."cost_actual_usd" >= 0),
	CONSTRAINT "agent_runs_time_order" CHECK ("agent_runs"."ended_at" is null or "agent_runs"."ended_at" >= "agent_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"role" "agent_role" NOT NULL,
	"status" "agent_status" DEFAULT 'idle' NOT NULL,
	"current_work_item_id" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_not_empty" CHECK (length("agents"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"target_type" "approval_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_reason" text NOT NULL,
	"risk_level" "approval_risk_level" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by" text,
	"denied_by" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"requirement_id" text,
	"prd_version_id" text,
	"work_item_id" text,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_target_id_not_empty" CHECK (length("approvals"."target_id") > 0),
	CONSTRAINT "approvals_requested_by_not_empty" CHECK (length("approvals"."requested_by") > 0),
	CONSTRAINT "approvals_requested_reason_not_empty" CHECK (length("approvals"."requested_reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"storage" "artifact_storage_provider" NOT NULL,
	"uri" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requirement_id" text,
	"prd_version_id" text,
	"work_item_id" text,
	"agent_run_id" text,
	"test_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_uri_not_empty" CHECK (length("artifacts"."uri") > 0),
	CONSTRAINT "artifacts_content_type_not_empty" CHECK (length("artifacts"."content_type") > 0),
	CONSTRAINT "artifacts_size_bytes_nonnegative" CHECK ("artifacts"."size_bytes" >= 0),
	CONSTRAINT "artifacts_checksum_sha256_not_empty" CHECK (length("artifacts"."checksum_sha256") > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_display" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"message" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"metadata_json" jsonb,
	"hash" text NOT NULL,
	"previous_hash" text,
	"requirement_id" text,
	"prd_version_id" text,
	"work_item_id" text,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_trace_id_not_empty" CHECK (length("audit_events"."trace_id") > 0),
	CONSTRAINT "audit_events_actor_type_not_empty" CHECK (length("audit_events"."actor_type") > 0),
	CONSTRAINT "audit_events_actor_id_not_empty" CHECK (length("audit_events"."actor_id") > 0),
	CONSTRAINT "audit_events_action_not_empty" CHECK (length("audit_events"."action") > 0),
	CONSTRAINT "audit_events_target_type_not_empty" CHECK (length("audit_events"."target_type") > 0),
	CONSTRAINT "audit_events_target_id_not_empty" CHECK (length("audit_events"."target_id") > 0),
	CONSTRAINT "audit_events_hash_not_empty" CHECK (length("audit_events"."hash") > 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scope_type" "budget_scope_type" NOT NULL,
	"scope_id" text NOT NULL,
	"limit_usd" numeric(12, 2) NOT NULL,
	"soft_threshold_usd" numeric(12, 2),
	"spent_usd" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "budget_status" DEFAULT 'active' NOT NULL,
	"approval_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scope_id_not_empty" CHECK (length("budgets"."scope_id") > 0),
	CONSTRAINT "budgets_limit_usd_nonnegative" CHECK ("budgets"."limit_usd" >= 0),
	CONSTRAINT "budgets_soft_threshold_usd_nonnegative" CHECK ("budgets"."soft_threshold_usd" is null or "budgets"."soft_threshold_usd" >= 0),
	CONSTRAINT "budgets_spent_usd_nonnegative" CHECK ("budgets"."spent_usd" >= 0),
	CONSTRAINT "budgets_currency_not_empty" CHECK (length("budgets"."currency") > 0),
	CONSTRAINT "budgets_created_by_not_empty" CHECK (length("budgets"."created_by") > 0)
);
--> statement-breakpoint
CREATE TABLE "capability_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"agent_run_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "capability_manifest_status" DEFAULT 'draft' NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"allowed_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_network" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_cost_usd" numeric(12, 2),
	"max_runtime_ms" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_manifests_version_positive" CHECK ("capability_manifests"."version" > 0),
	CONSTRAINT "capability_manifests_max_cost_usd_nonnegative" CHECK ("capability_manifests"."max_cost_usd" is null or "capability_manifests"."max_cost_usd" >= 0),
	CONSTRAINT "capability_manifests_max_runtime_ms_positive" CHECK ("capability_manifests"."max_runtime_ms" is null or "capability_manifests"."max_runtime_ms" > 0),
	CONSTRAINT "capability_manifests_created_by_not_empty" CHECK (length("capability_manifests"."created_by") > 0)
);
--> statement-breakpoint
CREATE TABLE "defects" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"source_agent_run_id" text,
	"source_test_run_id" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"reproduction_steps" text NOT NULL,
	"expected_behavior" text NOT NULL,
	"actual_behavior" text NOT NULL,
	"severity" "defect_severity" DEFAULT 'medium' NOT NULL,
	"status" "defect_status" DEFAULT 'reported' NOT NULL,
	"reporter" text NOT NULL,
	"artifact_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_failure_type" "failure_type",
	"source_commit" text,
	"source_branch" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "defects_title_not_empty" CHECK (length("defects"."title") > 0),
	CONSTRAINT "defects_reporter_not_empty" CHECK (length("defects"."reporter") > 0)
);
--> statement-breakpoint
CREATE TABLE "interface_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "interface_contract_kind" NOT NULL,
	"status" "interface_contract_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"summary" text NOT NULL,
	"provider_role" "agent_role" NOT NULL,
	"consumer_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spec_markdown" text NOT NULL,
	"spec_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interface_contracts_name_not_empty" CHECK (length("interface_contracts"."name") > 0),
	CONSTRAINT "interface_contracts_version_positive" CHECK ("interface_contracts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_not_empty" CHECK (length("organizations"."slug") > 0),
	CONSTRAINT "organizations_name_not_empty" CHECK (length("organizations"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE "prd_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "prd_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_usd" numeric(12, 2),
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prd_versions_version_positive" CHECK ("prd_versions"."version" > 0),
	CONSTRAINT "prd_versions_title_not_empty" CHECK (length("prd_versions"."title") > 0),
	CONSTRAINT "prd_versions_budget_usd_nonnegative" CHECK ("prd_versions"."budget_usd" is null or "prd_versions"."budget_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_not_empty" CHECK (length("projects"."slug") > 0),
	CONSTRAINT "projects_name_not_empty" CHECK (length("projects"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider" "pull_request_provider" DEFAULT 'local' NOT NULL,
	"status" "pull_request_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"branch_name" text NOT NULL,
	"base_branch" text NOT NULL,
	"base_commit" text,
	"head_commit" text,
	"url" text NOT NULL,
	"body_markdown" text NOT NULL,
	"reviewer_summary" text NOT NULL,
	"test_summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_title_not_empty" CHECK (length("pull_requests"."title") > 0),
	CONSTRAINT "pull_requests_branch_name_not_empty" CHECK (length("pull_requests"."branch_name") > 0),
	CONSTRAINT "pull_requests_base_branch_not_empty" CHECK (length("pull_requests"."base_branch") > 0),
	CONSTRAINT "pull_requests_url_not_empty" CHECK (length("pull_requests"."url") > 0)
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider" text DEFAULT 'git' NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"remote_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_provider_not_empty" CHECK (length("repositories"."provider") > 0),
	CONSTRAINT "repositories_owner_not_empty" CHECK (length("repositories"."owner") > 0),
	CONSTRAINT "repositories_name_not_empty" CHECK (length("repositories"."name") > 0),
	CONSTRAINT "repositories_remote_url_not_empty" CHECK (length("repositories"."remote_url") > 0),
	CONSTRAINT "repositories_default_branch_not_empty" CHECK (length("repositories"."default_branch") > 0)
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"raw_input" text NOT NULL,
	"input_type" "requirement_input_type" NOT NULL,
	"status" "requirement_status" DEFAULT 'submitted' NOT NULL,
	"simple_summary" text NOT NULL,
	"created_by" text NOT NULL,
	"artifact_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"clarification_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"clarification_turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirements_title_not_empty" CHECK (length("requirements"."title") > 0),
	CONSTRAINT "requirements_created_by_not_empty" CHECK (length("requirements"."created_by") > 0)
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"source_defect_id" text,
	"title" text NOT NULL,
	"kind" "test_case_kind" NOT NULL,
	"status" "test_case_status" DEFAULT 'draft' NOT NULL,
	"priority" "test_case_priority" DEFAULT 'medium' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_result" text NOT NULL,
	"linked_acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_id" text,
	"last_test_run_id" text,
	"flaky" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_cases_title_not_empty" CHECK (length("test_cases"."title") > 0),
	CONSTRAINT "test_cases_expected_result_not_empty" CHECK (length("test_cases"."expected_result") > 0)
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text,
	"prd_version_id" text,
	"work_item_id" text,
	"test_case_id" text,
	"agent_run_id" text,
	"pull_request_id" text,
	"status" "test_run_status" DEFAULT 'queued' NOT NULL,
	"command" text NOT NULL,
	"summary" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"commit" text,
	"branch" text,
	"workspace_path" text,
	"runner" text,
	"environment_image" text,
	"exit_code" integer,
	"failure_summary" text,
	"log_artifact_id" text,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer,
	"max_attempts" integer,
	"flaky_signal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_runs_command_not_empty" CHECK (length("test_runs"."command") > 0),
	CONSTRAINT "test_runs_duration_ms_nonnegative" CHECK ("test_runs"."duration_ms" >= 0),
	CONSTRAINT "test_runs_retry_count_nonnegative" CHECK ("test_runs"."retry_count" >= 0),
	CONSTRAINT "test_runs_attempt_positive" CHECK ("test_runs"."attempt" is null or "test_runs"."attempt" > 0),
	CONSTRAINT "test_runs_max_attempts_positive" CHECK ("test_runs"."max_attempts" is null or "test_runs"."max_attempts" > 0),
	CONSTRAINT "test_runs_time_order" CHECK ("test_runs"."ended_at" is null or "test_runs"."started_at" is null or "test_runs"."ended_at" >= "test_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"title" text NOT NULL,
	"status" "work_item_status" DEFAULT 'proposed' NOT NULL,
	"role" "agent_role" NOT NULL,
	"scope" text NOT NULL,
	"non_goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"test_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_usd" numeric(12, 2),
	"concurrency_key" text,
	"max_concurrent" integer,
	"assigned_agent_id" text,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"source_defect_id" text,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"last_rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_title_not_empty" CHECK (length("work_items"."title") > 0),
	CONSTRAINT "work_items_scope_not_empty" CHECK (length("work_items"."scope") > 0),
	CONSTRAINT "work_items_budget_usd_nonnegative" CHECK ("work_items"."budget_usd" is null or "work_items"."budget_usd" >= 0),
	CONSTRAINT "work_items_max_concurrent_positive" CHECK ("work_items"."max_concurrent" is null or "work_items"."max_concurrent" > 0),
	CONSTRAINT "work_items_version_positive" CHECK ("work_items"."version" > 0),
	CONSTRAINT "work_items_rework_count_nonnegative" CHECK ("work_items"."rework_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"runner" "agent_runner_kind" NOT NULL,
	"status" "workspace_run_status" DEFAULT 'preparing' NOT NULL,
	"isolation" "workspace_isolation" NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "workspace_runs_path_not_empty" CHECK (length("workspace_runs"."path") > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_manifests" ADD CONSTRAINT "capability_manifests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_manifests" ADD CONSTRAINT "capability_manifests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_source_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("source_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_source_test_run_id_test_runs_id_fk" FOREIGN KEY ("source_test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_contracts" ADD CONSTRAINT "interface_contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_contracts" ADD CONSTRAINT "interface_contracts_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_contracts" ADD CONSTRAINT "interface_contracts_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_versions" ADD CONSTRAINT "prd_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_versions" ADD CONSTRAINT "prd_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_project_id_idx" ON "agent_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_runs_requirement_id_idx" ON "agent_runs" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "agent_runs_prd_version_id_idx" ON "agent_runs" USING btree ("prd_version_id");--> statement-breakpoint
CREATE INDEX "agent_runs_work_item_id_idx" ON "agent_runs" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_project_id_idx" ON "agents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agents_role_idx" ON "agents" USING btree ("role");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approvals_project_id_idx" ON "approvals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approvals_kind_idx" ON "approvals" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "approvals_target_idx" ON "approvals" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "approvals_expires_at_idx" ON "approvals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "artifacts_project_id_idx" ON "artifacts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "artifacts_kind_idx" ON "artifacts" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "artifacts_requirement_id_idx" ON "artifacts" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "artifacts_work_item_id_idx" ON "artifacts" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "artifacts_agent_run_id_idx" ON "artifacts" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "artifacts_test_run_id_idx" ON "artifacts" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "artifacts_checksum_sha256_idx" ON "artifacts" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_hash_unique" ON "audit_events" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "audit_events_project_id_idx" ON "audit_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "audit_events_trace_id_idx" ON "audit_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_agent_run_id_idx" ON "audit_events" USING btree ("agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_scope_unique" ON "budgets" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "budgets_project_id_idx" ON "budgets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "budgets_status_idx" ON "budgets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "capability_manifests_project_id_idx" ON "capability_manifests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "capability_manifests_agent_run_id_idx" ON "capability_manifests" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "capability_manifests_status_idx" ON "capability_manifests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "defects_project_id_idx" ON "defects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "defects_requirement_id_idx" ON "defects" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "defects_work_item_id_idx" ON "defects" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "defects_source_agent_run_id_idx" ON "defects" USING btree ("source_agent_run_id");--> statement-breakpoint
CREATE INDEX "defects_source_test_run_id_idx" ON "defects" USING btree ("source_test_run_id");--> statement-breakpoint
CREATE INDEX "defects_status_idx" ON "defects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "defects_severity_idx" ON "defects" USING btree ("severity");--> statement-breakpoint
CREATE UNIQUE INDEX "interface_contracts_prd_name_version_unique" ON "interface_contracts" USING btree ("prd_version_id","name","version");--> statement-breakpoint
CREATE INDEX "interface_contracts_project_id_idx" ON "interface_contracts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "interface_contracts_requirement_id_idx" ON "interface_contracts" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "interface_contracts_kind_idx" ON "interface_contracts" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "interface_contracts_status_idx" ON "interface_contracts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "prd_versions_requirement_version_unique" ON "prd_versions" USING btree ("requirement_id","version");--> statement-breakpoint
CREATE INDEX "prd_versions_project_id_idx" ON "prd_versions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "prd_versions_requirement_id_idx" ON "prd_versions" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "prd_versions_status_idx" ON "prd_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_unique" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "projects_organization_id_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_provider_url_unique" ON "pull_requests" USING btree ("provider","url");--> statement-breakpoint
CREATE INDEX "pull_requests_project_id_idx" ON "pull_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pull_requests_work_item_id_idx" ON "pull_requests" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "pull_requests_agent_run_id_idx" ON "pull_requests" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "pull_requests_status_idx" ON "pull_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_project_provider_owner_name_unique" ON "repositories" USING btree ("project_id","provider","owner","name");--> statement-breakpoint
CREATE INDEX "repositories_project_id_idx" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "requirements_project_id_idx" ON "requirements" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "requirements_status_idx" ON "requirements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "test_cases_project_id_idx" ON "test_cases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "test_cases_requirement_id_idx" ON "test_cases" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "test_cases_prd_version_id_idx" ON "test_cases" USING btree ("prd_version_id");--> statement-breakpoint
CREATE INDEX "test_cases_work_item_id_idx" ON "test_cases" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "test_cases_status_idx" ON "test_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "test_runs_project_id_idx" ON "test_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "test_runs_test_case_id_idx" ON "test_runs" USING btree ("test_case_id");--> statement-breakpoint
CREATE INDEX "test_runs_agent_run_id_idx" ON "test_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "test_runs_pull_request_id_idx" ON "test_runs" USING btree ("pull_request_id");--> statement-breakpoint
CREATE INDEX "test_runs_status_idx" ON "test_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "work_items_project_id_idx" ON "work_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "work_items_requirement_id_idx" ON "work_items" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "work_items_prd_version_id_idx" ON "work_items" USING btree ("prd_version_id");--> statement-breakpoint
CREATE INDEX "work_items_assigned_agent_id_idx" ON "work_items" USING btree ("assigned_agent_id");--> statement-breakpoint
CREATE INDEX "work_items_status_idx" ON "work_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_runs_agent_run_unique" ON "workspace_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "workspace_runs_project_id_idx" ON "workspace_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workspace_runs_work_item_id_idx" ON "workspace_runs" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "workspace_runs_status_idx" ON "workspace_runs" USING btree ("status");
