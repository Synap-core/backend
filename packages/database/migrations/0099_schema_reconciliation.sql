-- ============================================================================
-- 0099_schema_reconciliation.sql  (CUSTOM — runs after all other migrations)
-- ============================================================================
--
-- Why this file is in migrations-custom/ (not migrations-drizzle/)
-- ----------------------------------------------------------------
-- The channels table is created by custom/0038_channels_refactor.sql. On fresh
-- pods the drizzle runner previously ran before custom migrations, causing
-- drizzle/0066_channel_system_v2 and earlier channel-altering migrations to
-- fail. By placing this reconciliation in migrations-custom/ it is guaranteed
-- to run AFTER all migrations that create the channels table.
--
-- With the interleaved runner (migrate.ts) both directories are sorted together
-- by filename. 0099 sorts last, so it truly acts as the catch-all regardless
-- of runner version.
--
-- Why this exists
-- ---------------
-- The repo stopped using drizzle-kit generate after migration 0003. Every
-- schema change since then has been a hand-written .sql migration, and some
-- columns declared in packages/database/src/schema/*.ts never made it into a
-- numbered .sql file at all — or were only added defensively in files that
-- a given pod may never have reached.
--
-- Additionally, some drizzle migrations that alter the channels table sort
-- before custom/0038_channels_refactor (which creates channels). Those
-- migrations skip gracefully via DO $$ IF EXISTS $$ blocks; this file catches
-- up any columns they would have added.
--
-- What this migration does
-- ------------------------
-- Idempotently reconciles the live DB with the Drizzle schema by:
--   1. CREATE TABLE IF NOT EXISTS channels — fallback for pods where the
--      custom 0038 refactor never ran (e.g. missing migrations-custom volume).
--   2. ADD COLUMN IF NOT EXISTS for every column the schema declares that is
--      not guaranteed by an earlier migration.
--   3. CREATE TABLE IF NOT EXISTS for tables that only ever existed in code.
--   4. CREATE INDEX IF NOT EXISTS for all declared indexes.
--
-- Fully idempotent and safe to re-run. Must NEVER drop data.
--
-- Adding a new column? Land it in a numbered migration AND add it here so pods
-- upgrading from any starting point catch up. See backend-rules.md.
--
-- ============================================================================

-- ─── channels table (fallback) ───────────────────────────────────────────────
-- Created by custom/0038_channels_refactor.sql (renames chat_threads).
-- If that migration never ran (missing migrations-custom volume in a prior
-- deploy), create the table here from scratch so all subsequent ALTER TABLE
-- operations succeed.

CREATE TABLE IF NOT EXISTS "channels" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             text        NOT NULL,
  "workspace_id"        uuid,
  "channel_type"        text        NOT NULL DEFAULT 'thread',
  "scope"               text        NOT NULL DEFAULT 'workspace',
  "feed_scope"          text,
  "status"              text        DEFAULT 'active',
  "title"               text,
  "parent_channel_id"   uuid,
  "branch_purpose"      text,
  "result_summary"      text,
  "merged_at"           timestamptz,
  "agent_id"            text,
  "agent_type"          text        DEFAULT 'none',
  "agent_config"        jsonb,
  "context_object_type" text,
  "context_object_id"   uuid,
  "external_source"     text,
  "external_channel_id" text,
  "context_summary"     text,
  "metadata"            jsonb,
  "created_at"          timestamptz DEFAULT now(),
  "updated_at"          timestamptz DEFAULT now()
);

-- ─── channels — V2 columns ───────────────────────────────────────────────────
-- scope + feed_scope added in 0066. result_summary added in 0047 custom.
-- Re-add here so pods that skipped 0066 (channels didn't exist yet) catch up.

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "feed_scope" TEXT;

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "result_summary" text;

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "merged_at" timestamptz;

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "merged_into_state_id" uuid;

-- V2 data migrations (idempotent — WHERE clauses ensure no double-application)
UPDATE "channels" SET agent_type = 'none'       WHERE agent_type = 'default';
UPDATE "channels" SET channel_type = 'thread'   WHERE channel_type = 'ai_thread';
UPDATE "channels" SET channel_type = 'sub_thread' WHERE channel_type = 'branch';
UPDATE "channels" SET channel_type = 'thread'   WHERE channel_type IN ('entity_comments', 'document_review', 'view_discussion');
UPDATE "channels" SET channel_type = 'external' WHERE channel_type = 'external_import';
UPDATE "channels" SET channel_type = 'agent_collab' WHERE channel_type = 'a2ai';
UPDATE "channels" SET channel_type = 'sub_thread'
  WHERE channel_type = 'thread' AND parent_channel_id IS NOT NULL;
UPDATE "channels" SET scope = 'pod' WHERE workspace_id IS NULL AND scope = 'workspace';

-- Drop channel_purpose column if it still exists (dropped by 0066 on pods that ran it)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'channel_purpose'
  ) THEN
    DROP INDEX IF EXISTS channels_purpose_idx;
    ALTER TABLE channels DROP COLUMN channel_purpose;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "channels_scope_idx" ON "channels" ("scope");
CREATE INDEX IF NOT EXISTS "channels_type_idx"  ON "channels" ("channel_type");
CREATE INDEX IF NOT EXISTS "channels_user_id_idx"       ON "channels" ("user_id");
CREATE INDEX IF NOT EXISTS "channels_workspace_id_idx"  ON "channels" ("workspace_id");
CREATE INDEX IF NOT EXISTS "channels_status_idx"        ON "channels" ("status");
CREATE INDEX IF NOT EXISTS "channels_parent_channel_id_idx" ON "channels" ("parent_channel_id");
CREATE INDEX IF NOT EXISTS "channels_context_idx"
  ON "channels" ("context_object_type", "context_object_id")
  WHERE "context_object_id" IS NOT NULL;

-- ─── property_defs ───────────────────────────────────────────────────────────
-- Columns added in 0057 (unified relations), 0064 (profile scope), 0065 (workspace scope).

ALTER TABLE "property_defs"
  ADD COLUMN IF NOT EXISTS "profile_id" uuid
    REFERENCES "profiles"("id") ON DELETE CASCADE;

ALTER TABLE "property_defs"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid
    REFERENCES "workspaces"("id") ON DELETE CASCADE;

ALTER TABLE "property_defs"
  ADD COLUMN IF NOT EXISTS "relation_def_id" uuid
    REFERENCES "relation_defs"("id") ON DELETE SET NULL;

ALTER TABLE "property_defs"
  ADD COLUMN IF NOT EXISTS "target_profile_id" uuid
    REFERENCES "profiles"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "property_defs_value_type_idx"
  ON "property_defs" ("value_type");

CREATE INDEX IF NOT EXISTS "property_defs_profile_id_idx"
  ON "property_defs" ("profile_id");

CREATE INDEX IF NOT EXISTS "property_defs_relation_def_id_idx"
  ON "property_defs" ("relation_def_id") WHERE "relation_def_id" IS NOT NULL;

-- ─── messages ────────────────────────────────────────────────────────────────
-- session_id (0047 custom). author_type / message_category / external_source
-- / inbox_item_id (0038 custom channels refactor).

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "session_id" uuid;

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "author_type" TEXT NOT NULL DEFAULT 'human';

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "message_category" TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "external_source" TEXT;

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "inbox_item_id" uuid;

CREATE INDEX IF NOT EXISTS "messages_session_id_idx"  ON "messages" ("session_id");
CREATE INDEX IF NOT EXISTS "messages_ext_source_idx"  ON "messages" ("external_source");

-- ─── entities ────────────────────────────────────────────────────────────────

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "system_data" jsonb NOT NULL DEFAULT '{}';

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "profile_id" uuid
    REFERENCES "profiles"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "entities_profile_id_idx" ON "entities" ("profile_id");

-- ─── profiles ────────────────────────────────────────────────────────────────

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "semantic_slug" text;

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "entity_scope" text NOT NULL DEFAULT 'workspace';

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "default_values" jsonb NOT NULL DEFAULT '{}';

-- ─── api_keys ────────────────────────────────────────────────────────────────

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "key_type" text NOT NULL DEFAULT 'hub_inbound';

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "description" text;

-- ─── proposals ───────────────────────────────────────────────────────────────

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "agent_user_id" text
    REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "created_by" text;

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "thread_id" uuid;

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "command_run_id" uuid;

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "source_message_id" uuid;

-- ─── channel_context_items ───────────────────────────────────────────────────

ALTER TABLE "channel_context_items"
  ADD COLUMN IF NOT EXISTS "relevance_score" real;

-- ─── widget_definitions ──────────────────────────────────────────────────────

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "source" text;

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "bundle_source" text;

-- ─── users ───────────────────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "user_type" text NOT NULL DEFAULT 'human';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "agent_metadata" jsonb;

-- ─── agent_configs ───────────────────────────────────────────────────────────
-- Per-user, per-workspace agent configuration overrides.
-- Declared in src/schema/agent-configs.ts — never created by a numbered migration.

CREATE TABLE IF NOT EXISTS "agent_configs" (
  "id"                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            text        NOT NULL,
  "workspace_id"       uuid        NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_type"         text        NOT NULL,
  "prompt_append"      text,
  "extra_tool_ids"     jsonb       NOT NULL DEFAULT '[]',
  "disabled_tool_ids"  jsonb       NOT NULL DEFAULT '[]',
  "max_steps_override" integer,
  "model_override"     text,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_configs_user_workspace_agent_unique"
    UNIQUE ("user_id", "workspace_id", "agent_type")
);

CREATE INDEX IF NOT EXISTS "agent_configs_user_id_idx"
  ON "agent_configs" ("user_id");

CREATE INDEX IF NOT EXISTS "agent_configs_workspace_id_idx"
  ON "agent_configs" ("workspace_id");

CREATE INDEX IF NOT EXISTS "agent_configs_agent_type_idx"
  ON "agent_configs" ("agent_type");

-- ─── entity_identity_signals ─────────────────────────────────────────────────
-- Cross-source identity dedup. Declared in schema — never created by a numbered migration.

CREATE TABLE IF NOT EXISTS "entity_identity_signals" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id"    uuid        NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "signal_type"  text        NOT NULL,
  "signal_value" text        NOT NULL,
  "source"       text        NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "entity_identity_signals_type_value_idx"
  ON "entity_identity_signals" ("signal_type", "signal_value");

CREATE INDEX IF NOT EXISTS "entity_identity_signals_entity_id_idx"
  ON "entity_identity_signals" ("entity_id");

CREATE INDEX IF NOT EXISTS "entity_identity_signals_signal_type_idx"
  ON "entity_identity_signals" ("signal_type");
