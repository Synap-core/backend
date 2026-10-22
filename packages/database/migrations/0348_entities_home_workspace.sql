-- 0348 — the space a POD-WIDE entity was filed FOR (founder decision, 2026-10-22).
--
-- Additive + idempotent: every statement is IF NOT EXISTS. Fresh installs also
-- get the column from 0000_baseline_schema.sql.
--
-- A pod-scope kind (decision, knowledge, person, …) lands pod-wide
-- (`workspace_id` NULL) even when it was written from a space (placement
-- decisions D1 / FX-B1 / D14: "pin ≠ exclusive"). Until now the read floor then
-- made it visible to its OWNER only, so a decision filed for a team was hidden
-- from that team. `home_workspace_id` records the space the write came from;
-- the read floor (`accessScopeWhere`) lets that space's MEMBERS read it. The
-- row stays pod-wide: placement, write-targetability and every other lens are
-- unchanged.
--
-- Set ONLY on a pod-wide row (the CHECK makes that a database fact): moving an
-- entity into a space clears it, moving it out to pod-wide sets it to the space
-- it left. No backfill — existing rows keep NULL (owner-only, as before).

ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "home_workspace_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_home_workspace_id_fkey') THEN
    ALTER TABLE "entities" ADD CONSTRAINT "entities_home_workspace_id_fkey"
      FOREIGN KEY ("home_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_home_workspace_pod_wide_check') THEN
    ALTER TABLE "entities" ADD CONSTRAINT "entities_home_workspace_pod_wide_check"
      CHECK ("home_workspace_id" IS NULL OR "workspace_id" IS NULL);
  END IF;
END $$;

-- The read floor asks "pod-wide rows homed in a space I belong to".
CREATE INDEX IF NOT EXISTS "entities_home_workspace_idx"
  ON "entities" ("home_workspace_id")
  WHERE "workspace_id" IS NULL AND "home_workspace_id" IS NOT NULL;
