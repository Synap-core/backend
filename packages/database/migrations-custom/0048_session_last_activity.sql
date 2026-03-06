-- 0048_session_last_activity.sql
-- Add lastActivityAt to sessions so timeout checks use last activity,
-- not session start time. Without this, a 30-min session with ongoing
-- messages would incorrectly time out based on when it was created.
--
-- Backfill: set to startedAt for existing rows (conservative — treats
-- existing sessions as if last activity was at session start).

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

UPDATE sessions SET last_activity_at = started_at WHERE last_activity_at IS NULL;
