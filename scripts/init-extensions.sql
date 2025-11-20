-- Initialize PostgreSQL extensions for Synap
-- This script runs automatically when the container starts

-- Enable pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- TimescaleDB is already enabled in timescaledb-ha image
-- But we ensure it's available
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable PostgreSQL cryptographic functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Verify extensions
SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'timescaledb', 'uuid-ossp', 'pgcrypto');

-- Create migrations tracking table
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Done
\echo 'PostgreSQL extensions initialized successfully!'

