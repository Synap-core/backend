/**
 * Telegram Bot → AI Forwarding
 *
 * Forwards a Telegram bot message to the user's persistent bot branch channel,
 * gets the AI response, and returns it for sending back via Telegram.
 *
 * The bot branch is separate from the user's personal AI channel so the
 * Telegram bot conversation doesn't pollute the main timeline.
 */

import { createHash, randomUUID } from "crypto";
import { db, eq, and, drizzleSql } from "@synap/database";
import {
  channels,
  messages,
  channelConnections,
  ChannelType,
  ChannelStatus,
  ChannelAgentType,
  MessageRole,
  MessageAuthorType,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { HubStreamEvent } from "@synap-core/types";
import { ensurePersonalChannel } from "./personal-channel.js";
import { resolveIntelligenceService } from "./intelligence-routing.js";

const logger = createLogger({ module: "telegram-bot-forward" });

const MAX_MESSAGE_LENGTH = 50_000;

export interface CapturedProposal {
  proposalId: string;
  toolName: string;
  description: string;
}

export interface ForwardResult {
  ok: boolean;
  reply?: string;
  error?: string;
  proposals?: CapturedProposal[];
}

/**
 * Look up a Synap user by their Telegram chat ID.
 * Returns the channel connection or null if not linked.
 */
export async function findTelegramUser(telegramChatId: string) {
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, "telegram"),
        eq(channelConnections.channelUserId, telegramChatId)
      )
    )
    .limit(1);

  return connection ?? null;
}

/**
 * Find or create the persistent bot branch channel for a user.
 * One per user, reused across all bot conversations.
 */
async function ensureBotBranchChannel(
  userId: string,
  personalChannelId: string,
  workspaceId?: string | null
) {
  // Look for existing active bot branch
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.SUB_THREAD),
      eq(channels.status, ChannelStatus.ACTIVE),
      drizzleSql`${channels.metadata}->>'telegramBotBranch' = 'true'`
    ),
  });

  if (existing) return existing;

  // Create a persistent bot branch
  const [branch] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: workspaceId ?? null,
      channelType: ChannelType.SUB_THREAD,
      status: ChannelStatus.ACTIVE,
      parentChannelId: personalChannelId,
      branchPurpose: "Telegram Bot",
      agentId: "orchestrator",
      agentType: ChannelAgentType.META,
      metadata: { telegramBotBranch: true, inheritContext: true },
    })
    .returning();

  logger.info(
    { userId, branchId: branch.id, parentId: personalChannelId },
    "Created persistent Telegram bot branch channel"
  );

  return branch;
}

/**
 * Forward a Telegram message to the AI and return the response.
 *
 * Flow:
 * 1. Look up the user's connection
 * 2. Find/create the personal channel + persistent bot branch
 * 3. Store the user message
 * 4. Send to Intelligence Service and collect response
 * 5. Store the AI response
 * 6. Return the reply text
 */
export async function forwardTelegramMessageToAI(opts: {
  telegramChatId: string;
  text: string;
  senderName?: string;
}): Promise<ForwardResult> {
  const { telegramChatId, text } = opts;

  // Validate input
  if (!text || text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: "Message too long or empty" };
  }

  // 1. Look up user
  const connection = await findTelegramUser(telegramChatId);
  if (!connection) {
    return {
      ok: false,
      error:
        "Your Telegram account is not linked to Synap. Use /link <token> to connect.",
    };
  }

  const { userId, workspaceId } = connection;

  try {
    // 2. Ensure personal channel + bot branch
    const personalChannel = await ensurePersonalChannel(
      userId,
      workspaceId ?? undefined
    );
    const botBranch = await ensureBotBranchChannel(
      userId,
      personalChannel.id,
      workspaceId
    );

    // 3. Store user message
    const userMsgId = randomUUID();
    const userMsgHash = createHash("sha256")
      .update(`${userMsgId}${text}`)
      .digest("hex");

    const [userMsg] = await db
      .insert(messages)
      .values({
        id: userMsgId,
        channelId: botBranch.id,
        role: MessageRole.USER,
        authorType: MessageAuthorType.EXTERNAL,
        content: text,
        userId,
        externalSource: "telegram",
        previousHash: "",
        hash: userMsgHash,
      })
      .returning();

    // 4. Resolve Intelligence Service and send
    const resolvedService = await resolveIntelligenceService({
      userId,
      workspaceId: workspaceId ?? undefined,
      capability: "chat",
    });

    let replyText = "";
    const capturedProposals: CapturedProposal[] = [];

    try {
      const stream = resolvedService.client.sendMessageStream({
        query: text,
        threadId: botBranch.id,
        userId,
        agentId: "orchestrator",
        agentType: "meta",
        workspaceId: workspaceId ?? undefined,
        sourceMessageId: userMsg.id,
        agentUserId: resolvedService.agentUserId,
        dataPodUrl: process.env.PUBLIC_URL || "http://localhost:3000",
        dataPodApiKey: process.env.HUB_PROTOCOL_API_KEY || "",
      });

      // Collect streaming response
      for await (const event of stream) {
        const evt = event as HubStreamEvent & {
          content?: string;
          data?: Record<string, unknown>;
        };
        if (evt.type === "chunk" && typeof evt.content === "string") {
          replyText += evt.content;
        }
        if (evt.type === "complete" && evt.data) {
          if (typeof evt.data.response === "string") {
            replyText = evt.data.response;
          }
          // Extract proposals created during this turn
          const incoming = evt.data.createdProposals as
            | Array<{
                proposalId: string;
                toolName: string;
                description: string;
              }>
            | undefined;
          if (Array.isArray(incoming)) {
            capturedProposals.push(...incoming);
          }
        }
      }
    } catch (streamErr) {
      logger.error(
        { userId, branchId: botBranch.id, error: streamErr },
        "Intelligence stream error"
      );
      return {
        ok: false,
        error: "AI is temporarily unavailable. Please try again.",
      };
    }

    if (!replyText.trim()) {
      replyText = "I processed your message but have no text response.";
    }

    // 5. Store AI response message
    const aiMsgId = randomUUID();
    const aiMsgHash = createHash("sha256")
      .update(`${aiMsgId}${replyText}`)
      .digest("hex");

    await db.insert(messages).values({
      id: aiMsgId,
      channelId: botBranch.id,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.AI_AGENT,
      content: replyText,
      userId,
      previousHash: userMsgHash,
      hash: aiMsgHash,
    });

    return {
      ok: true,
      reply: replyText,
      proposals: capturedProposals.length > 0 ? capturedProposals : undefined,
    };
  } catch (err) {
    logger.error(
      { telegramChatId, userId, error: err },
      "Failed to forward Telegram message to AI"
    );
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
