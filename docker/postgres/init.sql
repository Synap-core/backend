-- Synap Database Initialization
-- Auto-runs when database is first created

-- Create required databases
CREATE DATABASE IF NOT EXISTS synap;
CREATE DATABASE IF NOT EXISTS kratos_db;

-- Connect to synap database for extensions
\c synap

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant permissions (if using separate app user in production)
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO synap_app;
-- GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO synap_app;

-- Log initialization
DO $$
BEGIN
  RAISE NOTICE '✅ Synap database initialized with required extensions';
END $$;
