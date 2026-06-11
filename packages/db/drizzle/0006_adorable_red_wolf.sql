DROP INDEX "interface_contracts_prd_name_version_unique";--> statement-breakpoint
ALTER TABLE "interface_contracts" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "interface_contracts" ADD COLUMN "repository_full_name" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "repository_full_name" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "repository_full_name" text;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "repository_full_name" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "repository_full_name" text;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD COLUMN "repository_full_name" text;--> statement-breakpoint
ALTER TABLE "interface_contracts" ADD CONSTRAINT "interface_contracts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interface_contracts_prd_repository_name_version_unique" ON "interface_contracts" USING btree ("prd_version_id","repository_id","name","version");--> statement-breakpoint
CREATE INDEX "interface_contracts_repository_id_idx" ON "interface_contracts" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "pull_requests_repository_id_idx" ON "pull_requests" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "test_cases_repository_id_idx" ON "test_cases" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "test_runs_repository_id_idx" ON "test_runs" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "work_items_repository_id_idx" ON "work_items" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "workspace_runs_repository_id_idx" ON "workspace_runs" USING btree ("repository_id");