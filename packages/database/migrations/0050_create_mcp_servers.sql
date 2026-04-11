-- Create mcp_servers table for MCP (Model Context Protocol) server configurations
CREATE TABLE IF NOT EXISTS mcp_servers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    transport text NOT NULL,
    command text,
    args jsonb NOT NULL DEFAULT '[]',
    url text,
    env jsonb NOT NULL DEFAULT '{}',
    enabled boolean NOT NULL DEFAULT true,
    approved boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'unknown',
    last_ping_at timestamptz,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS mcp_servers_workspace_slug_unique ON mcp_servers (workspace_id, slug);
CREATE INDEX IF NOT EXISTS mcp_servers_workspace_id_idx ON mcp_servers (workspace_id);
CREATE INDEX IF NOT EXISTS mcp_servers_status_idx ON mcp_servers (status);
