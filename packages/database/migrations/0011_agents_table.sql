-- Migration 0011: Agents Table Redesign
--
-- Replaces the old agentType-based text ID system with a proper agents table
-- using UUIDs. Adds intelligence service integration, owner types, and
-- capability tracking. Backfills existing orchestrator channels with a synthetic
-- agent row.

BEGIN;

-- Drop legacy agent columns from channels (idempotent)
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

-- Create the new agents table
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
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique idx per service+slug
CREATE UNIQUE INDEX IF NOT EXISTS agents_intelligence_service_id_agent_slug_unique ON agents(intelligence_service_id, agent_slug);

-- Additional indexes for fast lookups
CREATE INDEX IF NOT EXISTS agents_intelligence_service_id_idx ON agents(intelligence_service_id);
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

-- Backfill: create a synthetic agent row for the legacy "orchestrator" agentType
-- so existing channels with agent_type='orchestrator' can point to a real agent
DO $$
DECLARE
    orchestrator_agent_id UUID;
BEGIN
    INSERT INTO agents (id, name, agent_slug, capabilities, owner_type)
    VALUES (gen_random_uuid(), 'Orchestrator', 'orchestrator', '{"orchestration", "generalist"}', 'system')
    ON CONFLICT (intelligence_service_id, agent_slug) WHERE intelligence_service_id IS NULL DO NOTHING
    RETURNING id INTO orchestrator_agent_id;

    -- If the ON CONFLICT swallowed it, fetch it
    IF orchestrator_agent_id IS NULL THEN
        SELECT id INTO orchestrator_agent_id FROM agents
        WHERE agent_slug = 'orchestrator' AND intelligence_service_id IS NULL;
    END IF;

    -- Set sender_agent_id on all channels that have no sender yet.
    -- sender_agent_id is a new column, so NULL means legacy — we attribute
    -- all legacy messages to the orchestrator agent as a sensible default.
    IF orchestrator_agent_id IS NOT NULL THEN
        UPDATE channels SET sender_agent_id = orchestrator_agent_id
        WHERE sender_agent_id IS NULL;
    END IF;
END $$;

COMMIT;
