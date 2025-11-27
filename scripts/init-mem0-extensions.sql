-- Initialize PostgreSQL extensions for Mem0
-- This script is executed when the postgres-mem0 container starts

-- Enable pgvector extension for vector search
CREATE EXTENSION IF NOT EXISTS vector;

-- Mem0 will create its own tables and schema
-- This script only ensures required extensions are available

