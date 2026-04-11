-- Add per-channel MCP server list (opt-in model: null = no MCPs for this channel)
-- Defensive: channels is created by custom/0038_channels_refactor which may sort
-- after this file. Skip gracefully if channels does not yet exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'channels'
  ) THEN
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS mcp_server_ids uuid[];
  END IF;
END;
$$;
