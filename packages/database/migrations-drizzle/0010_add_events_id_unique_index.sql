-- Migration: Add Unique Index on events.id for Foreign Key Support
-- Description: The events table has a composite primary key (id, timestamp) for TimescaleDB.
-- However, foreign keys from webhook_deliveries, thread_entities, and thread_documents
-- need to reference events.id. Since id alone is not unique, we need to add a unique
-- constraint or index on id to support these foreign keys.
--
-- Note: In practice, event IDs are unique (UUIDs), but the composite PK is required
-- for TimescaleDB hypertable partitioning. This unique index allows foreign keys to work.

-- Create a unique index on events.id to support foreign key references
-- This is safe because event IDs are UUIDs and are inherently unique
CREATE UNIQUE INDEX IF NOT EXISTS "idx_events_id_unique" ON "events" ("id");
