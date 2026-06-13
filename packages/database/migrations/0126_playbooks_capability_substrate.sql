-- Migration: 0126_playbooks_capability_substrate.sql
-- Phase 0 of the Playbooks & Capability Substrate
-- (design doc: team/platform/playbooks-capability-substrate.mdx).
--
-- Adds three CONFIGURATION tables — separated from entity DATA per the
-- data/config separation principle:
--   tools     — registered integrations the AI can use (creds via vault)
--   playbooks — session templates (goal + params + capabilities + schedule)
--   links     — polymorphic config/runtime graph edges (mirrors `relations`
--               for non-entity objects), powering uniform "related" fetch +
--               graph + detail pages across playbook/tool/skill/session/entity.
-- Plus focus_sessions.playbook_id (runtime → config FK).

-- ── tools (registered integrations) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tools" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"   uuid,
  "created_by"     text        NOT NULL,
  "name"           text        NOT NULL,
  "description"    text,
  "kind"           text        NOT NULL,
  "input_schema"   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "credential_ref" text,
  "executor"       text        NOT NULL DEFAULT 'is-agent',
  "config"         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "status"         text        NOT NULL DEFAULT 'active',
  "metadata"       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_tools_workspace_id" ON "tools" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_tools_kind"         ON "tools" ("kind");

-- ── playbooks (session templates) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "playbooks" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"     uuid,
  "created_by"       text        NOT NULL,
  "name"             text        NOT NULL,
  "description"      text,
  "goal_template"    text        NOT NULL,
  "params"           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "input_strategy"   jsonb       NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
  "channel_spec"     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "expected_outputs" jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "schedule"         jsonb,
  "executor"         text        NOT NULL DEFAULT 'is-agent',
  "status"           text        NOT NULL DEFAULT 'draft',
  "metadata"         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_playbooks_workspace_id" ON "playbooks" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_playbooks_status"       ON "playbooks" ("status");

-- ── links (polymorphic config/runtime graph edges) ───────────────────────────
CREATE TABLE IF NOT EXISTS "links" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid,
  "from_type"    text        NOT NULL,
  "from_id"      text        NOT NULL,
  "to_type"      text        NOT NULL,
  "to_id"        text        NOT NULL,
  "link_type"    text        NOT NULL,
  "metadata"     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "created_by"   text,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_links_from" ON "links" ("from_type", "from_id");
CREATE INDEX IF NOT EXISTS "idx_links_to"   ON "links" ("to_type", "to_id");
CREATE INDEX IF NOT EXISTS "idx_links_type" ON "links" ("link_type");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_links_unique_edge"
  ON "links" ("from_type", "from_id", "to_type", "to_id", "link_type");

-- ── focus_sessions.playbook_id (runtime → config FK; created AFTER playbooks) ──
ALTER TABLE "focus_sessions"
  ADD COLUMN IF NOT EXISTS "playbook_id" uuid REFERENCES "playbooks"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_playbook_id"
  ON "focus_sessions" ("playbook_id")
  WHERE "playbook_id" IS NOT NULL;
