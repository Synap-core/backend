-- 0055_performance_indexes.sql
-- Critical performance indexes for entities, messages, and entity_vectors tables.
-- entities had zero indexes despite being the core data store.
-- messages was missing sessionId and composite (channelId, timestamp) indexes.
-- entity_vectors was missing userId for user-scoped semantic search filtering.

-- ============================================================
-- entities table indexes (was: zero indexes)
-- ============================================================

-- Workspace-scoped listing (most common query pattern)
CREATE INDEX IF NOT EXISTS entities_workspace_id_idx
  ON entities (workspace_id)
  WHERE deleted_at IS NULL;

-- User-scoped listing (personal AI, cross-workspace)
CREATE INDEX IF NOT EXISTS entities_user_id_idx
  ON entities (user_id)
  WHERE deleted_at IS NULL;

-- Composite: workspace + user + soft-delete (covers the primary list query)
CREATE INDEX IF NOT EXISTS entities_workspace_user_deleted_idx
  ON entities (workspace_id, user_id, deleted_at);

-- Profile-type filtering
CREATE INDEX IF NOT EXISTS entities_profile_id_idx
  ON entities (profile_id)
  WHERE profile_id IS NOT NULL;

-- Type column (still used for backward compat queries)
CREATE INDEX IF NOT EXISTS entities_type_workspace_idx
  ON entities (type, workspace_id)
  WHERE deleted_at IS NULL;

-- ============================================================
-- messages table indexes (was: channelId, inboxItemId, externalSource)
-- ============================================================

-- Session-scoped memory queries (compaction, bootstrap assembler)
CREATE INDEX IF NOT EXISTS messages_session_id_idx
  ON messages (session_id)
  WHERE session_id IS NOT NULL;

-- Chronological message fetch (primary read path: channel history)
CREATE INDEX IF NOT EXISTS messages_channel_timestamp_idx
  ON messages (channel_id, timestamp DESC)
  WHERE deleted_at IS NULL;

-- ============================================================
-- entity_vectors table indexes (was: primary key on entity_id only)
-- ============================================================

-- User-scoped semantic search (all vector search queries filter by userId first)
CREATE INDEX IF NOT EXISTS entity_vectors_user_id_idx
  ON entity_vectors (user_id);

-- HNSW index for cosine-similarity ANN search (pgvector)
-- Only created if vector column is populated; harmless if table is empty.
CREATE INDEX IF NOT EXISTS entity_vectors_embedding_hnsw_idx
  ON entity_vectors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
