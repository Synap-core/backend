-- Migration 0012: Agent dispatch fixes
--
-- 1. Drop legacy private columns from the agents table (only present on DBs
--    initialised from the 0000 baseline before the redesign).
-- 2. Add intelligence_services.provider_type and agent_list_sync_enabled
--    (present in Drizzle schema but never migrated).
-- 3. Fix the agents active index: was incorrectly UNIQUE in Drizzle schema
--    (migrations already created it as a plain INDEX — no-op on most DBs,
--    but drop+recreate to guarantee consistency).
-- 4. Add channels.assigned_agent_id FK → agents.id (channel-level agent
--    assignment, separate from sender_agent_id which tracks last sender).

BEGIN;

-- ── 1. Drop legacy private columns from agents ────────────────────────────────
DO $$
BEGIN
    -- system_prompt
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'system_prompt') THEN
        ALTER TABLE agents DROP COLUMN system_prompt;
    END IF;
    -- tools_config
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'tools_config') THEN
        ALTER TABLE agents DROP COLUMN tools_config;
    END IF;
    -- llm_provider
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'llm_provider') THEN
        ALTER TABLE agents DROP COLUMN llm_provider;
    END IF;
    -- llm_model
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'llm_model') THEN
        ALTER TABLE agents DROP COLUMN llm_model;
    END IF;
    -- execution_mode
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'execution_mode') THEN
        ALTER TABLE agents DROP COLUMN execution_mode;
    END IF;
    -- max_iterations
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'max_iterations') THEN
        ALTER TABLE agents DROP COLUMN max_iterations;
    END IF;
    -- timeout_seconds
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'timeout_seconds') THEN
        ALTER TABLE agents DROP COLUMN timeout_seconds;
    END IF;
    -- weight
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'weight') THEN
        ALTER TABLE agents DROP COLUMN weight;
    END IF;
    -- performance_metrics
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'performance_metrics') THEN
        ALTER TABLE agents DROP COLUMN performance_metrics;
    END IF;
    -- created_by (old FK, replaced by user_id)
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'created_by') THEN
        ALTER TABLE agents DROP COLUMN created_by;
    END IF;
END $$;

-- ── 2. Add missing intelligence_services columns ──────────────────────────────
ALTER TABLE intelligence_services
    ADD COLUMN IF NOT EXISTS provider_type TEXT,
    ADD COLUMN IF NOT EXISTS agent_list_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. Fix agents active index (ensure it is a plain index, not unique) ───────
-- Drop any unique variant that may exist from the Drizzle schema definition,
-- then recreate as a regular index (idempotent).
DROP INDEX IF EXISTS idx_agents_active;
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(active);

-- ── 4. Add channels.assigned_agent_id ────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'channels' AND column_name = 'assigned_agent_id'
    ) THEN
        ALTER TABLE channels ADD COLUMN assigned_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS channels_assigned_agent_id_idx ON channels(assigned_agent_id);

COMMIT;
