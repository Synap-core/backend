/**
 * Personal Channel Utility
 *
 * Every user in a workspace has exactly one personal AI timeline channel —
 * auto-provisioned on workspace join and used as the default destination for
 * all AI interactions that don't specify an explicit channelId.
 *
 * SELECT-or-INSERT — safe to call concurrently (idempotent by intent;
 * duplicates are resolved by returning the first match).
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
 * Get or create the user's personal AI timeline for a workspace.
 * Identified by: userId + workspaceId + channelType=ai_thread + metadata.isPersonal=true.
 */
export async function ensurePersonalChannel(
  userId: string,
  workspaceId: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.workspaceId, workspaceId),
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
      workspaceId,
      channelType: ChannelType.AI_THREAD,
      status: ChannelStatus.ACTIVE,
      agentId: "orchestrator",
      agentType: ChannelAgentType.META,
      metadata: { isPersonal: true },
    })
    .returning();

  return channel;
}
