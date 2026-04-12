DO $$ BEGIN
  CREATE TYPE "public"."secret_type" AS ENUM('password', 'api_key', 'credential', 'note', 'card', 'identity', 'ssh_key', 'certificate', 'env_variable', 'database', 'oauth');
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"custom_theme" jsonb,
	"default_templates" jsonb,
	"custom_entity_types" jsonb,
	"entity_metadata_schemas" jsonb,
	"ui_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graph_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"intelligence_service_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"onboarding_step" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"user_type" text DEFAULT 'human' NOT NULL,
	"agent_metadata" jsonb,
	"kratos_identity_id" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"metadata" jsonb,
	"source" text DEFAULT 'api',
	"correlation_id" uuid,
	"user_id" text NOT NULL,
	CONSTRAINT "events_id_timestamp_pk" PRIMARY KEY("id","timestamp")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"profile_id" uuid,
	"type" text NOT NULL,
	"title" text,
	"preview" text,
	"document_id" uuid,
	"properties" jsonb DEFAULT '{}' NOT NULL,
	"system_data" jsonb DEFAULT '{}' NOT NULL,
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
CREATE TABLE IF NOT EXISTS "document_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
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
	"author" text NOT NULL,
	"author_id" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"language" text,
	"storage_url" text,
	"storage_key" text,
	"size" integer DEFAULT 0 NOT NULL,
	"mime_type" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"last_saved_version" integer DEFAULT 0 NOT NULL,
	"working_state" text,
	"working_state_updated_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" text NOT NULL,
	"author_type" text DEFAULT 'human' NOT NULL,
	"message_category" text DEFAULT 'chat' NOT NULL,
	"external_source" text,
	"inbox_item_id" uuid,
	"content" text NOT NULL,
	"metadata" jsonb,
	"user_id" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	"session_id" uuid,
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
	"key_type" text DEFAULT 'hub_inbound' NOT NULL,
	"description" text,
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
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_user_id_check" CHECK ("api_keys"."user_id" IS NOT NULL AND LENGTH(TRIM("api_keys"."user_id")) > 0),
	CONSTRAINT "api_keys_key_name_check" CHECK (LENGTH(TRIM("api_keys"."key_name")) > 0),
	CONSTRAINT "api_keys_key_prefix_check" CHECK ("api_keys"."key_prefix" IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_'))
);
--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"title" text,
	"channel_type" text DEFAULT 'thread' NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"feed_scope" text,
	"context_object_type" text,
	"context_object_id" uuid,
	"parent_channel_id" uuid,
	"branched_from_message_id" uuid,
	"branch_purpose" text,
	"agent_id" text DEFAULT 'orchestrator' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"agent_type" text DEFAULT 'none' NOT NULL,
	"agent_config" jsonb,
	"mcp_server_id" uuid[],
	"context_summary" text,
	"result_summary" text,
	"merged_into_state_id" uuid,
	"external_source" text,
	"external_channel_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_context_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"conflict_status" text DEFAULT 'none' NOT NULL,
	"source_message_id" uuid,
	"relevance_score" real,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_context_unique" UNIQUE("channel_id","object_id","object_type","relationship_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"channel_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"default_channel_id" uuid,
	"external_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connections_channel_user_unique" UNIQUE("channel","channel_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"channel" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"default_channel_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_link_tokens_token_unique" UNIQUE("token")
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
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"token_hash" text,
	"password_hash" text,
	"access" text DEFAULT 'anyone_with_link',
	"revoked_at" timestamp with time zone,
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
CREATE TABLE IF NOT EXISTS "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
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
	"mcp_endpoint" text,
	"api_key" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pricing" text DEFAULT 'free',
	"status" text DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mcp_approved" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_health_check" timestamp,
	"last_health_status" text,
	CONSTRAINT "intelligence_services_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"prompt_template" text NOT NULL,
	"compiled_template_ast" jsonb,
	"derived_inputs" jsonb,
	"input_overrides" jsonb,
	"allowed_tools" jsonb,
	"allowed_entity_types" jsonb,
	"max_entities_created_per_run" integer,
	"can_create_views" boolean DEFAULT false NOT NULL,
	"output_mode" text DEFAULT 'text' NOT NULL,
	"permissions_profile" text DEFAULT 'propose_writes' NOT NULL,
	"shared_scope" text DEFAULT 'workspace' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "command_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"permissions_snapshot" jsonb,
	"inputs" jsonb,
	"selection_context_snapshot" jsonb,
	"output_summary" text,
	"proposed_actions" jsonb,
	"approved_actions" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"workspace_id" uuid,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token")
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
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscription_tier" text,
	"subscription_status" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_members" (
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
CREATE TABLE IF NOT EXISTS "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope_profile_ids" uuid[],
	"scope_mode" text,
	"query" jsonb DEFAULT '{}',
	"config" jsonb DEFAULT '{}',
	"filter" jsonb DEFAULT '{}',
	"sort" jsonb DEFAULT '{}',
	"columns" jsonb DEFAULT '[]',
	"layout_config" jsonb DEFAULT '{}',
	"document_id" uuid,
	"yjs_room_id" text,
	"thumbnail_url" text,
	"schema_snapshot" jsonb,
	"snapshot_updated_at" timestamp with time zone,
	"embedded_view_ids" uuid[],
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"proposal_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"thread_id" uuid,
	"command_run_id" uuid,
	"source_message_id" uuid,
	"agent_user_id" text,
	"expires_at" timestamp with time zone,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"comments" jsonb DEFAULT '[]',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"schema" jsonb,
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
CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"kind" text DEFAULT 'code' NOT NULL,
	"scope" text DEFAULT 'pod' NOT NULL,
	"agent_types" jsonb,
	"name" text NOT NULL,
	"description" text,
	"code" text NOT NULL,
	"parameters" jsonb,
	"category" text,
	"execution_mode" text DEFAULT 'sync' NOT NULL,
	"timeout_seconds" integer DEFAULT 30,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"event_pattern" text,
	"filters" jsonb,
	"cron_expression" text,
	"channel_type" text DEFAULT 'personal' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"automation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "background_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"schedule" text,
	"action" text NOT NULL,
	"context" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"triggered_by" text,
	"trigger_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_message" text,
	"steps_completed" integer DEFAULT 0 NOT NULL,
	"steps_failed" integer DEFAULT 0 NOT NULL,
	"output_summary" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"command_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flow_definition" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"error_message" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"backend_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"position" jsonb,
	"metadata" jsonb,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_type" text NOT NULL,
	"prompt_append" text,
	"extra_tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_steps_override" integer,
	"model_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_configs_user_workspace_agent_unique" UNIQUE("user_id","workspace_id","agent_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_ping_at" timestamp with time zone,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_workspace_slug_unique" UNIQUE("workspace_id","slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "property_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"profile_id" uuid,
	"workspace_id" uuid,
	"value_type" text NOT NULL,
	"constraints" jsonb DEFAULT '{}' NOT NULL,
	"ui_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"relation_def_id" uuid,
	"target_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_workspace_access" (
	"profile_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_workspace_access_profile_id_workspace_id_pk" PRIMARY KEY("profile_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"parent_profile_id" uuid,
	"ui_hints" jsonb DEFAULT '{}' NOT NULL,
	"default_values" jsonb DEFAULT '{}' NOT NULL,
	"semantic_slug" text,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"user_id" text,
	"workspace_id" uuid,
	"entity_scope" text DEFAULT 'workspace' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_properties" (
	"profile_id" uuid NOT NULL,
	"property_def_id" uuid NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "profile_properties_profile_id_property_def_id_pk" PRIMARY KEY("profile_id","property_def_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_property_index" (
	"entity_id" uuid NOT NULL,
	"property_def_id" uuid NOT NULL,
	"value_text" text,
	"value_num" numeric,
	"value_bool" boolean,
	"value_ts" timestamp with time zone,
	"value_entity_id" uuid,
	"value_jsonb" jsonb,
	CONSTRAINT "entity_property_index_entity_id_property_def_id_pk" PRIMARY KEY("entity_id","property_def_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relation_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"ui_hints" jsonb DEFAULT '{}' NOT NULL,
	"is_directional" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_defs_slug_workspace_unique" UNIQUE("slug","workspace_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_relations" (
	"source_profile_id" uuid NOT NULL,
	"target_profile_id" uuid NOT NULL,
	"relation_def_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"property_def_id" uuid,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "profile_relations_source_profile_id_target_profile_id_relation_def_id_pk" PRIMARY KEY("source_profile_id","target_profile_id","relation_def_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid NOT NULL,
	"shared_with_user_id" text,
	"shared_with_workspace_id" uuid,
	"permission" text DEFAULT 'read' NOT NULL,
	"shared_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_tags_unique" UNIQUE("secret_id","tag")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_vault_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"salt" text NOT NULL,
	"key_derivation_algorithm" text DEFAULT 'argon2id' NOT NULL,
	"key_derivation_params" jsonb NOT NULL,
	"verification_cipher" text NOT NULL,
	"verification_iv" text NOT NULL,
	"verification_tag" text NOT NULL,
	"recovery_key_hash" text,
	"recovery_key_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_unlocked_at" timestamp with time zone,
	CONSTRAINT "secret_vault_keys_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"type" "secret_type" DEFAULT 'password' NOT NULL,
	"url" text,
	"category" text,
	"description" text,
	"icon_url" text,
	"encrypted_data" text NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"encryption_mode" text DEFAULT 'client' NOT NULL,
	"service_id" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"password_strength" integer,
	"password_last_changed" timestamp with time zone,
	"is_compromised" boolean DEFAULT false,
	"compromised_at" timestamp with time zone,
	"is_shared" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"bootstrap_state_id" uuid,
	"produced_state_id" uuid,
	"total_tokens_used" integer DEFAULT 0,
	"message_count" integer DEFAULT 0,
	"compaction_count" integer DEFAULT 0,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compacted_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"session_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"identity_block" text DEFAULT '' NOT NULL,
	"user_model_block" text DEFAULT '' NOT NULL,
	"continuity_block" text DEFAULT '' NOT NULL,
	"active_goals_block" text DEFAULT '' NOT NULL,
	"entity_context_block" text DEFAULT '' NOT NULL,
	"raw_token_count" integer,
	"compressed_token_count" integer,
	"compaction_model" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compacted_states_channel_version_unique" UNIQUE("channel_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_key" text NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"category" text,
	"renderer_type" text DEFAULT 'builtin' NOT NULL,
	"renderer_source" text,
	"source" text,
	"bundle_source" text,
	"config_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_config" jsonb DEFAULT '{}'::jsonb,
	"default_size" jsonb DEFAULT '{"w":6,"h":4}'::jsonb NOT NULL,
	"min_size" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" text DEFAULT '1.0.0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"nango_connection_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_hash" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_identity_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"signal_value" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT false,
	"quiet_hours_start" text DEFAULT '22:00',
	"quiet_hours_end" text DEFAULT '08:00',
	"routing_rules" jsonb DEFAULT '{}',
	"sound_enabled" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"icon" text,
	"source_type" text NOT NULL,
	"source_id" text,
	"workspace_url" text,
	"actions" jsonb DEFAULT '[]',
	"group_key" text,
	"status" text DEFAULT 'unread' NOT NULL,
	"read_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_peer_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"local_timestamp" timestamp with time zone,
	"remote_timestamp" timestamp with time zone,
	"resolution" text NOT NULL,
	"event_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_peers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"peer_pod_url" text NOT NULL,
	"direction" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"label" text,
	"auth_token" text,
	"workspace_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_peer_id" uuid NOT NULL,
	"last_cursor" timestamp with time zone,
	"last_push_cursor" timestamp with time zone,
	"last_pull_cursor" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"status" text DEFAULT 'idle' NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"events_processed" integer DEFAULT 0 NOT NULL,
	"supplementary_cursors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_generation" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"promoted_at" timestamp with time zone,
	"promoted_from" text,
	"last_peer_generation" bigint DEFAULT 0,
	"last_peer_contact" timestamp with time zone,
	"split_brain_detected" boolean DEFAULT false NOT NULL,
	"split_brain_detected_at" timestamp with time zone,
	"split_brain_local_gen" bigint,
	"split_brain_remote_gen" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" DROP CONSTRAINT IF EXISTS "entities_profile_id_profiles_id_fk";
ALTER TABLE "entities" ADD CONSTRAINT "entities_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" DROP CONSTRAINT IF EXISTS "entities_document_id_documents_id_fk";
ALTER TABLE "entities" ADD CONSTRAINT "entities_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_vectors" DROP CONSTRAINT IF EXISTS "entity_vectors_entity_id_entities_id_fk";
ALTER TABLE "entity_vectors" ADD CONSTRAINT "entity_vectors_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sessions" DROP CONSTRAINT IF EXISTS "document_sessions_document_id_documents_id_fk";
ALTER TABLE "document_sessions" ADD CONSTRAINT "document_sessions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_document_id_documents_id_fk";
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" DROP CONSTRAINT IF EXISTS "relations_source_entity_id_entities_id_fk";
ALTER TABLE "relations" ADD CONSTRAINT "relations_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" DROP CONSTRAINT IF EXISTS "relations_target_entity_id_entities_id_fk";
ALTER TABLE "relations" ADD CONSTRAINT "relations_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_channel_id_channels_id_fk";
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_inbox_item_id_inbox_items_id_fk";
ALTER TABLE "messages" ADD CONSTRAINT "messages_inbox_item_id_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_session_id_sessions_id_fk";
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk";
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_event_id_events_id_fk";
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_context_items" DROP CONSTRAINT IF EXISTS "channel_context_items_channel_id_channels_id_fk";
ALTER TABLE "channel_context_items" ADD CONSTRAINT "channel_context_items_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_context_items" DROP CONSTRAINT IF EXISTS "channel_context_items_source_message_id_messages_id_fk";
ALTER TABLE "channel_context_items" ADD CONSTRAINT "channel_context_items_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" DROP CONSTRAINT IF EXISTS "channel_connections_user_id_users_id_fk";
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" DROP CONSTRAINT IF EXISTS "channel_connections_workspace_id_workspaces_id_fk";
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" DROP CONSTRAINT IF EXISTS "channel_connections_default_channel_id_channels_id_fk";
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_default_channel_id_channels_id_fk" FOREIGN KEY ("default_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_tokens" DROP CONSTRAINT IF EXISTS "channel_link_tokens_user_id_users_id_fk";
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_tokens" DROP CONSTRAINT IF EXISTS "channel_link_tokens_workspace_id_workspaces_id_fk";
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_tokens" DROP CONSTRAINT IF EXISTS "channel_link_tokens_default_channel_id_channels_id_fk";
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_default_channel_id_channels_id_fk" FOREIGN KEY ("default_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_workspace_id_workspaces_id_fk";
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_enrichments" DROP CONSTRAINT IF EXISTS "entity_enrichments_entity_id_entities_id_fk";
ALTER TABLE "entity_enrichments" ADD CONSTRAINT "entity_enrichments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" DROP CONSTRAINT IF EXISTS "entity_relationships_source_entity_id_entities_id_fk";
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" DROP CONSTRAINT IF EXISTS "entity_relationships_target_entity_id_entities_id_fk";
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_commands" DROP CONSTRAINT IF EXISTS "intelligence_commands_workspace_id_workspaces_id_fk";
ALTER TABLE "intelligence_commands" ADD CONSTRAINT "intelligence_commands_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_runs" DROP CONSTRAINT IF EXISTS "command_runs_thread_id_channels_id_fk";
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_thread_id_channels_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_runs" DROP CONSTRAINT IF EXISTS "command_runs_command_id_intelligence_commands_id_fk";
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_command_id_intelligence_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."intelligence_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_workspace_id_workspaces_id_fk";
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "workspace_members_workspace_id_workspaces_id_fk";
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "project_members_project_id_projects_id_fk";
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" DROP CONSTRAINT IF EXISTS "views_workspace_id_workspaces_id_fk";
ALTER TABLE "views" ADD CONSTRAINT "views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" DROP CONSTRAINT IF EXISTS "views_scope_profile_ids_profiles_id_fk";
ALTER TABLE "views" ADD CONSTRAINT "views_scope_profile_ids_profiles_id_fk" FOREIGN KEY ("scope_profile_ids") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" DROP CONSTRAINT IF EXISTS "views_document_id_documents_id_fk";
ALTER TABLE "views" ADD CONSTRAINT "views_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_thread_id_channels_id_fk";
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_thread_id_channels_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_command_run_id_command_runs_id_fk";
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_command_run_id_command_runs_id_fk" FOREIGN KEY ("command_run_id") REFERENCES "public"."command_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_source_message_id_messages_id_fk";
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_agent_user_id_users_id_fk";
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_templates" DROP CONSTRAINT IF EXISTS "entity_templates_workspace_id_workspaces_id_fk";
ALTER TABLE "entity_templates" ADD CONSTRAINT "entity_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_workspace_id_workspaces_id_fk";
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_triggers" DROP CONSTRAINT IF EXISTS "skill_triggers_skill_id_skills_id_fk";
ALTER TABLE "skill_triggers" ADD CONSTRAINT "skill_triggers_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_triggers" DROP CONSTRAINT IF EXISTS "skill_triggers_workspace_id_workspaces_id_fk";
ALTER TABLE "skill_triggers" ADD CONSTRAINT "skill_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_tasks" DROP CONSTRAINT IF EXISTS "background_tasks_workspace_id_workspaces_id_fk";
ALTER TABLE "background_tasks" ADD CONSTRAINT "background_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "automation_runs_automation_id_automations_id_fk";
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_step_runs" DROP CONSTRAINT IF EXISTS "automation_step_runs_run_id_automation_runs_id_fk";
ALTER TABLE "automation_step_runs" ADD CONSTRAINT "automation_step_runs_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "automations_workspace_id_workspaces_id_fk";
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_links" DROP CONSTRAINT IF EXISTS "message_links_message_id_messages_id_fk";
ALTER TABLE "message_links" ADD CONSTRAINT "message_links_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" DROP CONSTRAINT IF EXISTS "agent_configs_workspace_id_workspaces_id_fk";
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_workspace_id_workspaces_id_fk";
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_defs" DROP CONSTRAINT IF EXISTS "property_defs_profile_id_profiles_id_fk";
ALTER TABLE "property_defs" ADD CONSTRAINT "property_defs_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_defs" DROP CONSTRAINT IF EXISTS "property_defs_workspace_id_workspaces_id_fk";
ALTER TABLE "property_defs" ADD CONSTRAINT "property_defs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_defs" DROP CONSTRAINT IF EXISTS "property_defs_relation_def_id_relation_defs_id_fk";
ALTER TABLE "property_defs" ADD CONSTRAINT "property_defs_relation_def_id_relation_defs_id_fk" FOREIGN KEY ("relation_def_id") REFERENCES "public"."relation_defs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_defs" DROP CONSTRAINT IF EXISTS "property_defs_target_profile_id_profiles_id_fk";
ALTER TABLE "property_defs" ADD CONSTRAINT "property_defs_target_profile_id_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_workspace_access" DROP CONSTRAINT IF EXISTS "profile_workspace_access_profile_id_profiles_id_fk";
ALTER TABLE "profile_workspace_access" ADD CONSTRAINT "profile_workspace_access_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_workspace_access" DROP CONSTRAINT IF EXISTS "profile_workspace_access_workspace_id_workspaces_id_fk";
ALTER TABLE "profile_workspace_access" ADD CONSTRAINT "profile_workspace_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT IF EXISTS "profiles_workspace_id_workspaces_id_fk";
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_properties" DROP CONSTRAINT IF EXISTS "profile_properties_profile_id_profiles_id_fk";
ALTER TABLE "profile_properties" ADD CONSTRAINT "profile_properties_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_properties" DROP CONSTRAINT IF EXISTS "profile_properties_property_def_id_property_defs_id_fk";
ALTER TABLE "profile_properties" ADD CONSTRAINT "profile_properties_property_def_id_property_defs_id_fk" FOREIGN KEY ("property_def_id") REFERENCES "public"."property_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_property_index" DROP CONSTRAINT IF EXISTS "entity_property_index_entity_id_entities_id_fk";
ALTER TABLE "entity_property_index" ADD CONSTRAINT "entity_property_index_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_property_index" DROP CONSTRAINT IF EXISTS "entity_property_index_property_def_id_property_defs_id_fk";
ALTER TABLE "entity_property_index" ADD CONSTRAINT "entity_property_index_property_def_id_property_defs_id_fk" FOREIGN KEY ("property_def_id") REFERENCES "public"."property_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_defs" DROP CONSTRAINT IF EXISTS "relation_defs_workspace_id_workspaces_id_fk";
ALTER TABLE "relation_defs" ADD CONSTRAINT "relation_defs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_relations" DROP CONSTRAINT IF EXISTS "profile_relations_source_profile_id_profiles_id_fk";
ALTER TABLE "profile_relations" ADD CONSTRAINT "profile_relations_source_profile_id_profiles_id_fk" FOREIGN KEY ("source_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_relations" DROP CONSTRAINT IF EXISTS "profile_relations_target_profile_id_profiles_id_fk";
ALTER TABLE "profile_relations" ADD CONSTRAINT "profile_relations_target_profile_id_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_relations" DROP CONSTRAINT IF EXISTS "profile_relations_relation_def_id_relation_defs_id_fk";
ALTER TABLE "profile_relations" ADD CONSTRAINT "profile_relations_relation_def_id_relation_defs_id_fk" FOREIGN KEY ("relation_def_id") REFERENCES "public"."relation_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_relations" DROP CONSTRAINT IF EXISTS "profile_relations_property_def_id_property_defs_id_fk";
ALTER TABLE "profile_relations" ADD CONSTRAINT "profile_relations_property_def_id_property_defs_id_fk" FOREIGN KEY ("property_def_id") REFERENCES "public"."property_defs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_audit_log" DROP CONSTRAINT IF EXISTS "secret_audit_log_secret_id_secrets_id_fk";
ALTER TABLE "secret_audit_log" ADD CONSTRAINT "secret_audit_log_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_shares" DROP CONSTRAINT IF EXISTS "secret_shares_secret_id_secrets_id_fk";
ALTER TABLE "secret_shares" ADD CONSTRAINT "secret_shares_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_tags" DROP CONSTRAINT IF EXISTS "secret_tags_secret_id_secrets_id_fk";
ALTER TABLE "secret_tags" ADD CONSTRAINT "secret_tags_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_channel_id_channels_id_fk";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compacted_states" DROP CONSTRAINT IF EXISTS "compacted_states_channel_id_channels_id_fk";
ALTER TABLE "compacted_states" ADD CONSTRAINT "compacted_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compacted_states" DROP CONSTRAINT IF EXISTS "compacted_states_session_id_sessions_id_fk";
ALTER TABLE "compacted_states" ADD CONSTRAINT "compacted_states_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_definitions" DROP CONSTRAINT IF EXISTS "widget_definitions_workspace_id_workspaces_id_fk";
ALTER TABLE "widget_definitions" ADD CONSTRAINT "widget_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_external_links" DROP CONSTRAINT IF EXISTS "entity_external_links_entity_id_entities_id_fk";
ALTER TABLE "entity_external_links" ADD CONSTRAINT "entity_external_links_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_signals" DROP CONSTRAINT IF EXISTS "entity_identity_signals_entity_id_entities_id_fk";
ALTER TABLE "entity_identity_signals" ADD CONSTRAINT "entity_identity_signals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" DROP CONSTRAINT IF EXISTS "sync_conflicts_sync_peer_id_sync_peers_id_fk";
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_sync_peer_id_sync_peers_id_fk" FOREIGN KEY ("sync_peer_id") REFERENCES "public"."sync_peers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" DROP CONSTRAINT IF EXISTS "sync_state_sync_peer_id_sync_peers_id_fk";
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_sync_peer_id_sync_peers_id_fk" FOREIGN KEY ("sync_peer_id") REFERENCES "public"."sync_peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_subject" ON "events" USING btree ("subject_type","subject_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_user_type" ON "events" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_timestamp" ON "events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_workspace_id_idx" ON "entities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_user_id_idx" ON "entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_workspace_user_deleted_idx" ON "entities" USING btree ("workspace_id","user_id","deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_profile_id_idx" ON "entities" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_type_workspace_idx" ON "entities" USING btree ("type","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_vectors_user_id_idx" ON "entity_vectors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sessions_document_id_idx" ON "document_sessions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sessions_user_id_idx" ON "document_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sessions_active_idx" ON "document_sessions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_versions_document_id_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_versions_version_idx" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_type_idx" ON "documents" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_channel_id_idx" ON "messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_inbox_item_idx" ON "messages" USING btree ("inbox_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_ext_source_idx" ON "messages" USING btree ("external_source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_channel_timestamp_idx" ON "messages" USING btree ("channel_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_user_id_idx" ON "channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_workspace_id_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_parent_channel_id_idx" ON "channels" USING btree ("parent_channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_status_idx" ON "channels" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_context_idx" ON "channels" USING btree ("context_object_type","context_object_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_scope_idx" ON "channels" USING btree ("scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_type_idx" ON "channels" USING btree ("channel_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_context_channel_idx" ON "channel_context_items" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_context_object_idx" ON "channel_context_items" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_context_user_idx" ON "channel_context_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_context_workspace_idx" ON "channel_context_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_context_conflict_idx" ON "channel_context_items" USING btree ("conflict_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_connections_channel_user_idx" ON "channel_connections" USING btree ("channel","channel_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_connections_user_idx" ON "channel_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_link_tokens_token_idx" ON "channel_link_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_link_tokens_user_idx" ON "channel_link_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_created_by_idx" ON "agents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_active_idx" ON "agents" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_entity_id_idx" ON "entity_enrichments" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_user_id_idx" ON "entity_enrichments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_type_idx" ON "entity_enrichments" USING btree ("enrichment_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_enrichments_entity_user_idx" ON "entity_enrichments" USING btree ("entity_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_relationships_source_idx" ON "entity_relationships" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_relationships_target_idx" ON "entity_relationships" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_relationships_user_id_idx" ON "entity_relationships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_traces_subject_idx" ON "reasoning_traces" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_traces_user_id_idx" ON "reasoning_traces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_traces_agent_idx" ON "reasoning_traces" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_user_status" ON "inbox_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_provider" ON "inbox_items" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_timestamp" ON "inbox_items" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_snoozed" ON "inbox_items" USING btree ("user_id","snoozed_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_priority" ON "inbox_items" USING btree ("user_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbox_external_unique" ON "inbox_items" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_starred" ON "user_entity_state" USING btree ("user_id","starred");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_pinned" ON "user_entity_state" USING btree ("user_id","pinned");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_state_viewed" ON "user_entity_state" USING btree ("user_id","last_viewed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intelligence_commands_workspace_id_idx" ON "intelligence_commands" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intelligence_commands_created_by_idx" ON "intelligence_commands" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "command_runs_command_id_idx" ON "command_runs" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "command_runs_workspace_id_idx" ON "command_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "command_runs_user_id_idx" ON "command_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "command_runs_thread_id_idx" ON "command_runs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "command_runs_started_at_idx" ON "command_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_members_project" ON "project_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_members_user_project" ON "project_members" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_workspace_status" ON "proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_target" ON "proposals" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_thread_id" ON "proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_command_run_id" ON "proposals" USING btree ("command_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_source_message_id" ON "proposals" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_created_by" ON "proposals" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_thread_status" ON "proposals" USING btree ("thread_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_agent_user_id" ON "proposals" USING btree ("agent_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_user" ON "entity_templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_workspace" ON "entity_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_target_type" ON "entity_templates" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_entity_type" ON "entity_templates" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_inbox_type" ON "entity_templates" USING btree ("inbox_item_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_user_id_idx" ON "skills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_workspace_id_idx" ON "skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_status_idx" ON "skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_kind_idx" ON "skills" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_name_idx" ON "skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_triggers_skill_id_idx" ON "skill_triggers" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_triggers_workspace_id_idx" ON "skill_triggers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_triggers_type_idx" ON "skill_triggers" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_tasks_user_id_idx" ON "background_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_tasks_workspace_id_idx" ON "background_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_tasks_status_idx" ON "background_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_tasks_type_idx" ON "background_tasks" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_tasks_next_run_at_idx" ON "background_tasks" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_automation_id_idx" ON "automation_runs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_status_idx" ON "automation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_started_at_idx" ON "automation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_step_runs_run_id_idx" ON "automation_step_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_workspace_id_idx" ON "automations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_status_idx" ON "automations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_trigger_type_idx" ON "automations" USING btree ("trigger_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_next_run_at_idx" ON "automations" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_created_by_idx" ON "automations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_invitations_email" ON "admin_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_invitations_token_hash" ON "admin_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provisioning_tokens_token_hash" ON "provisioning_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_links_message_id_idx" ON "message_links" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_links_target_idx" ON "message_links" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_links_relationship_idx" ON "message_links" USING btree ("relationship_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_links_user_id_idx" ON "message_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_links_workspace_id_idx" ON "message_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_configs_user_id_idx" ON "agent_configs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_configs_workspace_id_idx" ON "agent_configs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_configs_agent_type_idx" ON "agent_configs" USING btree ("agent_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_workspace_id_idx" ON "mcp_servers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_status_idx" ON "mcp_servers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_defs_value_type_idx" ON "property_defs" USING btree ("value_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_defs_profile_id_idx" ON "property_defs" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_workspace_access_workspace_idx" ON "profile_workspace_access" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_parent_profile_id_idx" ON "profiles" USING btree ("parent_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_scope_idx" ON "profiles" USING btree ("scope","workspace_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_properties_profile_id_idx" ON "profile_properties" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_properties_property_def_id_idx" ON "profile_properties" USING btree ("property_def_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_text_idx" ON "entity_property_index" USING btree ("property_def_id","value_text");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_num_idx" ON "entity_property_index" USING btree ("property_def_id","value_num");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_bool_idx" ON "entity_property_index" USING btree ("property_def_id","value_bool");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_ts_idx" ON "entity_property_index" USING btree ("property_def_id","value_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_entity_idx" ON "entity_property_index" USING btree ("property_def_id","value_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_property_index_entity_id_idx" ON "entity_property_index" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relation_defs_workspace_id_idx" ON "relation_defs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_relations_source_profile_id_idx" ON "profile_relations" USING btree ("source_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_relations_target_profile_id_idx" ON "profile_relations" USING btree ("target_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_relations_relation_def_id_idx" ON "profile_relations" USING btree ("relation_def_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_audit_log_secret_id" ON "secret_audit_log" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_audit_log_user_id" ON "secret_audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_audit_log_created_at" ON "secret_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_shares_secret_id" ON "secret_shares" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_shares_shared_with_user" ON "secret_shares" USING btree ("shared_with_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_shares_shared_with_workspace" ON "secret_shares" USING btree ("shared_with_workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secret_tags_tag" ON "secret_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_user_id" ON "secrets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_workspace_id" ON "secrets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_type" ON "secrets" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_category" ON "secrets" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_url" ON "secrets" USING btree ("url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_deleted_at" ON "secrets" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_user_type" ON "secrets" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_service_id" ON "secrets" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_encryption_mode" ON "secrets" USING btree ("encryption_mode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_secrets_user_service" ON "secrets" USING btree ("user_id","service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_channel_id_idx" ON "sessions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_channel_status_idx" ON "sessions" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_started_at_idx" ON "sessions" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compacted_states_channel_version_idx" ON "compacted_states" USING btree ("channel_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "widget_def_type_key_workspace_uniq" ON "widget_definitions" USING btree ("type_key","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_def_workspace_id_idx" ON "widget_definitions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_def_is_active_idx" ON "widget_definitions" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_external_links_provider_external_id_idx" ON "entity_external_links" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_external_links_entity_id_idx" ON "entity_external_links" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_external_links_provider_idx" ON "entity_external_links" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_external_links_nango_connection_id_idx" ON "entity_external_links" USING btree ("nango_connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_external_links_status_idx" ON "entity_external_links" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_identity_signals_type_value_idx" ON "entity_identity_signals" USING btree ("signal_type","signal_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_identity_signals_entity_id_idx" ON "entity_identity_signals" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_identity_signals_signal_type_idx" ON "entity_identity_signals" USING btree ("signal_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_prefs_user_workspace_idx" ON "notification_preferences" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifs_user_workspace_status_idx" ON "notifications" USING btree ("user_id","workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifs_group_key_idx" ON "notifications" USING btree ("group_key","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifs_source_idx" ON "notifications" USING btree ("source_type","source_id");