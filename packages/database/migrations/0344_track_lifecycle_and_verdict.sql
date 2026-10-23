-- 0344 — ONE lifecycle for tracks (goals), and how a goal ENDED
--
-- Founder decision 2026-10-23 (work model D1, R1, R3): a track stops running
-- on a private 4-value status. Its status is the option key of a SYSTEM
-- LIFECYCLE declared like a kind's (`TRACK_STATUS_DECLARATION`,
-- @synap-core/types/units), read by the same classifier and governance:
--
--   open    proposed · agreed · ready     (new — R3, before work starts)
--   active  active
--   paused  paused
--   done    completed  ("Closed"; only a person may enter it)
--   lost    archived   ("Dropped")
--
-- Stored keys are contracts (CLI, IS, Control Plane, Relay, browser send
-- them): `completed` and `archived` keep their keys. How the goal ended is a
-- separate VERDICT, never more statuses:
--
--   verdict         met · partly_met · not_met                    (done)
--                   no_longer_needed · impossible · replaced · mistake (lost)
--   verdict_reason  required for impossible and replaced
--   verdict_by/at   the person who closed it, and when. No existing column
--                   records the close (`updated_at` moves on every write).
--
-- Backfill: a `completed` track was closed by a person before verdicts
-- existed — it reads `met` (the only done ending it could have meant); who and
-- when are NOT known and stay NULL rather than guessed. An `archived` track
-- keeps verdict NULL (why it was dropped was never recorded).
--
-- The live-name unique index (0317) is rebuilt for the new live set: open,
-- active and paused tracks hold their name. Before this migration no row can
-- carry an open status (the old CHECK refused them), so the rebuilt index
-- covers exactly the rows the old one did — no dedupe is needed. Same index
-- NAME, so `findMissingIndexes` (schema-coherence.ts) keeps passing.
--
-- `project_tracks` is NOT in 0000_baseline_schema.sql (it references
-- `projects`, created by 0151), so the new columns are guarded by
-- schema-coherence.ts only, like 0274 and 0302. Idempotent: every step is
-- IF [NOT] EXISTS or drop-then-add.

ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "verdict" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "verdict_reason" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "verdict_by" text;
ALTER TABLE "project_tracks" ADD COLUMN IF NOT EXISTS "verdict_at" timestamptz;

ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_status_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_status_check"
  CHECK ("status" IN (
    'proposed', 'agreed', 'ready', 'active', 'paused', 'completed', 'archived'
  ));

UPDATE "project_tracks"
   SET "verdict" = 'partly_met'
 WHERE "status" = 'completed' AND "verdict" IS NULL;

-- The verdict matches the ending: a closed track has a done verdict, a
-- dropped one a lost verdict or none (dropped before 0344), a live one none;
-- impossible and replaced carry a reason. The status door enforces the same
-- rule first (`checkTrackClose`), with words an agent can act on. Every
-- `IN (...)` on the nullable verdict is guarded by `IS NOT NULL`: a CHECK
-- passes on NULL, and `NULL IN (...)` is NULL, not false.
ALTER TABLE "project_tracks" DROP CONSTRAINT IF EXISTS "project_tracks_verdict_check";
ALTER TABLE "project_tracks"
  ADD CONSTRAINT "project_tracks_verdict_check"
  CHECK (
    (
      ("status" = 'completed'
        AND "verdict" IS NOT NULL
        AND "verdict" IN ('met', 'partly_met', 'not_met'))
      OR ("status" = 'archived'
        AND ("verdict" IS NULL
          OR "verdict" IN ('no_longer_needed', 'impossible', 'replaced', 'mistake')))
      OR ("status" NOT IN ('completed', 'archived') AND "verdict" IS NULL)
    )
    AND (
      "verdict" IS NULL
      OR "verdict" NOT IN ('impossible', 'replaced')
      OR btrim(coalesce("verdict_reason", '')) <> ''
    )
  );

DROP INDEX IF EXISTS "uniq_project_tracks_live_name";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_tracks_live_name"
  ON "project_tracks" ("project_id", lower(btrim("name")))
  WHERE "status" IN ('active', 'paused');
