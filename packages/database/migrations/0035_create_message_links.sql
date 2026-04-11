-- Migration: Create message_links table
-- The 0015.2 migration was mislabeled (it fixed chat_threads defaults instead).
-- This migration properly creates the message_links table.

CREATE TABLE IF NOT EXISTS message_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  relationship_type TEXT NOT NULL,
  position JSONB,
  metadata JSONB,
  user_id TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_links_message_id_idx ON message_links (message_id);
CREATE INDEX IF NOT EXISTS message_links_target_idx ON message_links (target_type, target_id);
CREATE INDEX IF NOT EXISTS message_links_relationship_idx ON message_links (relationship_type);
CREATE INDEX IF NOT EXISTS message_links_user_id_idx ON message_links (user_id);
CREATE INDEX IF NOT EXISTS message_links_workspace_id_idx ON message_links (workspace_id);
