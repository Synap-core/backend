-- Migration: 0129_playbook_runs.sql
-- Phase 3 of the Playbooks & Capability Substrate
-- (design doc: team/platform/playbooks-capability-substrate.mdx §4.3-4.4).
--
-- Adds the RUN LEDGER — one row per execution of a Playbook. A run is the
-- runtime instance recorded when the executor spine dispatches a playbook to
-- its `ExecutorRef` (is-agent | external-agent | hybrid). It links the config
-- (playbooks) to the runtime (focus_sessions) and records status/summary/error
-- as the executor reports back (capture-back via POST /runs/:id/capture).
--
-- ADDITIVE only — no change to existing tables beyond this new table.

-- ── playbook_runs (the run ledger; FKs to playbooks + focus_sessions) ─────────
CREATE TABLE IF NOT EXISTS "playbook_runs" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid,
  "playbook_id"  uuid        NOT NULL REFERENCES "playbooks"("id") ON DELETE CASCADE,
  "session_id"   uuid        REFERENCES "focus_sessions"("id") ON DELETE SET NULL,
  "executor"     text        NOT NULL,
  "status"       text        NOT NULL DEFAULT 'running',
  "input"        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "summary"      text,
  "error"        text,
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "created_by"   text        NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_playbook_runs_playbook_id"
  ON "playbook_runs" ("playbook_id");
CREATE INDEX IF NOT EXISTS "idx_playbook_runs_session_id"
  ON "playbook_runs" ("session_id")
  WHERE "session_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_playbook_runs_workspace_status"
  ON "playbook_runs" ("workspace_id", "status");
