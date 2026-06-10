CREATE TYPE "public"."acceptance_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('approved', 'changes_requested', 'blocked');--> statement-breakpoint
CREATE TABLE "acceptance_decisions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" "acceptance_status" NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_records" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" "review_status" NOT NULL,
	"requirement_id" text NOT NULL,
	"prd_version_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"linked_pull_request_id" text NOT NULL,
	"reviewer_agent_id" text,
	"summary" text NOT NULL,
	"test_summary" text NOT NULL,
	"risk_level" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_records_summary_not_empty" CHECK (length("review_records"."summary") > 0),
	CONSTRAINT "review_records_test_summary_not_empty" CHECK (length("review_records"."test_summary") > 0),
	CONSTRAINT "review_records_risk_level_valid" CHECK ("review_records"."risk_level" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
DROP INDEX "pull_requests_work_item_id_unique";--> statement-breakpoint
ALTER TABLE "acceptance_decisions" ADD CONSTRAINT "acceptance_decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_decisions" ADD CONSTRAINT "acceptance_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_prd_version_id_prd_versions_id_fk" FOREIGN KEY ("prd_version_id") REFERENCES "public"."prd_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_linked_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("linked_pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_decisions_project_id_idx" ON "acceptance_decisions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "acceptance_decisions_status_idx" ON "acceptance_decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acceptance_decisions_decided_at_idx" ON "acceptance_decisions" USING btree ("decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_records_agent_run_id_unique" ON "review_records" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "review_records_project_id_idx" ON "review_records" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "review_records_prd_version_id_idx" ON "review_records" USING btree ("prd_version_id");--> statement-breakpoint
CREATE INDEX "review_records_work_item_id_idx" ON "review_records" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "review_records_linked_pull_request_id_idx" ON "review_records" USING btree ("linked_pull_request_id");--> statement-breakpoint
CREATE INDEX "review_records_status_idx" ON "review_records" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_agent_run_id_unique" ON "pull_requests" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "pull_requests_work_item_id_idx" ON "pull_requests" USING btree ("work_item_id");