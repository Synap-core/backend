-- 0311: a partial index on events(app_id, timestamp).
--
-- "What has this app done?" is asked as
--   SELECT … FROM events WHERE user_id = $1 AND app_id = $2
--   ORDER BY timestamp DESC LIMIT n
-- by an application's own page (`events.read` with its new `appId` filter).
--
-- 0310 added `app_id` for ATTRIBUTION and deliberately left it unindexed — the
-- write side never needed one, and until `appId` reached a READ there was
-- nothing to index FOR. This is the index that reader needs, added in the same
-- change as the reader: the neighbouring `sessionId` filter pairs with
-- `idx_events_session_id` for exactly this reason.
--
-- PARTIAL on `IS NOT NULL`: 0310 leaves `app_id` NULL for every human/bare
-- write, so the index covers only the attributed minority rather than most of
-- an append-only table. `timestamp` is the second key, so the `ORDER BY` above
-- is served by the index order instead of a sort. Idempotent.

CREATE INDEX IF NOT EXISTS idx_events_app_id
  ON events (app_id, timestamp)
  WHERE app_id IS NOT NULL;
