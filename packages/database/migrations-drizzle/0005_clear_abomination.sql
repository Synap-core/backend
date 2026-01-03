CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"workspace_id" uuid,
	"permissions" jsonb DEFAULT '{}' NOT NULL,
	"filters" jsonb DEFAULT '{}',
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"public_token" text,
	"invited_users" text[] DEFAULT '{}',
	"permissions" jsonb DEFAULT '{"read":true}'::jsonb,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"view_count" integer DEFAULT 0,
	"last_accessed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"account" varchar(255) NOT NULL,
	"external_id" varchar(500) NOT NULL,
	"deep_link" text,
	"type" varchar(50) NOT NULL,
	"title" text NOT NULL,
	"preview" text,
	"timestamp" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'unread',
	"snoozed_until" timestamp with time zone,
	"priority" varchar(20),
	"tags" text[],
	"data" jsonb DEFAULT '{}' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_entity_state" (
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_type" varchar(20) NOT NULL,
	"starred" boolean DEFAULT false,
	"pinned" boolean DEFAULT false,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_entity_state_user_id_item_id_item_type_pk" PRIMARY KEY("user_id","item_id","item_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_services" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" text,
	"webhook_url" text NOT NULL,
	"api_key" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pricing" text DEFAULT 'free',
	"status" text DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_health_check" timestamp,
	CONSTRAINT "intelligence_services_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'personal' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"subscription_tier" text,
	"subscription_status" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"document_id" uuid,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"ui_preferences" jsonb DEFAULT '{}' NOT NULL,
	"graph_preferences" jsonb DEFAULT '{}' NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"onboarding_step" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "subject_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "subject_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "metadata" jsonb DEFAULT '{}';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "views" ADD CONSTRAINT "views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "views" ADD CONSTRAINT "views_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_user_status" ON "inbox_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_user_timestamp" ON "inbox_items" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_snoozed" ON "inbox_items" USING btree ("user_id","snoozed_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_priority" ON "inbox_items" USING btree ("user_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbox_unique_source" ON "inbox_items" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_starred" ON "user_entity_state" USING btree ("user_id","starred");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_pinned" ON "user_entity_state" USING btree ("user_id","pinned");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_viewed" ON "user_entity_state" USING btree ("user_id","last_viewed_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_subject" ON "events" USING btree ("subject_type","subject_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_user_type" ON "events" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_timestamp" ON "events" USING btree ("timestamp");