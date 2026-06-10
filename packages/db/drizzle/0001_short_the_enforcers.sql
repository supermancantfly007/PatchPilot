DROP INDEX "pull_requests_work_item_id_idx";--> statement-breakpoint
CREATE INDEX "agent_runs_work_item_status_idx" ON "agent_runs" USING btree ("work_item_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_work_item_unique" ON "agent_runs" USING btree ("work_item_id") WHERE "agent_runs"."status" in ('queued', 'running', 'needs_approval');--> statement-breakpoint
CREATE INDEX "audit_events_trace_id_created_at_idx" ON "audit_events" USING btree ("trace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_work_item_id_unique" ON "pull_requests" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "test_runs_work_item_id_created_at_idx" ON "test_runs" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "work_items_status_lease_expires_at_idx" ON "work_items" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_active_claim_token_unique" ON "work_items" USING btree ("claim_token") WHERE "work_items"."claim_token" is not null and "work_items"."status" in ('claimed', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_active_agent_claim_unique" ON "work_items" USING btree ("assigned_agent_id") WHERE "work_items"."assigned_agent_id" is not null and "work_items"."status" in ('claimed', 'running');--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_claim_token_not_empty" CHECK ("work_items"."claim_token" is null or length("work_items"."claim_token") > 0);--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_claim_fields_consistent" CHECK ((
        "work_items"."status" in ('claimed', 'running')
        and "work_items"."claim_token" is not null
        and "work_items"."claimed_at" is not null
        and "work_items"."lease_expires_at" is not null
      ) or (
        "work_items"."status" not in ('claimed', 'running')
        and "work_items"."claim_token" is null
        and "work_items"."claimed_at" is null
        and "work_items"."lease_expires_at" is null
      ));--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_claim_lease_after_claimed" CHECK ("work_items"."lease_expires_at" is null or "work_items"."claimed_at" is null or "work_items"."lease_expires_at" > "work_items"."claimed_at");--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_heartbeat_after_claimed" CHECK ("work_items"."heartbeat_at" is null or "work_items"."claimed_at" is null or "work_items"."heartbeat_at" >= "work_items"."claimed_at");