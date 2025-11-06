-- V0.3 Migration: Entity Vectors Table
-- Separate embeddings from entities for better performance

-- Create entity_vectors table
CREATE TABLE entity_vectors (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  
  -- Embedding
  embedding vector(1536),  -- OpenAI text-embedding-3-small
  embedding_model TEXT DEFAULT 'text-embedding-3-small' NOT NULL,
  
  -- Denormalized for search performance
  entity_type TEXT NOT NULL,
  title TEXT,
  preview TEXT,  -- First 500 chars of content
  
  -- Timestamps
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for similarity search (best performance)
CREATE INDEX idx_entity_vectors_embedding ON entity_vectors 
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- User isolation index
CREATE INDEX idx_entity_vectors_user ON entity_vectors(user_id);

-- Entity type filtering
CREATE INDEX idx_entity_vectors_type ON entity_vectors(entity_type);

-- Composite index for user + type filtering
CREATE INDEX idx_entity_vectors_user_type ON entity_vectors(user_id, entity_type);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_entity_vectors_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_entity_vectors_updated_at
  BEFORE UPDATE ON entity_vectors
  FOR EACH ROW
  EXECUTE FUNCTION update_entity_vectors_timestamp();

-- Comments
COMMENT ON TABLE entity_vectors IS 'Vector embeddings for semantic search (separated from entities for performance)';
COMMENT ON COLUMN entity_vectors.embedding IS 'OpenAI embedding vector (1536 dimensions)';
COMMENT ON COLUMN entity_vectors.preview IS 'Denormalized content preview for result snippets';
COMMENT ON INDEX idx_entity_vectors_embedding IS 'HNSW index for fast similarity search (m=16, ef_construction=64)';

