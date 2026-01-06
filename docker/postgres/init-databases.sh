#!/bin/bash
set -e

echo "🔄 Initializing Synap databases..."

# Create application database if it doesn't exist
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Check and create synap database
    SELECT 'CREATE DATABASE synap'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'synap')\gexec
    
    -- Check and create kratos_db database
    SELECT 'CREATE DATABASE kratos_db'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kratos_db')\gexec
EOSQL

# Connect to synap database and enable extensions
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "synap" <<-EOSQL
    -- Enable required extensions
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    
    -- Create migrations tracking table
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    -- Log success
    SELECT 'Synap database initialized with extensions' AS status;
EOSQL

echo "✅ Synap databases created successfully!"
