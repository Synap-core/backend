-- Migration: 0287_backfill_is_persona_created_via.sql
--
-- 0285 backfilled `created_via = 'system'` for the pod's own capture, form and
-- twin agents. It did not cover Intelligence Service personas: an agent-user
-- that the IS roster sync (`POST /api/hub/agents/sync`, hub-protocol/rest/
-- agents.ts) LINKED rather than created keeps whatever it had — and a row
-- older than 0225 had NULL. `resolveAgentDirection` reads NULL as `external`
-- (the documented safe default), so the pod's own personas showed as agents
-- a person connected, with "No key yet".
--
-- Stamps 'intelligence-service' on exactly the agent-users the IS catalog
-- claims: a row in `agents` with `owner_type = 'synap'` (the value only the
-- roster sync and its stubs write — a person's local adjunct is 'user') whose
-- `user_id` points at the agent. Never a name or agentType match.
-- Only NULL rows are touched, so a value any writer stamped ('cli', 'ui',
-- 'system') is never overwritten, and re-running is a no-op. The going-forward
-- half is `findOrCreateServiceAgentUser`, which now stamps a NULL row it
-- reuses. No new column (no baseline / schema-coherence change).

UPDATE users u
SET created_via = 'intelligence-service'
WHERE u.user_type = 'agent'
  AND u.created_via IS NULL
  AND COALESCE(u.is_personal_agent, false) = false
  AND EXISTS (
    SELECT 1 FROM agents a
    WHERE a.user_id = u.id
      AND a.owner_type = 'synap'
  );
