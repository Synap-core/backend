-- Migration: 0064_channel_purpose
-- Adds channel_purpose column to channels table.
-- Replaces JSONB metadata flags (isPersonal, isProactiveFeed, isCaptureThread)
-- with a typed, indexed column for reliable filtering without JSON decoding.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS channel_purpose TEXT
    CHECK (channel_purpose IN ('chat', 'feed', 'audit'));

-- Backfill from existing metadata flags
UPDATE channels SET channel_purpose = 'chat'
  WHERE channel_purpose IS NULL
    AND metadata->>'isPersonal' = 'true';

UPDATE channels SET channel_purpose = 'feed'
  WHERE channel_purpose IS NULL
    AND metadata->>'isProactiveFeed' = 'true';

UPDATE channels SET channel_purpose = 'audit'
  WHERE channel_purpose IS NULL
    AND metadata->>'isCaptureThread' = 'true';

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS channels_purpose_idx ON channels (channel_purpose)
  WHERE channel_purpose IS NOT NULL;
