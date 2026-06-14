-- 0131_agent_run_observability.sql
-- "Watch your agent work" — Phase 0 + Phase 1.
--
-- Adds first-class telemetry columns to the events table so an agentRun event
-- (and any agent-authored .completed event) carries authorship + cost/usage as
-- REAL COLUMNS (not buried in JSONB). cost_usd is NULL when the provider does
-- not report a price — honest-by-design, never a fabricated 0.
--
-- The events table is a TimescaleDB hypertable. ADD COLUMN with a *non-constant*
-- default is unsupported on a compressed hypertable; every column below is
-- nullable with NO default, which IS supported. All statements are guarded with
-- IF NOT EXISTS so this is safe to re-run and safe on fresh installs.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "is_agent"      boolean;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "agent_type"    text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "model"         text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "provider"      text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "cost_usd"      numeric(12,6);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "tokens_in"     integer;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "tokens_out"    integer;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "tokens_total"  integer;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "latency_ms"    integer;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "tool_count"    integer;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "run_status"    text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "finish_reason" text;

-- Fast "all runs by this agent" lookups; partial so it only indexes agent rows.
CREATE INDEX IF NOT EXISTS "events_agent_user_id_idx"
  ON "events" ("agent_user_id")
  WHERE "agent_user_id" IS NOT NULL;
