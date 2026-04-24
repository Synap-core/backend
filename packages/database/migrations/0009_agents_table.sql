-- Migration 0009: Agents Table Redesign
--
-- Replaces old text-based agent fields with proper agents table.
-- Handles both fresh DB and existing DB from 0000 baseline (TEXT id → UUID).
-- Idempotent — safe to apply to empty DBs, existing DBs, or re-run.

BEGIN;

-- 1. Drop old agent columns from channels (if they exist)
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

-- 2. Create agents table
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    agent_slug TEXT,
    description TEXT,
    icon TEXT,
    capabilities TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::jsonb,
    owner_type TEXT NOT NULL DEFAULT 'system',
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    intelligence_service_id TEXT REFERENCES intelligence_services(id) ON DELETE SET NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Add missing columns if table existed from older migration (idempotent)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_slug TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities TEXT[] DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'system';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS intelligence_service_id TEXT REFERENCES intelligence_services(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 4. If table existed from 0000 baseline with TEXT id, convert to UUID
DO $$ BEGIN
    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'id'
          AND (SELECT data_type FROM information_schema.columns
               WHERE table_name = 'agents' AND column_name = 'id') = 'text'
    ) THEN
        -- Table exists from baseline (id is TEXT → convert to UUID)
        ALTER TABLE agents ALTER COLUMN id TYPE UUID USING id::uuid;
    END IF;
END $$;

-- 5. Recreate indexes
DROP INDEX IF EXISTS agents_service_slug_unique;
CREATE UNIQUE INDEX agents_service_slug_unique ON agents(intelligence_service_id, agent_slug);

DROP INDEX IF EXISTS agents_user_id_idx;
CREATE INDEX agents_user_id_idx ON agents(user_id);

DROP INDEX IF EXISTS agents_owner_type_idx;
CREATE INDEX agents_owner_type_idx ON agents(owner_type);

DROP INDEX IF EXISTS agents_active_idx;
CREATE INDEX agents_active_idx ON agents(active);

DROP INDEX IF EXISTS agents_intelligence_service_idx;
CREATE INDEX agents_intelligence_service_idx ON agents(intelligence_service_id);

-- 6. Add sender_agent_id FK on channels
ALTER TABLE channels DROP COLUMN IF EXISTS sender_agent_id;
ALTER TABLE channels ADD COLUMN sender_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

-- 7. Backfill: create synthetic "orchestrator" agent
DO $$
DECLARE
    orchestrator_agent_id UUID;
BEGIN
    INSERT INTO agents (id, name, agent_slug, capabilities, owner_type)
    VALUES (gen_random_uuid(), 'Orchestrator', 'orchestrator', '{"orchestration", "generalist"}', 'system')
    ON CONFLICT (intelligence_service_id, agent_slug) WHERE intelligence_service_id IS NULL DO NOTHING;

    SELECT id INTO orchestrator_agent_id FROM agents
    WHERE agent_slug = 'orchestrator' AND intelligence_service_id IS NULL;

    IF orchestrator_agent_id IS NOT NULL THEN
        UPDATE channels SET sender_agent_id = orchestrator_agent_id
        WHERE sender_agent_id IS NULL;
    END IF;
END $$;

COMMIT;
