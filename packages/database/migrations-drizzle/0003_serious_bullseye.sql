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