-- 0359 — when we last SPOKE to someone (CRM recall plan C-W2, founder 2026-10-26).
--
-- Additive + idempotent: every statement is IF NOT EXISTS. Fresh installs also
-- get the column from 0000_baseline_schema.sql.
--
-- `last_interaction_at` is the TRUTH; `properties.lastInteractionAt` is its
-- READ PROJECTION (views, bento recipes, the hygiene expression keep reading
-- it). Both are written in ONE statement by ONE door, `noteInteraction`
-- (`services/interactions/note-interaction.ts`, @synap/database), which only
-- moves the value FORWARD. "Spoke to" = a meeting that happened, sent
-- outreach, a dated conversation; never a mention, an edit or a future
-- meeting. NULL = never (shown as "Never").
--
-- No data is moved by this file: the backfill is the operator script
-- `recompute-last-interaction` (it rebuilds the value from the graph).

ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "last_interaction_at" timestamptz;

-- "Who haven't I spoken to in a month" lists a kind ordered / windowed on it.
CREATE INDEX IF NOT EXISTS "entities_profile_last_interaction_idx"
  ON "entities" ("profile_id", "last_interaction_at")
  WHERE "deleted_at" IS NULL;
