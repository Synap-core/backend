-- V0.4 Migration: Conversation Messages (The Source of INTENTION)
-- Hash-chained conversation history for capturing user intent

-- Create conversation_messages table
CREATE TABLE conversation_messages (
  -- Identity
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Thread management
  thread_id UUID NOT NULL,
  parent_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
  
  -- Message content
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  
  -- Metadata (AI suggestions, action results, attachments)
  metadata JSONB,
  
  -- Ownership
  user_id TEXT NOT NULL,
  
  -- Timestamps
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Hash chain (blockchain-like integrity)
  previous_hash TEXT,  -- Hash of parent message
  hash TEXT NOT NULL,  -- SHA256 of this message
  
  -- Soft delete
  deleted_at TIMESTAMPTZ
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary queries: Get thread history
CREATE INDEX idx_conversation_thread ON conversation_messages(thread_id, timestamp ASC)
  WHERE deleted_at IS NULL;

-- User isolation
CREATE INDEX idx_conversation_user ON conversation_messages(user_id, timestamp DESC)
  WHERE deleted_at IS NULL;

-- Parent-child relationships (for branching)
CREATE INDEX idx_conversation_parent ON conversation_messages(parent_id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

-- Hash verification
CREATE INDEX idx_conversation_hash ON conversation_messages(hash);

-- Recent messages (for context loading)
CREATE INDEX idx_conversation_recent ON conversation_messages(user_id, timestamp DESC)
  WHERE deleted_at IS NULL AND role IN ('user', 'assistant');

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get thread history (ordered by time)
CREATE OR REPLACE FUNCTION get_thread_history(
  p_thread_id UUID,
  p_limit INTEGER DEFAULT 100
)
RETURNS SETOF conversation_messages AS $$
  SELECT *
  FROM conversation_messages
  WHERE thread_id = p_thread_id
    AND deleted_at IS NULL
  ORDER BY timestamp ASC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- Get conversation branches (all messages with same parent)
CREATE OR REPLACE FUNCTION get_conversation_branches(
  p_parent_id UUID
)
RETURNS SETOF conversation_messages AS $$
  SELECT *
  FROM conversation_messages
  WHERE parent_id = p_parent_id
    AND deleted_at IS NULL
  ORDER BY timestamp ASC;
$$ LANGUAGE SQL STABLE;

-- Verify hash chain integrity
CREATE OR REPLACE FUNCTION verify_hash_chain(
  p_thread_id UUID
)
RETURNS TABLE (
  is_valid BOOLEAN,
  broken_at UUID,
  message TEXT
) AS $$
DECLARE
  v_message RECORD;
  v_computed_hash TEXT;
BEGIN
  FOR v_message IN 
    SELECT * FROM conversation_messages
    WHERE thread_id = p_thread_id
    ORDER BY timestamp ASC
  LOOP
    -- For messages with a parent, verify the previous_hash matches
    IF v_message.parent_id IS NOT NULL THEN
      -- Get parent's hash
      SELECT hash INTO v_computed_hash
      FROM conversation_messages
      WHERE id = v_message.parent_id;
      
      IF v_computed_hash IS NULL THEN
        RETURN QUERY SELECT FALSE, v_message.id, 'Parent message not found'::TEXT;
        RETURN;
      END IF;
      
      IF v_computed_hash != v_message.previous_hash THEN
        RETURN QUERY SELECT FALSE, v_message.id, 'Hash chain broken: previous_hash mismatch'::TEXT;
        RETURN;
      END IF;
    END IF;
  END LOOP;
  
  RETURN QUERY SELECT TRUE, NULL::UUID, 'Hash chain valid'::TEXT;
END;
$$ LANGUAGE plpgsql;

-- Get latest message in thread
CREATE OR REPLACE FUNCTION get_latest_message(
  p_thread_id UUID
)
RETURNS conversation_messages AS $$
  SELECT *
  FROM conversation_messages
  WHERE thread_id = p_thread_id
    AND deleted_at IS NULL
  ORDER BY timestamp DESC
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

-- Count messages in thread
CREATE OR REPLACE FUNCTION count_thread_messages(
  p_thread_id UUID
)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM conversation_messages
  WHERE thread_id = p_thread_id
    AND deleted_at IS NULL;
$$ LANGUAGE SQL STABLE;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE conversation_messages IS 'V0.4: Hash-chained conversation history - The source of INTENTION';
COMMENT ON COLUMN conversation_messages.id IS 'Unique message ID';
COMMENT ON COLUMN conversation_messages.thread_id IS 'Conversation thread ID (multiple threads can exist)';
COMMENT ON COLUMN conversation_messages.parent_id IS 'Parent message ID (for branching conversations)';
COMMENT ON COLUMN conversation_messages.role IS 'Message role: user, assistant, or system';
COMMENT ON COLUMN conversation_messages.content IS 'Message content (natural language)';
COMMENT ON COLUMN conversation_messages.metadata IS 'Structured data: suggested actions, execution results, AI metadata';
COMMENT ON COLUMN conversation_messages.user_id IS 'Owner of this conversation';
COMMENT ON COLUMN conversation_messages.previous_hash IS 'SHA256 hash of parent message (for chain integrity)';
COMMENT ON COLUMN conversation_messages.hash IS 'SHA256 hash of this message (id + content + timestamp)';

COMMENT ON FUNCTION get_thread_history IS 'Get all messages in a thread (ordered by time)';
COMMENT ON FUNCTION get_conversation_branches IS 'Get all branches from a parent message';
COMMENT ON FUNCTION verify_hash_chain IS 'Verify hash chain integrity for a thread';

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ V0.4 Conversation Messages table created!';
  RAISE NOTICE '   Table: conversation_messages';
  RAISE NOTICE '   Features: Hash chain, branching, user isolation';
  RAISE NOTICE '   Helper functions: get_thread_history, verify_hash_chain';
END $$;

