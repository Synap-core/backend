/**
 * The "ask about it" THREAD on a slot, read back — ONE reader for both doors
 * that need it:
 *
 *   - `askAboutSlot` (idempotency): an unanswered seed about this slot is
 *     already waiting ⇒ return it (and re-trigger its turn) instead of a second
 *     seed. Keyed by the seed's ANCHOR, never by "the room's last message" —
 *     any other message landing in the room between two taps used to defeat
 *     that check and post a second seed.
 *   - `recordOwnerRoomReply` (the answer loop): the person's follow-up inside
 *     such a thread is conversation about the step, never its answer — the
 *     person answers from the step itself.
 *
 * A seed is the person's `role: user` message whose `metadata.anchor` is a
 * `session_slot` anchor (`SessionSlotAnchorSchema`, server-minted only by
 * `askAboutSlot`). It is "answered" once ANY agent message landed in the room
 * after it: a session room is one conversation, and an agent reply after the
 * seed is the turn's reply (agent replies carry no `parent_id` today, so the
 * thread cannot be read more exactly than that).
 *
 * Time comparisons stay IN SQL (a sub-select on the seed's own `timestamp`):
 * a bound JS Date crashes postgres.js 3.4.8 on the pod image
 * (`post-message.ts`).
 */

import {
  db,
  messages,
  MessageAuthorType,
  MessageRole,
  and,
  eq,
  desc,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  SessionSlotAnchorSchema,
  type SessionSlotAnchor,
} from "../../utils/message-anchor.js";
import { normalizeExpectedLabel } from "./expected-label.js";

export interface SlotThreadSeed {
  id: string;
  timestamp: Date;
  content: string;
  anchor: SessionSlotAnchor;
}

/** Bounded: a slot does not collect dozens of ask-about threads. */
const SEED_SCAN_LIMIT = 20;

/**
 * The NEWEST seed the person posted about this slot, or `null`. Reads the
 * anchor with the real schema, so a forged or malformed anchor is not a seed.
 */
export async function findNewestSlotThreadSeed(p: {
  channelId: string;
  sessionId: string;
  label: string;
  userId: string;
}): Promise<SlotThreadSeed | null> {
  const rows = await db
    .select({
      id: messages.id,
      content: messages.content,
      metadata: messages.metadata,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, p.channelId),
        eq(messages.userId, p.userId),
        eq(messages.role, MessageRole.USER),
        isNull(messages.deletedAt),
        drizzleSql`${messages.metadata}->'anchor'->>'kind' = 'session_slot'`,
        drizzleSql`${messages.metadata}->'anchor'->>'sessionId' = ${p.sessionId}`
      )
    )
    .orderBy(desc(messages.timestamp))
    .limit(SEED_SCAN_LIMIT);
  const wanted = normalizeExpectedLabel(p.label);
  for (const row of rows) {
    const anchor = SessionSlotAnchorSchema.safeParse(
      (row.metadata as { anchor?: unknown } | null)?.anchor
    );
    if (!anchor.success) continue;
    if (normalizeExpectedLabel(anchor.data.label) !== wanted) continue;
    return {
      id: row.id,
      timestamp: row.timestamp,
      content: row.content,
      anchor: anchor.data,
    };
  }
  return null;
}

/** Has any agent spoken in the room AFTER this message? */
export async function agentRepliedAfter(
  channelId: string,
  messageId: string
): Promise<boolean> {
  const [reply] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.authorType, MessageAuthorType.AI_AGENT),
        isNull(messages.deletedAt),
        drizzleSql`${messages.timestamp} > (select m.timestamp from messages m where m.id = ${messageId})`
      )
    )
    .limit(1);
  return !!reply;
}
