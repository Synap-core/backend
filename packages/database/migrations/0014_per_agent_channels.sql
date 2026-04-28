-- Migration: 0014_per_agent_channels
-- Re-introduce thread_kind (dropped by 0010) for the V2 channel model,
-- add assigned_agent_id FK, and create per-agent uniqueness indexes.

-- Re-add thread_kind (was dropped in 0010; V2 model requires it again).
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS thread_kind text;

-- One active personal thread per (user, agent).
-- Enforces the new per-agent DM model: each user gets exactly one
-- private thread with each agent (keyed by assigned_agent_id).
CREATE UNIQUE INDEX IF NOT EXISTS channels_user_agent_personal_uniq
  ON channels (user_id, assigned_agent_id)
  WHERE thread_kind = 'personal'
    AND assigned_agent_id IS NOT NULL
    AND status = 'active';

-- One active workspace group thread per (user, workspace).
-- Enforces one workspace-wide group channel per user per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS channels_user_workspace_group_uniq
  ON channels (user_id, workspace_id)
  WHERE thread_kind = 'workspace'
    AND status = 'active';
