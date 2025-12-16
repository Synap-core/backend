-- Migration: Add Event Sourcing Fields to Events Table
-- Date: 2025-12-16
-- Purpose: Add subjectId and subjectType for event sourcing capabilities

-- Step 1: Add new columns (nullable first to support existing data)
ALTER TABLE events 
  ADD COLUMN subject_id TEXT,
  ADD COLUMN subject_type TEXT;

-- Step 2: Backfill from data field where possible

-- Backfill inbox events
UPDATE events 
SET 
  subject_id = data->>'itemId',
  subject_type = 'inbox_item'
WHERE type LIKE 'inbox.%' 
  AND data->>'itemId' IS NOT NULL;

-- Backfill entity events
UPDATE events 
SET 
  subject_id = data->>'entityId',
  subject_type = 'entity'
WHERE type LIKE 'entities.%' 
  AND data->>'entityId' IS NOT NULL;

-- Backfill document events
UPDATE events
SET
  subject_id = data->>'documentId',
  subject_type = 'document'
WHERE type LIKE 'documents.%'
  AND data->>'documentId' IS NOT NULL;

-- Backfill conversation message events
UPDATE events
SET
  subject_id = data->>'messageId',
  subject_type = 'message'
WHERE type LIKE 'conversationMessages.%'
  AND data->>'messageId' IS NOT NULL;

-- Backfill chat thread events
UPDATE events
SET
  subject_id = data->>'threadId',
  subject_type = 'chat_thread'
WHERE type LIKE 'chatThreads.%'
  AND data->>'threadId' IS NOT NULL;

-- Step 3: Set defaults for any remaining events
UPDATE events
SET 
  subject_id = COALESCE(subject_id, id::text),
  subject_type = COALESCE(subject_type, 'unknown')
WHERE subject_id IS NULL OR subject_type IS NULL;

-- Step 4: Make columns required
ALTER TABLE events 
  ALTER COLUMN subject_id SET NOT NULL,
  ALTER COLUMN subject_type SET NOT NULL;

-- Step 5: Create indexes for event sourcing queries

-- Primary index for event sourcing: "get all events for this subject"
CREATE INDEX idx_events_subject 
  ON events(subject_type, subject_id, timestamp);

-- Index for querying by user and event type
CREATE INDEX idx_events_user_type
  ON events(user_id, type);

-- Index for time-based queries
CREATE INDEX idx_events_timestamp
  ON events(timestamp DESC);

-- Step 6: Add comment for documentation
COMMENT ON COLUMN events.subject_id IS 'The ID of the thing this event is about (inbox item, entity, document, etc.)';
COMMENT ON COLUMN events.subject_type IS 'The type of subject (inbox_item, entity, note, task, document, etc.)';
COMMENT ON INDEX idx_events_subject IS 'Primary index for event sourcing queries - rebuild state by replaying events for a subject';
