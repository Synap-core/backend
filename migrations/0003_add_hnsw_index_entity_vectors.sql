-- Migration 0003: HNSW index on entity_vectors for fast approximate nearest-neighbor search
--
-- Without this index every vector similarity query does a full sequential scan of
-- entity_vectors, which becomes untenable above ~10k rows.
-- HNSW (Hierarchical Navigable Small World) is the recommended pgvector index type:
--   - Build is slower than IVFFlat but query accuracy is higher at all recall levels
--   - m=16 / ef_construction=64 are sensible defaults for 1536-dim embeddings
--   - cosine_ops matches the <=> (cosine distance) operator used in queries
--
-- Also add a btree index on user_id since all queries filter by that column first.

-- Enable pgvector extension if not already present
CREATE EXTENSION IF NOT EXISTS vector;

-- HNSW index: cosine similarity on 1536-dim OpenAI embeddings
CREATE INDEX CONCURRENTLY IF NOT EXISTS entity_vectors_embedding_hnsw_idx
  ON entity_vectors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- btree index on user_id for fast per-user filtering before vector scan
CREATE INDEX CONCURRENTLY IF NOT EXISTS entity_vectors_user_id_idx
  ON entity_vectors (user_id);
