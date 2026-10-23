-- 0341: the session OWNER's room message wakes the session channel at once.
--
-- 0297 made the session's activity ledger NOTIFY `focus_session_changed` and
-- deliberately left human messages out (the activity ledger records agent
-- notes only). The session change feed (`waitForSessionChanges`,
-- `synap_wait_for_answer` with `events`) reports one human message kind —
-- `owner_message`, a message the session's OWNER wrote in the session's room —
-- and without a NOTIFY a waiter only saw it on its 5 s fallback poll.
--
-- Narrow on purpose, the SAME predicate the feed applies on the read:
--   - role 'user' AND author_type 'human' — a person typing. NOT the pod's own
--     recall notices (role 'assistant' + author_type 'human'), NOT agent posts
--     (0297 already notifies those);
--   - only the sessions whose OWNER wrote it (`fs.user_id = NEW.user_id`): a
--     teammate's message in a shared room wakes nothing.
-- Same channel, same id-only payload as 0277/0297 (the listener's contract).
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION synap_notify_session_owner_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sid uuid;
BEGIN
  FOR sid IN
    SELECT id FROM focus_sessions
     WHERE channel_id = NEW.channel_id
       AND user_id = NEW.user_id
  LOOP
    PERFORM pg_notify('focus_session_changed', sid::text);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_session_owner_message_notify ON messages;
CREATE TRIGGER trg_messages_session_owner_message_notify
  AFTER INSERT ON messages
  FOR EACH ROW
  WHEN (NEW.author_type = 'human' AND NEW.role = 'user')
  EXECUTE FUNCTION synap_notify_session_owner_message();
