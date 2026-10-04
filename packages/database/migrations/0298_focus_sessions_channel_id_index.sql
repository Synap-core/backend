-- 0298: a plain index on focus_sessions(channel_id).
--
-- 0297's room triggers (`synap_notify_session_room_changed`,
-- `synap_notify_session_turn_event`) look sessions up by
-- `WHERE channel_id = NEW.channel_id` with NO status filter, on every
-- chat_turns insert / status change, every step/error turn event and every AI
-- message pod-wide — inside the writer's transaction. The only channel index
-- was PARTIAL (`idx_focus_sessions_active_channel … WHERE status = 'active'`,
-- 0121), which the planner cannot use for an unfiltered predicate, so each of
-- those writes paid a sequential scan of focus_sessions. The lens read
-- (`lens-containers.ts`, `inArray(focus_sessions.channel_id, …)`) has the same
-- shape.
--
-- Deliberately NOT partial: any predicate on channel_id can use it, with no
-- reliance on the planner proving a WHERE-clause implication. Idempotent.

CREATE INDEX IF NOT EXISTS idx_focus_sessions_channel_id
  ON focus_sessions (channel_id);
