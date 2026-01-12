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