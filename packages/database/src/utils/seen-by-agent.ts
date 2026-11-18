/**
 * THE "SEEN BY THE AGENT" MARK on a person's room message (plan efb315a5,
 * W1): a room shows Sent → Seen once the agent CONSUMED the message — never
 * when it was merely delivered, never on a peek.
 *
 * Stamped by the two moments an agent takes a message in:
 *   - its own stamped wait read it (`waitForSessionChanges` with
 *     `stampReceipt`, an `owner_message` or an answer) — `@synap/api`;
 *   - a pod-run turn started with it as its trigger (the A2AI worker,
 *     `@synap/jobs`, which cannot import api: hence this lowest package).
 * A peek (`stamp: false`, a watcher, an app's read) calls neither.
 *
 * Stored on `messages.metadata` (`seenByAgentAt` ISO, `seenByAgentId` the
 * agent when known), no column: the room read (`GET /threads/:id/messages`)
 * already returns `metadata`. Written ONCE: the first consumption is the mark,
 * a later read never moves it. Only a PERSON's message (`role` user, author
 * human) in that channel is ever stamped; `computeMessageHash` covers (id,
 * content, previousHash) only, so the tamper chain is untouched.
 */

import { and, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import { db } from "../client-pg.js";
import {
  messages,
  MessageAuthorType,
  MessageRole,
} from "../schema/messages.js";

/** `messages.metadata` key of the mark (ISO time). */
export const SEEN_BY_AGENT_AT_META_KEY = "seenByAgentAt" as const;
/** `messages.metadata` key of the agent that consumed it, when known. */
export const SEEN_BY_AGENT_ID_META_KEY = "seenByAgentId" as const;

/**
 * Stamp the mark on these person messages of `channelId` that do not carry
 * it yet. Returns how many were stamped. Throws on a failed write: callers
 * decide (a wait logs it and still answers).
 */
export async function stampMessagesSeenByAgent(p: {
  channelId: string;
  messageIds: readonly string[];
  agentUserId?: string | null;
  now?: Date;
  database?: typeof db;
}): Promise<number> {
  const ids = [...new Set(p.messageIds.filter((id) => !!id))];
  if (ids.length === 0) return 0;
  const database = p.database ?? db;
  const at = (p.now ?? new Date()).toISOString();
  const mark = p.agentUserId
    ? drizzleSql`jsonb_build_object(${SEEN_BY_AGENT_AT_META_KEY}::text, ${at}::text, ${SEEN_BY_AGENT_ID_META_KEY}::text, ${p.agentUserId}::text)`
    : drizzleSql`jsonb_build_object(${SEEN_BY_AGENT_AT_META_KEY}::text, ${at}::text)`;
  const stamped = await database
    .update(messages)
    .set({
      metadata: drizzleSql`COALESCE(${messages.metadata}, '{}'::jsonb) || ${mark}`,
    })
    .where(
      and(
        inArray(messages.id, ids),
        eq(messages.channelId, p.channelId),
        eq(messages.role, MessageRole.USER),
        eq(messages.authorType, MessageAuthorType.HUMAN),
        isNull(messages.deletedAt),
        // The key spelled literally: a bound parameter after `?` reads as a
        // placeholder to some drivers. `SEEN_BY_AGENT_AT_META_KEY` names it.
        drizzleSql`NOT (COALESCE(${messages.metadata}, '{}'::jsonb) ? 'seenByAgentAt')`
      )
    )
    .returning({ id: messages.id });
  return stamped.length;
}
