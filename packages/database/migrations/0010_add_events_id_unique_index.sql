-- Migration: Add Index on events.id for Query Performance
-- Description: Adds a non-unique index on events.id to improve query performance when
-- looking up events by their ID (e.g., in webhook_deliveries, thread_entities lookups).
--
-- IMPORTANT: TimescaleDB hypertables do not allow unique indexes without the partitioning column.
-- Since events is partitioned by timestamp, we cannot create a unique index on id alone.
-- However, we can create a non-unique index for query performance.
--
-- Note: Event IDs are UUIDs and are inherently unique in practice, but we cannot enforce
-- uniqueness at the database level due to TimescaleDB hypertable limitations. Referential
-- integrity must be handled at the application level if needed.

-- Create a non-unique index on events.id for query performance
-- This improves lookup performance when querying events by ID
CREATE INDEX IF NOT EXISTS "idx_events_id" ON "events" ("id");
