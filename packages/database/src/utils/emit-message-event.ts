/**
 * emitMessageEvent — the canonical `message.received` / `message.sent` fact
 * writer into the `events` log. This is the ONE implementation; the api
 * package's `emit-message-observation.ts` (send-message.ts, inbound-recorder.ts)
 * delegates to it, and shared @synap/database writers
 * (`insertChannelMessage`, `persistAssistantReply`) call it directly so every
 * caller of THOSE doors gets the fact write for free.
 *
 * See the api-side `emit-message-observation.ts` header for the full
 * rationale (why not the hub-protocol observations.ts door, why no
 * isAgent/proposal, why never throw). Kept in one file, in @synap/database,
 * so it can be called from both layers without duplicating logic.
 */

import { createSynapEvent, createLogger } from "@synap-core/core";
import { eventRepository } from "../repositories/event-repository.js";

const logger = createLogger({ module: "message-event" });

export interface EmitMessageEventArgs {
  /** `message.received` (inbound) or `message.sent` (outbound). */
  type: "message.received" | "message.sent";
  userId: string;
  /** The real channel this message landed on — the primary subject. */
  channelId: string;
  /** The just-inserted message row's id. */
  messageId: string;
  workspaceId?: string | null;
  /**
   * The real entity this channel is bound to (`contextObjectId`), when one
   * exists. Carried in `data.entityId` — NOT swapped in as `subjectType` —
   * so every message observation stays queryable by channel while an
   * entity-scoped reader can still filter on `data->>'entityId'`.
   */
  entityId?: string | null;
  /**
   * Minimal fact fields ONLY (authorType, externalSource, threadId, …) —
   * never the message body/content.
   */
  data: Record<string, unknown>;
  /**
   * When this message actually happened. Pass the message's real `sentAt` on
   * a historical backfill so the fact is stamped with WHEN it occurred.
   * Omit for live inbound/outbound (now).
   */
  timestamp?: Date;
}

/**
 * Append one `message.received` / `message.sent` fact into the `events` log.
 *
 * Call ONLY after confirming the `messages` insert actually landed a NEW row
 * — the caller must check the idempotency-insert result itself (this
 * function does not know about `onConflictDoNothing` / chat-turn dedup).
 * Never throws — a failure is logged and swallowed; message landing is the
 * critical path, this is a side observation of it.
 */
export async function emitMessageEvent(
  args: EmitMessageEventArgs
): Promise<void> {
  try {
    const event = createSynapEvent({
      type: args.type,
      userId: args.userId,
      subjectId: args.channelId,
      subjectType: "channel",
      data: {
        ...args.data,
        channelId: args.channelId,
        messageId: args.messageId,
        ...(args.entityId ? { entityId: args.entityId } : {}),
      },
      source: "api",
      // Ties this fact to everything else tagged by the message it is about
      // (the message row itself carries no correlationId of its own).
      correlationId: args.messageId,
    });

    await eventRepository.append({
      ...event,
      workspaceId: args.workspaceId ?? undefined,
      timestamp: args.timestamp ?? event.timestamp,
      // Deliberately NOT set: isAgent, agentUserId, proposalId — see header.
    });
  } catch (err) {
    logger.warn(
      { err, channelId: args.channelId, type: args.type },
      "message event emit failed (non-fatal)"
    );
  }
}
