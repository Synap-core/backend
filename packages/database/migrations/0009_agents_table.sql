-- Migration 0009: Agents Table Redesign
--
-- Creates the agents table as the canonical AI agent identity registry.
-- Removes agentId + agentType columns from channels (replaced by sender_agent_id FK).

BEGIN;

-- Drop existing agent-related columns from channels (if they exist)
-- These were the old text-based agent fields replaced by the agents table FK
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'channels' AND column_name = 'agent_id'
    ) THEN
        ALTER TABLE channels DROP COLUMN agent_id;
    END IF;

    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'channels' AND column_name = 'agent_type'
    ) THEN
        ALTER TABLE channels DROP COLUMN agent_type;
    END IF;
END $$;

-- Drop old agents table (recreated below with proper schema)
DROP TABLE IF EXISTS agents CASCADE;

-- Create new agents table
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    agent_slug TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    capabilities TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::jsonb,
    active BOOLEAN DEFAULT true,
    owner_type TEXT NOT NULL DEFAULT 'system',
    intelligence_service_id TEXT REFERENCES intelligence_services(id),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add missing columns if table existed from older migration without them
ALTER TABLE agents ADD COLUMN IF NOT EXISTS intelligence_service_id TEXT REFERENCES intelligence_services(id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_slug TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'system';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities TEXT[] DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;

-- Recreate indexes (IF NOT EXISTS is idempotent)
CREATE INDEX IF NOT EXISTS agents_service_slug_unique ON agents(intelligence_service_id, agent_slug);
CREATE INDEX IF NOT EXISTS agents_intelligence_service_idx ON agents(intelligence_service_id);
CREATE INDEX IF NOT EXISTS agents_user_id_idx ON agents(user_id);
CREATE INDEX IF NOT EXISTS agents_owner_type_idx ON agents(owner_type);
CREATE INDEX IF NOT EXISTS agents_active_idx ON agents(active);

-- Drop old sender_agent_id (text) and recreate as UUID FK
ALTER TABLE channels DROP COLUMN IF EXISTS sender_agent_id;
ALTER TABLE channels ADD COLUMN sender_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

COMMIT;
