-- Add MCP server endpoint to intelligence_services
-- Allows ZeroClaw/OpenClaw services to expose their local tools via MCP to the Intelligence Hub

ALTER TABLE intelligence_services
ADD COLUMN IF NOT EXISTS mcp_endpoint TEXT;

COMMENT ON COLUMN intelligence_services.mcp_endpoint IS
'Optional MCP server URL exposed by this intelligence service. When set, the Intelligence Hub will register this as an MCP server for the workspace, giving agents access to the service''s local tools (shell, browser, filesystem, messaging channels, etc.) via the Model Context Protocol.';
