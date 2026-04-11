/**
 * Personal Channel Utilities
 *
 * Two distinct pod-wide AI channels per user:
 *
 * 1. Personal channel  (channelType='personal')
 *    — Pure user↔AI conversation. User types, AI responds in context.
 *    — NOTHING automated goes here. Context stays clean.
 *    — Used by: Chat tab in Browser/Relay, IS agent responses.
 *    — Pod-wide (one per user, not per workspace).
 *
 * 2. Proactive FEED channel  (channelType='feed', feedScope='user')
 *    — AI posts, user reads. Morning briefings, event prep, summaries.
 *    — Automation outputs (channel_message with channelType:'proactive') go here.
 *    — Hub Protocol /proactive/post goes here.
 *    — Rate-limited: 3/hour, 10/day.
 *    — User can tap an item to "continue in chat" (opens a thread).
 *
 * Capture history is NOT a channel — it's a query against the event log:
 *   GET /api/hub/events?types[]=capture.complete.completed&userId=X
 *
 * All are pod-wide, SELECT-or-INSERT (idempotent).
 */

import { db, eq, and } from "@synap/database";
import {
  channels,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
  ChannelAgentType,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";

/**
 * Get or create the user's personal channel (pod-wide).
 * Pure user↔AI conversation — no automation outputs here.
 */
export async function ensurePersonalChannel(
  userId: string,
  _workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.PERSONAL),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.PERSONAL,
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
