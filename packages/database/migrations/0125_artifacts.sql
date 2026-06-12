-- Migration: 0125_artifacts.sql
-- Adds the artifacts table — the ledger that records lifecycle + provenance
-- for cell instances placed on the desk, home, sidebar, or library.
-- This is Phase 1 of the Desk & Artifact System (design doc: desk-artifact-system.mdx).

CREATE TABLE IF NOT EXISTS "artifacts" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text        NOT NULL,
  "user_id"      text        NOT NULL,
  "kind"         text        NOT NULL,
  "ref_id"       text,
  "cell_key"     text,
  "props"        jsonb,
  "title"        text        NOT NULL,
  "origin_kind"  text        NOT NULL DEFAULT 'user',
  "actor_id"     text,
  "session_id"   uuid,
  "state"        text        NOT NULL DEFAULT 'working',
  "placement"    text        NOT NULL DEFAULT 'desk',
  "kept_at"      timestamptz,
  "swept_at"     timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_artifacts_workspace_state"
  ON "artifacts" ("workspace_id", "state");

CREATE INDEX IF NOT EXISTS "idx_artifacts_session_id"
  ON "artifacts" ("session_id")
  WHERE "session_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_artifacts_user_id"
  ON "artifacts" ("user_id");
