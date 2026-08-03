-- 0223_events_workspace_id_column.sql
-- Promote workspace context to a REAL column on the events table.
--
-- Until now the workspace a given event belongs to lived only inside the `data`
-- JSONB (`data->>'workspaceId'`), which readers had to string-match. This adds a
-- first-class, indexable `workspace_id` column so workspace-scoped event reads
-- (searchEvents / listAgentRuns / countEvents) can key on a column.
--
-- Type is `text` (matches `proposals.workspace_id`, NOT uuid).
--
-- The events table is a TimescaleDB hypertable. ADD COLUMN with a *non-constant*
-- default is unsupported on a compressed hypertable; a nullable column with NO
-- default IS supported (direct precedent: 0131_agent_run_observability.sql). The
-- statement is guarded with IF NOT EXISTS so it is safe to re-run and safe on a
-- fresh install.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "workspace_id" text;

-- Partial index so only workspace-scoped rows are indexed.
CREATE INDEX IF NOT EXISTS "idx_events_workspace_id"
  ON "events" ("workspace_id")
  WHERE "workspace_id" IS NOT NULL;

-- BEST-EFFORT backfill from the JSONB. Compressed hypertable chunks may reject
-- the UPDATE — so the whole thing is wrapped to be NON-FATAL: a failure raises a
-- NOTICE and the migration continues (readers COALESCE the column with the JSONB,
-- so un-backfilled rows still resolve their workspace).
DO $$
BEGIN
  UPDATE events
     SET workspace_id = data->>'workspaceId'
   WHERE workspace_id IS NULL
     AND data ? 'workspaceId'
     AND data->>'workspaceId' IS NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'events.workspace_id backfill skipped (non-fatal): %', SQLERRM;
END $$;
