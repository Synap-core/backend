-- Migration: 0458_frame_read_log_at_index.sql
--
-- `frame_read_log` (0456) grows by one row per frame read. Its daily
-- retention (`frame-read-log-retention`) deletes `WHERE at < cutoff`, and no
-- index leads with `at` (the two it has lead with the surface and the user),
-- so each run scanned the whole table. One index on `(at)`.
--
-- Plain CREATE INDEX (not CONCURRENTLY: the runner wraps each migration in a
-- transaction). The table is young and bounded to 30 days. Idempotent.

CREATE INDEX IF NOT EXISTS "frame_read_log_at_idx"
  ON "frame_read_log" ("at");
