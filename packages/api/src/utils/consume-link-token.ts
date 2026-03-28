/**
 * Consume Link Token
 *
 * Validates a single-use link token and creates a channel_connections row.
 * Reusable from both tRPC (channel-gateway) and REST (Telegram webhook).
 */

import { db, eq, and, isNull, gte } from "@synap/database";
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
  const now = new Date();

  // Use a transaction so the token can't be double-spent by concurrent requests.
  // The UPDATE with WHERE usedAt IS NULL is the atomic guard: only one concurrent
  // call will succeed in marking the token used; the other gets rowCount=0.
  return await db.transaction(async (tx) => {
    // 1. Atomically mark the token as used (WHERE usedAt IS NULL ensures single-use)
    const updated = await tx
      .update(channelLinkTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(channelLinkTokens.token, token.toUpperCase()),
          eq(channelLinkTokens.channel, channel),
          isNull(channelLinkTokens.usedAt),
          // Guard against expired tokens at the DB level (expiresAt >= now)
          gte(channelLinkTokens.expiresAt, now)
        )
      )
      .returning({ id: channelLinkTokens.id });

    if (updated.length === 0) {
      // Could be: token not found, wrong channel, already used, or expired
      // Distinguish expired vs truly invalid for better UX
      const tokenRow = await tx.query.channelLinkTokens.findFirst({
        where: eq(channelLinkTokens.token, token.toUpperCase()),
        columns: { expiresAt: true, usedAt: true, channel: true },
      });
      if (!tokenRow) {
        return { ok: false, error: "Invalid link token." };
      }
      if (tokenRow.usedAt) {
        return {
          ok: false,
          error: "This link token has already been used. Generate a new one.",
        };
      }
      if (tokenRow.expiresAt < now) {
        return {
          ok: false,
          error: "Link token has expired. Generate a new one in the app.",
        };
      }
      return { ok: false, error: "Invalid link token." };
    }

    // 2. Fetch full token data (now safe — we hold exclusive ownership)
    const linkToken = await tx.query.channelLinkTokens.findFirst({
      where: eq(channelLinkTokens.id, updated[0]!.id),
    });
    if (!linkToken) {
      return { ok: false, error: "Link token not found." };
    }

    // 3. Create or update the channel connection
    const existing = await tx.query.channelConnections.findFirst({
      where: and(
        eq(channelConnections.channel, channel),
        eq(channelConnections.channelUserId, channelUserId)
      ),
    });

    if (existing) {
      await tx
        .update(channelConnections)
        .set({
          userId: linkToken.userId,
          workspaceId: linkToken.workspaceId,
          defaultChannelId: linkToken.defaultChannelId,
          externalUsername: externalUsername ?? existing.externalUsername,
          updatedAt: now,
        })
        .where(eq(channelConnections.id, existing.id));

      logger.info(
        { channel, channelUserId, userId: linkToken.userId },
        "Re-linked existing channel connection"
      );
    } else {
      await tx.insert(channelConnections).values({
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

    return {
      ok: true,
      userId: linkToken.userId,
      workspaceId: linkToken.workspaceId,
    };
  });
}
