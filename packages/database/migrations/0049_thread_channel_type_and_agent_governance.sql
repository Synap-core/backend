-- Migration: THREAD channel type + agent workspace governance
-- 0049_thread_channel_type_and_agent_governance.sql

-- 1. Add 'thread' to channels.channel_type enum.
--    Drizzle uses a plain text column (no PG enum), so no ALTER TYPE needed —
--    the constraint is enforced at the application layer only.
--    This migration is a no-op at the DB level for the enum, but documents the intent.

-- 2. Backfill isPersonalAgent on existing pod-wide agent users.
--    Any agent user that was created by ensureAgentUser (single per human) should be
--    marked as isPersonalAgent=true. We identify them by the synthetic email pattern
--    and by having exactly one workspace membership (the first workspace they joined).
--    Since the old logic created one per workspace, we select the oldest one per human
--    and mark it; the rest will be cleaned up lazily (they'll just be unused).
UPDATE users
SET agent_metadata = agent_metadata || '{"isPersonalAgent": true}'::jsonb
WHERE user_type = 'agent'
  AND agent_metadata->>'isPersonalAgent' IS NULL
  AND agent_metadata->>'createdByUserId' IS NOT NULL
  AND agent_metadata->>'agentType' = 'orchestrator'
  AND id IN (
    -- Pick the oldest agent user per human (the one to keep as the pod-wide agent)
    SELECT DISTINCT ON (agent_metadata->>'createdByUserId') id
    FROM users
    WHERE user_type = 'agent'
      AND agent_metadata->>'createdByUserId' IS NOT NULL
      AND agent_metadata->>'agentType' = 'orchestrator'
    ORDER BY agent_metadata->>'createdByUserId', created_at ASC
  );

-- 3. Set governanceMode on existing agent workspaces.
UPDATE workspaces
SET settings = settings || '{"governanceMode": "agent-owned"}'::jsonb
WHERE settings->>'workspaceType' = 'agent'
  AND settings->>'governanceMode' IS NULL;

-- 4. For existing agent workspaces, downgrade the human creator from 'owner' to 'admin'
--    so the agent can be added as 'owner' on next message.
UPDATE workspace_members wm
SET role = 'admin'
FROM workspaces w
WHERE wm.workspace_id = w.id
  AND w.settings->>'workspaceType' = 'agent'
  AND wm.role = 'owner'
  AND wm.user_id NOT IN (
    -- Don't touch rows that are already agent users
    SELECT id FROM users WHERE user_type = 'agent'
  );
