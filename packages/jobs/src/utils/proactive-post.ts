/**
 * Proactive Post Utility (Jobs Package)
 *
 * Lightweight version of @synap/api's postProactiveMessage for use in cron workers.
 * The jobs package cannot import @synap/api (circular dep), so we replicate the
 * core posting logic here: preference check, dedup, insert, realtime emit.
 *
 * Posts to the PROACTIVE FEED channel (isProactiveFeed: true) — NOT the personal chat channel.
 */

import { randomUUID, createHash } from "crypto";
import { db, eq, and, gte, drizzleSql } from "@synap/database";
import {
  messages,
  workspaces,
  channels,
  ChannelType,
  ChannelStatus,
  ChannelAgentType,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import type {
  WorkspaceSettings,
  ProactiveAiPreferences,
  Channel,
} from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "proactive-post" });

// ── Types ────────────────────────────────────────────────────────────────────

export type ProactiveMessageType =
  | "morning_briefing"
  | "weekly_digest"
  | "health_check"
  | "nudge"
  | "insight";

export interface PostProactiveOptions {
  userId: string;
  workspaceId: string;
  content: string;
  proactiveType: ProactiveMessageType;
  metadata?: Record<string, unknown>;
}

export interface PostProactiveResult {
  posted: boolean;
  messageId?: string;
  reason?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read proactive AI preferences for a workspace, returning defaults if unset. */
export async function getProactivePrefsForWorkspace(
  workspaceId: string
): Promise<ProactiveAiPreferences> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { settings: true },
  });

  const settings = (ws?.settings ?? {}) as WorkspaceSettings;
  return settings.proactiveAi ?? getDefaultProactiveAiPreferences();
}

/** Get or create the user's proactive FEED channel (pod-wide). */
async function ensureProactiveFeedChannel(
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

/** Start of today (UTC midnight) — deduplication window. */
function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/** Fire-and-forget realtime emit via the bridge server. */
function emitRealtimeEvent(payload: {
  event: string;
  data: Record<string, unknown>;
  channelId: string;
  userId: string;
}): void {
  const realtimeUrl = process.env.REALTIME_URL || "http://localhost:4001";
  const url = `${realtimeUrl}/bridge/emit`;
  const body = JSON.stringify(payload);

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Fire-and-forget — failure is non-critical for cron workers
  });
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Post a proactive AI message to the user's personal channel.
 *
 * Checks workspace preferences, deduplicates (one per type per day),
 * inserts the message, and emits a realtime event.
 *
 * Never throws — returns { posted: false, reason } on any error.
 */
export async function postProactiveMessage(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  const { userId, workspaceId, content, proactiveType, metadata } = options;

  try {
    if (!content || content.trim().length === 0) {
      return { posted: false, reason: "empty_content" };
    }

    // Check preferences
    const prefs = await getProactivePrefsForWorkspace(workspaceId);

    if (!prefs.enabled) {
      return { posted: false, reason: "proactive_ai_disabled" };
    }

    if (prefs.mutedUntil) {
      const mutedUntilDate = new Date(prefs.mutedUntil);
      if (!isNaN(mutedUntilDate.getTime()) && mutedUntilDate > new Date()) {
        return { posted: false, reason: "muted_until_active" };
      }
    }

    // Deduplication: skip if same proactiveType already sent today
    const channel = await ensureProactiveFeedChannel(userId, workspaceId);
    const todayStart = startOfTodayUTC();

    const todayMessages = await db.query.messages.findMany({
      where: and(
        eq(messages.channelId, channel.id),
        eq(messages.role, MessageRole.SYSTEM),
        gte(messages.timestamp, todayStart)
      ),
      columns: { metadata: true },
    });

    const alreadySent = todayMessages.some((m) => {
      const meta = m.metadata as Record<string, unknown> | null;
      return meta?.proactiveType === proactiveType;
    });

    if (alreadySent) {
      return { posted: false, reason: "already_sent_today" };
    }

    // Insert message
    const messageId = randomUUID();
    const messageHash = createHash("sha256")
      .update(`${messageId}${content}`)
      .digest("hex");

    const messageMetadata = {
      ...metadata,
      proactiveType,
      proactiveAi: true,
    };

    await db.insert(messages).values({
      id: messageId,
      channelId: channel.id,
      role: MessageRole.SYSTEM,
      authorType: MessageAuthorType.BOT,
      messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
      content: content.trim(),
      userId,
      previousHash: "",
      hash: messageHash,
      metadata: messageMetadata as (typeof messages.$inferInsert)["metadata"],
    });

    // Emit realtime event (fire-and-forget)
    emitRealtimeEvent({
      event: "chat:message",
      data: {
        threadId: channel.id,
        message: {
          id: messageId,
          threadId: channel.id,
          role: MessageRole.SYSTEM,
          authorType: MessageAuthorType.BOT,
          content: content.trim(),
          userId,
          timestamp: new Date(),
          previousHash: "",
          hash: messageHash,
          metadata: messageMetadata,
        },
        userId,
      },
      channelId: channel.id,
      userId,
    });

    logger.info(
      { userId, workspaceId, proactiveType, messageId },
      "Proactive message posted"
    );

    return { posted: true, messageId };
  } catch (err) {
    logger.error(
      { err, userId, workspaceId, proactiveType },
      "Failed to post proactive message"
    );
    return {
      posted: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
}
