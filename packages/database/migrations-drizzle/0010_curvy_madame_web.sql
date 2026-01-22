CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_user_unique" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "document_proposals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "document_proposals" CASCADE;--> statement-breakpoint
DROP INDEX "idx_inbox_user_timestamp";--> statement-breakpoint
DROP INDEX "idx_inbox_unique_source";--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "settings" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "intelligence_service_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "entity_templates" ADD COLUMN "project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_members_project" ON "project_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user_project" ON "project_members" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_provider" ON "inbox_items" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_inbox_timestamp" ON "inbox_items" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbox_external_unique" ON "inbox_items" USING btree ("user_id","provider","external_id");--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN "file_url";--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN "file_path";--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN "file_size";--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN "file_type";--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN "checksum";