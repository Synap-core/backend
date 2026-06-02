-- 0037_users_agent_singleton_unique.sql
--
-- Firewall: partial UNIQUE indexes on users.agent_metadata (JSONB expression
-- indexes) that make duplicate agent-users structurally impossible at the DB
-- level — regardless of app-layer dedup bugs or provisioning races. Scoped to
-- agent rows only (user_type = 'agent'); human rows are unaffected.
--
-- Three dedup semantics, one per provisioning path:
--   1. Service / integration agents (no agentTemplate, not personal):
--      one per agentType, pod-wide.  (POST /api/hub/setup/agent — eve pipeline,
--      openclaw, openwebui, hermes, …)  This is the path that produced the
--      original duplicate-agents bug.
--   2. Personal agents (isPersonalAgent = true): one per creator.
--      (ensureAgentUser — the pod-wide personal orchestrator)
--   3. Twin agents (agentTemplate = 'twin'): one per creator.
--      (seedAdminUser / user-provisioning)
--
-- User-custom agents (agentTemplate IN 'assistant','custom') are intentionally
-- NOT constrained — a user may legitimately create several with distinct names.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_type_unique
    ON users ((agent_metadata->>'agentType'))
    WHERE user_type = 'agent'
      AND (agent_metadata->>'agentTemplate') IS NULL
      AND COALESCE(agent_metadata->>'isPersonalAgent', 'false') <> 'true';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_personal_agent_unique
    ON users ((agent_metadata->>'createdByUserId'))
    WHERE user_type = 'agent'
      AND (agent_metadata->>'isPersonalAgent') = 'true';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_twin_agent_unique
    ON users ((agent_metadata->>'createdByUserId'))
    WHERE user_type = 'agent'
      AND (agent_metadata->>'agentTemplate') = 'twin';
