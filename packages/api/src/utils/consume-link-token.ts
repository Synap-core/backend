/**
 * Consume Link Token
 *
 * Validates a single-use link token and creates a channel_connections row.
 * Reusable from both tRPC (channel-gateway) and REST (Telegram webhook).
 */

import { db, eq, and, isNull } from "@synap/database";
import { channelConnections, channelLinkTokens } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "consume-link-token" });

export interface ConsumeLinkTokenResult {
  ok: boolean;
  error?: string;
  userId?: string;
  workspaceId?: string | null;
}

/**
 * Validate a link token and create the channel connection.
 *
 * @param token        The link token (e.g. "ABC123")
 * @param channel      Expected channel type ("telegram", "whatsapp", etc.)
 * @param channelUserId External platform user ID (e.g. Telegram chat ID)
 * @param externalUsername Optional display name from the platform
 */
export async function consumeLinkToken(
  token: string,
  channel: string,
  channelUserId: string,
  externalUsername?: string
): Promise<ConsumeLinkTokenResult> {
  // Find valid, unused token
  const linkToken = await db.query.channelLinkTokens.findFirst({
    where: and(
      eq(channelLinkTokens.token, token.toUpperCase()),
      eq(channelLinkTokens.channel, channel),
      isNull(channelLinkTokens.usedAt)
    ),
  });

  if (!linkToken) {
    return { ok: false, error: "Invalid or expired link token" };
  }

  if (linkToken.expiresAt < new Date()) {
    return {
      ok: false,
      error: "Link token has expired. Generate a new one in the app.",
    };
  }

  // Check if connection already exists for this external user
  const existing = await db.query.channelConnections.findFirst({
    where: and(
      eq(channelConnections.channel, channel),
      eq(channelConnections.channelUserId, channelUserId)
    ),
  });

  if (existing) {
    // Update the existing connection to point to the new user (re-linking)
    await db
      .update(channelConnections)
      .set({
        userId: linkToken.userId,
        workspaceId: linkToken.workspaceId,
        defaultChannelId: linkToken.defaultChannelId,
        externalUsername: externalUsername ?? existing.externalUsername,
        updatedAt: new Date(),
      })
      .where(eq(channelConnections.id, existing.id));

    logger.info(
      { channel, channelUserId, userId: linkToken.userId },
      "Re-linked existing channel connection"
    );
  } else {
    // Create new connection
    await db.insert(channelConnections).values({
      channel,
      channelUserId,
      userId: linkToken.userId,
      workspaceId: linkToken.workspaceId,
      defaultChannelId: linkToken.defaultChannelId,
      externalUsername: externalUsername ?? null,
    });

    logger.info(
      { channel, channelUserId, userId: linkToken.userId },
      "Created channel connection"
    );
  }

  // Mark token as consumed
  await db
    .update(channelLinkTokens)
    .set({ usedAt: new Date() })
    .where(eq(channelLinkTokens.id, linkToken.id));

  return {
    ok: true,
    userId: linkToken.userId,
    workspaceId: linkToken.workspaceId,
  };
}
