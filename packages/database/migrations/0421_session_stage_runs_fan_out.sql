-- 0421_session_stage_runs_fan_out
--
-- A step that runs once per batch of items (`forEach`, plan fbfadf54 fix 3)
-- keeps its fan-out on its step row: the collection it was cut from, each
-- batch's items, and each child run (queued, running, or how it ended). The
-- stage runner (`stage-for-each.ts`) writes it under a row lock, so at most
-- three children run at once and a replayed child close settles nothing twice.
-- NULL for every other step. No backfill: no step fanned out before 0421.
--
-- Fresh installs also get this from 0000_baseline_schema.sql. Re-runnable.

ALTER TABLE "session_stage_runs" ADD COLUMN IF NOT EXISTS "fan_out" jsonb;
