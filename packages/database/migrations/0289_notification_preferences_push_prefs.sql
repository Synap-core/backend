-- 0289 — per-person push categories (W8 "Phone magic").
--
-- `push_prefs` holds the sparse `PushPrefs` shape from `@synap-core/types/push`:
--   { "categories": { "<category>": true|false } }
-- (A morning-brief time was planned here and retracted before shipping: no
-- producer reads it. The migration runner applies files by name, unchecksummed,
-- so this comment was corrected in place.)
-- A category absent from the map reads as its default (never as off).
--
-- A COLUMN, not a key inside `routing_rules`: that map is a flat
-- `{ type|category: "in_app"|"os"|"all"|"mute" }` string map that three
-- surfaces iterate as such (the producer, the catalogue, browser settings);
-- a nested object there would be read as an unknown rule. Push categories are
-- PERSON-scoped, so only the pod-wide row (workspace_id IS NULL) is read.
--
-- Additive + idempotent.
ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "push_prefs" jsonb NOT NULL DEFAULT '{}';
