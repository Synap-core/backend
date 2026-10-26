-- 0345 — WHAT A GOAL HOLDS (work model W2, 2026-10-23)
--
-- A goal (a track) holds, beside its name, direction and KPI (0302):
--
--   end_state          what "done" looks like, in words (NULL = unsaid)
--   criteria           0 or 2–5 criteria, the SAME shape as a session's
--                      (`SessionCriterion`, read by the same `readCriteria`),
--                      each with the judge's `acceptance` once decided (R2).
--                      NULL / [] = a lasting goal. The count rule (2–5) is the
--                      write door's (`setTrackDirection` / `startTrack`).
--   drop_conditions    when to stop: a list of lines (string[]), NULL = none
--   work_kind          the kind of work (decision 4)
--   uncertainty        how well the way is known (decision 4)
--   kind_confirmed_by  the person who confirmed kind + uncertainty, and when.
--   kind_confirmed_at  The AI proposes them; a person writing them directly
--                      counts as confirmed. NULL = proposed, not confirmed.
--
-- Machine name `work_kind`, not `kind`: "kind" already names an entity's
-- kind (profiles), a session's kind (work · run · receipt) and a template's
-- kind in this codebase.
--
-- Nothing derived is stored: a criterion's mark (met · claimed · under way ·
-- not met · not started), "in review" and "waiting on" are computed on read
-- from the sessions filed into the goal (`deriveGoalCriteria`,
-- @synap-core/types/units).
--
-- `project_tracks` is NOT in 0000_baseline_schema.sql (it references
-- `projects`, created by 0151): the new columns are guarded by
-- schema-coherence.ts only, like 0302 and 0344. Idempotent.

ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "end_state" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "criteria" jsonb;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "drop_conditions" jsonb;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "work_kind" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "uncertainty" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "kind_confirmed_by" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "kind_confirmed_at" timestamptz;

-- The closed sets (`TRACK_WORK_KINDS`, `TRACK_UNCERTAINTY_LEVELS`,
-- @synap-core/types/units — the DB mirrors in schema/project-tracks.ts are
-- pinned to them at compile time). A CHECK passes on NULL, and `NULL IN (...)`
-- is NULL, so NULL stays allowed: a goal with no kind yet.
ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_work_kind_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_work_kind_check"
  CHECK ("work_kind" IS NULL OR "work_kind" IN (
    'project', 'flow', 'operation', 'investigation', 'incident', 'commission', 'pathway'
  ));

ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_uncertainty_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_uncertainty_check"
  CHECK ("uncertainty" IS NULL OR "uncertainty" IN (
    'clear', 'complicated', 'complex', 'chaotic', 'unknown'
  ));

-- Criteria and drop conditions are LISTS: anything else is refused, so a
-- reader never has to guess what a scalar meant.
ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_criteria_array_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_criteria_array_check"
  CHECK ("criteria" IS NULL OR jsonb_typeof("criteria") = 'array');

ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_drop_conditions_array_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_drop_conditions_array_check"
  CHECK ("drop_conditions" IS NULL OR jsonb_typeof("drop_conditions") = 'array');
