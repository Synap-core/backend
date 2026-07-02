-- Per-automation persistent state (watermark/cursor).
--
-- A feed automation can read {{automation.state.<key>}} at trigger time and
-- write it back via an explicit `output` node (outputType "set_state") to do
-- "only new since last run". Author-controlled — never written automatically.
-- Concurrent runs last-writer-merge via jsonb `||` (documented; acceptable).
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "state" jsonb NOT NULL DEFAULT '{}'::jsonb;
