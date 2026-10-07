-- 0316 — per-connection personalisation (Connected, founder decision 7).
--
-- `connection_prefs` holds `{ "<kind>:<id>": { "pinned"?: bool, "notify"?:
-- "everything"|"problems"|"nothing" } }`, kind ∈ the membrane
-- `CONNECTION_KINDS` (app|agent|account|channel|tool|model|webhook). Sparse:
-- a key the person never touched reads as unpinned + `problems`.
--
-- On the POD-WIDE row (workspace_id IS NULL) only, like `push_prefs` (0289):
-- a connection belongs to the person, not to a workspace. A COLUMN, not a key
-- in `routing_rules` (a flat string map three surfaces iterate) and not in
-- `user_preferences.ui_preferences` (its write door replaces the whole blob):
-- the notifier reads the level here, and the pin rides in the same record so
-- one connection has one personalisation row.
--
-- Additive + idempotent.
ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "connection_prefs" jsonb NOT NULL DEFAULT '{}';
