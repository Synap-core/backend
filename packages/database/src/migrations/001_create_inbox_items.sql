-- Migration: Create inbox_items table for Life Feed
-- Purpose: Store external items (emails, calendar events, messages) before processing
-- Architecture: Direct columns instead of JSONB for better queryability

CREATE TABLE IF NOT EXISTS inbox_items (
  -- Identity
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  
  -- External source tracking (direct columns for performance)
  provider VARCHAR(50) NOT NULL,          -- 'gmail', 'google_calendar', 'slack', etc.
  account VARCHAR(255) NOT NULL,          -- 'user@gmail.com', account identifier
  external_id VARCHAR(500) NOT NULL,      -- ID in external system
  deep_link TEXT,                         -- Deep link to open in native app
  
  -- Content
  type VARCHAR(50) NOT NULL,              -- 'email', 'calendar_event', 'slack_message'
  title TEXT NOT NULL,
  preview TEXT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- State management
  status VARCHAR(20) DEFAULT 'unread',    -- 'unread' | 'read' | 'archived' | 'snoozed'
  snoozed_until TIMESTAMP WITH TIME ZONE,
  
  -- AI-enhanced metadata (populated by workers after ingestion)
  priority VARCHAR(20),                   -- 'urgent' | 'high' | 'normal' | 'low'
  tags TEXT[],                            -- ['Action', 'FYI', 'Bientôt']
  
  -- Type-specific data (still use JSONB for provider-specific fields)
  data JSONB NOT NULL DEFAULT '{}',
  
  -- Lifecycle tracking
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_inbox_user_status 
  ON inbox_items(user_id, status);

CREATE INDEX idx_inbox_user_timestamp 
  ON inbox_items(user_id, timestamp DESC);

CREATE INDEX idx_inbox_snoozed 
  ON inbox_items(user_id, snoozed_until) 
  WHERE status = 'snoozed' AND snoozed_until IS NOT NULL;

CREATE INDEX idx_inbox_priority 
  ON inbox_items(user_id, priority) 
  WHERE priority IS NOT NULL;

-- GIN index for JSONB data querying
CREATE INDEX idx_inbox_data 
  ON inbox_items USING GIN (data);

-- Unique constraint to prevent duplicates from same external source
CREATE UNIQUE INDEX idx_inbox_unique_source 
  ON inbox_items(user_id, provider, external_id);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_inbox_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_inbox_items_updated_at
  BEFORE UPDATE ON inbox_items
  FOR EACH ROW
  EXECUTE FUNCTION update_inbox_items_updated_at();

-- Comments for documentation
COMMENT ON TABLE inbox_items IS 'External items from Gmail, Calendar, Slack, etc. to be processed';
COMMENT ON COLUMN inbox_items.provider IS 'Source provider: gmail, google_calendar, slack, etc.';
COMMENT ON COLUMN inbox_items.external_id IS 'ID in the external system for deduplication';
COMMENT ON COLUMN inbox_items.deep_link IS 'URL to open item in native app (e.g., googlegmail://)';
COMMENT ON COLUMN inbox_items.data IS 'Provider-specific fields (from, threadId, attendees, etc.)';
COMMENT ON COLUMN inbox_items.status IS 'unread (inbox), read, archived (processed), snoozed (delayed)';
