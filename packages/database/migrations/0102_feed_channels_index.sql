-- Migration: Feed Channels Index
-- Adds index on channel_type='feed' for efficient scheduler queries
--
-- This migration is safe to re-run: uses IF NOT EXISTS throughout.
--
-- The index supports queries like:
--   SELECT * FROM channels WHERE channel_type = 'feed' AND feed_scope = 'user' AND status = 'active'
--   SELECT * FROM channels WHERE channel_type = 'feed' AND workspace_id = ? AND status = 'active'

-- Index for feed channel lookups by type and scope
CREATE INDEX IF NOT EXISTS "channels_feed_type_scope_idx"
  ON "channels" ("channel_type", "feed_scope", "status")
  WHERE "channel_type" = 'feed';

-- Index for feed channels by workspace (for workspace-scoped feeds)
CREATE INDEX IF NOT EXISTS "channels_feed_workspace_idx"
  ON "channels" ("workspace_id", "channel_type", "status")
  WHERE "channel_type" = 'feed' AND "workspace_id" IS NOT NULL;

-- Index for feed channels by user (for user-scoped feeds)
CREATE INDEX IF NOT EXISTS "channels_feed_user_idx"
  ON "channels" ("user_id", "channel_type", "status")
  WHERE "channel_type" = 'feed';

-- Composite index for scheduler queries that filter by feed type, scope, and user
CREATE INDEX IF NOT EXISTS "channels_feed_scheduler_idx"
  ON "channels" ("user_id", "feed_scope", "status", "channel_type");

-- Add comment for documentation
COMMENT ON INDEX "channels_feed_type_scope_idx" IS 'Optimizes feed channel lookups for unified feeds system';
COMMENT ON INDEX "channels_feed_workspace_idx" IS 'Optimizes workspace-scoped feed channel queries';
COMMENT ON INDEX "channels_feed_user_idx" IS 'Optimizes user feed channel queries';
COMMENT ON INDEX "channels_feed_scheduler_idx" IS 'Optimizes unified feed scheduler queries';
