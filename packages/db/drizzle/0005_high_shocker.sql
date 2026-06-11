CREATE TABLE "github_app_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text,
	"repository_selection" text DEFAULT 'selected' NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_repository_id" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_installations_installation_id_not_empty" CHECK (length("github_app_installations"."installation_id") > 0),
	CONSTRAINT "github_app_installations_account_login_not_empty" CHECK (length("github_app_installations"."account_login") > 0),
	CONSTRAINT "github_app_installations_repository_selection_valid" CHECK ("github_app_installations"."repository_selection" in ('all', 'selected'))
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "html_url" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "github_installation_id" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "github_repository_id" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "selected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_installations_project_installation_unique" ON "github_app_installations" USING btree ("project_id","installation_id");--> statement-breakpoint
CREATE INDEX "github_app_installations_project_id_idx" ON "github_app_installations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "repositories_github_installation_id_idx" ON "repositories" USING btree ("github_installation_id");--> statement-breakpoint
CREATE INDEX "repositories_selected_idx" ON "repositories" USING btree ("project_id","selected");