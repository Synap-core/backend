-- 0350 — A GOAL PROPOSES ITS NEXT RUN (work model W4, 2026-10-23)
--
-- One column on the goal (a track):
--
--   loop   the goal's loop, as a person set it:
--          { on, perWeek, onAt, by } — on: the goal proposes its next run
--          while a required criterion is unmet; perWeek: at most that many
--          proposals in any seven days; onAt: when a person last switched it
--          on (failures before it no longer stop it); by: who set it.
--          NULL = never set = OFF. Read tolerantly by `readGoalLoop`
--          (@synap-core/types/units); written only by the goal write door
--          (`setTrackDirection` / `startTrack`, governed).
--
-- Nothing derived is stored: whether the goal proposes now, why it holds and
-- which criterion stopped it are computed from the goal's runs and their
-- `session_evaluations` rows (`decideGoalNextRun`, `goalCriteriaFailedTwice`);
-- the budget counts the proposals the loop filed.
--
-- `project_tracks` is NOT in 0000_baseline_schema.sql (it references
-- `projects`, created by 0151): the column is guarded by schema-coherence.ts
-- only, like 0302, 0344 and 0345. Idempotent.

ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "loop" jsonb;

-- An object or nothing: a reader never has to guess what a scalar meant.
ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_loop_object_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_loop_object_check"
  CHECK ("loop" IS NULL OR jsonb_typeof("loop") = 'object');
