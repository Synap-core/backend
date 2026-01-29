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