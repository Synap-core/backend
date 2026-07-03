/**
 * persistAssistantReply — the ONE writer for an AI assistant reply in a channel.
 *
 * Both real agent-turn paths persist an assistant message with the same
 * hash-chain: `previousHash = sha256(userMessageId + triggerContent)` and
 * `hash = sha256(assistantId + content + previousHash)`. That chain was
 * copy-pasted in `channels.sendMessage` (interactive) and the
 * `a2ai-response-trigger` worker (headless); this collapses the two into one
 * function so the chain can never drift.
 *
 * It performs only the DB write (insert + `channels.updatedAt` bump). It does
 * NOT emit the realtime event (`emitChatEvent` lives in `@synap/api`) — the
 * interactive caller broadcasts separately; headless callers rely on the
 * channel-room subscription. Returns the generated id + hashes so callers can
 * build their own downstream events (e.g. the CHAT_MESSAGE broadcast).
 */

import { createHash, randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import {
  messages,
  channels,
  MessageRole,
  MessageAuthorType,
  type RoutedSource,
} from "../schema/index.js";

export interface PersistAssistantReplyParams {
  channelId: string;
  /** Id of the message that triggered this reply (its user/trigger message). */
  userMessageId: string;
  /** Content of that triggering message — the prevHash input. */
  triggerContent: string;
  /** The assistant's reply text. */
  content: string;
  /** Author identity to stamp on the row. */
  userId: string;
  /** Provenance metadata (aiSteps + service/agent ids, or the a2ai marker). */
  metadata: Record<string, unknown>;
  /** IS-memory session this turn belongs to, when tracked. */
  sessionId?: string | null;
  /** Routed-teammate attribution for multiplayer rooms; null for single-responder. */
  routed?: { teammateId: string; source: RoutedSource } | null;
}

export interface PersistAssistantReplyResult {
  assistantId: string;
  previousHash: string;
  hash: string;
}

export async function persistAssistantReply(
  params: PersistAssistantReplyParams
): Promise<PersistAssistantReplyResult> {
  const assistantId = randomUUID();
  const previousHash = createHash("sha256")
    .update(`${params.userMessageId}${params.triggerContent}`)
    .digest("hex");
  const hash = createHash("sha256")
    .update(`${assistantId}${params.content}${previousHash}`)
    .digest("hex");

  await db.insert(messages).values({
    id: assistantId,
    channelId: params.channelId,
    role: MessageRole.ASSISTANT,
    authorType: MessageAuthorType.AI_AGENT,
    content: params.content,
    userId: params.userId,
    previousHash,
    hash,
    metadata: params.metadata as (typeof messages.$inferInsert)["metadata"],
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.routed
      ? {
          routedTeammateId: params.routed.teammateId,
          routedSource: params.routed.source,
        }
      : {}),
  });

  await db
    .update(channels)
    .set({ updatedAt: new Date() })
    .where(eq(channels.id, params.channelId));

  return { assistantId, previousHash, hash };
}
