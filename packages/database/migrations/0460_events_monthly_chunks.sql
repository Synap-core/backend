-- Migration: 0460_events_monthly_chunks.sql
--
-- New `events` chunks span 30 days instead of 7 (decision ce5fb987 item C,
-- finding a87810a8). Every read of `events` without a constant time bound
-- plans over every chunk: 46 on the founder's pod on 2026-11-27 (weekly
-- chunks back to 2023-03-30, most of them holding a handful of rows), about
-- 75-110 ms of planning per read. A 30-day interval adds 12 chunks a year
-- instead of 52.
--
-- `set_chunk_time_interval` changes FUTURE chunks only: existing chunks keep
-- their 7-day ranges and no data is rewritten. Merging the old chunks is a
-- separate maintenance (backup first, in a window), never a migration.
--
-- Cost, stated: the compression policy (compress_after 7 days) compresses a
-- chunk only once its whole range is 7 days old, so up to ~37 days of events
-- stay uncompressed instead of ~14.
--
-- A fresh pod gets the same interval: 0237 creates the hypertable (default
-- 7 days) and this migration runs after it.
--
-- Guarded like 0237's retention block: the interval is an operational
-- setting, and a failure to apply it must not stop a pod from updating. On a
-- Postgres without TimescaleDB, or where `events` is not a hypertable, it
-- does nothing. Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE NOTICE '0460: timescaledb absent: events is a plain table, no chunk interval to set.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_name = 'events'
      AND hypertable_schema = current_schema()
  ) THEN
    RAISE WARNING '0460: events is NOT a hypertable, chunk interval not set.';
    RETURN;
  END IF;

  PERFORM set_chunk_time_interval('events', INTERVAL '30 days');
  RAISE NOTICE '0460: new events chunks span 30 days.';

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '0460: could not set the events chunk interval: % (%). New chunks keep their previous interval.', SQLERRM, SQLSTATE;
END $$;
