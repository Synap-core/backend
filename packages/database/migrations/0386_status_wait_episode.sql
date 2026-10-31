-- 0386: wait episodes (status-first PR-H, build plan 4ed2a4b8 §4).
--
-- One row per stretch of time a thing WAITED on one thing: it opens when the
-- status watcher's tick finds a wait (THE waiting-on collector,
-- `readWaitingOnSourcesFor`) and closes on the first tick that no longer finds
-- it. The history of where the time went; nothing reads it to decide a move.
--
--   subject_type / subject_id  the thing that waits (an entity, a goal, a session)
--   facet_id                   the role's facet when the wait is on a role's
--                              lifecycle, else NULL
--   wait_kind                  `WaitKind` (`@synap-core/types/units`)
--   on                         a hold's `on` (`HOLD_ON`) when the wait is a pause
--   reason                     the coarse waiting-on reason (`WAITING_ON_REASONS`)
--   ref                        what is waited on (`WaitingOnRef`), as its holder reads it
--   ref_key                    the ref's identity (its id, else url, else label;
--                              '' when unnamed): part of the episode's key
--
-- ONE OPEN EPISODE per (subject, facet, wait kind, ref): the partial unique
-- index makes a second tick's insert a no-op (ON CONFLICT DO NOTHING), so two
-- racing ticks open it once. A closed episode never blocks the next one.
--
-- No backfill: the first tick after deploy opens what waits now.
-- Fresh installs get all of this from 0000_baseline_schema.sql. Idempotent.

CREATE TABLE IF NOT EXISTS "status_wait_episode" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_type" text        NOT NULL,
  "subject_id"   text        NOT NULL,
  "facet_id"     text,
  "wait_kind"    text        NOT NULL,
  "on"           text,
  "reason"       text,
  "ref"          jsonb,
  "ref_key"      text        NOT NULL DEFAULT '',
  "opened_at"    timestamptz NOT NULL DEFAULT now(),
  "closed_at"    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_status_wait_episode_open"
  ON "status_wait_episode" ("subject_type", "subject_id", "facet_id", "wait_kind", "ref_key")
  NULLS NOT DISTINCT
  WHERE "closed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_status_wait_episode_subject"
  ON "status_wait_episode" ("subject_type", "subject_id", "opened_at");
