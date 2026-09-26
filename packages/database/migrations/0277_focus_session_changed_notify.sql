-- 0277: live session updates — every write to a session NOTIFYs.
--
-- `focus_session:updated` used to be emitted by hand from 4 of the ~41 code
-- paths that write `focus_sessions`; every other writer (services, jobs, raw
-- SQL) left open session pages stale until their poll. A row trigger catches
-- EVERY writer by construction — a new writer joins by existing, no list to
-- maintain (founder decision B, 2026-09-25).
--
-- Channel `focus_session_changed`, payload = the session id ONLY (never goal,
-- title or any content: NOTIFY payloads are visible to every LISTENer on the
-- database). The ONE consumer is the api process's listener
-- (`packages/api/src/utils/session-changed-listener.ts`), which coalesces per
-- id, resolves the audience (owner + human roster of the session's room) and
-- emits `focus_session:updated` to their `user:` rooms.
--
-- Delivery semantics (Postgres): NOTIFY is sent at COMMIT (a rolled-back write
-- notifies nobody), and identical (channel, payload) pairs inside one
-- transaction are folded into one. A notification is lost if no listener is
-- connected — polling stays the floor.
--
-- Also fired from `session_evaluations` (keyed by session_id): a criterion
-- verdict changes the session page without touching the session row.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION synap_notify_focus_session_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('focus_session_changed', OLD.id::text);
  ELSE
    PERFORM pg_notify('focus_session_changed', NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION synap_notify_session_ledger_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('focus_session_changed', OLD.session_id::text);
  ELSE
    PERFORM pg_notify('focus_session_changed', NEW.session_id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_focus_sessions_changed_notify ON focus_sessions;
CREATE TRIGGER trg_focus_sessions_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON focus_sessions
  FOR EACH ROW
  EXECUTE FUNCTION synap_notify_focus_session_changed();

DROP TRIGGER IF EXISTS trg_session_evaluations_changed_notify ON session_evaluations;
CREATE TRIGGER trg_session_evaluations_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON session_evaluations
  FOR EACH ROW
  EXECUTE FUNCTION synap_notify_session_ledger_changed();
