-- 0031_hermes_agent.sql
--
-- Seed the Hermes system agent so it is discoverable and selectable from EVERY
-- frontend that talks to the pod (browser companion, Relay, OpenWebUI, @mentions).
--
-- Hermes is an autonomous AI runtime (deployed by Eve as `eve-builder-hermes`).
-- The IS routes agentType "hermes" to HermesAgent, which proxies to
-- HERMES_TRIGGER_URL/v1/chat/completions. Registering it as an `agents` row means
-- no per-frontend wiring is needed — the existing agent picker + agentHandle
-- resolution surface it automatically. Owner_type 'system' = pod-wide, like orchestrator.
--
-- Idempotent via WHERE NOT EXISTS (NULL intelligence_service_id = pod-native agent,
-- same convention as orchestrator). WHERE NOT EXISTS is index-predicate-agnostic, so it
-- stays correct whether the unique index on (intelligence_service_id, agent_slug) is
-- full or partial.

DO $$
BEGIN
    INSERT INTO agents (id, name, agent_slug, description, capabilities, owner_type, active)
    SELECT
        gen_random_uuid(),
        'Hermes',
        'hermes',
        'Autonomous AI agent running on this pod. Handles long-running tasks, feature planning, and cross-platform messaging.',
        '{"autonomous", "planning", "messaging"}',
        'system',
        true
    WHERE NOT EXISTS (
        SELECT 1 FROM agents
        WHERE agent_slug = 'hermes' AND intelligence_service_id IS NULL
    );
END $$;
