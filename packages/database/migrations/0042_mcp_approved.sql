-- Add mcp_approved column to intelligence_services
-- Controls whether a service's MCP endpoint can inject tools into LLM requests.
-- Default false — requires explicit approval by workspace owner/admin, or auto-approval
-- via the trusted Hub Protocol provisioning path.
ALTER TABLE intelligence_services
  ADD COLUMN IF NOT EXISTS mcp_approved boolean NOT NULL DEFAULT false;
