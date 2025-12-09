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