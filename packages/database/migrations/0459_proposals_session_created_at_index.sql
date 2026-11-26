-- 0459: an index on proposals(session_id, created_at DESC).
--
-- The needs-you clocks (`needs-you-predicate.ts`: `sessionLastAgentWriteSql`,
-- `sessionLastAgentWorkSql`) ask, once per session row,
--   SELECT max(created_at) FROM proposals
--    WHERE session_id = <the row's id> AND agent_user_id IS NOT NULL
-- in the work graph (`readPageNeedsYou`, `loadSessionLiveness`), the owed
-- door (`listOwedSlots`) and the turn-effect read.
--
-- Postgres answers a lone max() as `ORDER BY created_at DESC LIMIT 1`, and
-- 0288's `idx_proposals_created_at_id` (created_at DESC, id DESC) offers that
-- order. With no index leading with session_id AND ordered by created_at, the
-- planner may walk the WHOLE created_at index newest-first, filtering
-- session_id row by row, and stop at the first match. A session with no agent
-- proposal (an automation run: the GitHub dev-loop automation mints one closed
-- run session per webhook, about 160 an hour on the founder's pod) never
-- matches, so each such row read every proposal. The work graph puts up to
-- 500 such rows in one read (measured 2026-11-26: 229 run nodes, 25 s; the
-- pod-wide graph past the 30 s request guard).
--
-- With session_id first and created_at second, the same max() is one index
-- descent bounded by the session: no rows for that session = no rows read.
-- Plain CREATE INDEX (not CONCURRENTLY: the runner wraps each migration in a
-- transaction). Idempotent.

CREATE INDEX IF NOT EXISTS "idx_proposals_session_created_at"
  ON "proposals" ("session_id", "created_at" DESC);
