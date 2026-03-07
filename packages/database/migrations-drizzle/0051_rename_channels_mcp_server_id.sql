-- Rename mcp_server_ids to mcp_server_id to match Drizzle schema
-- Drizzle defines: uuid("mcp_server_id").array()
-- DB has: mcp_server_ids uuid[]
ALTER TABLE channels RENAME COLUMN mcp_server_ids TO mcp_server_id;
