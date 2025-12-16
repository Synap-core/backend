-- Migration: Create user_entity_state table
-- Purpose: Store user-specific interaction state for any item (entity or inbox_item)
-- Examples: starred, pinned, last viewed, view count

CREATE TABLE IF NOT EXISTS user_entity_state (
  -- Composite key
  user_id TEXT NOT NULL,
  item_id UUID NOT NULL,
  item_type VARCHAR(20) NOT NULL,        -- 'entity' | 'inbox_item'
  
  -- User interaction flags
  starred BOOLEAN DEFAULT false,
  pinned BOOLEAN DEFAULT false,
  
  -- Analytics
  last_viewed_at TIMESTAMP WITH TIME ZONE,
  view_count INT DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (user_id, item_id, item_type)
);

-- Indexes for common queries
CREATE INDEX idx_user_state_starred 
  ON user_entity_state(user_id, starred) 
  WHERE starred = true;

CREATE INDEX idx_user_state_pinned 
  ON user_entity_state(user_id, pinned) 
  WHERE pinned = true;

CREATE INDEX idx_user_state_viewed 
  ON user_entity_state(user_id, last_viewed_at DESC) 
  WHERE last_viewed_at IS NOT NULL;

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_entity_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_user_entity_state_updated_at
  BEFORE UPDATE ON user_entity_state
  FOR EACH ROW
  EXECUTE FUNCTION update_user_entity_state_updated_at();

-- Comments
COMMENT ON TABLE user_entity_state IS 'User interaction state for entities and inbox items';
COMMENT ON COLUMN user_entity_state.item_type IS 'Type of item: entity or inbox_item';
COMMENT ON COLUMN user_entity_state.starred IS 'User marked as important';
COMMENT ON COLUMN user_entity_state.pinned IS 'User pinned to top of list';
