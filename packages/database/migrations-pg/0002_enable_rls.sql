-- ============================================================
-- ROW-LEVEL SECURITY (RLS) SETUP
-- ============================================================
-- This enables multi-tenant isolation at the database level.
-- Each user can only access their own data.
--
-- Important: The application MUST set `app.current_user_id` 
-- before running queries. See packages/api/src/context.ts
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_tags ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- EVENTS TABLE POLICY
-- ============================================================
CREATE POLICY user_isolation_events ON events
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- ============================================================
-- ENTITIES TABLE POLICY
-- ============================================================
CREATE POLICY user_isolation_entities ON entities
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- ============================================================
-- CONTENT_BLOCKS TABLE POLICY
-- ============================================================
-- Content blocks don't have direct user_id, so we join through entities
CREATE POLICY user_isolation_content_blocks ON content_blocks
  FOR ALL
  USING (
    entity_id IN (
      SELECT id FROM entities 
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    entity_id IN (
      SELECT id FROM entities 
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- RELATIONS TABLE POLICY
-- ============================================================
CREATE POLICY user_isolation_relations ON relations
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- ============================================================
-- TASK_DETAILS TABLE POLICY
-- ============================================================
-- Task details don't have direct user_id, so we join through entities
CREATE POLICY user_isolation_task_details ON task_details
  FOR ALL
  USING (
    entity_id IN (
      SELECT id FROM entities 
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    entity_id IN (
      SELECT id FROM entities 
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- TAGS TABLE POLICY
-- ============================================================
-- Tags are user-specific
CREATE POLICY user_isolation_tags ON tags
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- ============================================================
-- ENTITY_TAGS TABLE POLICY
-- ============================================================
-- Entity-tag relationships inherit user isolation from both entities and tags
CREATE POLICY user_isolation_entity_tags ON entity_tags
  FOR ALL
  USING (
    entity_id IN (
      SELECT id FROM entities 
      WHERE user_id = current_setting('app.current_user_id', true)
    )
    AND
    tag_id IN (
      SELECT id FROM tags
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    entity_id IN (
      SELECT id FROM entities 
      WHERE user_id = current_setting('app.current_user_id', true)
    )
    AND
    tag_id IN (
      SELECT id FROM tags
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- INDEXES FOR RLS PERFORMANCE
-- ============================================================
-- These indexes significantly improve RLS policy performance

CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relations_user_id ON relations(user_id);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);

CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- ============================================================
-- VECTOR SIMILARITY INDEX (for RAG search)
-- ============================================================
-- Create HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_content_blocks_embedding ON content_blocks 
  USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- VERIFICATION
-- ============================================================
-- Verify RLS is enabled
SELECT 
  schemaname, 
  tablename, 
  rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename IN ('events', 'entities', 'content_blocks', 'relations', 'task_details', 'tags', 'entity_tags');

-- List all policies
SELECT 
  schemaname, 
  tablename, 
  policyname,
  permissive,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

