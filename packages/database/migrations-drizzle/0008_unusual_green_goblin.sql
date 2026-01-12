ALTER TABLE "document_versions" ADD COLUMN "type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "last_saved_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "working_state" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "working_state_updated_at" timestamp with time zone;