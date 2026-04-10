/**
 * Personal Channel Utilities
 *
 * Three distinct pod-wide AI channels per user:
 *
 * 1. Personal CHAT channel  (isPersonal: true)
 *    — Pure user↔AI conversation. User types, AI responds in context.
 *    — NOTHING automated goes here. Context stays clean.
 *    — Used by: Chat tab in Browser/Relay, IS agent responses.
 *
 * 2. Proactive FEED channel  (isProactiveFeed: true)
 *    — AI posts, user reads. Morning briefings, event prep, summaries.
 *    — Automation outputs (channel_message with channelType:'proactive') go here.
 *    — Hub Protocol /proactive/post goes here.
 *    — Rate-limited: 3/hour, 10/day.
 *    — User can tap an item to "continue in chat" (opens a new ai_thread).
 *
 * 3. Capture THREAD channel  (isCaptureThread: true)
 *    — Records every quick capture interaction (user text + AI extraction).
 *    — Hidden from the main channel list (filtered by metadata).
 *    — Full transparency: every AI decision traceable.
 *    — User can browse their capture history.
 *
 * All are ai_thread type channels, pod-wide, SELECT-or-INSERT (idempotent).
 */

import { db, eq, and, drizzleSql } from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelStatus,
  ChannelAgentType,
  MessageRole,
  MessageAuthorType,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";
import { createHash } from "crypto";
import { randomUUID } from "crypto";

/**
 * Get or create the user's personal CHAT channel (pod-wide).
 * Pure user↔AI conversation — no automation outputs here.
 */
export async function ensurePersonalChannel(
  userId: string,
  workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.AI_THREAD),
      eq(channels.status, ChannelStatus.ACTIVE),
      drizzleSql`${channels.metadata}->>'isPersonal' = 'true'`
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: workspaceId ?? null,
      channelType: ChannelType.AI_THREAD,
      status: ChannelStatus.ACTIVE,
      agentId: "personal",
      agentType: ChannelAgentType.PERSONAL,
      metadata: { isPersonal: true, isProactiveFeed: false },
    })
    .returning();

  return channel;
}

/**
 * Get or create the user's proactive FEED channel (pod-wide).
 * AI-initiated posts: morning briefings, event prep, automation summaries.
 * Rate-limited via /api/hub/proactive/post (3/hr, 10/day).
 * User reads, taps to open a conversation — does not type directly here.
 */
export async function ensureProactiveFeedChannel(
  userId: string,
  workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.AI_THREAD),
      eq(channels.status, ChannelStatus.ACTIVE),
      drizzleSql`${channels.metadata}->>'isProactiveFeed' = 'true'`
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: workspaceId ?? null,
      channelType: ChannelType.AI_THREAD,
      status: ChannelStatus.ACTIVE,
      agentId: "proactive",
      agentType: ChannelAgentType.PERSONAL,
      metadata: { isPersonal: false, isProactiveFeed: true },
    })
    .returning();

  return channel;
}

/**
 * Get or create the user's capture THREAD channel (pod-wide).
 * Records AI capture interactions for transparency/audit.
 * Hidden from the main channel list (isCaptureThread: true).
 */
export async function ensureCaptureChannel(
  userId: string,
  workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.AI_THREAD),
      eq(channels.status, ChannelStatus.ACTIVE),
      drizzleSql`${channels.metadata}->>'isCaptureThread' = 'true'`
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: workspaceId ?? null,
      title: "Capture History",
      channelType: ChannelType.AI_THREAD,
      status: ChannelStatus.ACTIVE,
      agentId: "capture",
      agentType: ChannelAgentType.DEFAULT,
      metadata: {
        isCaptureThread: true,
        isPersonal: false,
        isProactiveFeed: false,
      },
    })
    .returning();

  return channel;
}

/**
 * Record a capture interaction as a message pair in the capture channel.
 * Non-blocking — errors are logged but never thrown.
 *
 * @param userText — the raw text the user captured
 * @param aiSummary — human-readable summary of what the AI extracted
 * @param proposals — full structured proposals (stored in message metadata for audit)
 */
export async function recordCaptureMessages(
  userId: string,
  workspaceId: string,
  userText: string,
  aiSummary: string,
  proposals: unknown
): Promise<void> {
  try {
    const channel = await ensureCaptureChannel(userId, workspaceId);

    // User message: the raw capture text
    const userMsgId = randomUUID();
    const userMsgHash = createHash("sha256")
      .update(`${userMsgId}${userText}`)
      .digest("hex");
    await db.insert(messages).values({
      id: userMsgId,
      channelId: channel.id,
      userId,
      role: MessageRole.USER,
      authorType: MessageAuthorType.HUMAN,
      content: userText,
      hash: userMsgHash,
      previousHash: "",
      metadata: {
        captureSource: "quick_capture",
      } as (typeof messages.$inferInsert)["metadata"],
    });

    // AI message: summary of extracted entities + full proposals in metadata
    const aiMsgId = randomUUID();
    const aiMsgHash = createHash("sha256")
      .update(`${aiMsgId}${aiSummary}`)
      .digest("hex");
    await db.insert(messages).values({
      id: aiMsgId,
      channelId: channel.id,
      userId,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.AI_AGENT,
      content: aiSummary,
      hash: aiMsgHash,
      previousHash: userMsgHash,
      metadata: {
        captureProposals: proposals,
      } as (typeof messages.$inferInsert)["metadata"],
    });
  } catch (err) {
    // Non-blocking — capture recording is best-effort
    console.warn(
      "[personal-channel] Failed to record capture messages:",
      err instanceof Error ? err.message : err
    );
  }
}
