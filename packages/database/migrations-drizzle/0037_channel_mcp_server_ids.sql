-- Add per-channel MCP server list (opt-in model: null = no MCPs for this channel)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS mcp_server_ids uuid[];
