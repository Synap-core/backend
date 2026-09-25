-- 0274 — a session's TRACK STAGE, a track's PARAMS and its STAGE HISTORY
--
-- Founder decisions 2026-09-25 (tracks-first project experience, wave A1):
--
-- M1  `focus_sessions.track_stage` — the stage of its track a session was
--     FILED at. Stamped at birth (default: the track's current stage; an
--     explicit stage must be one the track PINNED). NOT named `current_stage`:
--     that is the session's OWN playbook phase (a different axis), and the
--     `current-stage-one-door` tripwire guards every `currentStage:` write.
--     Nullable, and NOT backfilled: nothing records the stage an existing
--     tracked session was filed at, so NULL honestly reads "not filed at a
--     stage" rather than a guessed one.
--
-- M4  `project_tracks.params` — the answers to the method's declared params
--     (the track's onboarding). A dedicated column, not `metadata`: metadata is
--     the check-gate marker bag, and the Hub shallow-merge would let any client
--     rewrite it.
--
-- M5  `project_tracks.stage_history` — every stage the track ENTERED, in order,
--     `{ stageKey, fromStage, enteredAt, actor }`. Appended ONLY by the track's
--     single stage writer (`TrackRepository.advanceStage`, the compare-and-set)
--     in the SAME UPDATE as `current_stage`, plus the birth seed. A re-entered
--     stage appends a NEW entry — a map keyed by stage would lose it.
--     BACKFILL: one entry per existing track that stands on a stage, dated at
--     the track's `created_at` and attributed to its starter. Idempotent: only
--     rows whose history is still empty are touched.
--
-- `project_tracks` is NOT in 0000_baseline_schema.sql (it references
-- `projects`, created by 0151), so its two new columns are guarded by
-- schema-coherence.ts only. `focus_sessions.track_stage` IS mirrored in the
-- baseline.

ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "track_stage" text;
-- "Which sessions belong to step 3 of this track" — one indexed WHERE.
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_track_stage"
  ON "focus_sessions" ("track_id", "track_stage");

ALTER TABLE "project_tracks"
  ADD COLUMN IF NOT EXISTS "params" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "project_tracks"
  ADD COLUMN IF NOT EXISTS "stage_history" jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE "project_tracks"
SET "stage_history" = jsonb_build_array(
  jsonb_build_object(
    'stageKey', "current_stage",
    'fromStage', NULL,
    -- UTC ISO-8601 with ms + 'Z' — byte-identical to JS `toISOString()`, the
    -- format every appended entry carries, whatever the session TimeZone.
    'enteredAt', to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor', "user_id"
  )
)
WHERE "current_stage" IS NOT NULL
  AND "stage_history" = '[]'::jsonb;
