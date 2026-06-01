-- 0035_proposal_correlation.sql
--
-- Reactions convergence (Step 1): link proposals back to the event spine.
--
-- Every PROPOSE branch of checkPermissionOrPropose now records (or reuses) a
-- `{subject}.{action}.requested` event. We persist the correlation chain and
-- the concrete originating event row id directly on the proposal so the
-- proposal ↔ event linkage is queryable without scanning JSONB.
--
-- Both columns nullable — pre-existing proposals have no linkage.

ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "correlation_id" uuid;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "requested_event_id" uuid;

CREATE INDEX IF NOT EXISTS "proposals_correlation_id_idx"
  ON "proposals" ("correlation_id");
