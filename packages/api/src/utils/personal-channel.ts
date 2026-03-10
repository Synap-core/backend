/**
 * Personal Channel Utility
 *
 * Every user has exactly ONE personal AI timeline channel, pod-wide.
 * It is NOT scoped to a workspace — it's the user's global AI inbox.
 *
 * When a workspaceId is provided, it is set on the channel for context
 * (e.g. the workspace that was active when the channel was first created).
 * But lookup always uses userId only — the channel is pod-wide.
 *
 * SELECT-or-INSERT — safe to call concurrently (idempotent).
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
 * Get or create the user's personal AI timeline (pod-wide).
 * workspaceId is optional context — not used for lookup.
 */
export async function ensurePersonalChannel(
  userId: string,
  workspaceId?: string
): Promise<Channel> {
  // Pod-wide lookup: find personal channel for this user (any workspace or none)
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
      metadata: { isPersonal: true },
    })
    .returning();

  return channel;
}
