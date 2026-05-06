-- 0020_api_keys_workspace_scope.sql
--
-- Add workspace scoping to api_keys.
--
-- Background
-- ----------
-- API keys were originally pod-wide / user-scoped. The new
-- `apiKeys.{listForWorkspace, createForWorkspace, revokeForWorkspace}`
-- procedures need a way to tag a key to a specific workspace so the
-- workspace-admin UI can list/manage only the keys that belong to it
-- (without leaking keys from other workspaces a user is also a member of).
--
-- Defensive (per backend-rules.md):
--   - ADD COLUMN IF NOT EXISTS — safe to re-run
--   - CREATE INDEX IF NOT EXISTS — safe to re-run
--   - No backfill: existing pod-wide / user-scoped keys keep workspace_id = NULL,
--     which preserves all current behavior.
--
-- Same DDL is duplicated in 0000_baseline_schema.sql so a fresh pod boots with
-- this column without needing the incremental migration; schema-coherence
-- gets a new entry for the tripwire.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE INDEX IF NOT EXISTS "api_keys_workspace_id_idx"
  ON "api_keys" ("workspace_id")
  WHERE "workspace_id" IS NOT NULL;
