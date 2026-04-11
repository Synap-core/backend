-- Rename mcp_server_ids → mcp_server_id to match Drizzle schema.
-- Defensive: only rename if the old column name still exists. On fresh pods
-- where 0037 was skipped (channels didn't exist yet), this column is absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'channels'
      AND column_name  = 'mcp_server_ids'
  ) THEN
    ALTER TABLE channels RENAME COLUMN mcp_server_ids TO mcp_server_id;
  END IF;
END;
$$;
