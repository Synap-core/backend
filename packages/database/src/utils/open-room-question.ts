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
 * `'question'` with no `answer` stamp (the answer door stamps it) and no
 * `closed` stamp (its session ended, or its agent withdrew it), not deleted.
 */

import { and, eq, inArray, isNull, sql as drizzleSql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { QuestionClosed } from "@synap-core/types/ask";
import type { db } from "../client-pg.js";
import { messages, MessageAuthorType } from "../schema/messages.js";
import { focusSessions } from "../schema/focus-sessions.js";
import {
  owedSlotExistsIn,
  OPEN_SESSION_STATUSES,
} from "./owed-slot-predicate.js";
import { awaitedGatePendingIn } from "./awaited-gate-wait.js";

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
    // A closed question is not waiting on anyone: it leaves needs-you, the
    // answer loop no longer reads a reply as its answer, and the reapers no
    // longer hold its session for it (Resolve-XP W2).
    drizzleSql`NOT ((${m.metadata}->${ROOM_POST_META_KEY}) ? 'closed')`,
  ];
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Stamp `roomPost.closed` on the OPEN agent questions of one room — the ONE
 * writer of that stamp (a session that ends, an agent that withdraws). One
 * UPDATE through the predicate above, so a question is closed at most once
 * and never after it was answered: an answer that got there first wins, the
 * order `questionDisposition` (`@synap-core/types/ask`) reads.
 *
 * `messageIds` narrows it to those questions; `askedBy` to the questions that
 * agent asked (`routed_teammate_id`, stamped by the post door). Returns the ids
 * it closed; empty = nothing named was still open. Hash-safe:
 * `computeMessageHash` covers (id, content) only.
 */
export async function closeOpenRoomQuestions(
  executor: typeof db | DbTx,
  p: {
    channelId: string;
    messageIds?: readonly string[];
    askedBy?: string;
    closed: QuestionClosed;
  }
): Promise<string[]> {
  if (p.messageIds && p.messageIds.length === 0) return [];
  const rows = await executor
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(${messages.metadata}, ${`{${ROOM_POST_META_KEY},closed}`}::text[], ${JSON.stringify(p.closed)}::jsonb, true)`,
    })
    .where(
      and(
        eq(messages.channelId, p.channelId),
        ...(p.messageIds ? [inArray(messages.id, [...p.messageIds])] : []),
        ...(p.askedBy ? [eq(messages.routedTeammateId, p.askedBy)] : []),
        ...openRoomQuestionConditions()
      )
    )
    .returning({ id: messages.id });
  return rows.map((r) => r.id);
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
 * it owes them a slot (`sessionOwesHumanWhere`'s rule), its room holds an
 * open agent question, OR it waits on its pending plan/deploy gate
 * (`awaitedGatePendingIn`). The run reaper parks / keeps parked on THIS.
 */
export function sessionWaitsOnPersonWhere(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM focus_sessions waiting
    WHERE waiting.id = ${sessionId}
      AND waiting.status IN (${OPEN_SESSION_SQL_LIST})
      AND (
        ${owedSlotExistsIn(drizzleSql.raw("waiting.expected_outputs"))}
        OR ${openRoomQuestionIn(drizzleSql.raw("waiting.channel_id"))}
        OR ${awaitedGatePendingIn(drizzleSql.raw("waiting.id"))}
      )
  )`;
}

/** SQL over a `focus_sessions` row: the same three arms as {@link sessionWaitsOnPersonWhere}. */
export function focusSessionWaitsOnPersonWhere(): SQL {
  return drizzleSql`(${owedSlotExistsIn(focusSessions.expectedOutputs)} OR ${openRoomQuestionIn(focusSessions.channelId)} OR ${awaitedGatePendingIn(focusSessions.id)})`;
}
