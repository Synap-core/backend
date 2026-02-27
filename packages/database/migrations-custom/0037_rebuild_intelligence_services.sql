-- Migration: Rebuild intelligence_services table
--
-- The original migration (0004_intelligence.sql) created an old schema
-- (workspace_id, provider, api_key_ref, config, is_enabled).
-- The current codebase expects a completely different design as a
-- global service registry (service_id, webhook_url, api_key, capabilities, etc.).
--
-- Since this table had no data and the design is fundamentally different,
-- we drop and recreate it.

DROP TABLE IF EXISTS intelligence_services CASCADE;

CREATE TABLE intelligence_services (
  id            TEXT PRIMARY KEY,
  service_id    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  version       TEXT,
  webhook_url   TEXT NOT NULL,
  api_key       TEXT NOT NULL,
  capabilities  JSONB NOT NULL DEFAULT '[]',
  pricing       TEXT DEFAULT 'free',
  status        TEXT NOT NULL DEFAULT 'active',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_health_check TIMESTAMPTZ
);
