-- 0297: live session ACTIVITY — the activity ledger NOTIFYs too.
--
-- 0277 made every write to a session ROW push `focus_session:updated`. But a
-- session's activity (what the session page's Activity block and Now line
-- read, `loadSessionActivity`) lives in OTHER tables, and none of them touch
-- the session row: an agent's governed write (`events.session_id`), a
-- proposal filed or decided under the session, an IS turn starting / stepping
-- / ending in the session's room, an agent note posted there. So the page only
-- moved on its poll. Founder decision D2 (2026-10-04): live updates come from
-- the POD's realtime stream — this extends the SAME channel, the SAME listener
-- and the SAME audience (the session's readers, id-only) to those tables.
--
-- Channel `focus_session_changed`, payload = the session id ONLY (0277's
-- contract). Bursts (a turn's steps) are folded per transaction by Postgres
-- and per window by the listener's coalescer.
--
-- Deliberately NOT fired:
--   - chat_turns UPDATEs other than `status`: every streamed frame bumps
--     `last_event_seq`/`updated_at`; only start (INSERT) and finish (status)
--     are activity. A turn's tool steps arrive through chat_turn_events.
--   - chat_turn_events other than `step` / `error` (token deltas etc.).
--   - human messages: the activity ledger records agent notes only.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

-- A row keyed by its room (chat_turns, messages) → every session in that room.
CREATE OR REPLACE FUNCTION synap_notify_session_room_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sid uuid;
BEGIN
  FOR sid IN
    SELECT id FROM focus_sessions WHERE channel_id = NEW.channel_id
  LOOP
    PERFORM pg_notify('focus_session_changed', sid::text);
  END LOOP;
  RETURN NULL;
END;
$$;

-- A turn's step / error frame → the sessions in the turn's room.
CREATE OR REPLACE FUNCTION synap_notify_session_turn_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sid uuid;
BEGIN
  FOR sid IN
    SELECT fs.id
      FROM chat_turns t
      JOIN focus_sessions fs ON fs.channel_id = t.channel_id
     WHERE t.id = NEW.turn_id
  LOOP
    PERFORM pg_notify('focus_session_changed', sid::text);
  END LOOP;
  RETURN NULL;
END;
$$;

-- events / proposals carry session_id: 0277's ledger function applies as is.
DROP TRIGGER IF EXISTS trg_events_session_activity_notify ON events;
CREATE TRIGGER trg_events_session_activity_notify
  AFTER INSERT ON events
  FOR EACH ROW
  WHEN (NEW.session_id IS NOT NULL)
  EXECUTE FUNCTION synap_notify_session_ledger_changed();

DROP TRIGGER IF EXISTS trg_proposals_session_activity_notify ON proposals;
CREATE TRIGGER trg_proposals_session_activity_notify
  AFTER INSERT OR UPDATE OF status ON proposals
  FOR EACH ROW
  WHEN (NEW.session_id IS NOT NULL)
  EXECUTE FUNCTION synap_notify_session_ledger_changed();

DROP TRIGGER IF EXISTS trg_chat_turns_session_activity_notify ON chat_turns;
CREATE TRIGGER trg_chat_turns_session_activity_notify
  AFTER INSERT OR UPDATE OF status ON chat_turns
  FOR EACH ROW
  EXECUTE FUNCTION synap_notify_session_room_changed();

DROP TRIGGER IF EXISTS trg_chat_turn_events_session_activity_notify ON chat_turn_events;
CREATE TRIGGER trg_chat_turn_events_session_activity_notify
  AFTER INSERT ON chat_turn_events
  FOR EACH ROW
  WHEN (NEW.type IN ('step', 'error'))
  EXECUTE FUNCTION synap_notify_session_turn_event();

DROP TRIGGER IF EXISTS trg_messages_session_activity_notify ON messages;
CREATE TRIGGER trg_messages_session_activity_notify
  AFTER INSERT ON messages
  FOR EACH ROW
  WHEN (NEW.author_type = 'ai_agent')
  EXECUTE FUNCTION synap_notify_session_room_changed();
