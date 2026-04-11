-- ============================================================================
-- 0099_schema_reconciliation.sql
-- ============================================================================
--
-- CATCH-UP / RECONCILIATION MIGRATION
--
-- Why this exists
-- ---------------
-- The repo stopped using drizzle-kit generate after migration 0003. Every
-- schema change since then has been a hand-written .sql migration, and some
-- columns declared in packages/database/src/schema/*.ts never made it into a
-- numbered .sql file at all — or were only added defensively in files that
-- a given pod may never have reached (e.g. a pod that last deployed at 0063
-- never ran 0064/0065/0066/... and is silently missing columns the Drizzle
-- schema and runtime code both assume exist).
--
-- Additionally, migrations-custom/ and migrations-drizzle/ have historically
-- drifted: a few tables (entity_identity_signals, agent_configs) live only in
-- the TypeScript schema and have never been created by any migration at all.
--
-- What this migration does
-- ------------------------
-- Idempotently reconciles the *live* DB with the Drizzle schema by:
--   1. ADD COLUMN IF NOT EXISTS for every column the schema declares that is
--      not guaranteed by an earlier migration (pod-age-independent).
--   2. CREATE TABLE IF NOT EXISTS for tables that only ever existed in code.
--   3. CREATE INDEX IF NOT EXISTS for indexes the Drizzle schema declares.
--   4. Every foreign-key ON DELETE behaviour matches the Drizzle schema.
--
-- It is fully idempotent and safe to re-run. It must NEVER drop data.
-- If this migration fails, the runner will now block (see migrate.ts banner).
--
-- Adding a new column? The rule: land it in a new numbered migration AND add
-- it to this reconciliation file so pods upgrading from arbitrary starting
-- points catch up. See .claude/rules/backend-rules.md.
--
-- ============================================================================

-- ─── property_defs ──────────────────────────────────────────────────────────
-- Columns added defensively in 0057 (unified relations), 0064 (profile scope),
-- and 0065 (workspace scope). Re-add here so pods that stopped before those
-- migrations catch up in one shot.

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

-- ─── channels ───────────────────────────────────────────────────────────────
-- scope + feed_scope added in 0066 (channel system v2).
-- result_summary + merged_into_state_id added in 0047 custom (session memory).
-- Re-add here so pods that stopped earlier catch up.

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'workspace'
    CHECK ("scope" IN ('pod', 'workspace', 'user'));

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "feed_scope" TEXT
    CHECK ("feed_scope" IN ('user', 'workspace'));

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "result_summary" text;

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "merged_into_state_id" uuid;

CREATE INDEX IF NOT EXISTS "channels_scope_idx" ON "channels" ("scope");
CREATE INDEX IF NOT EXISTS "channels_type_idx" ON "channels" ("channel_type");

-- ─── messages ───────────────────────────────────────────────────────────────
-- session_id added in 0047 custom. author_type / message_category / external_source
-- / inbox_item_id added in 0038 custom (channels refactor).

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

CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "messages" ("session_id");
CREATE INDEX IF NOT EXISTS "messages_ext_source_idx" ON "messages" ("external_source");

-- ─── entities ───────────────────────────────────────────────────────────────
-- system_data (0046 custom) and profile_id (0003_sparkling_thundra / earlier
-- custom migration) — defensive re-add.

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "system_data" jsonb NOT NULL DEFAULT '{}';

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "profile_id" uuid
    REFERENCES "profiles"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "entities_profile_id_idx" ON "entities" ("profile_id");

-- ─── profiles ───────────────────────────────────────────────────────────────
-- semantic_slug (0054), entity_scope (0060 drizzle / 0061 custom), default_values
-- (0035). Re-add defensively.

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "semantic_slug" text;

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "entity_scope" text NOT NULL DEFAULT 'workspace';

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "default_values" jsonb NOT NULL DEFAULT '{}';

-- ─── api_keys ───────────────────────────────────────────────────────────────
-- key_type + description added in 0044 custom.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "key_type" text NOT NULL DEFAULT 'hub_inbound';

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "description" text;

-- ─── proposals ──────────────────────────────────────────────────────────────
-- agent_user_id + expires_at (0034) + thread_id, command_run_id, source_message_id,
-- created_by (0037 custom). Re-add defensively.

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

-- ─── channel_context_items ──────────────────────────────────────────────────
-- relevance_score added in 0047 custom.

ALTER TABLE "channel_context_items"
  ADD COLUMN IF NOT EXISTS "relevance_score" real;

-- ─── widget_definitions ────────────────────────────────────────────────────
-- source + bundle_source added in 0056 (native widgets).

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "source" text;

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "bundle_source" text;

-- ─── users ──────────────────────────────────────────────────────────────────
-- user_type + agent_metadata added in 0032 custom (AI agent users).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "user_type" text NOT NULL DEFAULT 'human';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "agent_metadata" jsonb;

-- ─── agent_configs ──────────────────────────────────────────────────────────
-- Per-user, per-workspace agent configuration overrides.
-- Declared in src/schema/agent-configs.ts but NEVER created by any previous
-- migration. This is the first migration that creates the table.

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

-- ─── entity_identity_signals ────────────────────────────────────────────────
-- Cross-source identity signals (email, phone, linkedin, github, ...) used
-- for O(1) dedup lookup. Declared in src/schema/entity-identity-signals.ts
-- but NEVER created by any previous migration.

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
