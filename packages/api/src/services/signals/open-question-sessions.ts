/**
 * Which of these sessions have an OPEN agent question in their room — the
 * live-state read behind a `"session-pointer"` notification
 * (`session.needs_you`) in the needs-you union (`needs-you-union.ts`
 * `dedupeNotifications`).
 *
 * "Open" is the answer loop's ONE predicate, `openRoomQuestionConditions()`
 * (`focus-sessions/session-answer.ts`), the same conditions `findOpenQuestion`
 * reads. It is composed here, never restated. The room is the session's
 * `channel_id`.
 *
 * It returns ids only, never message content, and only for session ids the
 * caller already holds from their OWN notification rows (the notif-center user
 * floor). It exposes nothing the caller could not already read.
 */
import { db, messages, focusSessions, and, eq, inArray } from "@synap/database";
import { openRoomQuestionConditions } from "../focus-sessions/session-answer.js";

export async function sessionsWithOpenQuestion(
  sessionIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ sessionId: focusSessions.id })
    .from(focusSessions)
    .innerJoin(messages, eq(messages.channelId, focusSessions.channelId))
    .where(
      and(inArray(focusSessions.id, ids), ...openRoomQuestionConditions())
    );
  return new Set(rows.map((r) => r.sessionId));
}
