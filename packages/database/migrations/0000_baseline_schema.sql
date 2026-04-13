-- ============================================================================
-- 0000_baseline_schema.sql — Complete Baseline Schema
-- ============================================================================
--
-- This file creates the full Synap data-pod schema from scratch.
-- Every statement is idempotent (IF NOT EXISTS / IF NOT EXISTS guards).
-- It is safe to run on an empty DB or on a fully-provisioned pod.
--
-- At the end of this file, every legacy migration filename is inserted
-- into _migrations so the runner skips them on existing pods.
-- ============================================================================

-- ─── Extensions ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ─── Enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "secret_type" AS ENUM (
    'password', 'api_key', 'credential', 'note', 'card',
    'identity', 'ssh_key', 'certificate', 'env_variable',
    'database', 'oauth'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

-- ─── 1. users ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "users" (
  "id"                  text        PRIMARY KEY,
  "email"               text        NOT NULL UNIQUE,
  "name"                text,
  "email_verified"      boolean     NOT NULL DEFAULT false,
  "avatar_url"          text,
  "timezone"            text        NOT NULL DEFAULT 'UTC',
  "locale"              text        NOT NULL DEFAULT 'en',
  "user_type"           text        NOT NULL DEFAULT 'human',
  "agent_metadata"      jsonb,
  "kratos_identity_id"  text,
  "last_synced_at"      timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'UTC';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" text DEFAULT 'en';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "user_type" text DEFAULT 'human';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_metadata" jsonb;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kratos_identity_id" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

-- ─── 2. workspaces + workspace_members + invites ─────────────────────────────

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"            text        NOT NULL,
  "name"                text        NOT NULL,
  "description"         text,
  "type"                text        NOT NULL DEFAULT 'personal',
  "settings"            jsonb       NOT NULL DEFAULT '{}',
  "subscription_tier"   text,
  "subscription_status" text,
  "stripe_customer_id"  text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "owner_id" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'personal';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "settings" jsonb DEFAULT '{}';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "subscription_tier" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "subscription_status" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id"            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"  uuid  NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"       text  NOT NULL,
  "role"          text  NOT NULL,
  "joined_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "invited_by"    text
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "joined_at" timestamp with time zone DEFAULT now();
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "invited_by" text;

CREATE TABLE IF NOT EXISTS "invites" (
  "id"            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"          text  NOT NULL,
  "workspace_id"  uuid  REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email"         text  NOT NULL,
  "role"          text  NOT NULL,
  "token"         text  NOT NULL UNIQUE,
  "invited_by"    text  NOT NULL,
  "expires_at"    timestamp with time zone NOT NULL,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "token" text;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "invited_by" text;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

-- ─── 3. events ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "events" (
  "id"             uuid      NOT NULL DEFAULT gen_random_uuid(),
  "timestamp"      timestamp with time zone NOT NULL DEFAULT now(),
  "type"           text      NOT NULL,
  "subject_id"     text      NOT NULL,
  "subject_type"   text      NOT NULL,
  "data"           jsonb     NOT NULL,
  "metadata"       jsonb,
  "source"         text      DEFAULT 'api',
  "correlation_id" uuid,
  "user_id"        text      NOT NULL,
  PRIMARY KEY ("id", "timestamp")
);
-- NOTE: No ALTER TABLE guard for "events" — it is a TimescaleDB hypertable
-- with columnstore compression. ALTER TABLE ADD COLUMN with non-constant defaults
-- is not supported on compressed hypertables. The CREATE TABLE IF NOT EXISTS above
-- handles fresh installs; existing hypertables already have the correct schema.

CREATE INDEX IF NOT EXISTS "idx_events_subject"
  ON "events" ("subject_type", "subject_id", "timestamp");

CREATE INDEX IF NOT EXISTS "idx_events_user_type"
  ON "events" ("user_id", "type");

CREATE INDEX IF NOT EXISTS "idx_events_timestamp"
  ON "events" ("timestamp");

-- ─── 4. profiles + profile_workspace_access ──────────────────────────────────

CREATE TABLE IF NOT EXISTS "profiles" (
  "id"               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"             text    NOT NULL,
  "display_name"     text    NOT NULL,
  "parent_profile_id" uuid,
  "ui_hints"         jsonb   NOT NULL DEFAULT '{}',
  "default_values"   jsonb   NOT NULL DEFAULT '{}',
  "semantic_slug"    text,
  "scope"            text    NOT NULL DEFAULT 'workspace',
  "user_id"          text,
  "workspace_id"     uuid    REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_scope"     text    NOT NULL DEFAULT 'workspace',
  "is_active"        boolean NOT NULL DEFAULT true,
  "version"          integer NOT NULL DEFAULT 1,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "parent_profile_id" uuid;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "ui_hints" jsonb DEFAULT '{}';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "default_values" jsonb DEFAULT '{}';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "semantic_slug" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'workspace';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "entity_scope" text DEFAULT 'workspace';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

-- Self-reference FK for parent_profile_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'profiles' AND constraint_name = 'profiles_parent_profile_id_fkey'
  ) THEN
    ALTER TABLE "profiles"
      ADD CONSTRAINT "profiles_parent_profile_id_fkey"
      FOREIGN KEY ("parent_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL;
  END IF;
END; $$;

CREATE INDEX IF NOT EXISTS "profiles_parent_profile_id_idx"
  ON "profiles" ("parent_profile_id");

CREATE INDEX IF NOT EXISTS "profiles_scope_idx"
  ON "profiles" ("scope", "workspace_id", "user_id");

-- Partial unique indexes for slug scoping (migration 0052)
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_system_shared_uniq"
  ON "profiles" ("slug")
  WHERE "scope" IN ('system', 'shared');

CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_workspace_uniq"
  ON "profiles" ("slug", "workspace_id")
  WHERE "scope" = 'workspace';

CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_user_uniq"
  ON "profiles" ("slug", "user_id")
  WHERE "scope" = 'user';

CREATE TABLE IF NOT EXISTS "profile_workspace_access" (
  "profile_id"    uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "workspace_id"  uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "granted_at"    timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("profile_id", "workspace_id")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "profile_workspace_access" ADD COLUMN IF NOT EXISTS "profile_id" uuid REFERENCES "profiles"("id") ON DELETE CASCADE;
ALTER TABLE "profile_workspace_access" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "profile_workspace_access" ADD COLUMN IF NOT EXISTS "granted_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "profile_workspace_access_workspace_idx"
  ON "profile_workspace_access" ("workspace_id");

-- ─── 5. relation_defs ────────────────────────────────────────────────────────
-- Must come before property_defs (which references it)

CREATE TABLE IF NOT EXISTS "relation_defs" (
  "id"              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"            text    NOT NULL,
  "display_name"    text    NOT NULL,
  "description"     text,
  "workspace_id"    uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"         text    NOT NULL,
  "ui_hints"        jsonb   NOT NULL DEFAULT '{}',
  "is_directional"  boolean NOT NULL DEFAULT true,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "relation_defs_slug_workspace_unique" UNIQUE ("slug", "workspace_id")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "ui_hints" jsonb DEFAULT '{}';
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "is_directional" boolean DEFAULT true;
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "relation_defs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "relation_defs_workspace_id_idx"
  ON "relation_defs" ("workspace_id");

-- ─── 6. property_defs ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "property_defs" (
  "id"                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"              text  NOT NULL,
  "profile_id"        uuid  REFERENCES "profiles"("id") ON DELETE CASCADE,
  "workspace_id"      uuid  REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "value_type"        text  NOT NULL,
  "constraints"       jsonb NOT NULL DEFAULT '{}',
  "ui_hints"          jsonb NOT NULL DEFAULT '{}',
  "relation_def_id"   uuid  REFERENCES "relation_defs"("id") ON DELETE SET NULL,
  "target_profile_id" uuid  REFERENCES "profiles"("id") ON DELETE SET NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "profile_id" uuid REFERENCES "profiles"("id") ON DELETE CASCADE;
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "value_type" text;
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "constraints" jsonb DEFAULT '{}';
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "ui_hints" jsonb DEFAULT '{}';
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "relation_def_id" uuid REFERENCES "relation_defs"("id") ON DELETE SET NULL;
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "target_profile_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL;
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "property_defs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "property_defs_value_type_idx"
  ON "property_defs" ("value_type");

CREATE INDEX IF NOT EXISTS "property_defs_profile_id_idx"
  ON "property_defs" ("profile_id");

CREATE INDEX IF NOT EXISTS "property_defs_relation_def_id_idx"
  ON "property_defs" ("relation_def_id")
  WHERE "relation_def_id" IS NOT NULL;

-- Partial unique indexes for property_defs scoping (migration 0065)
CREATE UNIQUE INDEX IF NOT EXISTS "property_defs_global_slug_uniq"
  ON "property_defs" ("slug")
  WHERE "profile_id" IS NULL AND "workspace_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "property_defs_profile_base_slug_uniq"
  ON "property_defs" ("slug", "profile_id")
  WHERE "workspace_id" IS NULL AND "profile_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "property_defs_workspace_overlay_slug_uniq"
  ON "property_defs" ("slug", "profile_id", "workspace_id")
  WHERE "workspace_id" IS NOT NULL AND "profile_id" IS NOT NULL;

-- ─── 7. profile_properties ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "profile_properties" (
  "profile_id"      uuid    NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "property_def_id" uuid    NOT NULL REFERENCES "property_defs"("id") ON DELETE CASCADE,
  "required"        boolean NOT NULL DEFAULT false,
  "default_value"   jsonb,
  "display_order"   integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("profile_id", "property_def_id")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "profile_properties" ADD COLUMN IF NOT EXISTS "profile_id" uuid REFERENCES "profiles"("id") ON DELETE CASCADE;
ALTER TABLE "profile_properties" ADD COLUMN IF NOT EXISTS "property_def_id" uuid REFERENCES "property_defs"("id") ON DELETE CASCADE;
ALTER TABLE "profile_properties" ADD COLUMN IF NOT EXISTS "required" boolean DEFAULT false;
ALTER TABLE "profile_properties" ADD COLUMN IF NOT EXISTS "default_value" jsonb;
ALTER TABLE "profile_properties" ADD COLUMN IF NOT EXISTS "display_order" integer DEFAULT 0;

CREATE INDEX IF NOT EXISTS "profile_properties_profile_id_idx"
  ON "profile_properties" ("profile_id");

CREATE INDEX IF NOT EXISTS "profile_properties_property_def_id_idx"
  ON "profile_properties" ("property_def_id");

-- ─── 8. profile_relations ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "profile_relations" (
  "source_profile_id" uuid    NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "target_profile_id" uuid    NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "relation_def_id"   uuid    NOT NULL REFERENCES "relation_defs"("id") ON DELETE CASCADE,
  "display_order"     integer NOT NULL DEFAULT 0,
  "property_def_id"   uuid    REFERENCES "property_defs"("id") ON DELETE SET NULL,
  "metadata"          jsonb   NOT NULL DEFAULT '{}',
  PRIMARY KEY ("source_profile_id", "target_profile_id", "relation_def_id")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "profile_relations" ADD COLUMN IF NOT EXISTS "source_profile_id" uuid REFERENCES "profiles"("id") ON DELETE CASCADE;
ALTER TABLE "profile_relations" ADD COLUMN IF NOT EXISTS "target_profile_id" uuid REFERENCES "profiles"("id") ON DELETE CASCADE;
ALTER TABLE "profile_relations" ADD COLUMN IF NOT EXISTS "relation_def_id" uuid REFERENCES "relation_defs"("id") ON DELETE CASCADE;
ALTER TABLE "profile_relations" ADD COLUMN IF NOT EXISTS "display_order" integer DEFAULT 0;
ALTER TABLE "profile_relations" ADD COLUMN IF NOT EXISTS "property_def_id" uuid REFERENCES "property_defs"("id") ON DELETE SET NULL;
ALTER TABLE "profile_relations" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "profile_relations_source_profile_id_idx"
  ON "profile_relations" ("source_profile_id");

CREATE INDEX IF NOT EXISTS "profile_relations_target_profile_id_idx"
  ON "profile_relations" ("target_profile_id");

CREATE INDEX IF NOT EXISTS "profile_relations_relation_def_id_idx"
  ON "profile_relations" ("relation_def_id");

-- ─── 9. documents (created before entities because entities refs documents) ──

CREATE TABLE IF NOT EXISTS "documents" (
  "id"                       uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                  text    NOT NULL,
  "workspace_id"             uuid    NOT NULL,
  "title"                    text    NOT NULL,
  "type"                     text    NOT NULL,
  "language"                 text,
  "storage_url"              text,
  "storage_key"              text,
  "size"                     integer NOT NULL DEFAULT 0,
  "mime_type"                text,
  "current_version"          integer NOT NULL DEFAULT 1,
  "last_saved_version"       integer NOT NULL DEFAULT 0,
  "working_state"            text,
  "working_state_updated_at" timestamp with time zone,
  "metadata"                 jsonb,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"               timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at"               timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "language" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "storage_url" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "storage_key" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "size" integer DEFAULT 0;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "mime_type" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "current_version" integer DEFAULT 1;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "last_saved_version" integer DEFAULT 0;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "working_state" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "working_state_updated_at" timestamp with time zone;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "documents_user_id_idx" ON "documents" ("user_id");
CREATE INDEX IF NOT EXISTS "documents_type_idx"    ON "documents" ("type");

CREATE TABLE IF NOT EXISTS "document_versions" (
  "id"          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid    NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "version"     integer NOT NULL,
  "content"     text    NOT NULL,
  "author"      text    NOT NULL,
  "author_id"   text    NOT NULL,
  "message"     text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "document_id" uuid REFERENCES "documents"("id") ON DELETE CASCADE;
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "version" integer;
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "content" text;
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "author" text;
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "author_id" text;
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "message" text;
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "document_versions_document_id_idx"
  ON "document_versions" ("document_id");

CREATE INDEX IF NOT EXISTS "document_versions_version_idx"
  ON "document_versions" ("document_id", "version");

CREATE TABLE IF NOT EXISTS "document_sessions" (
  "id"                   uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id"          uuid    NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "user_id"              text    NOT NULL,
  "channel_id"           uuid    NOT NULL,
  "is_active"            boolean NOT NULL DEFAULT true,
  "active_collaborators" jsonb,
  "started_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at"             timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "document_id" uuid REFERENCES "documents"("id") ON DELETE CASCADE;
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "channel_id" uuid;
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "active_collaborators" jsonb;
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now();
ALTER TABLE "document_sessions" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "document_sessions_document_id_idx"
  ON "document_sessions" ("document_id");

CREATE INDEX IF NOT EXISTS "document_sessions_user_id_idx"
  ON "document_sessions" ("user_id");

CREATE INDEX IF NOT EXISTS "document_sessions_active_idx"
  ON "document_sessions" ("is_active");

-- ─── 10. entities ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entities" (
  "id"           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text    NOT NULL,
  "workspace_id" uuid,
  "profile_id"   uuid    REFERENCES "profiles"("id") ON DELETE SET NULL,
  "type"         text    NOT NULL,
  "title"        text,
  "preview"      text,
  "document_id"  uuid    REFERENCES "documents"("id") ON DELETE SET NULL,
  "properties"   jsonb   NOT NULL DEFAULT '{}',
  "system_data"  jsonb   NOT NULL DEFAULT '{}',
  "version"      integer NOT NULL DEFAULT 1,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at"   timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "profile_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "preview" text;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "properties" jsonb DEFAULT '{}';
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "system_data" jsonb DEFAULT '{}';
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "entities_workspace_id_idx"
  ON "entities" ("workspace_id");

CREATE INDEX IF NOT EXISTS "entities_user_id_idx"
  ON "entities" ("user_id");

CREATE INDEX IF NOT EXISTS "entities_workspace_user_deleted_idx"
  ON "entities" ("workspace_id", "user_id", "deleted_at");

CREATE INDEX IF NOT EXISTS "entities_profile_id_idx"
  ON "entities" ("profile_id");

CREATE INDEX IF NOT EXISTS "entities_type_workspace_idx"
  ON "entities" ("type", "workspace_id");

CREATE INDEX IF NOT EXISTS "entities_document_id_idx"
  ON "entities" ("document_id")
  WHERE "document_id" IS NOT NULL;

-- ─── 11. entity_property_index ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_property_index" (
  "entity_id"       uuid    NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "property_def_id" uuid    NOT NULL REFERENCES "property_defs"("id") ON DELETE CASCADE,
  "value_text"      text,
  "value_num"       numeric,
  "value_bool"      boolean,
  "value_ts"        timestamp with time zone,
  "value_entity_id" uuid,
  "value_jsonb"     jsonb,
  PRIMARY KEY ("entity_id", "property_def_id")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "property_def_id" uuid REFERENCES "property_defs"("id") ON DELETE CASCADE;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "value_text" text;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "value_num" numeric;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "value_bool" boolean;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "value_ts" timestamp with time zone;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "value_entity_id" uuid;
ALTER TABLE "entity_property_index" ADD COLUMN IF NOT EXISTS "value_jsonb" jsonb;

CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_text_idx"
  ON "entity_property_index" ("property_def_id", "value_text");

CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_num_idx"
  ON "entity_property_index" ("property_def_id", "value_num");

CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_bool_idx"
  ON "entity_property_index" ("property_def_id", "value_bool");

CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_ts_idx"
  ON "entity_property_index" ("property_def_id", "value_ts");

CREATE INDEX IF NOT EXISTS "entity_property_index_property_value_entity_idx"
  ON "entity_property_index" ("property_def_id", "value_entity_id");

CREATE INDEX IF NOT EXISTS "entity_property_index_entity_id_idx"
  ON "entity_property_index" ("entity_id");

-- ─── 12. entity_vectors ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_vectors" (
  "entity_id"       uuid  PRIMARY KEY REFERENCES "entities"("id") ON DELETE CASCADE,
  "user_id"         text  NOT NULL,
  "embedding"       vector(1536),
  "embedding_model" text  NOT NULL DEFAULT 'text-embedding-3-small',
  "entity_type"     text  NOT NULL,
  "title"           text,
  "preview"         text,
  "file_url"        text,
  "indexed_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "embedding_model" text DEFAULT 'text-embedding-3-small';
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "entity_type" text;
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "preview" text;
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "file_url" text;
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "indexed_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entity_vectors" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "entity_vectors_user_id_idx"
  ON "entity_vectors" ("user_id");

-- HNSW index for cosine ANN search (pgvector)
CREATE INDEX IF NOT EXISTS "entity_vectors_embedding_hnsw_idx"
  ON "entity_vectors" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── 13. entity_external_links ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_external_links" (
  "id"                    uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id"             uuid  NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "provider"              text  NOT NULL,
  "external_id"           text  NOT NULL,
  "nango_connection_id"   text  NOT NULL,
  "status"                text  NOT NULL DEFAULT 'active',
  "sync_hash"             text,
  "last_synced_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "disconnected_at"       timestamp with time zone,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "provider" text;
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "external_id" text;
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "nango_connection_id" text;
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "sync_hash" text;
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "disconnected_at" timestamp with time zone;
ALTER TABLE "entity_external_links" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "entity_external_links_provider_external_id_idx"
  ON "entity_external_links" ("provider", "external_id");

CREATE INDEX IF NOT EXISTS "entity_external_links_entity_id_idx"
  ON "entity_external_links" ("entity_id");

CREATE INDEX IF NOT EXISTS "entity_external_links_provider_idx"
  ON "entity_external_links" ("provider");

CREATE INDEX IF NOT EXISTS "entity_external_links_nango_connection_id_idx"
  ON "entity_external_links" ("nango_connection_id");

CREATE INDEX IF NOT EXISTS "entity_external_links_status_idx"
  ON "entity_external_links" ("status");

-- ─── 14. entity_identity_signals ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_identity_signals" (
  "id"           uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id"    uuid  NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "signal_type"  text  NOT NULL,
  "signal_value" text  NOT NULL,
  "source"       text  NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_identity_signals" ADD COLUMN IF NOT EXISTS "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_identity_signals" ADD COLUMN IF NOT EXISTS "signal_type" text;
ALTER TABLE "entity_identity_signals" ADD COLUMN IF NOT EXISTS "signal_value" text;
ALTER TABLE "entity_identity_signals" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "entity_identity_signals" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "entity_identity_signals_type_value_idx"
  ON "entity_identity_signals" ("signal_type", "signal_value");

CREATE INDEX IF NOT EXISTS "entity_identity_signals_entity_id_idx"
  ON "entity_identity_signals" ("entity_id");

CREATE INDEX IF NOT EXISTS "entity_identity_signals_signal_type_idx"
  ON "entity_identity_signals" ("signal_type");

-- ─── 15. entity_templates ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_templates" (
  "id"               uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"             text    NOT NULL,
  "description"      text,
  "user_id"          text,
  "workspace_id"     uuid    REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "target_type"      text    NOT NULL,
  "entity_type"      text,
  "inbox_item_type"  text,
  "config"           jsonb   NOT NULL DEFAULT '{}',
  "schema"           jsonb,
  "is_default"       boolean NOT NULL DEFAULT false,
  "is_public"        boolean NOT NULL DEFAULT false,
  "version"          integer NOT NULL DEFAULT 1,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "valid_scope" CHECK (
    (user_id IS NOT NULL AND workspace_id IS NULL) OR
    (user_id IS NULL AND workspace_id IS NOT NULL)
  ),
  CONSTRAINT "target_type_check" CHECK (
    target_type IN ('entity', 'document', 'project', 'inbox_item')
  ),
  CONSTRAINT "unique_default_per_scope" UNIQUE (
    "user_id", "workspace_id", "target_type", "entity_type", "inbox_item_type", "is_default"
  )
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "target_type" text;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "entity_type" text;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "inbox_item_type" text;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}';
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "schema" jsonb;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1;
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entity_templates" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_templates_user"
  ON "entity_templates" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_templates_workspace"
  ON "entity_templates" ("workspace_id");

CREATE INDEX IF NOT EXISTS "idx_templates_target_type"
  ON "entity_templates" ("target_type");

CREATE INDEX IF NOT EXISTS "idx_templates_entity_type"
  ON "entity_templates" ("entity_type");

CREATE INDEX IF NOT EXISTS "idx_templates_inbox_type"
  ON "entity_templates" ("inbox_item_type");

-- ─── 16. relations ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "relations" (
  "id"               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          text  NOT NULL,
  "workspace_id"     uuid  NOT NULL,
  "source_entity_id" uuid  NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "target_entity_id" uuid  NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "type"             text  NOT NULL,
  "metadata"         jsonb DEFAULT '{}',
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "source_entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "target_entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "relations_source_entity_id_idx"
  ON "relations" ("source_entity_id");

CREATE INDEX IF NOT EXISTS "relations_target_entity_id_idx"
  ON "relations" ("target_entity_id");

CREATE INDEX IF NOT EXISTS "relations_workspace_id_idx"
  ON "relations" ("workspace_id");

CREATE INDEX IF NOT EXISTS "relations_type_idx"
  ON "relations" ("type");

-- ─── 17. views ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "views" (
  "id"                  uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"        uuid  REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"             text  NOT NULL,
  "type"                text  NOT NULL,
  "category"            text  NOT NULL,
  "name"                text  NOT NULL,
  "description"         text,
  "scope_profile_ids"   uuid[],
  "scope_mode"          text,
  "query"               jsonb DEFAULT '{}',
  "config"              jsonb DEFAULT '{}',
  "filter"              jsonb DEFAULT '{}',
  "sort"                jsonb DEFAULT '{}',
  "columns"             jsonb DEFAULT '[]',
  "layout_config"       jsonb DEFAULT '{}',
  "document_id"         uuid  REFERENCES "documents"("id") ON DELETE SET NULL,
  "yjs_room_id"         text,
  "thumbnail_url"       text,
  "schema_snapshot"     jsonb,
  "snapshot_updated_at" timestamp with time zone,
  "embedded_view_ids"   uuid[],
  "metadata"            jsonb NOT NULL DEFAULT '{}',
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "scope_profile_ids" uuid[];
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "scope_mode" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "query" jsonb DEFAULT '{}';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "filter" jsonb DEFAULT '{}';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "sort" jsonb DEFAULT '{}';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "columns" jsonb DEFAULT '[]';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "layout_config" jsonb DEFAULT '{}';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "yjs_room_id" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "thumbnail_url" text;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "schema_snapshot" jsonb;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "snapshot_updated_at" timestamp with time zone;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "embedded_view_ids" uuid[];
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "views_workspace_id_idx"
  ON "views" ("workspace_id");

CREATE INDEX IF NOT EXISTS "views_user_id_idx"
  ON "views" ("user_id");

CREATE INDEX IF NOT EXISTS "views_type_idx"
  ON "views" ("type");

-- ─── 18. channels ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "channels" (
  "id"                    uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"               text  NOT NULL,
  "workspace_id"          uuid,
  "title"                 text,
  "channel_type"          text  NOT NULL DEFAULT 'thread',
  "scope"                 text  NOT NULL DEFAULT 'workspace',
  "feed_scope"            text,
  "context_object_type"   text,
  "context_object_id"     uuid,
  "parent_channel_id"     uuid,
  "branched_from_message_id" uuid,
  "branch_purpose"        text,
  "agent_id"              text  NOT NULL DEFAULT 'orchestrator',
  "status"                text  NOT NULL DEFAULT 'active',
  "agent_type"            text  NOT NULL DEFAULT 'none',
  "agent_config"          jsonb,
  "mcp_server_id"         uuid[],
  "context_summary"       text,
  "result_summary"        text,
  "merged_into_state_id"  uuid,
  "external_source"       text,
  "external_channel_id"   text,
  "metadata"              jsonb,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "merged_at"             timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "channel_type" text DEFAULT 'thread';
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'workspace';
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "feed_scope" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "context_object_type" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "context_object_id" uuid;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "parent_channel_id" uuid;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "branched_from_message_id" uuid;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "branch_purpose" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "agent_id" text DEFAULT 'orchestrator';
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "agent_type" text DEFAULT 'none';
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "agent_config" jsonb;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "mcp_server_id" uuid[];
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "context_summary" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "result_summary" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "merged_into_state_id" uuid;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "external_source" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "external_channel_id" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "channels_user_id_idx"
  ON "channels" ("user_id");

CREATE INDEX IF NOT EXISTS "channels_workspace_id_idx"
  ON "channels" ("workspace_id");

CREATE INDEX IF NOT EXISTS "channels_parent_channel_id_idx"
  ON "channels" ("parent_channel_id");

CREATE INDEX IF NOT EXISTS "channels_status_idx"
  ON "channels" ("status");

CREATE INDEX IF NOT EXISTS "channels_context_idx"
  ON "channels" ("context_object_type", "context_object_id")
  WHERE "context_object_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "channels_scope_idx"
  ON "channels" ("scope");

CREATE INDEX IF NOT EXISTS "channels_type_idx"
  ON "channels" ("channel_type");

-- ─── 19. channel_connections + channel_link_tokens ───────────────────────────

CREATE TABLE IF NOT EXISTS "channel_connections" (
  "id"                  uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel"             text  NOT NULL,
  "channel_user_id"     text  NOT NULL,
  "user_id"             text  NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id"        uuid  REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "default_channel_id"  uuid  REFERENCES "channels"("id") ON DELETE SET NULL,
  "external_username"   text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "channel_connections_channel_user_unique" UNIQUE ("channel", "channel_user_id")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "channel" text;
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "channel_user_id" text;
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "default_channel_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL;
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "external_username" text;
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "channel_connections_channel_user_idx"
  ON "channel_connections" ("channel", "channel_user_id");

CREATE INDEX IF NOT EXISTS "channel_connections_user_idx"
  ON "channel_connections" ("user_id");

CREATE TABLE IF NOT EXISTS "channel_link_tokens" (
  "id"                  uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "token"               text  NOT NULL UNIQUE,
  "channel"             text  NOT NULL,
  "user_id"             text  NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id"        uuid  REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "default_channel_id"  uuid  REFERENCES "channels"("id") ON DELETE SET NULL,
  "expires_at"          timestamp with time zone NOT NULL,
  "used_at"             timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "token" text;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "channel" text;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "default_channel_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
ALTER TABLE "channel_link_tokens" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "channel_link_tokens_token_idx"
  ON "channel_link_tokens" ("token");

CREATE INDEX IF NOT EXISTS "channel_link_tokens_user_idx"
  ON "channel_link_tokens" ("user_id");

-- ─── 20. channel_context_items ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "channel_context_items" (
  "id"                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel_id"        uuid  NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "object_type"       text  NOT NULL,
  "object_id"         uuid  NOT NULL,
  "relationship_type" text  NOT NULL,
  "conflict_status"   text  NOT NULL DEFAULT 'none',
  "source_message_id" uuid,
  "relevance_score"   real,
  "user_id"           text  NOT NULL,
  "workspace_id"      uuid  NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "channel_context_unique" UNIQUE (
    "channel_id", "object_id", "object_type", "relationship_type"
  )
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "object_type" text;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "object_id" uuid;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "relationship_type" text;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "conflict_status" text DEFAULT 'none';
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "source_message_id" uuid;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "relevance_score" real;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "channel_context_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "channel_context_channel_idx"
  ON "channel_context_items" ("channel_id");

CREATE INDEX IF NOT EXISTS "channel_context_object_idx"
  ON "channel_context_items" ("object_type", "object_id");

CREATE INDEX IF NOT EXISTS "channel_context_user_idx"
  ON "channel_context_items" ("user_id");

CREATE INDEX IF NOT EXISTS "channel_context_workspace_idx"
  ON "channel_context_items" ("workspace_id");

CREATE INDEX IF NOT EXISTS "channel_context_conflict_idx"
  ON "channel_context_items" ("conflict_status");

-- ─── 21. sessions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "sessions" (
  "id"                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel_id"          uuid    NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "started_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at"            timestamp with time zone,
  "last_activity_at"    timestamp with time zone,
  "bootstrap_state_id"  uuid,
  "produced_state_id"   uuid,
  "total_tokens_used"   integer DEFAULT 0,
  "message_count"       integer DEFAULT 0,
  "compaction_count"    integer DEFAULT 0,
  "status"              text    NOT NULL DEFAULT 'active'
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now();
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "bootstrap_state_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "produced_state_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "total_tokens_used" integer DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "message_count" integer DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "compaction_count" integer DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';

CREATE INDEX IF NOT EXISTS "sessions_channel_id_idx"
  ON "sessions" ("channel_id");

CREATE INDEX IF NOT EXISTS "sessions_channel_status_idx"
  ON "sessions" ("channel_id", "status");

CREATE INDEX IF NOT EXISTS "sessions_started_at_idx"
  ON "sessions" ("channel_id", "started_at");

-- ─── 22. compacted_states ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "compacted_states" (
  "id"                      uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel_id"              uuid    NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "session_id"              uuid    REFERENCES "sessions"("id") ON DELETE SET NULL,
  "version"                 integer NOT NULL DEFAULT 1,
  "identity_block"          text    NOT NULL DEFAULT '',
  "user_model_block"        text    NOT NULL DEFAULT '',
  "continuity_block"        text    NOT NULL DEFAULT '',
  "active_goals_block"      text    NOT NULL DEFAULT '',
  "entity_context_block"    text    NOT NULL DEFAULT '',
  "raw_token_count"         integer,
  "compressed_token_count"  integer,
  "compaction_model"        text,
  "metadata"                jsonb,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "compacted_states_channel_version_unique" UNIQUE ("channel_id", "version")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "identity_block" text DEFAULT '';
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "user_model_block" text DEFAULT '';
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "continuity_block" text DEFAULT '';
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "active_goals_block" text DEFAULT '';
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "entity_context_block" text DEFAULT '';
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "raw_token_count" integer;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "compressed_token_count" integer;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "compaction_model" text;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "compacted_states" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "compacted_states_channel_version_idx"
  ON "compacted_states" ("channel_id", "version");

-- Add FK from sessions → compacted_states (after both tables exist)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'sessions' AND constraint_name = 'sessions_bootstrap_state_id_fkey'
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_bootstrap_state_id_fkey"
      FOREIGN KEY ("bootstrap_state_id") REFERENCES "compacted_states"("id") ON DELETE SET NULL;
  END IF;
END; $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'sessions' AND constraint_name = 'sessions_produced_state_id_fkey'
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_produced_state_id_fkey"
      FOREIGN KEY ("produced_state_id") REFERENCES "compacted_states"("id") ON DELETE SET NULL;
  END IF;
END; $$;

-- Add FK from channels → compacted_states (merged_into_state_id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'channels' AND constraint_name = 'channels_merged_into_state_id_fkey'
  ) THEN
    ALTER TABLE "channels"
      ADD CONSTRAINT "channels_merged_into_state_id_fkey"
      FOREIGN KEY ("merged_into_state_id") REFERENCES "compacted_states"("id") ON DELETE SET NULL;
  END IF;
END; $$;

-- ─── 23. inbox_items ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "inbox_items" (
  "id"            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       text          NOT NULL,
  "workspace_id"  uuid          NOT NULL,
  "provider"      varchar(50)   NOT NULL,
  "account"       varchar(255)  NOT NULL,
  "external_id"   varchar(500)  NOT NULL,
  "deep_link"     text,
  "type"          varchar(50)   NOT NULL,
  "title"         text          NOT NULL,
  "preview"       text,
  "timestamp"     timestamp with time zone NOT NULL,
  "status"        varchar(20)   DEFAULT 'unread',
  "snoozed_until" timestamp with time zone,
  "priority"      varchar(20),
  "tags"          text[],
  "data"          jsonb         NOT NULL DEFAULT '{}',
  "processed_at"  timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "provider" varchar(50);
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "account" varchar(255);
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "external_id" varchar(500);
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "deep_link" text;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "type" varchar(50);
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "preview" text;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "timestamp" timestamp with time zone;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'unread';
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "priority" varchar(20);
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "tags" text[];
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "data" jsonb DEFAULT '{}';
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "processed_at" timestamp with time zone;
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_inbox_user_status"
  ON "inbox_items" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "idx_inbox_provider"
  ON "inbox_items" ("provider");

CREATE INDEX IF NOT EXISTS "idx_inbox_timestamp"
  ON "inbox_items" ("user_id", "timestamp");

CREATE INDEX IF NOT EXISTS "idx_inbox_snoozed"
  ON "inbox_items" ("user_id", "snoozed_until");

CREATE INDEX IF NOT EXISTS "idx_inbox_priority"
  ON "inbox_items" ("user_id", "priority");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbox_external_unique"
  ON "inbox_items" ("user_id", "provider", "external_id")
  WHERE "provider" IS NOT NULL AND "external_id" IS NOT NULL;

-- ─── 24. messages ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "messages" (
  "id"               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel_id"       uuid  NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "parent_id"        uuid,
  "role"             text  NOT NULL,
  "author_type"      text  NOT NULL DEFAULT 'human',
  "message_category" text  NOT NULL DEFAULT 'chat',
  "external_source"  text,
  "inbox_item_id"    uuid  REFERENCES "inbox_items"("id") ON DELETE SET NULL,
  "content"          text  NOT NULL,
  "metadata"         jsonb,
  "user_id"          text  NOT NULL,
  "timestamp"        timestamp with time zone NOT NULL DEFAULT now(),
  "previous_hash"    text,
  "hash"             text  NOT NULL,
  "session_id"       uuid  REFERENCES "sessions"("id") ON DELETE SET NULL,
  "deleted_at"       timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "parent_id" uuid;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "author_type" text DEFAULT 'human';
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "message_category" text DEFAULT 'chat';
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "external_source" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "inbox_item_id" uuid REFERENCES "inbox_items"("id") ON DELETE SET NULL;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "content" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "timestamp" timestamp with time zone DEFAULT now();
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "previous_hash" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "hash" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "messages_channel_id_idx"
  ON "messages" ("channel_id");

CREATE INDEX IF NOT EXISTS "messages_inbox_item_idx"
  ON "messages" ("inbox_item_id");

CREATE INDEX IF NOT EXISTS "messages_ext_source_idx"
  ON "messages" ("external_source");

CREATE INDEX IF NOT EXISTS "messages_session_id_idx"
  ON "messages" ("session_id");

CREATE INDEX IF NOT EXISTS "messages_channel_timestamp_idx"
  ON "messages" ("channel_id", "timestamp");

-- Add FK from channel_context_items → messages (now that messages table exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'channel_context_items'
      AND constraint_name = 'channel_context_items_source_message_id_fkey'
  ) THEN
    ALTER TABLE "channel_context_items"
      ADD CONSTRAINT "channel_context_items_source_message_id_fkey"
      FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL;
  END IF;
END; $$;

-- Add FK from channels → messages (branched_from_message_id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'channels'
      AND constraint_name = 'channels_branched_from_message_id_fkey'
  ) THEN
    ALTER TABLE "channels"
      ADD CONSTRAINT "channels_branched_from_message_id_fkey"
      FOREIGN KEY ("branched_from_message_id") REFERENCES "messages"("id") ON DELETE SET NULL;
  END IF;
END; $$;

-- ─── 25. message_links ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "message_links" (
  "id"                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id"        uuid  NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "target_type"       text  NOT NULL,
  "target_id"         uuid  NOT NULL,
  "relationship_type" text  NOT NULL,
  "position"          jsonb,
  "metadata"          jsonb,
  "user_id"           text  NOT NULL,
  "workspace_id"      uuid  NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "message_id" uuid REFERENCES "messages"("id") ON DELETE CASCADE;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "target_type" text;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "target_id" uuid;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "relationship_type" text;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "position" jsonb;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "message_links" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "message_links_message_id_idx"
  ON "message_links" ("message_id");

CREATE INDEX IF NOT EXISTS "message_links_target_idx"
  ON "message_links" ("target_type", "target_id");

CREATE INDEX IF NOT EXISTS "message_links_relationship_idx"
  ON "message_links" ("relationship_type");

CREATE INDEX IF NOT EXISTS "message_links_user_id_idx"
  ON "message_links" ("user_id");

CREATE INDEX IF NOT EXISTS "message_links_workspace_id_idx"
  ON "message_links" ("workspace_id");

-- ─── 26. intelligence_commands ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "intelligence_commands" (
  "id"                           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"                 uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by"                   text    NOT NULL,
  "title"                        text    NOT NULL,
  "prompt_template"              text    NOT NULL,
  "compiled_template_ast"        jsonb,
  "derived_inputs"               jsonb,
  "input_overrides"              jsonb,
  "allowed_tools"                jsonb,
  "allowed_entity_types"         jsonb,
  "max_entities_created_per_run" integer,
  "can_create_views"             boolean NOT NULL DEFAULT false,
  "output_mode"                  text    NOT NULL DEFAULT 'text',
  "permissions_profile"          text    NOT NULL DEFAULT 'propose_writes',
  "shared_scope"                 text    NOT NULL DEFAULT 'workspace',
  "created_at"                   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                   timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "prompt_template" text;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "compiled_template_ast" jsonb;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "derived_inputs" jsonb;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "input_overrides" jsonb;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "allowed_tools" jsonb;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "allowed_entity_types" jsonb;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "max_entities_created_per_run" integer;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "can_create_views" boolean DEFAULT false;
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "output_mode" text DEFAULT 'text';
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "permissions_profile" text DEFAULT 'propose_writes';
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "shared_scope" text DEFAULT 'workspace';
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "intelligence_commands" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "intelligence_commands_workspace_id_idx"
  ON "intelligence_commands" ("workspace_id");

CREATE INDEX IF NOT EXISTS "intelligence_commands_created_by_idx"
  ON "intelligence_commands" ("created_by");

-- ─── 27. command_runs ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "command_runs" (
  "id"                         uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id"                  uuid  NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "command_id"                 uuid  NOT NULL REFERENCES "intelligence_commands"("id") ON DELETE CASCADE,
  "workspace_id"               uuid  NOT NULL,
  "user_id"                    text  NOT NULL,
  "permissions_snapshot"       jsonb,
  "inputs"                     jsonb,
  "selection_context_snapshot" jsonb,
  "output_summary"             text,
  "proposed_actions"           jsonb,
  "approved_actions"           jsonb,
  "status"                     text  NOT NULL DEFAULT 'running',
  "started_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"               timestamp with time zone,
  "error_message"              text
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "thread_id" uuid REFERENCES "channels"("id") ON DELETE CASCADE;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "command_id" uuid REFERENCES "intelligence_commands"("id") ON DELETE CASCADE;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "permissions_snapshot" jsonb;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "inputs" jsonb;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "selection_context_snapshot" jsonb;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "output_summary" text;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "proposed_actions" jsonb;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "approved_actions" jsonb;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'running';
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now();
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "command_runs" ADD COLUMN IF NOT EXISTS "error_message" text;

CREATE INDEX IF NOT EXISTS "command_runs_command_id_idx"
  ON "command_runs" ("command_id");

CREATE INDEX IF NOT EXISTS "command_runs_workspace_id_idx"
  ON "command_runs" ("workspace_id");

CREATE INDEX IF NOT EXISTS "command_runs_user_id_idx"
  ON "command_runs" ("user_id");

CREATE INDEX IF NOT EXISTS "command_runs_thread_id_idx"
  ON "command_runs" ("thread_id");

CREATE INDEX IF NOT EXISTS "command_runs_started_at_idx"
  ON "command_runs" ("started_at");

-- ─── 28. proposals ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "proposals" (
  "id"                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"      text  NOT NULL,
  "target_type"       text  NOT NULL,
  "target_id"         text  NOT NULL,
  "proposal_type"     text  NOT NULL,
  "data"              jsonb NOT NULL,
  "status"            text  NOT NULL DEFAULT 'pending',
  "created_by"        text,
  "thread_id"         uuid  REFERENCES "channels"("id") ON DELETE SET NULL,
  "command_run_id"    uuid  REFERENCES "command_runs"("id") ON DELETE SET NULL,
  "source_message_id" uuid  REFERENCES "messages"("id") ON DELETE SET NULL,
  "agent_user_id"     text  REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at"        timestamp with time zone,
  "reviewed_by"       text,
  "reviewed_at"       timestamp with time zone,
  "rejection_reason"  text,
  "comments"          jsonb DEFAULT '[]',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "workspace_id" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "target_type" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "target_id" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "proposal_type" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "data" jsonb;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending';
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "thread_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "command_run_id" uuid REFERENCES "command_runs"("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "source_message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "agent_user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "reviewed_by" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "comments" jsonb DEFAULT '[]';
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_proposals_workspace_status"
  ON "proposals" ("workspace_id", "status");

CREATE INDEX IF NOT EXISTS "idx_proposals_target"
  ON "proposals" ("target_type", "target_id");

CREATE INDEX IF NOT EXISTS "idx_proposals_thread_id"
  ON "proposals" ("thread_id");

CREATE INDEX IF NOT EXISTS "idx_proposals_command_run_id"
  ON "proposals" ("command_run_id");

CREATE INDEX IF NOT EXISTS "idx_proposals_source_message_id"
  ON "proposals" ("source_message_id");

CREATE INDEX IF NOT EXISTS "idx_proposals_created_by"
  ON "proposals" ("created_by");

CREATE INDEX IF NOT EXISTS "idx_proposals_thread_status"
  ON "proposals" ("thread_id", "status");

CREATE INDEX IF NOT EXISTS "idx_proposals_agent_user_id"
  ON "proposals" ("agent_user_id");

-- ─── 29. knowledge_facts ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "knowledge_facts" (
  "id"                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           text  NOT NULL,
  "fact"              text  NOT NULL,
  "source_entity_id"  uuid,
  "source_message_id" uuid,
  "confidence"        real  NOT NULL DEFAULT 0.5,
  "embedding"         vector(1536) NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "fact" text;
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "source_entity_id" uuid;
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "source_message_id" uuid;
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "confidence" real DEFAULT 0.5;
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "knowledge_facts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

-- ─── 30. skills ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "skills" (
  "id"              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         text    NOT NULL,
  "workspace_id"    uuid    REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind"            text    NOT NULL DEFAULT 'code',
  "scope"           text    NOT NULL DEFAULT 'pod',
  "agent_types"     jsonb,
  "name"            text    NOT NULL,
  "description"     text,
  "code"            text    NOT NULL,
  "parameters"      jsonb,
  "category"        text,
  "execution_mode"  text    NOT NULL DEFAULT 'sync',
  "timeout_seconds" integer DEFAULT 30,
  "status"          text    NOT NULL DEFAULT 'active',
  "error_message"   text,
  "metadata"        jsonb   NOT NULL DEFAULT '{}',
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'code';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'pod';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "agent_types" jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "parameters" jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "execution_mode" text DEFAULT 'sync';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "timeout_seconds" integer DEFAULT 30;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "skills_user_id_idx"     ON "skills" ("user_id");
CREATE INDEX IF NOT EXISTS "skills_workspace_id_idx" ON "skills" ("workspace_id");
CREATE INDEX IF NOT EXISTS "skills_status_idx"       ON "skills" ("status");
CREATE INDEX IF NOT EXISTS "skills_kind_idx"         ON "skills" ("kind");
CREATE INDEX IF NOT EXISTS "skills_name_idx"         ON "skills" ("name");

-- ─── 31. skill_triggers ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "skill_triggers" (
  "id"              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "skill_id"        uuid    NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "workspace_id"    uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"         text    NOT NULL,
  "type"            text    NOT NULL,
  "event_pattern"   text,
  "filters"         jsonb,
  "cron_expression" text,
  "channel_type"    text    NOT NULL DEFAULT 'personal',
  "is_active"       boolean NOT NULL DEFAULT true,
  "automation_id"   uuid,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "skill_id" uuid REFERENCES "skills"("id") ON DELETE CASCADE;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "event_pattern" text;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "filters" jsonb;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "cron_expression" text;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "channel_type" text DEFAULT 'personal';
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "automation_id" uuid;
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "skill_triggers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "skill_triggers_skill_id_idx"
  ON "skill_triggers" ("skill_id");

CREATE INDEX IF NOT EXISTS "skill_triggers_workspace_id_idx"
  ON "skill_triggers" ("workspace_id");

CREATE INDEX IF NOT EXISTS "skill_triggers_type_idx"
  ON "skill_triggers" ("type");

-- ─── 32. agents ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agents" (
  "id"                  text    PRIMARY KEY,
  "name"                text    NOT NULL,
  "description"         text,
  "created_by"          text    NOT NULL,
  "user_id"             text,
  "llm_provider"        text    NOT NULL DEFAULT 'claude',
  "llm_model"           text    NOT NULL,
  "capabilities"        text[]  NOT NULL,
  "system_prompt"       text    NOT NULL,
  "tools_config"        jsonb,
  "execution_mode"      text    NOT NULL DEFAULT 'simple',
  "max_iterations"      integer DEFAULT 5,
  "timeout_seconds"     integer DEFAULT 30,
  "weight"              decimal(5, 2) DEFAULT 1.0,
  "performance_metrics" jsonb,
  "active"              boolean NOT NULL DEFAULT true,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "llm_provider" text DEFAULT 'claude';
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "llm_model" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capabilities" text[];
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "system_prompt" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "tools_config" jsonb;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "execution_mode" text DEFAULT 'simple';
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "max_iterations" integer DEFAULT 5;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "timeout_seconds" integer DEFAULT 30;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "weight" decimal(5, 2) DEFAULT 1.0;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "performance_metrics" jsonb;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "agents_created_by_idx" ON "agents" ("created_by");
CREATE INDEX IF NOT EXISTS "agents_user_id_idx"    ON "agents" ("user_id");
CREATE INDEX IF NOT EXISTS "agents_active_idx"     ON "agents" ("active");

-- ─── 33. agent_configs ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agent_configs" (
  "id"                 uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            text    NOT NULL,
  "workspace_id"       uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_type"         text    NOT NULL,
  "prompt_append"      text,
  "extra_tool_ids"     jsonb   NOT NULL DEFAULT '[]',
  "disabled_tool_ids"  jsonb   NOT NULL DEFAULT '[]',
  "max_steps_override" integer,
  "model_override"     text,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_configs_user_workspace_agent_unique"
    UNIQUE ("user_id", "workspace_id", "agent_type")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "agent_type" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "prompt_append" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "extra_tool_ids" jsonb DEFAULT '[]';
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "disabled_tool_ids" jsonb DEFAULT '[]';
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "max_steps_override" integer;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "model_override" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "agent_configs_user_id_idx"
  ON "agent_configs" ("user_id");

CREATE INDEX IF NOT EXISTS "agent_configs_workspace_id_idx"
  ON "agent_configs" ("workspace_id");

CREATE INDEX IF NOT EXISTS "agent_configs_agent_type_idx"
  ON "agent_configs" ("agent_type");

-- ─── 34. intelligence_services ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "intelligence_services" (
  "id"                  text    PRIMARY KEY,
  "service_id"          text    NOT NULL UNIQUE,
  "name"                text    NOT NULL,
  "description"         text,
  "version"             text,
  "webhook_url"         text    NOT NULL,
  "mcp_endpoint"        text,
  "api_key"             text    NOT NULL,
  "capabilities"        jsonb   NOT NULL DEFAULT '[]',
  "pricing"             text    DEFAULT 'free',
  "status"              text    NOT NULL DEFAULT 'active',
  "enabled"             boolean NOT NULL DEFAULT true,
  "mcp_approved"        boolean NOT NULL DEFAULT false,
  "metadata"            jsonb   DEFAULT '{}',
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "last_health_check"   timestamp with time zone,
  "last_health_status"  text
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "service_id" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "version" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "webhook_url" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "mcp_endpoint" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "api_key" text;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "capabilities" jsonb DEFAULT '[]';
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "pricing" text DEFAULT 'free';
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "mcp_approved" boolean DEFAULT false;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "last_health_check" timestamp with time zone;
ALTER TABLE "intelligence_services" ADD COLUMN IF NOT EXISTS "last_health_status" text;

-- ─── 35. automations + automation_runs + automation_step_runs ────────────────

CREATE TABLE IF NOT EXISTS "automations" (
  "id"              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"    uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by"      text    NOT NULL,
  "name"            text    NOT NULL,
  "description"     text,
  "trigger_type"    text    NOT NULL,
  "trigger_config"  jsonb   NOT NULL DEFAULT '{}',
  "flow_definition" jsonb   NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  "status"          text    NOT NULL DEFAULT 'draft',
  "error_message"   text,
  "last_run_at"     timestamp with time zone,
  "next_run_at"     timestamp with time zone,
  "run_count"       integer NOT NULL DEFAULT 0,
  "success_count"   integer NOT NULL DEFAULT 0,
  "failure_count"   integer NOT NULL DEFAULT 0,
  "metadata"        jsonb   NOT NULL DEFAULT '{}',
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "trigger_type" text;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "trigger_config" jsonb DEFAULT '{}';
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "flow_definition" jsonb DEFAULT '{"nodes":[],"edges":[]}';
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'draft';
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "next_run_at" timestamp with time zone;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "run_count" integer DEFAULT 0;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "success_count" integer DEFAULT 0;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "failure_count" integer DEFAULT 0;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "automations_workspace_id_idx"
  ON "automations" ("workspace_id");

CREATE INDEX IF NOT EXISTS "automations_status_idx"
  ON "automations" ("status");

CREATE INDEX IF NOT EXISTS "automations_trigger_type_idx"
  ON "automations" ("trigger_type");

CREATE INDEX IF NOT EXISTS "automations_next_run_at_idx"
  ON "automations" ("next_run_at");

CREATE INDEX IF NOT EXISTS "automations_created_by_idx"
  ON "automations" ("created_by");

CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id"              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "automation_id"   uuid  NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "workspace_id"    uuid  NOT NULL,
  "triggered_by"    text,
  "trigger_payload" jsonb NOT NULL DEFAULT '{}',
  "status"          text  NOT NULL DEFAULT 'running',
  "error_message"   text,
  "steps_completed" integer NOT NULL DEFAULT 0,
  "steps_failed"    integer NOT NULL DEFAULT 0,
  "output_summary"  jsonb,
  "started_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"    timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "automation_id" uuid REFERENCES "automations"("id") ON DELETE CASCADE;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "triggered_by" text;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "trigger_payload" jsonb DEFAULT '{}';
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'running';
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "steps_completed" integer DEFAULT 0;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "steps_failed" integer DEFAULT 0;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "output_summary" jsonb;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now();
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "automation_runs_automation_id_idx"
  ON "automation_runs" ("automation_id");

CREATE INDEX IF NOT EXISTS "automation_runs_status_idx"
  ON "automation_runs" ("status");

CREATE INDEX IF NOT EXISTS "automation_runs_started_at_idx"
  ON "automation_runs" ("started_at");

CREATE TABLE IF NOT EXISTS "automation_step_runs" (
  "id"               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id"           uuid  NOT NULL REFERENCES "automation_runs"("id") ON DELETE CASCADE,
  "node_id"          text  NOT NULL,
  "command_id"       uuid,
  "status"           text  NOT NULL DEFAULT 'pending',
  "resolved_inputs"  jsonb NOT NULL DEFAULT '{}',
  "output"           jsonb NOT NULL DEFAULT '{}',
  "error_message"    text,
  "started_at"       timestamp with time zone,
  "completed_at"     timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "run_id" uuid REFERENCES "automation_runs"("id") ON DELETE CASCADE;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "node_id" text;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "command_id" uuid;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending';
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "resolved_inputs" jsonb DEFAULT '{}';
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "output" jsonb DEFAULT '{}';
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "automation_step_runs_run_id_idx"
  ON "automation_step_runs" ("run_id");

-- ─── 36. notifications + notification_preferences ────────────────────────────

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"  text  NOT NULL,
  "user_id"       text  NOT NULL,
  "type"          text  NOT NULL,
  "category"      text  NOT NULL,
  "priority"      text  NOT NULL DEFAULT 'normal',
  "title"         text  NOT NULL,
  "body"          text  NOT NULL,
  "icon"          text,
  "source_type"   text  NOT NULL,
  "source_id"     text,
  "workspace_url" text,
  "actions"       jsonb DEFAULT '[]',
  "group_key"     text,
  "status"        text  NOT NULL DEFAULT 'unread',
  "read_at"       timestamp with time zone,
  "expires_at"    timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "workspace_id" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'normal';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "body" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "icon" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "source_id" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "workspace_url" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "actions" jsonb DEFAULT '[]';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "group_key" text;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'unread';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "notifs_user_workspace_status_idx"
  ON "notifications" ("user_id", "workspace_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "notifs_group_key_idx"
  ON "notifications" ("group_key", "workspace_id");

CREATE INDEX IF NOT EXISTS "notifs_source_idx"
  ON "notifications" ("source_type", "source_id");

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id"                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             text    NOT NULL,
  "workspace_id"        text    NOT NULL,
  "enabled"             boolean NOT NULL DEFAULT true,
  "quiet_hours_enabled" boolean DEFAULT false,
  "quiet_hours_start"   text    DEFAULT '22:00',
  "quiet_hours_end"     text    DEFAULT '08:00',
  "routing_rules"       jsonb   DEFAULT '{}',
  "sound_enabled"       boolean DEFAULT true,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "workspace_id" text;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "quiet_hours_enabled" boolean DEFAULT false;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "quiet_hours_start" text DEFAULT '22:00';
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "quiet_hours_end" text DEFAULT '08:00';
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "routing_rules" jsonb DEFAULT '{}';
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "sound_enabled" boolean DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "notif_prefs_user_workspace_idx"
  ON "notification_preferences" ("user_id", "workspace_id");

-- ─── 37. api_keys ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"                     uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                text    NOT NULL,
  "key_name"               text    NOT NULL,
  "key_prefix"             text    NOT NULL,
  "key_hash"               text    NOT NULL,
  "key_type"               text    NOT NULL DEFAULT 'hub_inbound',
  "description"            text,
  "hub_id"                 text,
  "scope"                  text[]  NOT NULL DEFAULT '{}',
  "expires_at"             timestamp with time zone,
  "is_active"              boolean NOT NULL DEFAULT true,
  "last_used_at"           timestamp with time zone,
  "usage_count"            bigint  NOT NULL DEFAULT 0,
  "rotated_from_id"        uuid,
  "rotation_scheduled_at"  timestamp with time zone,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "created_by"             text,
  "revoked_at"             timestamp with time zone,
  "revoked_by"             text,
  "revoked_reason"         text,
  CONSTRAINT "api_keys_key_hash_unique" UNIQUE ("key_hash"),
  CONSTRAINT "api_keys_user_id_check"
    CHECK ("user_id" IS NOT NULL AND LENGTH(TRIM("user_id")) > 0),
  CONSTRAINT "api_keys_key_name_check"
    CHECK (LENGTH(TRIM("key_name")) > 0),
  CONSTRAINT "api_keys_key_prefix_check"
    CHECK ("key_prefix" IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_'))
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_name" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_prefix" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_hash" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_type" text DEFAULT 'hub_inbound';
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "hub_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scope" text[] DEFAULT '{}';
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "usage_count" bigint DEFAULT 0;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rotated_from_id" uuid;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rotation_scheduled_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_by" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_reason" text;

-- ─── 38. provisioning_tokens ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "provisioning_tokens" (
  "id"          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash"  text  NOT NULL UNIQUE,
  "used_at"     timestamp with time zone,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "provisioning_tokens" ADD COLUMN IF NOT EXISTS "token_hash" text;
ALTER TABLE "provisioning_tokens" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
ALTER TABLE "provisioning_tokens" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_provisioning_tokens_token_hash"
  ON "provisioning_tokens" ("token_hash");

-- ─── 39. secrets vault tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "secrets" (
  "id"                     uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                text    NOT NULL,
  "workspace_id"           uuid,
  "name"                   text    NOT NULL,
  "type"                   secret_type NOT NULL DEFAULT 'password',
  "url"                    text,
  "category"               text,
  "description"            text,
  "icon_url"               text,
  "encrypted_data"         text    NOT NULL,
  "encryption_version"     integer NOT NULL DEFAULT 1,
  "iv"                     text    NOT NULL,
  "auth_tag"               text    NOT NULL,
  "encryption_mode"        text    NOT NULL DEFAULT 'client',
  "service_id"             text,
  "is_favorite"            boolean NOT NULL DEFAULT false,
  "sort_order"             integer DEFAULT 0,
  "last_accessed_at"       timestamp with time zone,
  "access_count"           integer NOT NULL DEFAULT 0,
  "password_strength"      integer,
  "password_last_changed"  timestamp with time zone,
  "is_compromised"         boolean DEFAULT false,
  "compromised_at"         timestamp with time zone,
  "is_shared"              boolean NOT NULL DEFAULT false,
  "deleted_at"             timestamp with time zone,
  "deleted_by"             text,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "type" secret_type DEFAULT 'password';
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "url" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "icon_url" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "encrypted_data" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "encryption_version" integer DEFAULT 1;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "iv" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "auth_tag" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "encryption_mode" text DEFAULT 'client';
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "service_id" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "is_favorite" boolean DEFAULT false;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "last_accessed_at" timestamp with time zone;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "access_count" integer DEFAULT 0;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "password_strength" integer;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "password_last_changed" timestamp with time zone;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "is_compromised" boolean DEFAULT false;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "compromised_at" timestamp with time zone;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "is_shared" boolean DEFAULT false;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "deleted_by" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_secrets_user_id"         ON "secrets" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_secrets_workspace_id"    ON "secrets" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_secrets_type"            ON "secrets" ("type");
CREATE INDEX IF NOT EXISTS "idx_secrets_category"        ON "secrets" ("category");
CREATE INDEX IF NOT EXISTS "idx_secrets_url"             ON "secrets" ("url");
CREATE INDEX IF NOT EXISTS "idx_secrets_deleted_at"      ON "secrets" ("deleted_at");
CREATE INDEX IF NOT EXISTS "idx_secrets_user_type"       ON "secrets" ("user_id", "type");
CREATE INDEX IF NOT EXISTS "idx_secrets_service_id"      ON "secrets" ("service_id");
CREATE INDEX IF NOT EXISTS "idx_secrets_encryption_mode" ON "secrets" ("encryption_mode");
CREATE INDEX IF NOT EXISTS "idx_secrets_user_service"    ON "secrets" ("user_id", "service_id");

CREATE TABLE IF NOT EXISTS "secret_tags" (
  "id"         uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret_id"  uuid  NOT NULL REFERENCES "secrets"("id") ON DELETE CASCADE,
  "tag"        text  NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "secret_tags_unique" UNIQUE ("secret_id", "tag")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "secret_tags" ADD COLUMN IF NOT EXISTS "secret_id" uuid REFERENCES "secrets"("id") ON DELETE CASCADE;
ALTER TABLE "secret_tags" ADD COLUMN IF NOT EXISTS "tag" text;
ALTER TABLE "secret_tags" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_secret_tags_tag" ON "secret_tags" ("tag");

CREATE TABLE IF NOT EXISTS "secret_shares" (
  "id"                       uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret_id"                uuid  NOT NULL REFERENCES "secrets"("id") ON DELETE CASCADE,
  "shared_with_user_id"      text,
  "shared_with_workspace_id" uuid,
  "permission"               text  NOT NULL DEFAULT 'read',
  "shared_by"                text  NOT NULL,
  "expires_at"               timestamp with time zone,
  "revoked_at"               timestamp with time zone,
  "revoked_by"               text,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "secret_id" uuid REFERENCES "secrets"("id") ON DELETE CASCADE;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "shared_with_user_id" text;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "shared_with_workspace_id" uuid;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "permission" text DEFAULT 'read';
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "shared_by" text;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "revoked_by" text;
ALTER TABLE "secret_shares" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_secret_shares_secret_id"
  ON "secret_shares" ("secret_id");

CREATE INDEX IF NOT EXISTS "idx_secret_shares_shared_with_user"
  ON "secret_shares" ("shared_with_user_id");

CREATE INDEX IF NOT EXISTS "idx_secret_shares_shared_with_workspace"
  ON "secret_shares" ("shared_with_workspace_id");

CREATE TABLE IF NOT EXISTS "secret_audit_log" (
  "id"          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret_id"   uuid  NOT NULL REFERENCES "secrets"("id") ON DELETE CASCADE,
  "user_id"     text  NOT NULL,
  "action"      text  NOT NULL,
  "ip_address"  text,
  "user_agent"  text,
  "metadata"    jsonb,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "secret_id" uuid REFERENCES "secrets"("id") ON DELETE CASCADE;
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "action" text;
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "ip_address" text;
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "user_agent" text;
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "secret_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_secret_audit_log_secret_id"
  ON "secret_audit_log" ("secret_id");

CREATE INDEX IF NOT EXISTS "idx_secret_audit_log_user_id"
  ON "secret_audit_log" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_secret_audit_log_created_at"
  ON "secret_audit_log" ("created_at");

CREATE TABLE IF NOT EXISTS "secret_vault_keys" (
  "id"                      uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                 text  NOT NULL UNIQUE,
  "salt"                    text  NOT NULL,
  "key_derivation_algorithm" text NOT NULL DEFAULT 'argon2id',
  "key_derivation_params"   jsonb NOT NULL,
  "verification_cipher"     text  NOT NULL,
  "verification_iv"         text  NOT NULL,
  "verification_tag"        text  NOT NULL,
  "recovery_key_hash"       text,
  "recovery_key_created_at" timestamp with time zone,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "last_unlocked_at"        timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "salt" text;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "key_derivation_algorithm" text DEFAULT 'argon2id';
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "key_derivation_params" jsonb;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "verification_cipher" text;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "verification_iv" text;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "verification_tag" text;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "recovery_key_hash" text;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "recovery_key_created_at" timestamp with time zone;
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "secret_vault_keys" ADD COLUMN IF NOT EXISTS "last_unlocked_at" timestamp with time zone;

-- ─── 40. user_preferences ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user_preferences" (
  "user_id"                           text    PRIMARY KEY,
  "theme"                             text    NOT NULL DEFAULT 'system',
  "custom_theme"                      jsonb,
  "default_templates"                 jsonb,
  "custom_entity_types"               jsonb,
  "entity_metadata_schemas"           jsonb,
  "ui_preferences"                    jsonb   NOT NULL DEFAULT '{}',
  "graph_preferences"                 jsonb   NOT NULL DEFAULT '{}',
  "intelligence_service_preferences"  jsonb   NOT NULL DEFAULT '{}',
  "onboarding_completed"              boolean NOT NULL DEFAULT false,
  "onboarding_step"                   text,
  "updated_at"                        timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "theme" text DEFAULT 'system';
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "custom_theme" jsonb;
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "default_templates" jsonb;
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "custom_entity_types" jsonb;
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "entity_metadata_schemas" jsonb;
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "ui_preferences" jsonb DEFAULT '{}';
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "graph_preferences" jsonb DEFAULT '{}';
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "intelligence_service_preferences" jsonb DEFAULT '{}';
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean DEFAULT false;
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "onboarding_step" text;
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

-- ─── 41. user_entity_state ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user_entity_state" (
  "user_id"       text         NOT NULL,
  "item_id"       uuid         NOT NULL,
  "item_type"     varchar(20)  NOT NULL,
  "starred"       boolean      DEFAULT false,
  "pinned"        boolean      DEFAULT false,
  "last_viewed_at" timestamp with time zone,
  "view_count"    integer      DEFAULT 0,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "item_id", "item_type")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "item_id" uuid;
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "item_type" varchar(20);
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "starred" boolean DEFAULT false;
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false;
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "last_viewed_at" timestamp with time zone;
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "view_count" integer DEFAULT 0;
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "user_entity_state" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_user_state_starred"
  ON "user_entity_state" ("user_id", "starred");

CREATE INDEX IF NOT EXISTS "idx_user_state_pinned"
  ON "user_entity_state" ("user_id", "pinned");

CREATE INDEX IF NOT EXISTS "idx_user_state_viewed"
  ON "user_entity_state" ("user_id", "last_viewed_at");

-- ─── 42. admin_invitations ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "admin_invitations" (
  "id"              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"           text  NOT NULL,
  "token_hash"      text  NOT NULL UNIQUE,
  "expires_at"      timestamp with time zone NOT NULL,
  "used_at"         timestamp with time zone,
  "backend_domain"  text  NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "admin_invitations" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "admin_invitations" ADD COLUMN IF NOT EXISTS "token_hash" text;
ALTER TABLE "admin_invitations" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "admin_invitations" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
ALTER TABLE "admin_invitations" ADD COLUMN IF NOT EXISTS "backend_domain" text;
ALTER TABLE "admin_invitations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_admin_invitations_email"
  ON "admin_invitations" ("email");

CREATE INDEX IF NOT EXISTS "idx_admin_invitations_token_hash"
  ON "admin_invitations" ("token_hash");

-- ─── 43. enrichments (entity_enrichments, entity_relationships, reasoning_traces) ──

CREATE TABLE IF NOT EXISTS "entity_enrichments" (
  "id"               uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id"        uuid      NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "enrichment_type"  text      NOT NULL,
  "source_event_id"  uuid      NOT NULL,
  "agent_id"         text      NOT NULL,
  "confidence"       decimal(3, 2) NOT NULL,
  "data"             jsonb     NOT NULL,
  "user_id"          text      NOT NULL,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "enrichment_type" text;
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "source_event_id" uuid;
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "agent_id" text;
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "confidence" decimal(3, 2);
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "data" jsonb;
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entity_enrichments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "entity_enrichments_entity_id_idx"
  ON "entity_enrichments" ("entity_id");

CREATE INDEX IF NOT EXISTS "entity_enrichments_user_id_idx"
  ON "entity_enrichments" ("user_id");

CREATE INDEX IF NOT EXISTS "entity_enrichments_type_idx"
  ON "entity_enrichments" ("enrichment_type");

CREATE INDEX IF NOT EXISTS "entity_enrichments_entity_user_idx"
  ON "entity_enrichments" ("entity_id", "user_id");

CREATE TABLE IF NOT EXISTS "entity_relationships" (
  "id"                uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_entity_id"  uuid      NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "target_entity_id"  uuid      NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "relationship_type" text      NOT NULL,
  "source_event_id"   uuid      NOT NULL,
  "agent_id"          text      NOT NULL,
  "confidence"        decimal(3, 2) NOT NULL,
  "context"           text,
  "user_id"           text      NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "entity_relationships_unique" UNIQUE (
    "source_entity_id", "target_entity_id", "relationship_type"
  )
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "source_entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "target_entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "relationship_type" text;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "source_event_id" uuid;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "agent_id" text;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "confidence" decimal(3, 2);
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "context" text;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entity_relationships" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "entity_relationships_source_idx"
  ON "entity_relationships" ("source_entity_id");

CREATE INDEX IF NOT EXISTS "entity_relationships_target_idx"
  ON "entity_relationships" ("target_entity_id");

CREATE INDEX IF NOT EXISTS "entity_relationships_user_id_idx"
  ON "entity_relationships" ("user_id");

CREATE TABLE IF NOT EXISTS "reasoning_traces" (
  "id"              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_type"    text  NOT NULL,
  "subject_id"      uuid  NOT NULL,
  "source_event_id" uuid  NOT NULL,
  "agent_id"        text  NOT NULL,
  "steps"           jsonb NOT NULL,
  "outcome"         jsonb NOT NULL,
  "metrics"         jsonb,
  "user_id"         text  NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "subject_type" text;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "subject_id" uuid;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "source_event_id" uuid;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "agent_id" text;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "steps" jsonb;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "outcome" jsonb;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "metrics" jsonb;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "reasoning_traces" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "reasoning_traces_subject_idx"
  ON "reasoning_traces" ("subject_type", "subject_id");

CREATE INDEX IF NOT EXISTS "reasoning_traces_user_id_idx"
  ON "reasoning_traces" ("user_id");

CREATE INDEX IF NOT EXISTS "reasoning_traces_agent_idx"
  ON "reasoning_traces" ("agent_id");

-- ─── 44. background_tasks ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "background_tasks" (
  "id"              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         text    NOT NULL,
  "workspace_id"    uuid    REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name"            text    NOT NULL,
  "description"     text,
  "type"            text    NOT NULL,
  "schedule"        text,
  "action"          text    NOT NULL,
  "context"         jsonb   NOT NULL DEFAULT '{}',
  "status"          text    NOT NULL DEFAULT 'active',
  "error_message"   text,
  "last_run_at"     timestamp with time zone,
  "next_run_at"     timestamp with time zone,
  "execution_count" integer NOT NULL DEFAULT 0,
  "success_count"   integer NOT NULL DEFAULT 0,
  "failure_count"   integer NOT NULL DEFAULT 0,
  "metadata"        jsonb   NOT NULL DEFAULT '{}',
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "schedule" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "action" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "context" jsonb DEFAULT '{}';
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "next_run_at" timestamp with time zone;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "execution_count" integer DEFAULT 0;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "success_count" integer DEFAULT 0;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "failure_count" integer DEFAULT 0;
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "background_tasks" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "background_tasks_user_id_idx"
  ON "background_tasks" ("user_id");

CREATE INDEX IF NOT EXISTS "background_tasks_workspace_id_idx"
  ON "background_tasks" ("workspace_id");

CREATE INDEX IF NOT EXISTS "background_tasks_status_idx"
  ON "background_tasks" ("status");

CREATE INDEX IF NOT EXISTS "background_tasks_type_idx"
  ON "background_tasks" ("type");

CREATE INDEX IF NOT EXISTS "background_tasks_next_run_at_idx"
  ON "background_tasks" ("next_run_at");

-- ─── 45. widget_definitions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "widget_definitions" (
  "id"               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "type_key"         text    NOT NULL,
  "workspace_id"     uuid    REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name"             text    NOT NULL,
  "description"      text,
  "icon"             text,
  "category"         text,
  "renderer_type"    text    NOT NULL DEFAULT 'builtin',
  "renderer_source"  text,
  "source"           text,
  "bundle_source"    text,
  "config_schema"    jsonb   NOT NULL DEFAULT '{}',
  "default_config"   jsonb   DEFAULT '{}',
  "default_size"     jsonb   NOT NULL DEFAULT '{"w":6,"h":4}',
  "min_size"         jsonb,
  "is_active"        boolean NOT NULL DEFAULT true,
  "version"          text    DEFAULT '1.0.0',
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "type_key" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "icon" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "renderer_type" text DEFAULT 'builtin';
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "renderer_source" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "bundle_source" text;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "config_schema" jsonb DEFAULT '{}';
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "default_config" jsonb DEFAULT '{}';
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "default_size" jsonb DEFAULT '{"w":6,"h":4}';
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "min_size" jsonb;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "version" text DEFAULT '1.0.0';
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "widget_def_type_key_workspace_uniq"
  ON "widget_definitions" ("type_key", "workspace_id");

CREATE INDEX IF NOT EXISTS "widget_def_workspace_id_idx"
  ON "widget_definitions" ("workspace_id");

CREATE INDEX IF NOT EXISTS "widget_def_is_active_idx"
  ON "widget_definitions" ("is_active");

-- ─── 46. mcp_servers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id"            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"  uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "slug"          text    NOT NULL,
  "name"          text    NOT NULL,
  "description"   text,
  "transport"     text    NOT NULL,
  "command"       text,
  "args"          jsonb   NOT NULL DEFAULT '[]',
  "url"           text,
  "env"           jsonb   NOT NULL DEFAULT '{}',
  "enabled"       boolean NOT NULL DEFAULT true,
  "approved"      boolean NOT NULL DEFAULT false,
  "status"        text    NOT NULL DEFAULT 'unknown',
  "last_ping_at"  timestamp with time zone,
  "error_message" text,
  "metadata"      jsonb   NOT NULL DEFAULT '{}',
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_servers_workspace_slug_unique" UNIQUE ("workspace_id", "slug")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "transport" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "command" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "args" jsonb DEFAULT '[]';
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "url" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "env" jsonb DEFAULT '{}';
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "approved" boolean DEFAULT false;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'unknown';
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "last_ping_at" timestamp with time zone;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "mcp_servers_workspace_id_idx"
  ON "mcp_servers" ("workspace_id");

CREATE INDEX IF NOT EXISTS "mcp_servers_status_idx"
  ON "mcp_servers" ("status");

-- ─── 47. resource_shares ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "resource_shares" (
  "id"              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "resource_type"   text    NOT NULL,
  "resource_id"     uuid    NOT NULL,
  "visibility"      text    NOT NULL DEFAULT 'private',
  "public_token"    text,
  "token_hash"      text,
  "password_hash"   text,
  "access"          text    DEFAULT 'anyone_with_link',
  "revoked_at"      timestamp with time zone,
  "invited_users"   text[]  DEFAULT '{}',
  "permissions"     jsonb   DEFAULT '{"read":true}',
  "expires_at"      timestamp with time zone,
  "created_by"      text    NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "view_count"      integer DEFAULT 0,
  "last_accessed_at" timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "resource_type" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "resource_id" uuid;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'private';
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "public_token" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "token_hash" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "password_hash" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "access" text DEFAULT 'anyone_with_link';
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "invited_users" text[] DEFAULT '{}';
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "permissions" jsonb DEFAULT '{"read":true}';
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "view_count" integer DEFAULT 0;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "last_accessed_at" timestamp with time zone;

-- ─── 48. sync tables (sync_peers, sync_state, sync_conflicts) ────────────────

CREATE TABLE IF NOT EXISTS "sync_peers" (
  "id"            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "peer_pod_url"  text    NOT NULL,
  "direction"     text    NOT NULL,
  "enabled"       boolean NOT NULL DEFAULT true,
  "label"         text,
  "auth_token"    text,
  "workspace_ids" text[],
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "peer_pod_url" text;
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "direction" text;
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true;
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "label" text;
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "auth_token" text;
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "workspace_ids" text[];
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE TABLE IF NOT EXISTS "sync_state" (
  "id"                    uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_peer_id"          uuid  NOT NULL REFERENCES "sync_peers"("id") ON DELETE CASCADE,
  "last_cursor"           timestamp with time zone,
  "last_push_cursor"      timestamp with time zone,
  "last_pull_cursor"      timestamp with time zone,
  "last_sync_at"          timestamp with time zone,
  "status"                text  NOT NULL DEFAULT 'idle',
  "error_count"           integer NOT NULL DEFAULT 0,
  "last_error"            text,
  "events_processed"      integer NOT NULL DEFAULT 0,
  "supplementary_cursors" jsonb NOT NULL DEFAULT '{}',
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "sync_peer_id" uuid REFERENCES "sync_peers"("id") ON DELETE CASCADE;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_cursor" timestamp with time zone;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_push_cursor" timestamp with time zone;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_pull_cursor" timestamp with time zone;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_sync_at" timestamp with time zone;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'idle';
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "error_count" integer DEFAULT 0;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "events_processed" integer DEFAULT 0;
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "supplementary_cursors" jsonb DEFAULT '{}';
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE TABLE IF NOT EXISTS "sync_conflicts" (
  "id"                uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_peer_id"      uuid  REFERENCES "sync_peers"("id") ON DELETE SET NULL,
  "subject_type"      text  NOT NULL,
  "subject_id"        text  NOT NULL,
  "local_timestamp"   timestamp with time zone,
  "remote_timestamp"  timestamp with time zone,
  "resolution"        text  NOT NULL,
  "event_data"        jsonb,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "sync_peer_id" uuid REFERENCES "sync_peers"("id") ON DELETE SET NULL;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "subject_type" text;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "subject_id" text;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "local_timestamp" timestamp with time zone;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "remote_timestamp" timestamp with time zone;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "resolution" text;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "event_data" jsonb;
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

-- ─── 49. sync_generation ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "sync_generation" (
  "id"                     text    PRIMARY KEY DEFAULT 'current',
  "generation"             bigint  NOT NULL DEFAULT 0,
  "role"                   text    NOT NULL DEFAULT 'primary'
    CHECK ("role" IN ('primary', 'replica', 'standalone', 'readonly')),
  "promoted_at"            timestamp with time zone,
  "promoted_from"          text,
  "last_peer_generation"   bigint  DEFAULT 0,
  "last_peer_contact"      timestamp with time zone,
  "split_brain_detected"   boolean NOT NULL DEFAULT false,
  "split_brain_detected_at" timestamp with time zone,
  "split_brain_local_gen"  bigint,
  "split_brain_remote_gen" bigint,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "generation" bigint DEFAULT 0;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'primary';
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp with time zone;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "promoted_from" text;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "last_peer_generation" bigint DEFAULT 0;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "last_peer_contact" timestamp with time zone;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "split_brain_detected" boolean DEFAULT false;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "split_brain_detected_at" timestamp with time zone;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "split_brain_local_gen" bigint;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "split_brain_remote_gen" bigint;
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "sync_generation" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

INSERT INTO "sync_generation" ("id", "generation", "role")
VALUES ('current', 0, 'primary')
ON CONFLICT ("id") DO NOTHING;

-- ─── 50. signals (subscriptions, classifications, fetch_history, auto_links) ──

CREATE TABLE IF NOT EXISTS "signal_subscriptions" (
  "id"                      uuid      NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  "user_id"                 uuid      NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id"            uuid      NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "topic"                   text      NOT NULL,
  "source_platform"         text,
  "source_route"            text,
  "is_active"               boolean   NOT NULL DEFAULT true,
  "confidence"              numeric(3, 2) NOT NULL DEFAULT 0.50,
  "notification_preference" text      NOT NULL DEFAULT 'none',
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "last_fetched_at"         timestamp with time zone,
  PRIMARY KEY ("user_id", "workspace_id", "topic", "source_platform", "source_route")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "topic" text;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "source_platform" text;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "source_route" text;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "confidence" numeric(3, 2) DEFAULT 0.50;
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "notification_preference" text DEFAULT 'none';
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "signal_subscriptions" ADD COLUMN IF NOT EXISTS "last_fetched_at" timestamp with time zone;

-- Drop the surrogate PK and re-add composite (Drizzle uses array primaryKey)
-- The table is created with composite PK above; drop generated UUID PK if exists
-- (The composite primary key above supersedes the uuid "id" column — keep id for FK compat)

CREATE INDEX IF NOT EXISTS "signal_subscriptions_user_workspace_idx"
  ON "signal_subscriptions" ("user_id", "workspace_id")
  WHERE "is_active" = true;

CREATE INDEX IF NOT EXISTS "signal_subscriptions_topic_idx"
  ON "signal_subscriptions" ("topic")
  WHERE "is_active" = true;

CREATE TABLE IF NOT EXISTS "signal_classifications" (
  "id"               uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid      NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id"     uuid      NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "topic"            text      NOT NULL,
  "confidence"       numeric(3, 2) NOT NULL DEFAULT 0.00,
  "source_type"      text      NOT NULL,
  "source_entity_id" uuid,
  "source_signal_id" uuid      REFERENCES "entities"("id") ON DELETE SET NULL,
  "occurrence_count" integer   NOT NULL DEFAULT 1,
  "total_weight"     numeric(6, 3) NOT NULL DEFAULT 1.000,
  "first_seen_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "decay_rate"       numeric(3, 2) NOT NULL DEFAULT 0.95,
  "last_decay_at"    timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "topic" text;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "confidence" numeric(3, 2) DEFAULT 0.00;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "source_entity_id" uuid;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "source_signal_id" uuid REFERENCES "entities"("id") ON DELETE SET NULL;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "occurrence_count" integer DEFAULT 1;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "total_weight" numeric(6, 3) DEFAULT 1.000;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "first_seen_at" timestamp with time zone DEFAULT now();
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone DEFAULT now();
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "decay_rate" numeric(3, 2) DEFAULT 0.95;
ALTER TABLE "signal_classifications" ADD COLUMN IF NOT EXISTS "last_decay_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "signal_classifications_confidence_idx"
  ON "signal_classifications" ("confidence" DESC)
  WHERE "confidence" > 0.1;

CREATE INDEX IF NOT EXISTS "signal_classifications_recency_idx"
  ON "signal_classifications" ("last_seen_at" DESC);

CREATE TABLE IF NOT EXISTS "signal_fetch_history" (
  "id"                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             uuid    NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id"        uuid    NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "source_route"        text    NOT NULL,
  "source_platform"     text    NOT NULL,
  "fetch_type"          text    NOT NULL,
  "item_count"          integer NOT NULL DEFAULT 0,
  "error_count"         integer NOT NULL DEFAULT 0,
  "cache_hit"           boolean NOT NULL DEFAULT false,
  "duration_ms"         integer NOT NULL,
  "response_size_bytes" integer,
  "fetched_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "user_agent"          text,
  "client_ip"           text
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "source_route" text;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "source_platform" text;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "fetch_type" text;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "item_count" integer DEFAULT 0;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "error_count" integer DEFAULT 0;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "cache_hit" boolean DEFAULT false;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "duration_ms" integer;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "response_size_bytes" integer;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "fetched_at" timestamp with time zone DEFAULT now();
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "user_agent" text;
ALTER TABLE "signal_fetch_history" ADD COLUMN IF NOT EXISTS "client_ip" text;

CREATE INDEX IF NOT EXISTS "signal_fetch_history_user_time_idx"
  ON "signal_fetch_history" ("user_id", "fetched_at" DESC);

CREATE INDEX IF NOT EXISTS "signal_fetch_history_platform_idx"
  ON "signal_fetch_history" ("source_platform", "fetched_at" DESC);

CREATE TABLE IF NOT EXISTS "signal_auto_links" (
  "id"                uuid      NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  "signal_entity_id"  uuid      NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "linked_entity_id"  uuid      NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "link_type"         text      NOT NULL,
  "link_strength"     numeric(3, 2) NOT NULL DEFAULT 0.50,
  "link_context"      text,
  "source"            text      NOT NULL,
  "source_model"      text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("signal_entity_id", "linked_entity_id", "link_type")
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "signal_entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "linked_entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "link_type" text;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "link_strength" numeric(3, 2) DEFAULT 0.50;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "link_context" text;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "source_model" text;
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "signal_auto_links" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE INDEX IF NOT EXISTS "signal_auto_links_signal_idx"
  ON "signal_auto_links" ("signal_entity_id");

CREATE INDEX IF NOT EXISTS "signal_auto_links_linked_idx"
  ON "signal_auto_links" ("linked_entity_id");

CREATE INDEX IF NOT EXISTS "signal_auto_links_strength_idx"
  ON "signal_auto_links" ("link_strength" DESC);

-- ─── 51. webhook_subscriptions + webhook_deliveries ──────────────────────────

CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id"                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           text    NOT NULL,
  "name"              text    NOT NULL,
  "url"               text    NOT NULL,
  "event_types"       text[]  NOT NULL,
  "secret"            text    NOT NULL,
  "active"            boolean NOT NULL DEFAULT true,
  "retry_config"      jsonb   DEFAULT '{"maxRetries":3}',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "last_triggered_at" timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "url" text;
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "event_types" text[];
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "secret" text;
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true;
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "retry_config" jsonb DEFAULT '{"maxRetries":3}';
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "last_triggered_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id"  uuid    NOT NULL REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE,
  "event_id"         uuid    NOT NULL,
  "status"           text    NOT NULL,
  "response_status"  integer,
  "attempt"          integer NOT NULL DEFAULT 1,
  "delivered_at"     timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "subscription_id" uuid REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "event_id" uuid;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "response_status" integer;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "attempt" integer DEFAULT 1;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

-- ─── Additional performance indexes (migration 0055) ─────────────────────────

CREATE INDEX IF NOT EXISTS "relations_source_workspace_idx"
  ON "relations" ("source_entity_id", "workspace_id");

CREATE INDEX IF NOT EXISTS "relations_target_workspace_idx"
  ON "relations" ("target_entity_id", "workspace_id");

CREATE INDEX IF NOT EXISTS "relations_workspace_type_idx"
  ON "relations" ("workspace_id", "type");

-- Feed channels index (migration 0102)
CREATE INDEX IF NOT EXISTS "channels_feed_scope_user_idx"
  ON "channels" ("user_id", "channel_type", "feed_scope")
  WHERE "channel_type" = 'feed';

-- ─── _migrations tracking table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "_migrations" (
  "id"         serial      PRIMARY KEY,
  "filename"   text        NOT NULL UNIQUE,
  "applied_at" timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "_migrations" ADD COLUMN IF NOT EXISTS "filename" text;
ALTER TABLE "_migrations" ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone DEFAULT now();

-- ─── Mark all legacy migration files as applied ───────────────────────────────
-- Prevents the runner from re-executing these on existing pods that already
-- have the schema built up incrementally. On a fresh pod this baseline
-- creates everything, so the legacy files must be skipped.

INSERT INTO "_migrations" ("filename") VALUES
  ('0000_core_infrastructure.sql'),
  ('0001_knowledge_graph.sql'),
  ('0002_project_management.sql'),
  ('0003_collaboration.sql'),
  ('0003_sparkling_thundra.sql'),
  ('001_add_timescale_compression.sql'),
  ('0004_intelligence.sql'),
  ('0005_user_preferences.sql'),
  ('0006_security_policies.sql'),
  ('0007_relations_metadata.sql'),
  ('0007_system_seed.sql'),
  ('0008_admin_invitations.sql'),
  ('0009_provisioning_tokens.sql'),
  ('0010_add_events_id_unique_index.sql'),
  ('0011_fix_chat_threads_schema.sql'),
  ('0012_fix_views_schema.sql'),
  ('0013_fix_user_preferences_schema.sql'),
  ('0015.2_add_message_links.sql'),
  ('0015_add_documents_type_column.sql'),
  ('0016_backfill_whiteboards_storage.sql'),
  ('0017_add_profiles_self_reference_fk.sql'),
  ('0018_add_documents_missing_columns.sql'),
  ('0019_add_views_scope_profiles.sql'),
  ('0019_fix_document_versions_schema.sql'),
  ('0020_add_view_composition.sql'),
  ('0020_migrate_projects_to_entities.sql'),
  ('0021_default_workspace_home_bento.sql'),
  ('0021_remove_project_ids_columns.sql'),
  ('0022_drop_projects_table.sql'),
  ('0023_seed_system_profiles.sql'),
  ('0024_add_entities_document_id_index.sql'),
  ('0025_add_sharing_capabilities.sql'),
  ('0026_add_chat_threads_workspace_id.sql'),
  ('0027_intelligence_commands.sql'),
  ('0028_command_runs.sql'),
  ('0029_documents_entity_id.sql'),
  ('0030_fix_thread_entities_documents_schema.sql'),
  ('0031_add_document_sessions_columns.sql'),
  ('0031_system_settings.sql'),
  ('0032_add_entities_search_vector.sql'),
  ('0032_ai_agent_users.sql'),
  ('0033_relation_defs_profile_relations.sql'),
  ('0033_secrets_vault.sql'),
  ('0034_proposals_agent_user_expiry.sql'),
  ('0034_seed_default_relation_defs.sql'),
  ('0035_consolidate_data_model.sql'),
  ('0035_create_message_links.sql'),
  ('0036_fix_resource_shares_schema.sql'),
  ('0036_service_secrets.sql'),
  ('0037_channel_mcp_server_ids.sql'),
  ('0037_proposals_thread_linkage.sql'),
  ('0037_rebuild_intelligence_services.sql'),
  ('0038_channels_refactor.sql'),
  ('0038_intelligence_service_key_encryption.sql'),
  ('0038_widget_definitions.sql'),
  ('0039_profile_scoped_property_defs.sql'),
  ('0040_profile_shared_scope.sql'),
  ('0041_a2ai_channels.sql'),
  ('0042_mcp_approved.sql'),
  ('0043_mcp_endpoint.sql'),
  ('0044_api_keys_type_description.sql'),
  ('0045_intelligence_service_health_status.sql'),
  ('0046_entities_system_data.sql'),
  ('0047_session_scoped_memory.sql'),
  ('0047_skills_kind_scope_agent_types.sql'),
  ('0048_session_last_activity.sql'),
  ('0049_align_entity_templates.sql'),
  ('0049_thread_channel_type_and_agent_governance.sql'),
  ('0050_create_mcp_servers.sql'),
  ('0050_drop_agent_type_check_constraint.sql'),
  ('0051_channel_connections.sql'),
  ('0051_rename_channels_mcp_server_id.sql'),
  ('0052_channel_connections_pod_wide.sql'),
  ('0052_profile_slug_scoped_unique.sql'),
  ('0053_automations.sql'),
  ('0053_drop_old_profiles_slug_idx.sql'),
  ('0054_entity_external_links.sql'),
  ('0054_profile_semantic_slug.sql'),
  ('0055_performance_indexes.sql'),
  ('0056_widget_native_columns.sql'),
  ('0057_unified_relations.sql'),
  ('0058_skill_triggers.sql'),
  ('0058_unified_invites.sql'),
  ('0059_invites_consistency_check.sql'),
  ('0059_notifications.sql'),
  ('0060_entity_scope_column.sql'),
  ('0060_sync_tables.sql'),
  ('0061_profile_entity_scope.sql'),
  ('0062_entities_workspace_id_nullable.sql'),
  ('0063_relations_indexes.sql'),
  ('0064_channel_purpose.sql'),
  ('0064_property_defs_profile_scoped_unique.sql'),
  ('0065_property_defs_workspace_scope.sql'),
  ('0066_channel_system_v2.sql'),
  ('0099_schema_reconciliation.sql'),
  ('0101_sync_generation_split_brain.sql'),
  ('0102_feed_channels_index.sql')
ON CONFLICT ("filename") DO NOTHING;
