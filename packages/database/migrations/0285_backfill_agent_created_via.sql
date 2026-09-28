-- Migration: 0285_backfill_agent_created_via.sql
--
-- 0225 added `users.created_via` and stamped it at each agent-creation site
-- from then on, but never backfilled. On pods older than 0225 the pod's OWN
-- agents — the capture agent, form agents, the personal twin — carry NULL, so
-- `agentUsers.list` cannot tell them from an agent a person connected, and
-- Settings asks the person to "connect" an agent that never holds a key.
--
-- Stamps 'system' on exactly those, identified the same way their writers
-- identify them (never a name match):
--   - capture agent: agent_type = 'capture'  (ensure-capture-agent.ts)
--   - form agents:   agent_type LIKE 'form:%' (form-definition.ts FORM_ACTOR_TYPE_PREFIX)
--   - the twin:      is_personal_agent = true (personal-agent-user.ts)
-- Only NULL rows are touched, so a value any writer stamped is never
-- overwritten, and re-running is a no-op. No new column (no baseline /
-- schema-coherence change).

UPDATE users
SET created_via = 'system'
WHERE user_type = 'agent'
  AND created_via IS NULL
  AND (
    agent_type = 'capture'
    OR agent_type LIKE 'form:%'
    OR is_personal_agent = true
  );
