CREATE TYPE "public"."release_gate_operation" AS ENUM('release', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."release_gate_status" AS ENUM('approval_pending', 'manual_action_required', 'denied', 'expired');--> statement-breakpoint
ALTER TYPE "public"."approval_target_type" ADD VALUE 'release_gate';--> statement-breakpoint
CREATE TABLE "release_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"operation" "release_gate_operation" NOT NULL,
	"status" "release_gate_status" DEFAULT 'approval_pending' NOT NULL,
	"target_environment" text NOT NULL,
	"approval_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_reason" text NOT NULL,
	"risk_level" "approval_risk_level" NOT NULL,
	"gate_passed" boolean DEFAULT false NOT NULL,
	"blocking_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manual_action" text NOT NULL,
	"requirement_id" text,
	"prd_version_id" text,
	"work_item_id" text,
	"agent_run_id" text,
	"repository_id" text,
	"repository_full_name" text,
	"pull_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_gates_target_environment_not_empty" CHECK (length("release_gates"."target_environment") > 0),
	CONSTRAINT "release_gates_requested_by_not_empty" CHECK (length("release_gates"."requested_by") > 0),
	CONSTRAINT "release_gates_requested_reason_not_empty" CHECK (length("release_gates"."requested_reason") > 0),
	CONSTRAINT "release_gates_manual_action_not_empty" CHECK (length("release_gates"."manual_action") > 0)
);
--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_gates" ADD CONSTRAINT "release_gates_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_gates_approval_id_unique" ON "release_gates" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "release_gates_project_id_idx" ON "release_gates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "release_gates_operation_status_idx" ON "release_gates" USING btree ("operation","status");--> statement-breakpoint
CREATE INDEX "release_gates_prd_version_id_idx" ON "release_gates" USING btree ("prd_version_id");--> statement-breakpoint
CREATE INDEX "release_gates_repository_id_idx" ON "release_gates" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "release_gates_pull_request_id_idx" ON "release_gates" USING btree ("pull_request_id");