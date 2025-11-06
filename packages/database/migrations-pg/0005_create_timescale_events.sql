-- V0.3 Migration: TimescaleDB Events Hypertable
-- Simplified for Neon's Apache-licensed TimescaleDB

-- Drop old table if exists (from failed migration)
DROP TABLE IF EXISTS events_v2 CASCADE;

-- Create the events_v2 table (new structure for event sourcing)
CREATE TABLE events_v2 (
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

-- Convert to TimescaleDB hypertable (time-series optimized)
-- Note: Neon's Apache license doesn't support compression/retention
SELECT create_hypertable(
  'events_v2',
  'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary lookup: aggregate stream (for event replay)
CREATE INDEX idx_events_v2_aggregate ON events_v2(aggregate_id, timestamp DESC, version DESC);

-- User isolation
CREATE INDEX idx_events_v2_user ON events_v2(user_id, timestamp DESC);

-- Event type filtering
CREATE INDEX idx_events_v2_type ON events_v2(event_type, timestamp DESC);

-- Correlation tracking (for workflow debugging)
CREATE INDEX idx_events_v2_correlation ON events_v2(correlation_id, timestamp DESC) 
  WHERE correlation_id IS NOT NULL;

-- Source tracking
CREATE INDEX idx_events_v2_source ON events_v2(source, timestamp DESC);

-- Composite indexes for common query patterns
CREATE INDEX idx_events_v2_user_type ON events_v2(user_id, event_type, timestamp DESC);
CREATE INDEX idx_events_v2_aggregate_type ON events_v2(aggregate_type, timestamp DESC);

-- Timestamp range queries (time-series optimization)
CREATE INDEX idx_events_v2_timestamp ON events_v2(timestamp DESC);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE events_v2 IS 'Event sourcing event store (TimescaleDB hypertable)';
COMMENT ON COLUMN events_v2.id IS 'Unique event ID';
COMMENT ON COLUMN events_v2.timestamp IS 'Event timestamp (hypertable partition key)';
COMMENT ON COLUMN events_v2.aggregate_id IS 'ID of the entity being modified';
COMMENT ON COLUMN events_v2.aggregate_type IS 'Type of aggregate (entity, relation, user, system)';
COMMENT ON COLUMN events_v2.event_type IS 'Event type (e.g., entity.created, task.completed)';
COMMENT ON COLUMN events_v2.data IS 'Event data (deltas only, NOT full object state)';
COMMENT ON COLUMN events_v2.version IS 'Optimistic locking version for the aggregate';
COMMENT ON COLUMN events_v2.causation_id IS 'ID of event that caused this event';
COMMENT ON COLUMN events_v2.correlation_id IS 'Group related events (e.g., workflow ID)';

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
  RAISE NOTICE '   Table: events_v2';
  RAISE NOTICE '   Chunk interval: 1 day';
  RAISE NOTICE '   Note: Compression/retention require Timescale Cloud (commercial license)';
  RAISE NOTICE '   For analytics, run: REFRESH MATERIALIZED VIEW events_daily;';
END $$;
