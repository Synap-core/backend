-- Reactions projection performance indexes.
--
-- The Reactions / Pulse read facade (routers/subscriptions.ts) fans each source
-- event out into its downstream reactions:
--   1. webhook_deliveries looked up by event_id (one query per fan-out)
--   2. events looked up by correlation_id (user-scoped) for the downstream chain
--
-- Both lookups were sequential scans. Add covering indexes.
-- Defensive: IF NOT EXISTS so re-runs / fresh installs are safe.

CREATE INDEX IF NOT EXISTS webhook_deliveries_event_id_idx
  ON webhook_deliveries (event_id);

CREATE INDEX IF NOT EXISTS idx_events_correlation_id
  ON events (correlation_id)
  WHERE correlation_id IS NOT NULL;
