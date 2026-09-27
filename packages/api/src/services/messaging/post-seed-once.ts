/**
 * postSeedOnce — post a "please help with this" seed into a channel at most
 * once per unanswered ask, the half that "Ask AI" doors share.
 *
 * Two doors open a conversation with an agent on the person's behalf:
 * `proposals.askAi` (a failed proposal's thread) and `focusSessions.askAboutSlot`
 * (a thread about one slot, in the session room). Both need the same
 * guarantee: a double-tap must produce ONE seed and ONE turn.
 *
 * READ-THEN-WRITE IS A RACE, closed by the WRITE, not by a lock: the latest
 * message is read on the ambient `db`, and the post carries an
 * `idempotencyKey` that NAMES the message the decision was made against
 * (`<scope>:<latest id | "empty">`). Two concurrent taps derive the SAME
 * deterministic message id; `postChannelMessage`'s `ON CONFLICT DO NOTHING`
 * lets exactly one insert, and the loser gets `duplicate-ignored`. A lock
 * held across `postChannelMessage` deadlocks the pool — see `ask-ai.ts`.
 *
 * It never starts the turn: each door calls `triggerAutoRespond` (the ONE
 * turn door) itself, only when `seeded` is true.
 */

import { db, eq, desc } from "@synap/database";
import { messages } from "@synap/database/schema";
import { postChannelMessage } from "./post-message.js";

export interface SeedLatestMessage {
  id: string;
  role: string | null;
  content: string | null;
  metadata: unknown;
}

export type PostSeedOnceResult =
  | { seeded: true; messageId: string }
  | {
      seeded: false;
      /**
       * `pending` — an unanswered seed for this ask is already the channel's
       * last message; `duplicate` — a concurrent tap won the insert.
       */
      reason: "pending" | "duplicate";
      /** The waiting / winning seed. */
      messageId: string;
    };

export async function postSeedOnce(params: {
  channelId: string;
  /** The person asking — the seed is posted as them, role `user`. */
  userId: string;
  content: string;
  /** Names this seed family; the key is `<scope>:<latest id | "empty">`. */
  idempotencyScope: string;
  /** Is the channel's LAST message this door's own, still-unanswered seed? */
  isPendingSeed: (latest: SeedLatestMessage) => boolean;
  /** A thread root's anchor (`messages.metadata.anchor`), when the seed has one. */
  comment?: { anchor: Record<string, unknown> };
}): Promise<PostSeedOnceResult> {
  const [latest] = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(eq(messages.channelId, params.channelId))
    // `messages` has NO `createdAt`: its clock column is `timestamp`.
    .orderBy(desc(messages.timestamp))
    .limit(1);

  if (latest && params.isPendingSeed(latest)) {
    return { seeded: false, reason: "pending", messageId: latest.id };
  }

  const posted = await postChannelMessage({
    channelId: params.channelId,
    content: params.content,
    role: "user",
    userId: params.userId,
    idempotencyKey: `${params.idempotencyScope}:${latest?.id ?? "empty"}`,
    // NOT `triggerAI` — that path starts an orchestrator turn with no
    // context. The door starts the turn through `triggerAutoRespond`.
    triggerAI: false,
    ...(params.comment ? { comment: params.comment } : {}),
  });
  if (posted.ackState === "duplicate-ignored") {
    return { seeded: false, reason: "duplicate", messageId: posted.messageId };
  }
  return { seeded: true, messageId: posted.messageId };
}
