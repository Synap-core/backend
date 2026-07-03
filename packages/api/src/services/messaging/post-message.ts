/**
 * postChannelMessage — shared service behind the MCP `synap_post_message` tool.
 *
 * Inserts a single message into a channel and, when `triggerAI` is set, emits a
 * CHAT_MESSAGE realtime event flagged to trigger an AI reply. Extracted verbatim
 * from the MCP adapter so the tool handler does ZERO direct DB work. (The Hub
 * REST `POST /threads/:id/messages` path uses a different hash input + pg-boss
 * autoRespond trigger, so it is intentionally NOT unified here.)
 */

import { randomUUID, createHash } from "crypto";
import { db, messages, MessageRole } from "@synap/database";

export interface PostChannelMessageParams {
  channelId: string;
  content: string;
  /** "user" | "system" | anything else → assistant. */
  role?: string;
  triggerAI?: boolean;
  userId: string;
}

export async function postChannelMessage(
  params: PostChannelMessageParams
): Promise<{ success: true; messageId: string; channelId: string }> {
  const { channelId, content, userId } = params;
  const role = params.role || "assistant";
  const triggerAI = Boolean(params.triggerAI);
  const msgId = randomUUID();
  const hash = createHash("sha256").update(`${msgId}${content}`).digest("hex");
  const roleEnum =
    role === "user"
      ? MessageRole.USER
      : role === "system"
        ? MessageRole.SYSTEM
        : MessageRole.ASSISTANT;

  await db.insert(messages).values({
    id: msgId,
    channelId,
    role: roleEnum,
    content,
    userId,
    hash,
    previousHash: "",
  });

  if (triggerAI) {
    const { emitChatEvent } =
      await import("../../utils/chat-realtime-broadcast.js");
    const { EventNames } = await import("@synap-core/types/events");
    emitChatEvent({
      event: EventNames.CHAT_MESSAGE,
      data: {
        threadId: channelId,
        message: {
          id: msgId,
          threadId: channelId,
          role: roleEnum,
          content,
          userId,
          timestamp: new Date(),
          previousHash: "",
          hash,
        },
        userId,
      },
      workspaceId: null,
      userId,
    });

    // The socket emit above is a UI hint only — no consumer turns it into an IS
    // reply. Fire the canonical one-path kickoff so a real headless turn is
    // produced. The helper gates to THREAD/AGENT_COLLAB channels with a
    // workspaceId (other channel types are a no-op today).
    const { triggerAutoRespond } =
      await import("../../utils/trigger-auto-respond.js");
    await triggerAutoRespond({
      channelId,
      userMessageId: msgId,
      content,
      sourceUserId: userId,
    });
  }

  return { success: true, messageId: msgId, channelId };
}
