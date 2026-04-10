/**
 * Delivery Router
 *
 * Routes AI signals to one or more delivery surfaces based on workspace
 * preferences + system defaults. Replaces hardwired delivery paths.
 *
 * Signal domains:
 *   proactive   — cron-driven briefings, digests, insights, nudges
 *   ai_insight  — IS agent-generated content (via /proactive/post)
 *   automation  — automation output channel_message nodes
 *   connector   — connector sync completion signals
 *
 * Default routing (when no workspace preferences set):
 *   proactive   → feed
 *   ai_insight  → feed
 *   automation  → feed
 *   connector   → notification
 *
 * Surfaces:
 *   feed         → postProactiveMessage() to the proactive feed channel
 *   chat         → inserts message into the personal chat channel
 *   notification → NotificationService.create()
 *   suppress     → no-op
 *
 * Usage:
 *   const result = await routeSignal({
 *     domain: 'ai_insight',
 *     proactiveType: 'insight',
 *     content: '...',
 *     userId, workspaceId,
 *   });
 */

import { randomUUID, createHash } from "crypto";
import { createLogger } from "@synap-core/core";
import { db, eq, workspaces, messages } from "@synap/database";
import {
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import type {
  WorkspaceSettings,
  SignalDeliveryRule,
  SignalSurface,
  DeliveryPreferences,
} from "@synap/database/schema";
import { postProactiveMessage } from "./proactive-channel-post.js";
import type { ProactiveMessageType } from "./proactive-channel-post.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { ensurePersonalChannel } from "./personal-channel.js";
import { emitChatEvent } from "./chat-realtime-broadcast.js";

const logger = createLogger({ module: "delivery-router" });

// ── Types ────────────────────────────────────────────────────────────────────

export type SignalDomain = keyof DeliveryPreferences;

export interface RouteSignalInput {
  /** Which category of signal this is — drives default routing */
  domain: SignalDomain;
  /** Message content to deliver */
  content: string;
  /** Target user */
  userId: string;
  /** Target workspace */
  workspaceId: string;
  /**
   * For feed/chat surfaces: the proactiveType tag embedded in message metadata.
   * Defaults to 'insight' if not set.
   */
  proactiveType?: ProactiveMessageType;
  /**
   * For notification surface: the notification type key (registry lookup).
   * Defaults to `ai.proactive.${proactiveType}`.
   */
  notificationType?: string;
  /** Additional metadata to embed in delivered messages */
  metadata?: Record<string, unknown>;
}

export interface SurfaceResult {
  surface: SignalSurface;
  success: boolean;
  reason?: string;
  messageId?: string;
}

export interface RouteSignalResult {
  /** True if at least one surface delivery succeeded */
  delivered: boolean;
  /** Which surfaces were targeted */
  surfaces: SignalSurface[];
  /** Per-surface delivery results */
  results: SurfaceResult[];
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * System-level default routing per domain.
 * Applied when workspace has no deliveryPreferences override.
 */
export const DEFAULT_DELIVERY_RULES: Record<SignalDomain, SignalDeliveryRule> =
  {
    proactive: { surfaces: ["feed"] },
    ai_insight: { surfaces: ["feed"] },
    automation: { surfaces: ["feed"] },
    connector: { surfaces: ["notification"] },
  };

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getDeliveryPreferences(
  workspaceId: string
): Promise<DeliveryPreferences> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { settings: true },
  });
  const settings = (ws?.settings ?? {}) as WorkspaceSettings;
  return settings.deliveryPreferences ?? {};
}

function resolveRule(
  domain: SignalDomain,
  prefs: DeliveryPreferences
): SignalDeliveryRule {
  return prefs[domain] ?? DEFAULT_DELIVERY_RULES[domain];
}

// ── Surface Delivery ─────────────────────────────────────────────────────────

async function deliverToFeed(
  input: RouteSignalInput & { proactiveType: ProactiveMessageType }
): Promise<SurfaceResult> {
  const result = await postProactiveMessage({
    userId: input.userId,
    workspaceId: input.workspaceId,
    content: input.content,
    proactiveType: input.proactiveType,
    metadata: input.metadata,
  });
  return {
    surface: "feed",
    success: result.posted,
    reason: result.reason,
    messageId: result.messageId,
  };
}

async function deliverToChat(
  input: RouteSignalInput & { proactiveType: ProactiveMessageType }
): Promise<SurfaceResult> {
  try {
    const { userId, workspaceId, content, proactiveType, metadata } = input;
    const channel = await ensurePersonalChannel(userId, workspaceId);
    const messageId = randomUUID();
    const hash = createHash("sha256")
      .update(`${messageId}${content}`)
      .digest("hex");

    const messageMetadata = {
      ...metadata,
      proactiveType,
      proactiveAi: true,
      deliveredViaChatSurface: true,
    };

    await db.insert(messages).values({
      id: messageId,
      channelId: channel.id,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.BOT,
      messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
      content: content.trim(),
      userId,
      previousHash: "",
      hash,
      metadata: messageMetadata as (typeof messages.$inferInsert)["metadata"],
    });

    emitChatEvent({
      event: "chat:message",
      data: {
        threadId: channel.id,
        message: {
          id: messageId,
          threadId: channel.id,
          role: MessageRole.ASSISTANT,
          authorType: MessageAuthorType.BOT,
          content: content.trim(),
          userId,
          timestamp: new Date(),
          previousHash: "",
          hash,
          metadata: messageMetadata,
        },
        userId,
      },
      channelId: channel.id,
      userId,
    });

    return { surface: "chat", success: true, messageId };
  } catch (err) {
    return {
      surface: "chat",
      success: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

async function deliverToNotification(
  input: RouteSignalInput & { proactiveType: ProactiveMessageType }
): Promise<SurfaceResult> {
  const notificationType =
    input.notificationType ?? `ai.proactive.${input.proactiveType}`;
  try {
    const notifId = await NotificationService.create({
      type: notificationType,
      workspaceId: input.workspaceId,
      userId: input.userId,
      sourceType: "proactive_message",
      data: {
        proactiveType: input.proactiveType,
        body: input.content.substring(0, 200),
        ...input.metadata,
      },
    });
    return { surface: "notification", success: !!notifId, messageId: notifId };
  } catch (err) {
    return {
      surface: "notification",
      success: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

// ── Main Function ─────────────────────────────────────────────────────────────

/**
 * Route an AI signal to one or more delivery surfaces.
 *
 * Reads workspace delivery preferences, resolves surfaces for the domain,
 * and delivers to each surface concurrently. Never throws.
 */
export async function routeSignal(
  input: RouteSignalInput
): Promise<RouteSignalResult> {
  const { domain, userId, workspaceId } = input;
  const proactiveType: ProactiveMessageType = input.proactiveType ?? "insight";

  try {
    const prefs = await getDeliveryPreferences(workspaceId);
    const rule = resolveRule(domain, prefs);

    // suppress is a complete no-op
    if (rule.surfaces.includes("suppress")) {
      logger.debug(
        { domain, userId, workspaceId },
        "Signal suppressed by delivery preferences"
      );
      return { delivered: false, surfaces: ["suppress"], results: [] };
    }

    const activeSurfaces = rule.surfaces.filter(
      (s): s is Exclude<SignalSurface, "suppress"> => s !== "suppress"
    );

    if (activeSurfaces.length === 0) {
      return { delivered: false, surfaces: [], results: [] };
    }

    const resolvedInput = { ...input, proactiveType };

    // Deliver to all surfaces concurrently
    const results = await Promise.all(
      activeSurfaces.map((surface) => {
        switch (surface) {
          case "feed":
            return deliverToFeed(resolvedInput);
          case "chat":
            return deliverToChat(resolvedInput);
          case "notification":
            return deliverToNotification(resolvedInput);
        }
      })
    );

    const delivered = results.some((r) => r.success);

    logger.debug(
      { domain, userId, workspaceId, surfaces: activeSurfaces, delivered },
      "Signal routed"
    );

    return { delivered, surfaces: activeSurfaces, results };
  } catch (err) {
    logger.error({ err, domain, userId, workspaceId }, "routeSignal failed");
    return { delivered: false, surfaces: [], results: [] };
  }
}
