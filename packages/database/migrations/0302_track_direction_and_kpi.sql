-- 0302 — a track's DIRECTION and its optional KPI
--
-- Founder decision 2026-10-05 (outcome model, "no hill chart"): a track is not
-- verified the way a session is. It carries
--
--   direction  one line saying where the track is heading. It may be
--              non-verifiable ("become the reference for X"). NULL = not said.
--   kpi        an optional number the track is steering by:
--              { label, unit?, target, current?, updatedAt? }.
--              `current` is STATED by a person or an agent, never measured:
--              nothing in the pod can derive "qualified leads per month", so a
--              number shown beside a target must say when it was last stated
--              (`updatedAt`) instead of passing for a live measurement.
--              NULL = the track steers by no number.
--
-- The bounded, verifiable part lives in the SESSIONS under the track (their
-- outcomes). Completion stays a person's act; reaching the KPI target only
-- NUDGES them (`track.kpi_reached`).
--
-- `project_tracks` is NOT in 0000_baseline_schema.sql (it references
-- `projects`, created by 0151 — an ALTER there fails on a fresh database with
-- 42P01), so these columns are guarded by schema-coherence.ts only, exactly
-- like 0274's `params` / `stage_history`.

ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "direction" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "kpi" jsonb;
