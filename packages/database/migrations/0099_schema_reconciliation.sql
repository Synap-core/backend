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

-- ─── inbox_items ─────────────────────────────────────────────────────────────
-- 0003 created an early variant of inbox_items with only id, workspace_id,
-- user_id, type, title, summary, link, read_at, archived_at, created_at,
-- expire_at. The current Drizzle schema (packages/database/src/schema/inbox-items.ts)
-- evolved to carry a full Life Feed payload — provider, account, external_id,
-- deep_link, preview, timestamp, status, snoozed_until, priority, tags,
-- data, processed_at, updated_at — but no numbered migration added the
-- new columns. Relay's useFeed crashes on every page load because it
-- SELECTs columns the user's pod doesn't have.
--
-- We add every missing column as NULLABLE (no NOT NULL) so existing rows
-- don't need backfill. New inserts from the Life Feed code path will
-- populate them; old placeholder rows stay intact.

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "provider" varchar(50);

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "account" varchar(255);

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "external_id" varchar(500);

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "deep_link" text;

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "preview" text;

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "timestamp" timestamptz;

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'unread';

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamptz;

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "priority" varchar(20);

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "tags" text[];

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL DEFAULT '{}';

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "processed_at" timestamptz;

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

-- Backfill `timestamp` from `created_at` for existing rows so the ORDER BY
-- in useFeed returns rows instead of nulls. Safe to run repeatedly because
-- we only set NULL values.
UPDATE "inbox_items"
  SET "timestamp" = "created_at"
  WHERE "timestamp" IS NULL;

-- Indexes from the current schema. All IF NOT EXISTS so they're idempotent.
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

-- Unique index is conditional — only meaningful once provider + external_id
-- are populated, which is true for new Life Feed rows but not for any
-- legacy rows from the 0003-era schema.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbox_external_unique"
  ON "inbox_items" ("user_id", "provider", "external_id")
  WHERE "provider" IS NOT NULL AND "external_id" IS NOT NULL;

-- ─── sync_generation table (split-brain prevention) ─────────────────────────
-- Added by 0101_sync_generation_split_brain.sql. Reconcile here for pods
-- upgrading from any starting point.

CREATE TABLE IF NOT EXISTS sync_generation (
  id TEXT PRIMARY KEY DEFAULT 'current',
  generation BIGINT NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary', 'replica', 'standalone', 'readonly')),
  promoted_at TIMESTAMPTZ,
  promoted_from TEXT,
  last_peer_generation BIGINT DEFAULT 0,
  last_peer_contact TIMESTAMPTZ,
  split_brain_detected BOOLEAN NOT NULL DEFAULT false,
  split_brain_detected_at TIMESTAMPTZ,
  split_brain_local_gen BIGINT,
  split_brain_remote_gen BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sync_generation (id, generation, role)
VALUES ('current', 0, 'primary')
ON CONFLICT (id) DO NOTHING;
