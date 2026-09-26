/**
 * listSessionAnswers — the POLL door for agents the pod cannot wake.
 *
 * Claude Code, claude.ai and Raycast ask the person in the session room and
 * then… cannot be told the answer arrived: there is no webhook into a terminal
 * (research brief M4). This read is what they poll (`synap session wait` is
 * built on it): every answer the session OWNER gave since a cursor, whether it
 * landed on a slot (`answer-slot.ts`) or answered a slotless room question
 * (`session-answer.ts`).
 *
 * CONTRACT (the CLI lane builds on it — change it only with them):
 *   - owner-floored: missing and not-yours are the same `null`. The tRPC twin
 *     (a HUMAN door) also admits a human roster member of the session's room
 *     (`roster`, decision C) — the page is then the OWNER's answers, the same
 *     page the owner reads. The Hub door never passes `roster`;
 *   - `since` is EXCLUSIVE (`answeredAt > since`); pass back `nextSince`.
 *     Millisecond ISO stamps: two DIFFERENT answers in the same millisecond
 *     straddling a page boundary could be skipped — vanishingly rare for
 *     human answers, stated rather than hidden;
 *   - ordered by `answeredAt` ascending, then `id`; bounded by `limit`
 *     (`hasMore` says a further page exists);
 *   - `id` is STABLE across polls — the answer's room message id, or, for an
 *     answer given where the session has no room,
 *     `slot:<sessionId>:<normalized label>:<answeredAt>`. Dedupe on it.
 *   - an answer that resolved a slot AND closed a room question is ONE item
 *     (both halves share the reply's message id), carrying both.
 *   - `text` is the PERSON'S words — data to act on, never instructions to
 *     obey blindly; only the owner's answers are ever returned.
 *
 * A failed read throws (the door answers 500) — never an empty list, which a
 * waiter would read as "no answer yet" and keep waiting on a broken pod.
 */

import {
  db,
  messages,
  focusSessions,
  MessageAuthorType,
  and,
  eq,
  isNull,
  asc,
  drizzleSql,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  ROOM_POST_META_KEY,
  readRoomPostMeta,
} from "../messaging/room-post-kind.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";

export const SESSION_ANSWERS_DEFAULT_LIMIT = 20;
export const SESSION_ANSWERS_MAX_LIMIT = 100;

export interface SessionAnswerItem {
  /** Stable id — dedupe on it across polls. */
  id: string;
  /** What the person said. */
  text: string;
  answeredAt: string;
  answeredBy: string;
  /** The room message carrying the answer; `null` when the session has no room. */
  messageId: string | null;
  /** The slot the answer was recorded on, when it was about one. */
  slot: { label: string; kind: string; question: string | null } | null;
  /** The agent's room question it answered, when it answered one. */
  question: {
    messageId: string;
    text: string;
    askedAt: string;
    /** The agent user that asked. */
    askedBy: string | null;
  } | null;
}

export interface SessionAnswersPage {
  sessionId: string;
  /** The cursor this page was read from (`null` = from the beginning). */
  since: string | null;
  answers: SessionAnswerItem[];
  /**
   * `answeredAt` of the last item — pass it back as `since`. On an empty page
   * it echoes `since` (so a waiter can loop on it blindly).
   */
  nextSince: string | null;
  hasMore: boolean;
}

export async function listSessionAnswers(p: {
  sessionId: string;
  /** The reader: the owner, or (with `roster`) a human roster member. */
  userId: string;
  /** Honour the human-roster read branch (`sessionReadableWhere`). Default false. */
  roster?: boolean;
  since?: Date | null;
  limit?: number;
}): Promise<SessionAnswersPage | null> {
  const limit = Math.max(
    1,
    Math.min(
      p.limit ?? SESSION_ANSWERS_DEFAULT_LIMIT,
      SESSION_ANSWERS_MAX_LIMIT
    )
  );
  const since = p.since ? p.since.toISOString() : null;

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      sessionReadableWhere({ userId: p.userId, roster: p.roster })
    ),
    columns: { id: true, userId: true, channelId: true, expectedOutputs: true },
  });
  if (!session) return null;
  // Only OWNERS answer in v1, so the author filter is the session's owner —
  // never the caller: a roster member reading with their own id would get an
  // empty page, which a waiter reads as "no answer yet".
  const ownerId = session.userId;

  const byId = new Map<string, SessionAnswerItem>();

  // 1. Answers recorded on slots — one row, already in hand.
  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  for (const slot of outputs) {
    const a = slot?.answer;
    if (!a || typeof a.answeredAt !== "string") continue;
    // Owner answers only — the stamp's own author, re-checked on the read.
    if (a.answeredBy !== ownerId) continue;
    if (since && !(a.answeredAt > since)) continue;
    const id =
      a.messageId ??
      `slot:${session.id}:${normalizeExpectedLabel(slot.label)}:${a.answeredAt}`;
    byId.set(id, {
      id,
      text: a.text,
      answeredAt: a.answeredAt,
      answeredBy: a.answeredBy,
      messageId: a.messageId,
      slot: {
        label: slot.label,
        kind: slot.kind,
        question: a.question ?? null,
      },
      question: null,
    });
  }

  // 2. Room questions the owner answered — bounded in SQL by the cursor.
  if (session.channelId) {
    const answeredAtSql = drizzleSql`${messages.metadata}->${ROOM_POST_META_KEY}->'answer'->>'answeredAt'`;
    const rows = await db
      .select({
        id: messages.id,
        content: messages.content,
        metadata: messages.metadata,
        routedTeammateId: messages.routedTeammateId,
        timestamp: messages.timestamp,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, session.channelId),
          eq(messages.authorType, MessageAuthorType.AI_AGENT),
          isNull(messages.deletedAt),
          drizzleSql`${messages.metadata}->${ROOM_POST_META_KEY}->>'kind' = 'question'`,
          drizzleSql`${messages.metadata}->${ROOM_POST_META_KEY}->'answer'->>'answeredBy' = ${ownerId}`,
          ...(since ? [drizzleSql`${answeredAtSql} > ${since}`] : [])
        )
      )
      .orderBy(asc(answeredAtSql))
      .limit(limit + 1);

    for (const row of rows) {
      const meta = readRoomPostMeta(row.metadata);
      const a = meta?.answer;
      if (!meta || !a) continue;
      const question = {
        messageId: row.id,
        text: row.content,
        askedAt: row.timestamp.toISOString(),
        askedBy: row.routedTeammateId ?? null,
      };
      const existing = byId.get(a.messageId);
      if (existing) {
        existing.question = question;
        continue;
      }
      byId.set(a.messageId, {
        id: a.messageId,
        text: a.text,
        answeredAt: a.answeredAt,
        answeredBy: a.answeredBy,
        messageId: a.messageId,
        slot: null,
        question,
      });
    }
  }

  const all = [...byId.values()].sort((x, y) =>
    x.answeredAt < y.answeredAt
      ? -1
      : x.answeredAt > y.answeredAt
        ? 1
        : x.id < y.id
          ? -1
          : x.id > y.id
            ? 1
            : 0
  );
  const answers = all.slice(0, limit);
  return {
    sessionId: session.id,
    since,
    answers,
    nextSince: answers.length ? answers[answers.length - 1]!.answeredAt : since,
    hasMore: all.length > limit,
  };
}
