-- 0231_events_proposal_id_column.sql
--
-- Instrument the events spine for the "ungoverned AI write" blind spot.
--
-- Semantic: an AGENT write that went through a proposal — whether auto-approved
-- (an AUTO_APPROVED `proposals` row) or pending→approved — stamps that proposal's
-- id here. A write that executed with NO proposal at all leaves it NULL. So an
-- "ungoverned AI write" (an agent write that never touched governance) is:
--
--   is_agent = true AND proposal_id IS NULL   (on the executed `.completed` event)
--
-- NO hard FK: events are append-only immutable history and a proposal row is
-- deletable — a FK could block an event append or a proposal delete. Plain
-- nullable uuid, mirroring how correlation_id / agent_user_id are kept FK-free.
--
-- events is a TimescaleDB hypertable with columnstore compression: ADD COLUMN
-- with a NON-constant default is unsupported on a compressed hypertable, but a
-- nullable column with NO default IS supported (same as the 0131 / 0223 columns).

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "proposal_id" uuid;

-- Partial index for the blind-spot query: "list agent writes that never went
-- through a proposal". Only un-stamped agent rows are indexed, so it stays small.
CREATE INDEX IF NOT EXISTS "idx_events_ungoverned_agent"
  ON "events" ("agent_user_id", "timestamp")
  WHERE "is_agent" = true AND "proposal_id" IS NULL;
