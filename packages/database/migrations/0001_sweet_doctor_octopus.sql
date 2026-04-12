CREATE TABLE IF NOT EXISTS "signal_auto_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_entity_id" uuid NOT NULL,
	"linked_entity_id" uuid NOT NULL,
	"link_type" text NOT NULL,
	"link_strength" numeric(3, 2) DEFAULT '0.50' NOT NULL,
	"link_context" text,
	"source" text NOT NULL,
	"source_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_auto_links_signal_entity_id_linked_entity_id_link_type_pk" PRIMARY KEY("signal_entity_id","linked_entity_id","link_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.00' NOT NULL,
	"source_type" text NOT NULL,
	"source_entity_id" uuid,
	"source_signal_id" uuid,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"total_weight" numeric(6, 3) DEFAULT '1.000' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decay_rate" numeric(3, 2) DEFAULT '0.95' NOT NULL,
	"last_decay_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_classifications_user_id_workspace_id_topic_pk" PRIMARY KEY("user_id","workspace_id","topic")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_fetch_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_route" text NOT NULL,
	"source_platform" text NOT NULL,
	"fetch_type" text NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"duration_ms" integer NOT NULL,
	"response_size_bytes" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"client_ip" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"source_platform" text,
	"source_route" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.50' NOT NULL,
	"notification_preference" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fetched_at" timestamp with time zone,
	CONSTRAINT "signal_subscriptions_user_id_workspace_id_topic_source_platform_source_route_pk" PRIMARY KEY("user_id","workspace_id","topic","source_platform","source_route")
);
--> statement-breakpoint
ALTER TABLE "signal_auto_links" DROP CONSTRAINT IF EXISTS "signal_auto_links_signal_entity_id_entities_id_fk";
ALTER TABLE "signal_auto_links" ADD CONSTRAINT "signal_auto_links_signal_entity_id_entities_id_fk" FOREIGN KEY ("signal_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_auto_links" DROP CONSTRAINT IF EXISTS "signal_auto_links_linked_entity_id_entities_id_fk";
ALTER TABLE "signal_auto_links" ADD CONSTRAINT "signal_auto_links_linked_entity_id_entities_id_fk" FOREIGN KEY ("linked_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_classifications" DROP CONSTRAINT IF EXISTS "signal_classifications_user_id_users_id_fk";
ALTER TABLE "signal_classifications" ADD CONSTRAINT "signal_classifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_classifications" DROP CONSTRAINT IF EXISTS "signal_classifications_workspace_id_workspaces_id_fk";
ALTER TABLE "signal_classifications" ADD CONSTRAINT "signal_classifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_classifications" DROP CONSTRAINT IF EXISTS "signal_classifications_source_signal_id_entities_id_fk";
ALTER TABLE "signal_classifications" ADD CONSTRAINT "signal_classifications_source_signal_id_entities_id_fk" FOREIGN KEY ("source_signal_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_fetch_history" DROP CONSTRAINT IF EXISTS "signal_fetch_history_user_id_users_id_fk";
ALTER TABLE "signal_fetch_history" ADD CONSTRAINT "signal_fetch_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_fetch_history" DROP CONSTRAINT IF EXISTS "signal_fetch_history_workspace_id_workspaces_id_fk";
ALTER TABLE "signal_fetch_history" ADD CONSTRAINT "signal_fetch_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_subscriptions" DROP CONSTRAINT IF EXISTS "signal_subscriptions_user_id_users_id_fk";
ALTER TABLE "signal_subscriptions" ADD CONSTRAINT "signal_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_subscriptions" DROP CONSTRAINT IF EXISTS "signal_subscriptions_workspace_id_workspaces_id_fk";
ALTER TABLE "signal_subscriptions" ADD CONSTRAINT "signal_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_auto_links_signal_idx" ON "signal_auto_links" USING btree ("signal_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_auto_links_linked_idx" ON "signal_auto_links" USING btree ("linked_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_auto_links_strength_idx" ON "signal_auto_links" USING btree ("link_strength" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_classifications_confidence_idx" ON "signal_classifications" USING btree ("confidence" DESC NULLS LAST) WHERE "signal_classifications"."confidence" > $1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_classifications_recency_idx" ON "signal_classifications" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_fetch_history_user_time_idx" ON "signal_fetch_history" USING btree ("user_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_fetch_history_platform_idx" ON "signal_fetch_history" USING btree ("source_platform","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_subscriptions_user_workspace_idx" ON "signal_subscriptions" USING btree ("user_id","workspace_id") WHERE "signal_subscriptions"."is_active" = $1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_subscriptions_topic_idx" ON "signal_subscriptions" USING btree ("topic") WHERE "signal_subscriptions"."is_active" = $1;