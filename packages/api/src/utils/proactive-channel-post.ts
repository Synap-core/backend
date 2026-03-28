/**
 * Proactive Channel Post Utility
 *
 * Posts AI-initiated proactive messages (morning briefings, weekly digests,
 * health checks, nudges, insights) to a user's personal channel.
 *
 * Key behaviors:
 * - Checks proactiveAi.enabled + mutedUntil before posting
 * - Deduplicates: at most one message per proactiveType per user+workspace per day
 * - Emits chat:message via the realtime bridge so the frontend updates live
 * - Never throws — returns { posted: false, reason } on any error
 */

import { randomUUID, createHash } from "crypto";
import { db, eq, and, gte } from "@synap/database";
import {
  messages,
  workspaces,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import type {
  WorkspaceSettings,
  ProactiveAiPreferences,
} from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { ensurePersonalChannel } from "./personal-channel.js";
import { emitChatEvent } from "./chat-realtime-broadcast.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "proactive-channel-post" });

/** Human-readable titles for proactive message types (used in notifications). */
const PROACTIVE_TITLES: Record<ProactiveMessageType, string> = {
  morning_briefing: "Morning Briefing",
  weekly_digest: "Weekly Digest",
  health_check: "Health Check",
  nudge: "AI Nudge",
  insight: "AI Insight",
  suggestion: "AI Suggestion",
  alert: "AI Alert",
};

// ── Types ────────────────────────────────────────────────────────────────────

export type ProactiveMessageType =
  | "morning_briefing"
  | "weekly_digest"
  | "health_check"
  | "nudge"
  | "insight"
  | "suggestion"
  | "alert";

export interface PostProactiveMessageOptions {
  userId: string;
  workspaceId: string;
  content: string;
  proactiveType: ProactiveMessageType;
  metadata?: Record<string, unknown>;
}

export interface PostProactiveMessageResult {
  posted: boolean;
  messageId?: string;
  reason?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read proactive AI preferences for a workspace, returning defaults if unset.
 */
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

/**
 * Start of today (UTC midnight) — used for deduplication window.
 */
function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Post a proactive AI message to the user's personal channel.
 *
 * Returns { posted: true, messageId } on success or { posted: false, reason } otherwise.
 */
export async function postProactiveMessage(
  options: PostProactiveMessageOptions
): Promise<PostProactiveMessageResult> {
  const { userId, workspaceId, content, proactiveType, metadata } = options;

  try {
    // ── 1. Validate content ────────────────────────────────────────────────
    if (!content || content.trim().length === 0) {
      return { posted: false, reason: "empty_content" };
    }

    // ── 2. Check preferences ───────────────────────────────────────────────
    const prefs = await getProactivePrefsForWorkspace(workspaceId);

    if (!prefs.enabled) {
      return { posted: false, reason: "proactive_ai_disabled" };
    }

    // Check mutedUntil
    if (prefs.mutedUntil) {
      const mutedUntilDate = new Date(prefs.mutedUntil);
      if (!isNaN(mutedUntilDate.getTime()) && mutedUntilDate > new Date()) {
        return { posted: false, reason: "muted_until_active" };
      }
    }

    // ── 3. Deduplication: skip if same proactiveType already sent today ────
    const channel = await ensurePersonalChannel(userId, workspaceId);
    const todayStart = startOfTodayUTC();

    // Query all system messages from today in this channel, then check metadata.
    // We use JSONB operator in a raw where clause for efficiency.
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

    // ── 4. Insert message ──────────────────────────────────────────────────
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
      metadata: messageMetadata as any,
    });

    // ── 5. Emit real-time event ────────────────────────────────────────────
    emitChatEvent({
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

    // ── 6. Create notification entry ──────────────────────────────────────
    try {
      await NotificationService.create({
        type: `ai.proactive.${proactiveType}`,
        workspaceId,
        userId,
        sourceType: "proactive_message",
        sourceId: messageId,
        data: {
          proactiveType,
          title: PROACTIVE_TITLES[proactiveType] || "AI Insight",
          body: content.substring(0, 200),
        },
      });
    } catch (notifErr) {
      // Non-fatal — notifications must never break the proactive message flow
      logger.warn(
        { err: notifErr, proactiveType, messageId },
        "Failed to create proactive notification (non-fatal)"
      );
    }

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
