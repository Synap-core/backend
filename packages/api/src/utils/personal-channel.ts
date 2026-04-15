/**
 * Thread bootstrap utilities.
 *
 * Personal chat now uses ChannelType.THREAD + ThreadKind.PERSONAL.
 * Proactive posts use ChannelType.FEED + feed metadata.
 */

import { db, eq, and } from "@synap/database";
import {
  channels,
  ChannelType,
  ChannelScope,
  FeedScope,
  ThreadKind,
  ChannelStatus,
  ChannelAgentType,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";

/**
 * Get or create the user's personal thread (pod-wide).
 * Pure user↔AI conversation — no automation outputs here.
 */
export async function ensurePersonalChannel(
  userId: string,
  _workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.threadKind, ThreadKind.PERSONAL),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.THREAD,
      threadKind: ThreadKind.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      agentId: "personal",
      agentType: ChannelAgentType.PERSONAL,
    })
    .returning();

  return channel;
}

/**
 * Get or create the user's proactive FEED channel (pod-wide, user-scoped).
 * AI-initiated posts: morning briefings, event prep, automation summaries.
 * Rate-limited via /api/hub/proactive/post (3/hr, 10/day).
 * User reads, taps to open a conversation — does not type directly here.
 */
export async function ensureProactiveFeedChannel(
  userId: string,
  _workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.FEED,
      scope: ChannelScope.POD,
      feedScope: FeedScope.USER,
      status: ChannelStatus.ACTIVE,
      agentId: "proactive",
      agentType: ChannelAgentType.PERSONAL,
    })
    .returning();

  return channel;
}
