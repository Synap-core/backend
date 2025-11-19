-- V1.0 Migration: Enable Row-Level Security (RLS)
-- Critical security hardening: Database-level user isolation
--
-- This migration enables RLS on all user-owned tables and creates policies
-- that automatically filter data based on the current user context.
--
-- How it works:
-- 1. Before each request, the API sets: SET app.current_user_id = 'user-id'
-- 2. PostgreSQL automatically applies RLS policies to all queries
-- 3. Users can only access their own data, even if application code forgets WHERE clauses
--
-- This is "defense in depth" - the database enforces security at the lowest level.

-- ============================================================================
-- STEP 1: CREATE SESSION VARIABLE FUNCTION
-- ============================================================================
-- 
-- We need a way to set the current user for each database connection.
-- PostgreSQL allows us to set custom session variables using SET.
-- However, we need to ensure the variable is properly typed and validated.

-- Create a function to safely set the current user
-- This function validates the user_id and sets it in the session
-- Note: We use EXECUTE with format to set the session variable
-- This is safe because user_id is validated before use
CREATE OR REPLACE FUNCTION set_current_user(p_user_id TEXT)
RETURNS VOID AS $$
BEGIN
  -- Validate that user_id is not empty
  IF p_user_id IS NULL OR LENGTH(TRIM(p_user_id)) = 0 THEN
    RAISE EXCEPTION 'Invalid user_id: cannot be null or empty';
  END IF;
  
  -- Set the session variable using EXECUTE
  -- We use format with %L to properly escape the user_id
  EXECUTE format('SET app.current_user_id = %L', p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a function to get the current user (for debugging)
CREATE OR REPLACE FUNCTION get_current_user()
RETURNS TEXT AS $$
  SELECT current_setting('app.current_user_id', true);
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- STEP 2: ENABLE RLS ON ALL USER-OWNED TABLES
-- ============================================================================

-- Core tables with direct user_id column
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_vectors ENABLE ROW LEVEL SECURITY;

-- Tables without direct user_id (inherit via foreign keys)
ALTER TABLE entity_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_details ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- STEP 3: CREATE RLS POLICIES
-- ============================================================================
--
-- Policies use the session variable app.current_user_id to filter rows.
-- The USING clause defines the condition that must be true for a row to be visible.
-- The WITH CHECK clause defines the condition for INSERT/UPDATE operations.

-- ============================================================================
-- POLICIES FOR TABLES WITH DIRECT user_id COLUMN
-- ============================================================================

-- Events table
DROP POLICY IF EXISTS user_isolation_events ON events;
CREATE POLICY user_isolation_events ON events
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Events_v2 table (TimescaleDB hypertable)
DROP POLICY IF EXISTS user_isolation_events_v2 ON events_v2;
CREATE POLICY user_isolation_events_v2 ON events_v2
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Entities table
DROP POLICY IF EXISTS user_isolation_entities ON entities;
CREATE POLICY user_isolation_entities ON entities
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Relations table
DROP POLICY IF EXISTS user_isolation_relations ON relations;
CREATE POLICY user_isolation_relations ON relations
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Tags table
DROP POLICY IF EXISTS user_isolation_tags ON tags;
CREATE POLICY user_isolation_tags ON tags
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Conversation messages table
DROP POLICY IF EXISTS user_isolation_conversation_messages ON conversation_messages;
CREATE POLICY user_isolation_conversation_messages ON conversation_messages
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Knowledge facts table
DROP POLICY IF EXISTS user_isolation_knowledge_facts ON knowledge_facts;
CREATE POLICY user_isolation_knowledge_facts ON knowledge_facts
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- AI suggestions table
DROP POLICY IF EXISTS user_isolation_ai_suggestions ON ai_suggestions;
CREATE POLICY user_isolation_ai_suggestions ON ai_suggestions
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Entity vectors table
DROP POLICY IF EXISTS user_isolation_entity_vectors ON entity_vectors;
CREATE POLICY user_isolation_entity_vectors ON entity_vectors
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- ============================================================================
-- POLICIES FOR TABLES WITHOUT DIRECT user_id (inherit via foreign keys)
-- ============================================================================
--
-- These tables don't have a user_id column, but they reference entities
-- which do. We need to check the user_id of the related entity.

-- Entity tags table (M2M join table)
-- Users can only access tags that belong to their entities
DROP POLICY IF EXISTS user_isolation_entity_tags ON entity_tags;
CREATE POLICY user_isolation_entity_tags ON entity_tags
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM entities
      WHERE entities.id = entity_tags.entity_id
        AND entities.user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM entities
      WHERE entities.id = entity_tags.entity_id
        AND entities.user_id = current_setting('app.current_user_id', true)
    )
  );

-- Task details table
-- Users can only access task details for their own entities
DROP POLICY IF EXISTS user_isolation_task_details ON task_details;
CREATE POLICY user_isolation_task_details ON task_details
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM entities
      WHERE entities.id = task_details.entity_id
        AND entities.user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM entities
      WHERE entities.id = task_details.entity_id
        AND entities.user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================================
-- STEP 4: GRANT PERMISSIONS
-- ============================================================================
--
-- Ensure the application user has the necessary permissions.
-- The policies above control WHAT data can be accessed,
-- but we still need to grant the basic table permissions.

-- Note: In production, you should use a dedicated database user for the application.
-- For now, we assume the connection user has the necessary permissions.
-- If you're using a specific user, grant permissions like this:
--
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO synap_app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO synap_app_user;

-- ============================================================================
-- STEP 5: VERIFICATION
-- ============================================================================
--
-- After running this migration, verify RLS is working:
--
-- 1. Set a test user:
--    SELECT set_current_user('test-user-123');
--
-- 2. Try to query entities:
--    SELECT * FROM entities;
--    -- Should only return entities where user_id = 'test-user-123'
--
-- 3. Try to insert an entity with wrong user_id:
--    INSERT INTO entities (id, user_id, type) VALUES (gen_random_uuid(), 'other-user', 'note');
--    -- Should fail due to WITH CHECK policy
--
-- 4. Clear the user context:
--    RESET app.current_user_id;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION set_current_user IS 'Sets the current user for RLS policies. Must be called before each request.';
COMMENT ON FUNCTION get_current_user IS 'Gets the current user from session context (for debugging).';

COMMENT ON POLICY user_isolation_events ON events IS 'RLS policy: Users can only access their own events';
COMMENT ON POLICY user_isolation_events_v2 ON events_v2 IS 'RLS policy: Users can only access their own events (TimescaleDB)';
COMMENT ON POLICY user_isolation_entities ON entities IS 'RLS policy: Users can only access their own entities';
COMMENT ON POLICY user_isolation_relations ON relations IS 'RLS policy: Users can only access their own relations';
COMMENT ON POLICY user_isolation_tags ON tags IS 'RLS policy: Users can only access their own tags';
COMMENT ON POLICY user_isolation_conversation_messages ON conversation_messages IS 'RLS policy: Users can only access their own conversation messages';
COMMENT ON POLICY user_isolation_knowledge_facts ON knowledge_facts IS 'RLS policy: Users can only access their own knowledge facts';
COMMENT ON POLICY user_isolation_ai_suggestions ON ai_suggestions IS 'RLS policy: Users can only access their own AI suggestions';
COMMENT ON POLICY user_isolation_entity_vectors ON entity_vectors IS 'RLS policy: Users can only access their own entity vectors';
COMMENT ON POLICY user_isolation_entity_tags ON entity_tags IS 'RLS policy: Users can only access entity_tags for their own entities';
COMMENT ON POLICY user_isolation_task_details ON task_details IS 'RLS policy: Users can only access task_details for their own entities';

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ V1.0 Row-Level Security (RLS) enabled!';
  RAISE NOTICE '   Tables protected: events, events_v2, entities, relations, tags, conversation_messages, knowledge_facts, ai_suggestions, entity_vectors, entity_tags, task_details';
  RAISE NOTICE '   Security: Database-level user isolation enforced';
  RAISE NOTICE '   Next step: Update API middleware to call set_current_user() before each request';
END $$;

