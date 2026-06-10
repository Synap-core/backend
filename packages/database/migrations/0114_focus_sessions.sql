-- Migration: 0114_focus_sessions.sql
-- Adds the focus_sessions table for goal-bound user work sessions.
-- This is workflow-side infrastructure, entirely separate from the
-- `sessions` table (which is IS memory/compaction machinery).

CREATE TABLE IF NOT EXISTS "focus_sessions" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"     text        NOT NULL,
  "user_id"          text        NOT NULL,
  "correlation_id"   text,
  "goal"             text        NOT NULL,
  "status"           text        NOT NULL DEFAULT 'active',
  "template_id"      text,
  "expected_outputs" jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "channel_id"       uuid,
  "progress"         integer,
  "agent_ids"        text[]      NOT NULL DEFAULT ARRAY[]::text[],
  "closed_at"        timestamptz,
  "started_at"       timestamptz NOT NULL DEFAULT now(),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: enforce one session per IS correlation ID (NULLs excluded).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_focus_sessions_correlation_id"
  ON "focus_sessions" ("correlation_id")
  WHERE "correlation_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_focus_sessions_workspace_id" ON "focus_sessions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_user_id"      ON "focus_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_status"       ON "focus_sessions" ("status");
