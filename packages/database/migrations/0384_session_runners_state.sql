-- 0384 — a runner says what it is doing (plan 5513a09a P3.1 / D5, finding
-- 821d25af): busy, idle, needs_permission or ended, on its session_runners row.
--
-- Any harness adapter names it on any key-auth call (MCP or Hub REST) with
-- `X-Synap-Runner-State: <state>` (MCP clients that cannot set headers:
-- `_meta["live.synap/runnerState"]`), beside the conversation and process
-- headers that already name the runner. The pod records it on the runner rows
-- of that conversation's process (`services/focus-sessions/session-runners.ts`):
-- the wait's own stamp, and every other call whose state differs.
--
--   state              what the runner last said; NULL = its client names none
--   state_since        when it entered that state
--   state_reported_at  when the pod heard the newest report — the order key, so a
--                      long wait's re-stamp never overwrites a fresher state
--
-- The index serves the non-wait write: it finds a conversation's process rows
-- by client key, not by session.
--
-- Telemetry like last_seen_at: no governance, no NOTIFY (no trigger here, and
-- the focus_sessions row is never written — 0277's trigger would wake the wait).
--
-- Fresh installs get all of this from 0000_baseline_schema.sql.

ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "state_since" timestamptz;
ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "state_reported_at" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_session_runners_client"
  ON "session_runners" ("client_key", "process_key");
