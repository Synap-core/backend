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
CREATE TABLE "entity_templates" (
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
ALTER TABLE "user_preferences" ADD COLUMN "custom_theme" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "default_templates" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "custom_entity_types" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "entity_metadata_schemas" jsonb;--> statement-breakpoint
ALTER TABLE "entity_templates" ADD CONSTRAINT "entity_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_templates_user" ON "entity_templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_templates_workspace" ON "entity_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_templates_target_type" ON "entity_templates" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX "idx_templates_entity_type" ON "entity_templates" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "idx_templates_inbox_type" ON "entity_templates" USING btree ("inbox_item_type");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_check" CHECK ("api_keys"."user_id" IS NOT NULL AND LENGTH(TRIM("api_keys"."user_id")) > 0);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_name_check" CHECK (LENGTH(TRIM("api_keys"."key_name")) > 0);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_prefix_check" CHECK ("api_keys"."key_prefix" IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_'));