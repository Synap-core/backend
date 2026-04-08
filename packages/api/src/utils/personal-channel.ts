/**
 * Personal Channel Utilities
 *
 * Two distinct pod-wide AI channels per user:
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
 * Both are ai_thread type channels, pod-wide, SELECT-or-INSERT (idempotent).
 */

import {
  db,
  eq,
  and,
  drizzleSql,
  channels,
  ChannelType,
  ChannelStatus,
  ChannelAgentType,
} from "@synap/database";
import type { Channel } from "@synap/database/schema";

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
