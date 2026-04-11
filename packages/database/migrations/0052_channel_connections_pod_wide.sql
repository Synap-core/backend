-- Migration: Make channel_connections and channel_link_tokens pod-wide
-- workspaceId is now optional (NULL = pod-wide connection, not workspace-scoped)

-- channel_connections: drop NOT NULL on workspace_id, change CASCADE to SET NULL
ALTER TABLE channel_connections
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE channel_connections
  DROP CONSTRAINT IF EXISTS channel_connections_workspace_id_fkey;

ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

-- channel_link_tokens: same change
ALTER TABLE channel_link_tokens
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE channel_link_tokens
  DROP CONSTRAINT IF EXISTS channel_link_tokens_workspace_id_fkey;

ALTER TABLE channel_link_tokens
  ADD CONSTRAINT channel_link_tokens_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
