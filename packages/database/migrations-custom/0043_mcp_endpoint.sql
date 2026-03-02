-- Add mcp_endpoint column to intelligence_services
-- Stores the MCP server URL exposed by a registered service (e.g., OpenClaw).
-- When populated AND mcp_approved = true, the endpoint is injected into LLM
-- requests for this workspace, making the service's tools available to agents.
ALTER TABLE intelligence_services
  ADD COLUMN IF NOT EXISTS mcp_endpoint text;
