-- Synap Backend V1 Schema (Squashed)
-- Generated: Thu Jan 29 17:35:16 CET 2026

-- Source: 0000_aspiring_sentinels.sql
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"source" text DEFAULT 'api',
	"correlation_id" uuid,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"preview" text,
	"file_url" text,
	"file_path" text,
	"file_size" integer,
	"file_type" text,
	"checksum" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_vectors" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"entity_type" text NOT NULL,
	"title" text,
	"preview" text,
	"file_url" text,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_details" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"due_date" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"user_id" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"fact" text NOT NULL,
	"source_entity_id" uuid,
	"source_message_id" uuid,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"payload" jsonb,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"key_name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"hub_id" text,
	"scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"usage_count" bigint DEFAULT 0 NOT NULL,
	"rotated_from_id" uuid,
	"rotation_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_vectors" ADD CONSTRAINT "entity_vectors_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relations" ADD CONSTRAINT "relations_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relations" ADD CONSTRAINT "relations_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_details" ADD CONSTRAINT "task_details_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


-- Source: 0001_absurd_unus.sql
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"attempt" integer DEFAULT 1 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"event_types" text[] NOT NULL,
	"secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"retry_config" jsonb DEFAULT '{"maxRetries":3}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


-- Source: 0002_classy_maverick.sql
CREATE TABLE IF NOT EXISTS "document_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"active_collaborators" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"delta" jsonb,
	"author" text NOT NULL,
	"author_id" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"language" text,
	"storage_url" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"project_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_sessions" ADD CONSTRAINT "document_sessions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sessions_document_id_idx" ON "document_sessions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sessions_user_id_idx" ON "document_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sessions_active_idx" ON "document_sessions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_versions_document_id_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_versions_version_idx" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_project_id_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_type_idx" ON "documents" USING btree ("type");

-- Source: 0003_serious_bullseye.sql
CREATE TABLE IF NOT EXISTS "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid,
	"title" text,
	"thread_type" text DEFAULT 'main' NOT NULL,
	"parent_thread_id" uuid,
	"branched_from_message_id" uuid,
	"branch_purpose" text,
	"agent_id" text DEFAULT 'orchestrator' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"context_summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"user_id" text,
	"llm_provider" text DEFAULT 'claude' NOT NULL,
	"llm_model" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"system_prompt" text NOT NULL,
	"tools_config" jsonb,
	"execution_mode" text DEFAULT 'simple' NOT NULL,
	"max_iterations" integer DEFAULT 5,
	"timeout_seconds" integer DEFAULT 30,
	"weight" numeric(5, 2) DEFAULT '1.0',
	"performance_metrics" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_user_id_idx" ON "chat_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_parent_thread_id_idx" ON "chat_threads" USING btree ("parent_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_project_id_idx" ON "chat_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_status_idx" ON "chat_threads" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_created_by_idx" ON "agents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_active_idx" ON "agents" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_status_idx" ON "projects" USING btree ("status");

-- Source: 0004_thin_donald_blake.sql
CREATE TABLE IF NOT EXISTS "entity_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"enrichment_type" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"data" jsonb NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"context" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_relationships_unique" UNIQUE("source_entity_id","target_entity_id","relationship_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reasoning_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"steps" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"metrics" jsonb,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_enrichments" ADD CONSTRAINT "entity_enrichments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_enrichments" ADD CONSTRAINT "entity_enrichments_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reasoning_traces" ADD CONSTRAINT "reasoning_traces_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_entity_id_idx" ON "entity_enrichments" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_user_id_idx" ON "entity_enrichments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_type_idx" ON "entity_enrichments" USING btree ("enrichment_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_entity_user_idx" ON "entity_enrichments" USING btree ("entity_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_relationships_source_idx" ON "entity_relationships" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_relationships_target_idx" ON "entity_relationships" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_relationships_user_id_idx" ON "entity_relationships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_traces_subject_idx" ON "reasoning_traces" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_traces_user_id_idx" ON "reasoning_traces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_traces_agent_idx" ON "reasoning_traces" USING btree ("agent_id");

-- Source: 0005_clear_abomination.sql
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
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'subject_id') THEN
        ALTER TABLE "events" ADD COLUMN "subject_id" text NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'subject_type') THEN
        ALTER TABLE "events" ADD COLUMN "subject_type" text NOT NULL;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'workspace_id') THEN
        ALTER TABLE "entities" ADD COLUMN "workspace_id" uuid;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'document_id') THEN
        ALTER TABLE "entities" ADD COLUMN "document_id" uuid;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'metadata') THEN
        ALTER TABLE "entities" ADD COLUMN "metadata" jsonb DEFAULT '{}';
    END IF;
END $$;--> statement-breakpoint
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

-- Source: 0006_add_rls_policies.sql
-- Migration: Add RLS Policies for Event-Based Access Control
-- Created: 2024-12-24
-- Purpose: Enable Row-Level Security on key tables with SELECT-only policies
--          Writes are handled by event system, reads are protected by RLS
--          Exception: Documents table allows UPDATE for Yjs real-time collaboration

-- ============================================================================
-- ENABLE RLS ON KEY TABLES
-- ============================================================================

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- SELECT POLICIES (Read Protection)
-- ============================================================================

-- Entities: User owns it OR user is in workspace
CREATE POLICY entities_select ON entities
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Workspaces: User owns it OR user is a member
CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (
    owner_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Views: User owns it OR user is in workspace
CREATE POLICY views_select ON views
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Documents: User owns it OR user has access to associated view
CREATE POLICY documents_select ON documents
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT document_id FROM views 
      WHERE user_id = current_setting('app.user_id', TRUE) OR
      workspace_id IN (
        SELECT workspace_id FROM workspace_members 
        WHERE user_id = current_setting('app.user_id', TRUE)
      )
    )
  );

-- Workspace Members: User is the member OR user is in the workspace
CREATE POLICY workspace_members_select ON workspace_members
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    workspace_id IN (
      SELECT workspace_id FROM workspace_members 
      WHERE user_id = current_setting('app.user_id', TRUE)
    )
  );

-- Relations: User owns the source entity OR entity is in user's workspace
CREATE POLICY relations_select ON relations
  FOR SELECT
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    source_entity_id IN (
      SELECT id FROM entities 
      WHERE workspace_id IN (
        SELECT workspace_id FROM workspace_members 
        WHERE user_id = current_setting('app.user_id', TRUE)
      )
    )
  );

-- ============================================================================
-- UPDATE POLICIES (Exceptions)
-- ============================================================================

-- Documents: Allow UPDATE for Yjs real-time collaboration
-- This is the ONLY write policy - all other writes go through events
CREATE POLICY documents_update ON documents
  FOR UPDATE
  USING (
    user_id = current_setting('app.user_id', TRUE) OR
    id IN (
      SELECT document_id FROM views 
      WHERE workspace_id IN (
        SELECT workspace_id FROM workspace_members 
        WHERE user_id = current_setting('app.user_id', TRUE)
      )
    )
  );

-- ============================================================================
-- NOTES
-- ============================================================================
-- 
-- All INSERT/DELETE operations are intentionally NOT protected by RLS.
-- These operations are handled by the event system which performs
-- permission checks before persisting data.
--
-- This migration creates a hybrid security model:
-- - Reads: Protected by RLS (this file)
-- - Writes: Protected by event-based permission checks (application layer)
-- - Exception: Document updates for Yjs (real-time collaboration requirement)
--


-- Source: 0006_breezy_havok.sql
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"kratos_identity_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"user_id" text,
	"workspace_id" uuid,
	"target_type" text NOT NULL,
	"entity_type" text,
	"inbox_item_type" text,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_default_per_scope" UNIQUE("user_id","workspace_id","target_type","entity_type","inbox_item_type","is_default"),
	CONSTRAINT "valid_scope" CHECK (
      (user_id IS NOT NULL AND workspace_id IS NULL) OR
      (user_id IS NULL AND workspace_id IS NOT NULL)
    ),
	CONSTRAINT "target_type_check" CHECK (
      target_type IN ('entity', 'document', 'project', 'inbox_item')
    )
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "ui_preferences" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "graph_preferences" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "custom_theme" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "default_templates" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "custom_entity_types" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "entity_metadata_schemas" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_templates" ADD CONSTRAINT "entity_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_user" ON "entity_templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_workspace" ON "entity_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_target_type" ON "entity_templates" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_entity_type" ON "entity_templates" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_inbox_type" ON "entity_templates" USING btree ("inbox_item_type");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_check" CHECK ("api_keys"."user_id" IS NOT NULL AND LENGTH(TRIM("api_keys"."user_id")) > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_name_check" CHECK (LENGTH(TRIM("api_keys"."key_name")) > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_prefix_check" CHECK ("api_keys"."key_prefix" IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Source: 0007_good_mockingbird.sql
CREATE TABLE IF NOT EXISTS "document_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"proposal_type" text NOT NULL,
	"proposed_by" text NOT NULL,
	"changes" jsonb NOT NULL,
	"original_content" text,
	"proposed_content" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "agent_type" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "agent_config" jsonb;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT 'custom';--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "yjs_room_id" text;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "thumbnail_url" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_proposals" ADD CONSTRAINT "document_proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_proposals_document_id_idx" ON "document_proposals" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_proposals_status_idx" ON "document_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_proposals_expires_at_idx" ON "document_proposals" USING btree ("expires_at");

-- Source: 0007_seed_system_roles.sql
-- Migration: Seed System Roles
-- Created: 2024-12-24
-- Purpose: Insert built-in system roles with predefined permissions
--          These roles are workspace-independent (workspace_id = NULL)

-- ============================================================================
-- SYSTEM ROLES
-- ============================================================================

INSERT INTO roles (name, description, workspace_id, permissions, created_by) VALUES

-- Owner: Full control over workspace and all resources
('owner', 'Full control over workspace and all resources', NULL, '{
  "workspaces": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "entities": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "views": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "documents": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "relations": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "members": {
    "invite": true,
    "remove": true,
    "update_roles": true
  },
  "roles": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "sharing": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  }
}'::jsonb, 'system'),

-- Admin: Manage members and all content
('admin', 'Manage members and all content', NULL, '{
  "workspaces": {
    "read": true,
    "update": true
  },
  "entities": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "views": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "documents": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "relations": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  },
  "members": {
    "invite": true,
    "remove": true,
    "update_roles": false
  },
  "roles": {
    "read": true
  },
  "sharing": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true
  }
}'::jsonb, 'system'),

-- Editor: Create and edit content
('editor', 'Create and edit content', NULL, '{
  "workspaces": {
    "read": true
  },
  "entities": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "views": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "documents": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "relations": {
    "create": true,
    "read": true,
    "update": true,
    "delete": false
  },
  "members": {
    "read": true
  },
  "roles": {
    "read": true
  },
  "sharing": {
    "create": true,
    "read": true
  }
}'::jsonb, 'system'),

-- Viewer: Read-only access
('viewer', 'Read-only access to workspace resources', NULL, '{
  "workspaces": {
    "read": true
  },
  "entities": {
    "read": true
  },
  "views": {
    "read": true
  },
  "documents": {
    "read": true
  },
  "relations": {
    "read": true
  },
  "members": {
    "read": true
  },
  "roles": {
    "read": true
  },
  "sharing": {
    "read": true
  }
}'::jsonb, 'system');

-- ============================================================================
-- NOTES
-- ============================================================================
--
-- System roles (workspace_id = NULL) are available to all workspaces.
-- Workspaces can also create custom roles specific to their needs.
--
-- Permission Structure:
-- - Each resource type (workspaces, entities, views, etc.) has CRUD permissions
-- - Special permissions for members (invite, remove, update_roles)
-- - Permissions are checked by the checkPermission() function in the API layer
--
-- Role Hierarchy (most to least privileged):
-- 1. owner - Full control, can delete workspace
-- 2. admin - Manage everything except workspace deletion and owner role changes
-- 3. editor - Create and edit content, no deletion
-- 4. viewer - Read-only access
--


-- Source: 0008_add_entity_templates.sql
-- Migration: 0008_add_entity_templates.sql

-- ============================================================================
-- Entity Templates Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS "entity_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  
  -- Scope: User OR Workspace (mutually exclusive)
  "user_id" text,
  "workspace_id" uuid,
  
  -- Target Configuration
  "target_type" text NOT NULL,
  "entity_type" text,       -- For target_type='entity'
  "inbox_item_type" text,   -- For target_type='inbox_item'
  
  -- Template Configuration (JSONB)
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  -- Metadata
  "is_default" boolean DEFAULT false NOT NULL,
  "is_public" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  
  -- Constraints
  CONSTRAINT "target_type_check" CHECK (target_type IN ('entity', 'document', 'project', 'inbox_item')),
  
  CONSTRAINT "valid_entity_type" CHECK (
    (target_type = 'entity' AND entity_type IS NOT NULL AND inbox_item_type IS NULL) OR
    (target_type = 'inbox_item' AND inbox_item_type IS NOT NULL AND entity_type IS NULL) OR
    (target_type NOT IN ('entity', 'inbox_item') AND entity_type IS NULL AND inbox_item_type IS NULL)
  ),
  
  CONSTRAINT "valid_scope" CHECK (
    (user_id IS NOT NULL AND workspace_id IS NULL) OR
    (user_id IS NULL AND workspace_id IS NOT NULL)
  )
);

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_templates_user" ON "entity_templates"(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_templates_workspace" ON "entity_templates"(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_templates_target_type" ON "entity_templates"(target_type);
CREATE INDEX IF NOT EXISTS "idx_templates_entity_type" ON "entity_templates"(entity_type) WHERE entity_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_templates_inbox_type" ON "entity_templates"(inbox_item_type) WHERE inbox_item_type IS NOT NULL;
-- Partial unique index to enforce one default per scope
CREATE UNIQUE INDEX IF NOT EXISTS "idx_templates_is_default" ON "entity_templates"(user_id, workspace_id, target_type, entity_type, inbox_item_type) WHERE is_default = true;

-- Foreign Keys
DO $$ BEGIN
  ALTER TABLE "entity_templates" ADD CONSTRAINT "entity_templates_workspace_id_workspaces_id_fk" 
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") 
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;


-- Source: 0008_unusual_green_goblin.sql
ALTER TABLE "document_versions" ADD COLUMN "type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "last_saved_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "working_state" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "working_state_updated_at" timestamp with time zone;

-- Source: 0009_add_preferences_columns.sql
-- Migration: Add user preferences columns for theme, templates, and entity customization
-- Created: 2024-01-04

-- Add new JSONB columns for user preferences
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS custom_theme JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS default_templates JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS custom_entity_types JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS entity_metadata_schemas JSONB;

-- Add column comments for documentation
COMMENT ON COLUMN user_preferences.custom_theme IS 'User custom Tamagui theme overrides (colors, spacing, radii, animations)';
COMMENT ON COLUMN user_preferences.default_templates IS 'Default template IDs per entity type (e.g., {"document": "notion-like", "note": "classic-note"})';
COMMENT ON COLUMN user_preferences.custom_entity_types IS 'User-defined custom entity types with metadata schemas';
COMMENT ON COLUMN user_preferences.entity_metadata_schemas IS 'Custom metadata field definitions per entity type';


-- Source: 0009_common_famine.sql
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_proposals_workspace_status" ON "proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_proposals_target" ON "proposals" USING btree ("target_type","target_id");

-- Source: 0010_curvy_madame_web.sql
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

-- Source: 0010_manual_users_workspaces.sql
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"kratos_identity_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'personal' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscription_tier" text,
	"subscription_status" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" text
);

CREATE TABLE IF NOT EXISTS "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_token_unique" UNIQUE("token")
);


-- Source: 0011_add_workspace_project_context.sql
-- ============================================================================
-- Migration: Add Workspace & Project Context to All Tables
-- Version: 2026-01-15
-- Description: Adds workspaceId (required) and projectIds (optional array) 
--              to all core resource tables for proper multi-tenant support
-- ============================================================================

-- IMPORTANT: Run this migration in a transaction
BEGIN;

-- ============================================================================
-- PHASE 1: Add Columns to Existing Tables
-- ============================================================================

-- Tags: Add workspaceId and projectIds
ALTER TABLE tags 
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Projects: Add workspaceId
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Relations: Add workspaceId and projectIds  
ALTER TABLE relations
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entities: Make workspaceId NOT NULL, add projectIds
-- (workspaceId already exists, just making it required + adding projectIds)
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Documents: Add workspaceId and projectIds
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entity Templates: Already has workspaceId, but add projectIds
ALTER TABLE entity_templates
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Views: Already has workspaceId, add projectIds
ALTER TABLE views
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Inbox Items: Add workspaceId and projectIds
ALTER TABLE inbox_items
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Resource Shares: Add projectIds (already has implicit workspace via resource)
ALTER TABLE resource_shares
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- ============================================================================
-- PHASE 2: Backfill Data (Use userId as temporary workspaceId for personal data)
-- ============================================================================

-- Tags: Set workspaceId to userId for existing records
UPDATE tags
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Projects: Set workspaceId to userId for existing records
UPDATE projects
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Relations: Set workspaceId to userId for existing records
UPDATE relations
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Entities: Set workspaceId to userId for existing NULL records
UPDATE entities
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Documents: Set workspaceId to userId for existing records
UPDATE documents
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Inbox Items: Set workspaceId to userId for existing records
UPDATE inbox_items
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- ============================================================================
-- PHASE 3: Add NOT NULL Constraints
-- ============================================================================

-- Now that data is backfilled, make workspaceId required
ALTER TABLE tags
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE projects
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE relations
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE entities
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE documents
ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE inbox_items
ALTER COLUMN workspace_id SET NOT NULL;

-- ============================================================================
-- PHASE 4: Add Indexes for Performance
-- ============================================================================

-- Tags
CREATE INDEX IF NOT EXISTS idx_tags_workspace_id ON tags(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tags_project_ids ON tags USING GIN(project_ids);

-- Projects
CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id);

-- Relations
CREATE INDEX IF NOT EXISTS idx_relations_workspace_id ON relations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_relations_project_ids ON relations USING GIN(project_ids);

-- Entities
CREATE INDEX IF NOT EXISTS idx_entities_workspace_id ON entities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_entities_project_ids ON entities USING GIN(project_ids);

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_project_ids ON documents USING GIN(project_ids);

-- Entity Templates
CREATE INDEX IF NOT EXISTS idx_entity_templates_project_ids ON entity_templates USING GIN(project_ids);

-- Views
CREATE INDEX IF NOT EXISTS idx_views_project_ids ON views USING GIN(project_ids);

-- Inbox Items
CREATE INDEX IF NOT EXISTS idx_inbox_items_workspace_id ON inbox_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_project_ids ON inbox_items USING GIN(project_ids);

-- Resource Shares
CREATE INDEX IF NOT EXISTS idx_resource_shares_project_ids ON resource_shares USING GIN(project_ids);

-- ============================================================================
-- PHASE 5: Add Foreign Key Constraints (Optional - for referential integrity)
-- ============================================================================

-- Note: Only add FK constraints if you want strict enforcement
-- Comment out if you prefer flexibility

-- ALTER TABLE tags
-- ADD CONSTRAINT fk_tags_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE projects
-- ADD CONSTRAINT fk_projects_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE relations
-- ADD CONSTRAINT fk_relations_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE entities
-- ADD CONSTRAINT fk_entities_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE documents
-- ADD CONSTRAINT fk_documents_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ALTER TABLE inbox_items
-- ADD CONSTRAINT fk_inbox_items_workspace
-- FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ============================================================================
-- PHASE 6: Update Comments for Documentation
-- ============================================================================

COMMENT ON COLUMN tags.workspace_id IS 'Workspace this tag belongs to (required - personal workspace=userId)';
COMMENT ON COLUMN tags.project_ids IS 'Optional: Projects this tag is scoped to (array allows multi-project)';

COMMENT ON COLUMN projects.workspace_id IS 'Workspace this project belongs to';

COMMENT ON COLUMN relations.workspace_id IS 'Workspace this relation belongs to';
COMMENT ON COLUMN relations.project_ids IS 'Optional: Projects this relation is scoped to';

COMMENT ON COLUMN entities.workspace_id IS 'Workspace this entity belongs to (required)';
COMMENT ON COLUMN entities.project_ids IS 'Optional: Projects this entity belongs to (many-to-many via array)';

COMMENT ON COLUMN documents.workspace_id IS 'Workspace this document belongs to';
COMMENT ON COLUMN documents.project_ids IS 'Optional: Projects this document belongs to';

COMMENT ON COLUMN entity_templates.project_ids IS 'Optional: Projects this template is scoped to';

COMMENT ON COLUMN views.project_ids IS 'Optional: Projects this view is scoped to';

COMMENT ON COLUMN inbox_items.workspace_id IS 'Workspace this inbox item belongs to';
COMMENT ON COLUMN inbox_items.project_ids IS 'Optional: Projects related to this inbox item';

COMMENT ON COLUMN resource_shares.project_ids IS 'Optional: Projects this share is scoped to';

-- ============================================================================
-- Commit Transaction
-- ============================================================================

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- Run these after migration to verify success:

-- Check for NULL workspaceIds (should be 0)
-- SELECT 'tags' as table_name, COUNT(*) as null_workspace_ids FROM tags WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'projects', COUNT(*) FROM projects WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'relations', COUNT(*) FROM relations WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'entities', COUNT(*) FROM entities WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'documents', COUNT(*) FROM documents WHERE workspace_id IS NULL
-- UNION ALL
-- SELECT 'inbox_items', COUNT(*) FROM inbox_items WHERE workspace_id IS NULL;

-- Check indexes created
-- SELECT tablename, indexname FROM pg_indexes 
-- WHERE indexname LIKE '%workspace_id%' OR indexname LIKE '%project_ids%'
-- ORDER BY tablename, indexname;


-- Source: 0011_high_mattie_franklin.sql
ALTER TABLE "entity_templates" ADD COLUMN "schema" jsonb;

-- Source: 0012_add_workspace_and_project_permissions.sql
-- ============================================================================
-- CONSOLIDATED MIGRATION: Workspace Context + Project Members
-- Version: 0012 (supersedes 0011)
-- Date: 2026-01-15
-- Description: 
--   1. Adds workspaceId/projectIds to all resource tables
--   2. Creates project_members table for project-level permissions
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: Add Workspace & Project Context to Resource Tables
-- ============================================================================

-- Tags: Add workspaceId and projectIds
ALTER TABLE tags 
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Projects: Add workspaceId
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Relations: Add workspaceId and projectIds  
ALTER TABLE relations
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entities: Add projectIds (workspaceId exists, just add array)
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Documents: Add workspaceId and projectIds
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Entity Templates: Add projectIds (workspaceId exists)
ALTER TABLE entity_templates
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Views: Add projectIds (workspaceId exists)
ALTER TABLE views
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- Inbox Items: Add workspaceId and projectIds
ALTER TABLE inbox_items
ADD COLUMN IF NOT EXISTS workspace_id UUID,
ADD COLUMN IF NOT EXISTS project_ids UUID[];

-- ============================================================================
-- PART 2: Backfill Data (Use userId as workspaceId for existing data)
-- ============================================================================

-- Tags
UPDATE tags
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Projects
UPDATE projects
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Relations
UPDATE relations
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Entities
UPDATE entities
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Documents
UPDATE documents
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- Inbox Items
UPDATE inbox_items
SET workspace_id = CAST(user_id AS UUID)
WHERE workspace_id IS NULL;

-- ============================================================================
-- PART 3: Add NOT NULL Constraints
-- ============================================================================

ALTER TABLE tags ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE relations ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE entities ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE inbox_items ALTER COLUMN workspace_id SET NOT NULL;

-- ============================================================================
-- PART 4: Add Indexes for Performance
-- ============================================================================

-- Tags
CREATE INDEX IF NOT EXISTS idx_tags_workspace_id ON tags(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tags_project_ids ON tags USING GIN(project_ids);

-- Projects
CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id);

-- Relations
CREATE INDEX IF NOT EXISTS idx_relations_workspace_id ON relations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_relations_project_ids ON relations USING GIN(project_ids);

-- Entities
CREATE INDEX IF NOT EXISTS idx_entities_workspace_id ON entities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_entities_project_ids ON entities USING GIN(project_ids);

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_project_ids ON documents USING GIN(project_ids);

-- Entity Templates
CREATE INDEX IF NOT EXISTS idx_entity_templates_project_ids ON entity_templates USING GIN(project_ids);

-- Views
CREATE INDEX IF NOT EXISTS idx_views_project_ids ON views USING GIN(project_ids);

-- Inbox Items
CREATE INDEX IF NOT EXISTS idx_inbox_items_workspace_id ON inbox_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_project_ids ON inbox_items USING GIN(project_ids);

-- ============================================================================
-- PART 5: Create project_members Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Relationships
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  
  -- Role in project (same as workspace for consistency)
  role TEXT NOT NULL DEFAULT 'viewer', -- 'owner' | 'editor' | 'viewer'
  
  -- Metadata
  invited_by TEXT,
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  
  -- Constraints
  UNIQUE(project_id, user_id)
);

-- Indexes for project_members
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_project ON project_members(user_id, project_id);

-- ============================================================================
-- PART 6: Add Comments for Documentation
-- ============================================================================

-- Resource tables
COMMENT ON COLUMN tags.workspace_id IS 'Workspace this tag belongs to (required)';
COMMENT ON COLUMN tags.project_ids IS 'Optional: Projects this tag is scoped to (array)';

COMMENT ON COLUMN projects.workspace_id IS 'Workspace this project belongs to (required)';

COMMENT ON COLUMN relations.workspace_id IS 'Workspace this relation belongs to (required)';
COMMENT ON COLUMN relations.project_ids IS 'Optional: Projects this relation is scoped to (array)';

COMMENT ON COLUMN entities.workspace_id IS 'Workspace this entity belongs to (required)';
COMMENT ON COLUMN entities.project_ids IS 'Optional: Projects this entity belongs to (array)';

COMMENT ON COLUMN documents.workspace_id IS 'Workspace this document belongs to (required)';
COMMENT ON COLUMN documents.project_ids IS 'Optional: Projects this document belongs to (array)';

COMMENT ON COLUMN views.project_ids IS 'Optional: Projects this view is scoped to (array)';
COMMENT ON COLUMN entity_templates.project_ids IS 'Optional: Projects this template is scoped to (array)';

COMMENT ON COLUMN inbox_items.workspace_id IS 'Workspace this inbox item belongs to (required)';
COMMENT ON COLUMN inbox_items.project_ids IS 'Optional: Projects related to inbox item (array)';

-- Project members table
COMMENT ON TABLE project_members IS 'Project-level permissions (sub-workspace access control)';
COMMENT ON COLUMN project_members.role IS 'User role in this specific project (owner/editor/viewer)';
COMMENT ON COLUMN project_members.invited_by IS 'User ID who added this member to the project';

-- ============================================================================
-- Commit Transaction
-- ============================================================================

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES (Run after migration)
-- ============================================================================

-- Check for NULL workspaceIds (should return 0 for all)
-- SELECT 'tags' as table_name, COUNT(*) as null_count FROM tags WHERE workspace_id IS NULL
-- UNION ALL SELECT 'projects', COUNT(*) FROM projects WHERE workspace_id IS NULL
-- UNION ALL SELECT 'relations', COUNT(*) FROM relations WHERE workspace_id IS NULL
-- UNION ALL SELECT 'entities', COUNT(*) FROM entities WHERE workspace_id IS NULL
-- UNION ALL SELECT 'documents', COUNT(*) FROM documents WHERE workspace_id IS NULL
-- UNION ALL SELECT 'inbox_items', COUNT(*) FROM inbox_items WHERE workspace_id IS NULL;

-- Check project_members table
-- SELECT COUNT(*) FROM project_members;

-- Check indexes created
-- SELECT tablename, indexname FROM pg_indexes 
-- WHERE schemaname = 'public' 
-- AND (indexname LIKE '%workspace_id%' OR indexname LIKE '%project%')
-- ORDER BY tablename, indexname;


-- Source: 0012_pretty_valkyrie.sql
CREATE TABLE "thread_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"conflict_status" text DEFAULT 'none' NOT NULL,
	"source_message_id" uuid,
	"source_event_id" uuid,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_entities_unique" UNIQUE("thread_id","entity_id","relationship_type")
);
--> statement-breakpoint
CREATE TABLE "thread_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"conflict_status" text DEFAULT 'none' NOT NULL,
	"source_message_id" uuid,
	"source_event_id" uuid,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_documents_unique" UNIQUE("thread_id","document_id","relationship_type")
);
--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_source_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_source_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_entities_thread_id_idx" ON "thread_entities" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_entities_entity_id_idx" ON "thread_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "thread_entities_user_id_idx" ON "thread_entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_entities_workspace_id_idx" ON "thread_entities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "thread_entities_conflict_idx" ON "thread_entities" USING btree ("conflict_status");--> statement-breakpoint
CREATE INDEX "thread_documents_thread_id_idx" ON "thread_documents" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_documents_document_id_idx" ON "thread_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "thread_documents_user_id_idx" ON "thread_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_documents_workspace_id_idx" ON "thread_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "thread_documents_conflict_idx" ON "thread_documents" USING btree ("conflict_status");

-- Source: 005_remove_entity_file_fields.sql
-- Migration: Remove deprecated file fields from entities table
-- Date: 2026-01-15
-- Purpose: Clean up deprecated fields, entities should only reference documents via documentId

-- Check if any data exists (should be 0 based on user confirmation)
DO $$ 
DECLARE 
    file_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO file_count 
    FROM entities 
    WHERE file_url IS NOT NULL OR file_path IS NOT NULL;
    
    IF file_count > 0 THEN
        RAISE NOTICE 'Warning: % entities have file data that will be lost', file_count;
    ELSE
        RAISE NOTICE 'Safe to proceed: No entities have deprecated file fields';
    END IF;
END $$;Okay, could you make a control date by removing the separate migration steps, where instead of adding updating, deleting, we just add tables by tables properly instead of making multiple operations for nothing. I think this is where we need to restructure, and we can accept that it is not backworld compatible. So, yes.

-- Remove deprecated columns
ALTER TABLE entities
  DROP COLUMN IF EXISTS file_url,
  DROP COLUMN IF EXISTS file_path,
  DROP COLUMN IF EXISTS file_size,
  DROP COLUMN IF EXISTS file_type,
  DROP COLUMN IF EXISTS checksum;

-- Verify columns removed
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'entities' 
  AND column_name IN ('file_url', 'file_path', 'file_size', 'file_type', 'checksum');
-- Should return 0 rows


