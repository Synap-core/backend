/**
 * persistAssistantReply — the ONE writer for an AI assistant REPLY-to-a-trigger
 * in a channel (the interactive `channels.sendMessage`, the `a2ai-response-trigger`
 * worker, and the Discord bridge). It collapses the copy-pasted reply-chain those
 * three paths shared into one function so the reply chain can never drift.
 *
 * The underlying hash FORMULA (`sha256(id + content + previousHash)`) is shared
 * even more widely — with the proactive-post writers — via `computeMessageHash`;
 * this helper is specifically the reply-to-trigger writer built on top of it.
 *
 * The caller MUST have already authorized `channelId` (this does a raw insert,
 * not a scoped write). It performs only the DB write (insert + `channels.updatedAt`
 * bump). It does NOT emit the realtime event (`emitChatEvent` lives in
 * `@synap/api`) — the interactive caller broadcasts separately; headless callers
 * rely on the channel-room subscription. Returns the generated id + hashes so
 * callers can build their own downstream events (e.g. the CHAT_MESSAGE broadcast).
 */

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { computeMessageHash } from "./message-hash.js";
import {
  messages,
  channels,
  MessageRole,
  MessageAuthorType,
  type MessageCategory,
  type RoutedSource,
} from "../schema/index.js";

export interface PersistAssistantReplyParams {
  channelId: string;
  /** The assistant's reply text. */
  content: string;
  /** Author identity to stamp on the row. */
  userId: string;
  /** Provenance metadata (aiSteps + service/agent ids, or the a2ai marker). Omit to leave NULL. */
  metadata?: Record<string, unknown>;
  /**
   * Chain link. Provide EITHER the trigger message's id + content (the reply
   * chains off `sha256(userMessageId + triggerContent)`) OR an explicit
   * `previousHash` (e.g. an inbound message's already-recorded hash). One is
   * required.
   */
  userMessageId?: string;
  triggerContent?: string;
  previousHash?: string;
  /** IS-memory session this turn belongs to, when tracked. */
  sessionId?: string | null;
  /** Routed-teammate attribution for multiplayer rooms; null for single-responder. */
  routed?: { teammateId: string; source: RoutedSource } | null;
  /** Message category override (e.g. CHAT for external-bridge replies). */
  messageCategory?: MessageCategory;
  /**
   * When true, the reply is delivered live over the realtime socket but excluded
   * from channel history/list reads (gone on reload). Used to make an assistant
   * reply to an ephemeral trigger (e.g. "catch me up") equally transient.
   */
  ephemeral?: boolean;
}

export interface PersistAssistantReplyResult {
  assistantId: string;
  previousHash: string;
  hash: string;
}

export async function persistAssistantReply(
  params: PersistAssistantReplyParams
): Promise<PersistAssistantReplyResult> {
  const previousHash =
    params.previousHash ??
    (params.userMessageId !== undefined && params.triggerContent !== undefined
      ? computeMessageHash(params.userMessageId, params.triggerContent)
      : undefined);
  if (previousHash === undefined) {
    throw new Error(
      "persistAssistantReply: provide either previousHash or userMessageId+triggerContent"
    );
  }

  const assistantId = randomUUID();
  const hash = computeMessageHash(assistantId, params.content, previousHash);

  await db.insert(messages).values({
    id: assistantId,
    channelId: params.channelId,
    role: MessageRole.ASSISTANT,
    authorType: MessageAuthorType.AI_AGENT,
    content: params.content,
    userId: params.userId,
    previousHash,
    hash,
    ...(params.metadata
      ? {
          metadata:
            params.metadata as (typeof messages.$inferInsert)["metadata"],
        }
      : {}),
    ...(params.messageCategory
      ? { messageCategory: params.messageCategory }
      : {}),
    ...(params.ephemeral ? { ephemeral: true } : {}),
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
