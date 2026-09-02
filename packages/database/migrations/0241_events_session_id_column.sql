-- 0241_events_session_id_column.sql
--
-- The TEMPORAL half of the why-spine: which focus session produced this event.
--
-- `events` already answers "what happened to object X" (idx_events_subject),
-- "which agent" (agent_user_id, 0131), "which workspace" (workspace_id, 0223)
-- and "which proposal" (proposal_id, 0231). It could NOT answer "which
-- SESSION" — the goal-bound unit of work that is the only thing on the spine
-- that carries an INTENT. `recordDomainMutation` has had the session id in
-- scope all along and handed it only to the automation matcher
-- (`emitSideEffects`), never to the event row.
--
-- With this column, "why does this entity look like this" resolves in one
-- indexed query per object: events by subject → their sessions → those
-- sessions' goals.
--
-- NO hard FK, for the same reason proposal_id has none (0231): events are
-- append-only immutable history and a focus_sessions row is deletable — a FK
-- could block an event append or a session delete. Plain nullable uuid,
-- mirroring correlation_id / proposal_id / agent_user_id.
--
-- events is a TimescaleDB hypertable with columnstore compression: ADD COLUMN
-- with a NON-constant default is unsupported on a compressed hypertable, but a
-- nullable column with NO default IS supported (same as 0131 / 0223 / 0231).

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "session_id" uuid;

-- "Everything that happened in this session, in order" — the session-detail
-- activity feed and the why-pane's session grouping. Partial so only
-- session-attributed rows are indexed (most events carry no session).
CREATE INDEX IF NOT EXISTS "idx_events_session_id"
  ON "events" ("session_id", "timestamp")
  WHERE "session_id" IS NOT NULL;
