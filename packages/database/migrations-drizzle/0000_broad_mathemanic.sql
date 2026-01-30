CREATE TABLE "user_preferences" (
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
CREATE TABLE "users" (
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
CREATE TABLE "events" (
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
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_ids" uuid[],
	"type" text NOT NULL,
	"title" text,
	"preview" text,
	"document_id" uuid,
	"metadata" jsonb DEFAULT '{}',
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entity_vectors" (
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
CREATE TABLE "document_sessions" (
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
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"type" text DEFAULT 'manual' NOT NULL,
	"content" text NOT NULL,
	"delta" jsonb,
	"author" text NOT NULL,
	"author_id" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_ids" uuid[],
	"title" text NOT NULL,
	"type" text NOT NULL,
	"language" text,
	"storage_url" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" integer NOT NULL,
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
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_ids" uuid[],
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_ids" uuid[],
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
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
CREATE TABLE "knowledge_facts" (
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
CREATE TABLE "ai_suggestions" (
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
CREATE TABLE "api_keys" (
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
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_user_id_check" CHECK ("api_keys"."user_id" IS NOT NULL AND LENGTH(TRIM("api_keys"."user_id")) > 0),
	CONSTRAINT "api_keys_key_name_check" CHECK (LENGTH(TRIM("api_keys"."key_name")) > 0),
	CONSTRAINT "api_keys_key_prefix_check" CHECK ("api_keys"."key_prefix" IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
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
CREATE TABLE "webhook_subscriptions" (
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
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_ids" uuid[],
	"title" text,
	"thread_type" text DEFAULT 'main' NOT NULL,
	"parent_thread_id" uuid,
	"branched_from_message_id" uuid,
	"branch_purpose" text,
	"agent_id" text DEFAULT 'orchestrator' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"agent_type" text DEFAULT 'default' NOT NULL,
	"agent_config" jsonb,
	"context_summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "agents" (
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
CREATE TABLE "projects" (
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
CREATE TABLE "roles" (
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
CREATE TABLE "resource_shares" (
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
CREATE TABLE "entity_enrichments" (
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
CREATE TABLE "entity_relationships" (
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
CREATE TABLE "reasoning_traces" (
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
CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_ids" uuid[],
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
CREATE TABLE "user_entity_state" (
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
CREATE TABLE "intelligence_services" (
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
CREATE TABLE "workspace_invites" (
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
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
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
CREATE TABLE "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"project_ids" uuid[],
	"type" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"document_id" uuid,
	"yjs_room_id" text,
	"thumbnail_url" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"proposal_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"comments" jsonb DEFAULT '[]',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"user_id" text,
	"workspace_id" uuid,
	"project_ids" uuid[],
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
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"code" text NOT NULL,
	"parameters" jsonb,
	"category" text,
	"execution_mode" text DEFAULT 'sync' NOT NULL,
	"timeout_seconds" integer DEFAULT 30,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_tasks" (
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
CREATE TABLE "admin_invitations" (
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
ALTER TABLE "entities" ADD CONSTRAINT "entities_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_vectors" ADD CONSTRAINT "entity_vectors_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sessions" ADD CONSTRAINT "document_sessions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_source_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entities" ADD CONSTRAINT "thread_entities_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_source_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_enrichments" ADD CONSTRAINT "entity_enrichments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_templates" ADD CONSTRAINT "entity_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_tasks" ADD CONSTRAINT "background_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_subject" ON "events" USING btree ("subject_type","subject_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_events_user_type" ON "events" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "idx_events_timestamp" ON "events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "document_sessions_document_id_idx" ON "document_sessions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_sessions_user_id_idx" ON "document_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_sessions_active_idx" ON "document_sessions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "document_versions_document_id_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_versions_version_idx" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "chat_threads_user_id_idx" ON "chat_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_threads_parent_thread_id_idx" ON "chat_threads" USING btree ("parent_thread_id");--> statement-breakpoint
CREATE INDEX "chat_threads_project_ids_idx" ON "chat_threads" USING btree ("project_ids");--> statement-breakpoint
CREATE INDEX "chat_threads_status_idx" ON "chat_threads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "thread_entities_thread_id_idx" ON "thread_entities" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_entities_entity_id_idx" ON "thread_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "thread_entities_user_id_idx" ON "thread_entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_entities_workspace_id_idx" ON "thread_entities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "thread_entities_conflict_idx" ON "thread_entities" USING btree ("conflict_status");--> statement-breakpoint
CREATE INDEX "thread_documents_thread_id_idx" ON "thread_documents" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_documents_document_id_idx" ON "thread_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "thread_documents_user_id_idx" ON "thread_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_documents_workspace_id_idx" ON "thread_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "thread_documents_conflict_idx" ON "thread_documents" USING btree ("conflict_status");--> statement-breakpoint
CREATE INDEX "agents_created_by_idx" ON "agents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_active_idx" ON "agents" USING btree ("active");--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "entity_enrichments_entity_id_idx" ON "entity_enrichments" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "entity_enrichments_user_id_idx" ON "entity_enrichments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "entity_enrichments_type_idx" ON "entity_enrichments" USING btree ("enrichment_type");--> statement-breakpoint
CREATE INDEX "entity_enrichments_entity_user_idx" ON "entity_enrichments" USING btree ("entity_id","user_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_source_idx" ON "entity_relationships" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_target_idx" ON "entity_relationships" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_user_id_idx" ON "entity_relationships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reasoning_traces_subject_idx" ON "reasoning_traces" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "reasoning_traces_user_id_idx" ON "reasoning_traces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reasoning_traces_agent_idx" ON "reasoning_traces" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_user_status" ON "inbox_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_inbox_provider" ON "inbox_items" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_inbox_timestamp" ON "inbox_items" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_inbox_snoozed" ON "inbox_items" USING btree ("user_id","snoozed_until");--> statement-breakpoint
CREATE INDEX "idx_inbox_priority" ON "inbox_items" USING btree ("user_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbox_external_unique" ON "inbox_items" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_user_state_starred" ON "user_entity_state" USING btree ("user_id","starred");--> statement-breakpoint
CREATE INDEX "idx_user_state_pinned" ON "user_entity_state" USING btree ("user_id","pinned");--> statement-breakpoint
CREATE INDEX "idx_user_state_viewed" ON "user_entity_state" USING btree ("user_id","last_viewed_at");--> statement-breakpoint
CREATE INDEX "idx_project_members_project" ON "project_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user_project" ON "project_members" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_proposals_workspace_status" ON "proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_proposals_target" ON "proposals" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_templates_user" ON "entity_templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_templates_workspace" ON "entity_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_templates_target_type" ON "entity_templates" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX "idx_templates_entity_type" ON "entity_templates" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "idx_templates_inbox_type" ON "entity_templates" USING btree ("inbox_item_type");--> statement-breakpoint
CREATE INDEX "skills_user_id_idx" ON "skills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skills_workspace_id_idx" ON "skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "skills_status_idx" ON "skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "skills_name_idx" ON "skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX "background_tasks_user_id_idx" ON "background_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "background_tasks_workspace_id_idx" ON "background_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "background_tasks_status_idx" ON "background_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "background_tasks_type_idx" ON "background_tasks" USING btree ("type");--> statement-breakpoint
CREATE INDEX "background_tasks_next_run_at_idx" ON "background_tasks" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_admin_invitations_email" ON "admin_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_admin_invitations_token_hash" ON "admin_invitations" USING btree ("token_hash");