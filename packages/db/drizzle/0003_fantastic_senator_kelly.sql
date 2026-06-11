ALTER TABLE "defects" ADD COLUMN "external_issue_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "defects" ADD COLUMN "external_issue_sync_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "defects" ADD COLUMN "external_blocker" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "external_issue_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "external_issue_sync_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "external_blocker" jsonb;