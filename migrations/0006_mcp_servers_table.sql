-- Migration 0006: Create mcp_servers table
--
-- Promotes MCP server configuration out of workspaces.settings.mcpServers[]
-- (a JSONB array) into a proper indexed table with per-server status tracking.
--
-- This enables:
--   - Per-server enable/disable without touching workspace settings
--   - Health status tracked per server (status, last_ping_at, error_message)
--   - Explicit approval gate before tools can be injected into LLM requests
--   - Standard CRUD and query patterns
--
-- Migrate existing data: on first boot, the backend reads
-- workspace.settings.mcpServers[] and inserts rows if they don't exist yet.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Unique human-readable slug within the workspace (e.g. 'playwright', 'filesystem')
  slug         text NOT NULL,
  name         text NOT NULL,

  -- Connection config
  transport    text NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  command      text,                          -- stdio: executable, e.g. 'npx'
  args         jsonb NOT NULL DEFAULT '[]',   -- stdio: args, e.g. ['@playwright/mcp']
  url          text,                          -- http/sse: server URL
  env          jsonb NOT NULL DEFAULT '{}',   -- environment variables passed to server

  -- Lifecycle
  enabled      boolean NOT NULL DEFAULT true,
  approved     boolean NOT NULL DEFAULT false, -- owner must approve before tools inject into LLM

  -- Runtime health (updated by periodic ping worker)
  status       text NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('connected', 'disconnected', 'error', 'unknown')),
  last_ping_at timestamptz,
  error_message text,

  -- Free-form metadata (capabilities list, version, description from server manifest)
  metadata     jsonb NOT NULL DEFAULT '{}',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE(workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS mcp_servers_workspace_id_idx ON mcp_servers (workspace_id);
CREATE INDEX IF NOT EXISTS mcp_servers_status_idx       ON mcp_servers (status);
