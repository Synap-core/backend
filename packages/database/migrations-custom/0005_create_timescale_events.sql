-- V0.3 Migration: TimescaleDB Events Hypertable
-- Simplified for Neon's Apache-licensed TimescaleDB

-- Drop old table if exists (from failed migration)
DROP TABLE IF EXISTS events_timescale CASCADE;

-- Create the events_timescale table (TimescaleDB hypertable for event sourcing)
CREATE TABLE events_timescale (
  -- Event identification
  id UUID DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Aggregate reference (the entity being modified)
  aggregate_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('entity', 'relation', 'user', 'system')),
  
  -- Event classification
  event_type TEXT NOT NULL,
  
  -- Ownership
  user_id TEXT NOT NULL,
  
  -- Event data (deltas and references only, NOT full objects)
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB,
  
  -- Event sourcing fields
  version INTEGER NOT NULL,
  causation_id UUID,      -- Event that caused this event
  correlation_id UUID,    -- Group of related events (e.g., workflow)
  
  -- Source tracking
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'automation', 'sync', 'migration', 'system'))
);

-- ============================================================================
-- TIMESCALEDB HYPERTABLE
-- ============================================================================
-- 
-- Why TimescaleDB?
-- 
-- TimescaleDB is a PostgreSQL extension optimized for time-series data.
-- It provides:
-- 1. **Automatic Partitioning**: Events are partitioned by time (1-day chunks)
--    This dramatically improves query performance for time-range queries.
-- 2. **Query Optimization**: Time-based queries (e.g., "events in last 7 days")
--    are optimized through chunk exclusion and parallel processing.
-- 3. **Scalability**: Can handle millions of events efficiently.
-- 4. **Retention Policies**: (Commercial license) Can automatically delete old events.
-- 
-- Performance Benefits:
-- - Time-range queries: 10-100x faster than regular PostgreSQL
-- - Aggregations: Optimized for COUNT, SUM, AVG over time windows
-- - Indexing: Automatic indexing on time dimension
-- 
-- Note: Neon's Apache-licensed TimescaleDB doesn't support compression/retention
-- features (requires Timescale Cloud commercial license).
-- 
-- Convert to TimescaleDB hypertable (time-series optimized)
SELECT create_hypertable(
  'events_timescale',
  'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary lookup: aggregate stream (for event replay)
CREATE INDEX idx_events_timescale_aggregate ON events_timescale(aggregate_id, timestamp DESC, version DESC);

-- User isolation
CREATE INDEX idx_events_timescale_user ON events_timescale(user_id, timestamp DESC);

-- Event type filtering
CREATE INDEX idx_events_timescale_type ON events_timescale(event_type, timestamp DESC);

-- Correlation tracking (for workflow debugging)
CREATE INDEX idx_events_timescale_correlation ON events_timescale(correlation_id, timestamp DESC) 
  WHERE correlation_id IS NOT NULL;

-- Source tracking
CREATE INDEX idx_events_timescale_source ON events_timescale(source, timestamp DESC);

-- Composite indexes for common query patterns
CREATE INDEX idx_events_timescale_user_type ON events_timescale(user_id, event_type, timestamp DESC);
CREATE INDEX idx_events_timescale_aggregate_type ON events_timescale(aggregate_type, timestamp DESC);

-- Timestamp range queries (time-series optimization)
CREATE INDEX idx_events_timescale_timestamp ON events_timescale(timestamp DESC);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE events_timescale IS 'Event sourcing event store (TimescaleDB hypertable)';
COMMENT ON COLUMN events_timescale.id IS 'Unique event ID';
COMMENT ON COLUMN events_timescale.timestamp IS 'Event timestamp (hypertable partition key)';
COMMENT ON COLUMN events_timescale.aggregate_id IS 'ID of the entity being modified';
COMMENT ON COLUMN events_timescale.aggregate_type IS 'Type of aggregate (entity, relation, user, system)';
COMMENT ON COLUMN events_timescale.event_type IS 'Event type (e.g., entity.created, task.completed)';
COMMENT ON COLUMN events_timescale.data IS 'Event data (deltas only, NOT full object state)';
COMMENT ON COLUMN events_timescale.version IS 'Optimistic locking version for the aggregate';
COMMENT ON COLUMN events_timescale.causation_id IS 'ID of event that caused this event';
COMMENT ON COLUMN events_timescale.correlation_id IS 'Group related events (e.g., workflow ID)';

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get aggregate current version
CREATE OR REPLACE FUNCTION get_aggregate_version(p_aggregate_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(version), 0)
  FROM events_v2
  WHERE aggregate_id = p_aggregate_id;
$$ LANGUAGE SQL STABLE;

-- Get aggregate event stream
CREATE OR REPLACE FUNCTION get_aggregate_stream(
  p_aggregate_id UUID,
  p_from_version INTEGER DEFAULT 0
)
RETURNS SETOF events_v2 AS $$
  SELECT *
  FROM events_v2
  WHERE aggregate_id = p_aggregate_id
    AND version > p_from_version
  ORDER BY version ASC;
$$ LANGUAGE SQL STABLE;

-- Get user event stream (last N days)
CREATE OR REPLACE FUNCTION get_user_event_stream(
  p_user_id TEXT,
  p_days INTEGER DEFAULT 7,
  p_limit INTEGER DEFAULT 1000
)
RETURNS SETOF events_v2 AS $$
  SELECT *
  FROM events_v2
  WHERE user_id = p_user_id
    AND timestamp >= NOW() - (p_days || ' days')::INTERVAL
  ORDER BY timestamp DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION get_aggregate_version IS 'Get current version of an aggregate (for optimistic locking)';
COMMENT ON FUNCTION get_aggregate_stream IS 'Get all events for an aggregate (for event replay)';
COMMENT ON FUNCTION get_user_event_stream IS 'Get recent events for a user (for activity feed)';

-- ============================================================================
-- MANUAL ANALYTICS VIEWS (since continuous aggregates require commercial license)
-- ============================================================================

-- Daily event counts (refresh manually with REFRESH MATERIALIZED VIEW)
CREATE MATERIALIZED VIEW events_daily AS
SELECT
  date_trunc('day', timestamp) AS day,
  user_id,
  event_type,
  aggregate_type,
  count(*) as event_count,
  count(DISTINCT aggregate_id) as unique_aggregates
FROM events_v2
GROUP BY day, user_id, event_type, aggregate_type;

CREATE INDEX idx_events_daily_day ON events_daily(day DESC);
CREATE INDEX idx_events_daily_user ON events_daily(user_id, day DESC);

COMMENT ON MATERIALIZED VIEW events_daily IS 'Daily event counts (refresh with: REFRESH MATERIALIZED VIEW events_daily)';

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ TimescaleDB hypertable created successfully!';
  RAISE NOTICE '   Table: events_timescale';
  RAISE NOTICE '   Chunk interval: 1 day';
  RAISE NOTICE '   Note: Compression/retention require Timescale Cloud (commercial license)';
  RAISE NOTICE '   For analytics, run: REFRESH MATERIALIZED VIEW events_daily;';
END $$;
