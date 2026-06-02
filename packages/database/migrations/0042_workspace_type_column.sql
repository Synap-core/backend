-- Promote workspace_type from JSONB settings to an indexed real column.
-- Existing rows default to 'personal'. settings JSONB continues to be
-- dual-written for back-compat during the transition window.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS workspace_type text NOT NULL DEFAULT 'personal';

CREATE INDEX IF NOT EXISTS idx_workspaces_workspace_type ON workspaces(workspace_type);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_workspace_type ON workspaces(owner_id, workspace_type);

-- Backfill from JSONB for existing agent/project/operational workspaces
UPDATE workspaces
SET workspace_type = settings->>'workspaceType'
WHERE settings->>'workspaceType' IS NOT NULL
  AND settings->>'workspaceType' != 'personal';
