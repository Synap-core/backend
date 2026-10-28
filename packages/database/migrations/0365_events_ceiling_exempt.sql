-- 0365 — events.ceiling_exempt (founder F2, 2026-10-27).
--
-- An agent's bookkeeping of its OWN focus session (starting it, updating it,
-- claiming or completing an outcome, a write on its own room) is required by
-- the work rules and touches nothing but that session. It still goes through
-- every governance rung, but it no longer spends the agent's daily write
-- ceiling (rung 2.56). The writer (`auditLog`) proves "own" from the session
-- row (`isOwnSessionBookkeeping`) and stamps TRUE here; the daily count
-- (`countAgentWritesTodayUtc`) adds `ceiling_exempt IS NOT TRUE`.
--
-- events is a TimescaleDB hypertable with columnstore compression: a nullable
-- column with NO default is supported (same as 0131 / 0223 / 0231 / 0310).
-- NULL = counted, so every existing row keeps its meaning and a rollback onto
-- this schema is safe.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "ceiling_exempt" boolean;
