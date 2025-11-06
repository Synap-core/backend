-- Enable pgvector extension for similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extension is installed
SELECT * FROM pg_extension WHERE extname = 'vector';

