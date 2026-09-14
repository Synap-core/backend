/**
 * recordCapturePartMessage — THE one writer of a capture clarification part
 * (question or answer) into a capture session's room.
 *
 * It inserts, hashes with `computeMessageHash`, and emits `CHAT_MESSAGE` so both
 * views (the capture sheet and the session room) see the same row live. That
 * is ALL it does, on purpose:
 *
 *  - It never starts an agent turn. A capture answer is role USER, and the
 *    shared message door (`postChannelMessage`) triggers the IS for any USER
 *    message — so this writer does not go through it, and it never calls the
 *    auto-respond door. `triggerAutoRespond` ALSO refuses any message carrying
 *    `metadata.capturePart` (defense in depth for a future caller). Tripwire:
 *    `__tests__/capture-part-no-agent-turn.tripwire.test.ts`.
 *  - It creates no proposal. These are narration messages in the user's own
 *    room; entity writes still happen only at `capture.execute`.
 *
 * Idempotent on the caller's deterministic id: a retry inserts nothing and
 * emits nothing (`inserted: false`).
 */

import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  computeMessageHash,
} from "@synap/database";
import type { CaptureClarificationPart } from "@synap-core/types/capture";
import { EventNames } from "@synap-core/types/events";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";

export interface RecordCapturePartMessageInput {
  /** Deterministic id (`deterministicUuidFromKey`) — a retry is a no-op. */
  id: string;
  channelId: string;
  userId: string;
  /** The question is narrated by the pod; the answer is the person's. */
  role: "assistant" | "user";
  /** Readable text: the question, or a summary of the answer. */
  content: string;
  part: CaptureClarificationPart;
}

export async function recordCapturePartMessage(
  input: RecordCapturePartMessageInput
): Promise<{ id: string; inserted: boolean }> {
  const role = input.role === "user" ? MessageRole.USER : MessageRole.ASSISTANT;
  // No SYSTEM author type exists; BOT is "automated system message".
  const authorType =
    input.role === "user" ? MessageAuthorType.HUMAN : MessageAuthorType.BOT;
  const hash = computeMessageHash(input.id, input.content);
  const metadata = { capturePart: input.part };

  const inserted = await db
    .insert(messages)
    .values({
      id: input.id,
      channelId: input.channelId,
      role,
      authorType,
      messageCategory: MessageCategory.CHAT,
      content: input.content,
      userId: input.userId,
      hash,
      previousHash: "",
      metadata: metadata as (typeof messages.$inferInsert)["metadata"],
    })
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id });

  if (inserted.length === 0) return { id: input.id, inserted: false };

  emitChatEvent({
    event: EventNames.CHAT_MESSAGE,
    data: {
      threadId: input.channelId,
      message: {
        id: input.id,
        threadId: input.channelId,
        role,
        authorType,
        content: input.content,
        userId: input.userId,
        timestamp: new Date(),
        previousHash: "",
        hash,
        metadata,
      },
      userId: input.userId,
    },
    userId: input.userId,
    channelId: input.channelId,
  });
  return { id: input.id, inserted: true };
}
