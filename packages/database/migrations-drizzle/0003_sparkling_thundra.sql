CREATE TABLE "property_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"value_type" text NOT NULL,
	"constraints" jsonb DEFAULT '{}' NOT NULL,
	"ui_hints" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_defs_slug_unique_idx" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"parent_profile_id" uuid,
	"ui_hints" jsonb DEFAULT '{}' NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"user_id" text,
	"workspace_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_slug_unique_idx" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "profile_properties" (
	"profile_id" uuid NOT NULL,
	"property_def_id" uuid NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "profile_properties_profile_id_property_def_id_pk" PRIMARY KEY("profile_id","property_def_id")
);
--> statement-breakpoint
CREATE TABLE "entity_property_index" (
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
ALTER TABLE "entities" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "properties" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_properties" ADD CONSTRAINT "profile_properties_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_properties" ADD CONSTRAINT "profile_properties_property_def_id_property_defs_id_fk" FOREIGN KEY ("property_def_id") REFERENCES "public"."property_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_property_index" ADD CONSTRAINT "entity_property_index_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_property_index" ADD CONSTRAINT "entity_property_index_property_def_id_property_defs_id_fk" FOREIGN KEY ("property_def_id") REFERENCES "public"."property_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "property_defs_value_type_idx" ON "property_defs" USING btree ("value_type");--> statement-breakpoint
CREATE INDEX "profiles_parent_profile_id_idx" ON "profiles" USING btree ("parent_profile_id");--> statement-breakpoint
CREATE INDEX "profiles_scope_idx" ON "profiles" USING btree ("scope","workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "profile_properties_profile_id_idx" ON "profile_properties" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "profile_properties_property_def_id_idx" ON "profile_properties" USING btree ("property_def_id");--> statement-breakpoint
CREATE INDEX "entity_property_index_property_value_text_idx" ON "entity_property_index" USING btree ("property_def_id","value_text");--> statement-breakpoint
CREATE INDEX "entity_property_index_property_value_num_idx" ON "entity_property_index" USING btree ("property_def_id","value_num");--> statement-breakpoint
CREATE INDEX "entity_property_index_property_value_bool_idx" ON "entity_property_index" USING btree ("property_def_id","value_bool");--> statement-breakpoint
CREATE INDEX "entity_property_index_property_value_ts_idx" ON "entity_property_index" USING btree ("property_def_id","value_ts");--> statement-breakpoint
CREATE INDEX "entity_property_index_property_value_entity_idx" ON "entity_property_index" USING btree ("property_def_id","value_entity_id");--> statement-breakpoint
CREATE INDEX "entity_property_index_entity_id_idx" ON "entity_property_index" USING btree ("entity_id");--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;