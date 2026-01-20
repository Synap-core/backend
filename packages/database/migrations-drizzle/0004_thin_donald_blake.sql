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