-- Migration 0009: Agents Table Redesign
--
-- Creates the agents table as the canonical AI agent identity registry.
-- Removes agentId + agentType columns from channels (replaced by sender_agent_id FK).

BEGIN;

-- Drop existing agent-related columns from channels (if they exist)
-- These were the old text-based agent fields replaced by the agents table FK
DO $$
BEGIN
    -- Drop agentId column (the text-based FK reference that was not a real FK)
    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'channels' AND column_name = 'agent_id'
    ) THEN
        ALTER TABLE channels DROP COLUMN agent_id;
    END IF;

    -- Drop agentType column (free-form string, replaced by agents table)
    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'channels' AND column_name = 'agent_type'
    ) THEN
        ALTER TABLE channels DROP COLUMN agent_type;
    END IF;
END $$;

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

-- Add intelligence_service_id column if missing (table may exist from baseline without it)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'intelligence_service_id'
    ) THEN
        ALTER TABLE agents ADD COLUMN intelligence_service_id TEXT REFERENCES intelligence_services(id);
    END IF;
END $$;

-- Unique idx per service
CREATE UNIQUE INDEX IF NOT EXISTS agents_service_slug_unique ON agents(intelligence_service_id, agent_slug);

-- Additional indexes for fast lookups
CREATE INDEX IF NOT EXISTS agents_intelligence_service_idx ON agents(intelligence_service_id);
CREATE INDEX IF NOT EXISTS agents_user_id_idx ON agents(user_id);
CREATE INDEX IF NOT EXISTS agents_owner_type_idx ON agents(owner_type);
CREATE INDEX IF NOT EXISTS agents_active_idx ON agents(active);

-- Add FK from channels to agents for sender identification
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'channels' AND column_name = 'sender_agent_id'
    ) THEN
        ALTER TABLE channels ADD COLUMN sender_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
    END IF;
END $$;

COMMIT;
