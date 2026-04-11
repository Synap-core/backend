-- Migration: 0064_channel_purpose
-- Adds channel_purpose column to channels table.
-- Replaces JSONB metadata flags (isPersonal, isProactiveFeed, isCaptureThread)
-- with a typed, indexed column for reliable filtering without JSON decoding.
--
-- Defensive: channels is created by custom/0038_channels_refactor. On fresh pods
-- with the interleaved runner this migration sorts before that file, so we skip
-- gracefully if channels doesn't exist yet. 0099_schema_reconciliation (custom)
-- catches up any pods that reach it without this migration having done its work.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'channels'
  ) THEN
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
  END IF;
END;
$$;
