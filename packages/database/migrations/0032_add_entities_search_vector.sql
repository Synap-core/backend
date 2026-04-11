-- Add tsvector column for full-text search on entities table
-- This provides much faster search than ILIKE pattern matching

-- Add generated tsvector column
ALTER TABLE entities
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(preview, '')), 'B')
) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS ntities_search_vector_idx ON entities USING GIN(search_vector);

-- Add comment
COMMENT ON COLUMN entities.search_vector IS 'Full-text search vector combining title (weight A) and preview (weight B)';
