/**
 * THE open room-question predicate — "an agent asked the person something in
 * this room and nobody has answered it" — in the lowest package, so the answer
 * loop (`@synap/api` `findOpenQuestion` / `openRoomQuestionConditions`), the
 * needs-you read (`sessionsWithOpenQuestion`) and the reapers (`@synap/jobs`,
 * which cannot import api) read ONE rule.
 *
 * Why the reapers need it: an external agent (a Claude Code routine) asks in
 * the room with `post_message kind:'question'` and then STOPS — its next run
 * starts only when the person answers. A question about no declared slot owes
 * no slot, so `sessionOwesHumanWhere` read that session as idle and the 24h
 * reapers force-failed the run and closed the session with the question still
 * open. A session waiting on the person's answer is quiet by definition, the
 * same W2-calm rule an owed slot already gets.
 *
 * "Open" = a persisted agent message whose `metadata.roomPost.kind` is
 * `'question'` with no `answer` stamp (the answer door stamps it), not deleted.
 */

import { and, eq, isNull, sql as drizzleSql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { messages, MessageAuthorType } from "../schema/messages.js";
import { focusSessions } from "../schema/focus-sessions.js";
import {
  owedSlotExistsIn,
  OPEN_SESSION_STATUSES,
} from "./owed-slot-predicate.js";

/** The `messages.metadata` key a room post's kind / slot / answer live under. */
export const ROOM_POST_META_KEY = "roomPost" as const;

type MessagesTable = typeof messages;

/** The clauses over a `messages` table (or an alias of it). */
export function openRoomQuestionConditions(m: MessagesTable = messages): SQL[] {
  return [
    eq(m.authorType, MessageAuthorType.AI_AGENT),
    isNull(m.deletedAt),
    drizzleSql`${m.metadata}->${ROOM_POST_META_KEY}->>'kind' = 'question'`,
    drizzleSql`NOT ((${m.metadata}->${ROOM_POST_META_KEY}) ? 'answer')`,
  ];
}

/** SQL: the room `channelId` (a correlated column / expression) holds an open agent question. */
export function openRoomQuestionIn(channelId: AnyPgColumn | SQL): SQL {
  // An alias interpolated into a raw template renders as its NAME only, so
  // the FROM names the table explicitly; the alias carries the column refs.
  const q = alias(messages, "open_question");
  return drizzleSql`EXISTS (
    SELECT 1 FROM ${messages} AS ${drizzleSql.identifier("open_question")}
    WHERE ${q.channelId} = ${channelId}
      AND ${and(...openRoomQuestionConditions(q as unknown as MessagesTable))}
  )`;
}

const OPEN_SESSION_SQL_LIST = drizzleSql.raw(
  OPEN_SESSION_STATUSES.map((s) => `'${s}'`).join(", ")
);

/**
 * SQL: the session whose id is `sessionId` is OPEN and waits on the person —
 * it owes them a slot (`sessionOwesHumanWhere`'s rule) OR its room holds an
 * open agent question. The run reaper parks / keeps parked on THIS.
 */
export function sessionWaitsOnPersonWhere(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM focus_sessions waiting
    WHERE waiting.id = ${sessionId}
      AND waiting.status IN (${OPEN_SESSION_SQL_LIST})
      AND (
        ${owedSlotExistsIn(drizzleSql.raw("waiting.expected_outputs"))}
        OR ${openRoomQuestionIn(drizzleSql.raw("waiting.channel_id"))}
      )
  )`;
}

/** SQL over a `focus_sessions` row: it owes a slot OR its room holds an open agent question. */
export function focusSessionWaitsOnPersonWhere(): SQL {
  return drizzleSql`(${owedSlotExistsIn(focusSessions.expectedOutputs)} OR ${openRoomQuestionIn(focusSessions.channelId)})`;
}
