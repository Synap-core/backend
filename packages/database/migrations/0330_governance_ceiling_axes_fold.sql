-- 0330 — the caps fold (agent routing W1c): every numeric governance limit
-- lives in `governance_ceilings`, read through ONE resolver (`resolveCeiling`).
--
-- Four limits that were system constants become user-editable axes. Their
-- fallback values stay in code, in ONE table (`CEILING_DEFAULTS`, which must
-- name every axis — a new axis with no default does not build):
--   automation_ai_dispatch_per_run   AI dispatches one automation run may start
--   automation_ai_dispatch_daily     rolling-24h AI dispatches per automation
--   worker_pending_approvals         sends a worker may have waiting on a person
--   worker_irreversible_sends_daily  sends a worker may make per UTC day
--
-- A ceiling can now name its SUBJECT (`subject_type` + `subject_id`, e.g. one
-- automation): the most specific row wins, a subject match above the
-- principal and scope ranks. Both NULL = the row applies to every subject.
--
-- TRANSACTION NOTE: as 0266 — `ALTER TYPE … ADD VALUE` is legal inside the
-- migration transaction on Postgres 12+ when the value is not used in it.
ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'automation_ai_dispatch_per_run';
ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'automation_ai_dispatch_daily';
ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'worker_pending_approvals';
ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'worker_irreversible_sends_daily';

ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "subject_type" text;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "subject_id" text;
CREATE INDEX IF NOT EXISTS "governance_ceilings_subject_idx"
  ON "governance_ceilings" ("axis", "subject_type", "subject_id")
  WHERE "revoked_at" IS NULL AND "subject_id" IS NOT NULL;
