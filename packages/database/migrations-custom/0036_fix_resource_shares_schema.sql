-- Migration: Align resource_shares table with current Drizzle schema
-- The schema was redesigned to support richer sharing (visibility modes,
-- public tokens, invited users, permissions) but the DB was never updated.

-- Add new columns required by the Drizzle schema
ALTER TABLE resource_shares
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS public_token TEXT,
  ADD COLUMN IF NOT EXISTS invited_users TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{"read": true}',
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- created_by should be NOT NULL — backfill existing rows (safe: data was cleared)
UPDATE resource_shares SET created_by = 'system' WHERE created_by IS NULL;
ALTER TABLE resource_shares ALTER COLUMN created_by SET NOT NULL;

-- Index for looking up public shares by visibility
CREATE INDEX IF NOT EXISTS idx_resource_shares_visibility
  ON resource_shares (resource_type, resource_id, visibility)
  WHERE revoked_at IS NULL;
