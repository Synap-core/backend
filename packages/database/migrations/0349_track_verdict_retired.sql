-- 0349 — an operation ends RETIRED, never met (work model R6)
--
-- Founder refinement R6 (2026-10-23): an operation (`work_kind` =
-- 'operation', 0345) is kept running and assessed per period; it never ends
-- "met". When it stops, it is RETIRED — a done verdict, beside met ·
-- partly_met · not_met (0344). The verdict set is exported once
-- (`TRACK_VERDICTS`, @synap-core/types/units) and mirrored by
-- `PROJECT_TRACK_VERDICTS` (@synap/database); this CHECK spells the same set.
--
-- Which kind may close with which verdict (an operation only `retired`, every
-- other kind never `retired`) is the status door's rule (`checkTrackClose`),
-- NOT this CHECK: a goal's kind of work stays editable after it closed (the
-- direction door writes `work_kind` on any goal), and a CHECK that paired
-- kind and verdict would turn that edit into a constraint error. This CHECK
-- keeps 0344's shape — a closed goal has a done verdict, a dropped one a lost
-- verdict or none, a live one none; impossible and replaced carry a reason —
-- with `retired` added to the done set.
--
-- No data change: no row can hold `retired` before this migration (0344's
-- CHECK refused it). Idempotent: drop-then-add.

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
