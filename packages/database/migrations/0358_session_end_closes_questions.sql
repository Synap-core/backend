-- 0358 — a session that ended stops asking (Resolve-XP W2, founder default 3)
--
-- From now on the close door (`completeFocusSession`, api) does two things at
-- every exit, in the transaction that stamps the terminal status:
--   1. every agent question still open in the session's room gets
--      `metadata.roomPost.closed = {reason: 'session_ended', at}` — closed,
--      never deleted (`closeOpenRoomQuestions`, @synap/database);
--   2. every owed slot whose ask is the AGENT's need (`confirm` / `choose`,
--      read through `effectiveSlotAsk`: a `decision` slot with no ask IS a
--      confirm) is stamped `retiredAt` + `retiredReason: 'session_ended'`.
--      `act` / `provide` / `form` asks and slots with no ask stay owed.
--
-- This migration applies the same two stamps to sessions that ENDED BEFORE the
-- rule existed, so their questions and asks leave needs-you the way a session
-- closed today does. `at` is the session's `closed_at` (now() when absent),
-- written in the ISO-8601 UTC shape the door writes (`toISOString()`).
--
-- The predicates spell the door's rules:
--   - open question = `openRoomQuestionConditions` (open-room-question.ts):
--     an ai_agent message, not deleted, roomPost kind 'question', no `answer`,
--     no `closed`. A room some OPEN session still uses is left alone.
--   - owed slot = `OWED_SLOT_CLAUSES` (owed-slot-predicate.ts).
--   - session-bound ask = `slotEndsWithSession` (api owed-outputs.ts) over
--     `deriveDecisionAsk` (@synap-core/types/ask): an explicit confirm/choose,
--     or no ask on a human `decision` slot that is not a playbook param.
--
-- Idempotent: a second run finds nothing open and nothing owed to stamp.

UPDATE "messages" AS m
SET "metadata" = jsonb_set(
  m."metadata",
  '{roomPost,closed}',
  jsonb_build_object(
    'reason', 'session_ended',
    'at', to_char(coalesce(fs."closed_at", now()) AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  true
)
FROM "focus_sessions" AS fs
WHERE fs."channel_id" = m."channel_id"
  AND fs."status" IN ('closed', 'cancelled', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM "focus_sessions" AS live
    WHERE live."channel_id" = m."channel_id"
      AND live."status" NOT IN ('closed', 'cancelled', 'failed')
  )
  AND m."author_type" = 'ai_agent'
  AND m."deleted_at" IS NULL
  AND m."metadata"->'roomPost'->>'kind' = 'question'
  AND NOT ((m."metadata"->'roomPost') ? 'answer')
  AND NOT ((m."metadata"->'roomPost') ? 'closed');

UPDATE "focus_sessions" AS fs
SET "expected_outputs" = (
  SELECT jsonb_agg(
    CASE
      WHEN slot->>'owner' = 'human'
        AND slot->>'status' IS DISTINCT FROM 'done'
        AND slot->>'retiredAt' IS NULL
        AND slot->>'optional' IS DISTINCT FROM 'true'
        AND (
          slot->'ask'->>'mode' IN ('confirm', 'choose')
          OR (
            (slot->'ask' IS NULL OR slot->'ask' = 'null'::jsonb)
            AND slot->>'blockedReason' = 'decision'
            AND slot->>'kind' IS DISTINCT FROM 'playbook_param'
          )
        )
      THEN slot || jsonb_build_object(
        'retiredAt', to_char(coalesce(fs."closed_at", now()) AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'retiredReason', 'session_ended'
      )
      ELSE slot
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(fs."expected_outputs") WITH ORDINALITY AS t(slot, ord)
)
WHERE fs."status" IN ('closed', 'cancelled', 'failed')
  AND jsonb_typeof(fs."expected_outputs") = 'array'
  AND fs."expected_outputs" @> '[{"owner": "human"}]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(fs."expected_outputs") AS slot
    WHERE slot->>'owner' = 'human'
      AND slot->>'status' IS DISTINCT FROM 'done'
      AND slot->>'retiredAt' IS NULL
      AND slot->>'optional' IS DISTINCT FROM 'true'
      AND (
        slot->'ask'->>'mode' IN ('confirm', 'choose')
        OR (
          (slot->'ask' IS NULL OR slot->'ask' = 'null'::jsonb)
          AND slot->>'blockedReason' = 'decision'
          AND slot->>'kind' IS DISTINCT FROM 'playbook_param'
        )
      )
  );
