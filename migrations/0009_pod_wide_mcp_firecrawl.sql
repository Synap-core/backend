-- Migration 0009: Pod-wide MCP server support + Firecrawl seed
--
-- 1. Drops the NOT NULL constraint on workspace_id so servers can be
--    workspace-scoped (not null) OR pod-wide (null).
-- 2. Seeds a pod-wide Firecrawl server pointing at the Docker service.
--    The Firecrawl container runs on port 3002 in the Docker network.
--    The Hub resolves MCP servers where workspaceId IS NULL (pod-wide)
--    as well as workspace-scoped entries.

ALTER TABLE mcp_servers
  ALTER COLUMN workspace_id DROP NOT NULL;

-- Seed pod-wide Firecrawl MCP server (idempotent).
-- This entry is pod-wide (workspace_id = null), pre-approved, and enabled.
INSERT INTO mcp_servers (
  slug,
  name,
  description,
  transport,
  command,
  args,
  env,
  enabled,
  approved,
  status
)
VALUES (
  'firecrawl',
  'Firecrawl',
  'Web scraping and content extraction via the local Firecrawl container.',
  'stdio',
  'npx',
  '[-y, firecrawl-mcp@latest]'::jsonb,
  '{"FIRECRAWL_API_URL": "http://eve-firecrawl:3002"}'::jsonb,
  true,
  true,
  'unknown'
)
ON CONFLICT DO NOTHING;
