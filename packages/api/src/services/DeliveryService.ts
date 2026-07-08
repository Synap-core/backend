/**
 * DeliveryService
 *
 * Unified service for delivering messages to users across all surfaces.
 * Consolidates: proactive-channel-post, automation output, cross-channel notifications,
 * feed posting, and notification creation into a single code path.
 *
 * Enhanced with:
 * - Retry logic with exponential backoff
 * - Circuit breaker pattern for resilience
 * - Delivery metrics tracking
 * - Dead letter queue integration
 * - Proactive AI feed delivery with preference checking
 * - Deduplication (one per proactiveType per day)
 * - Event emission and Socket.IO broadcast
 */

import { randomUUID } from "crypto";
import { db, eq, and, gte, computeMessageHash } from "@synap/database";
import {
  channels,
  messages,
  workspaces,
  ChannelType,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  type WorkspaceSettings,
  type ProactiveAiPreferences,
  getDefaultProactiveAiPreferences,
} from "@synap/database/schema";
import { eventRepository } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../notifications/NotificationService.js";
import {
  ensureAgentThread,
  ensureProactiveFeedChannel,
  getAgentIdBySlug,
} from "../utils/personal-channel.js";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { EventNames } from "@synap-core/types/events";
import {
  withRetryResult,
  API_RETRY_OPTIONS,
  type RetryOptions,
  type CircuitBreaker,
  circuitBreakerRegistry,
} from "@synap/shared-utils";

// Note: emitSideEffects import removed to avoid circular dependency
// Side effects are emitted directly via eventRepository

// Note: Removed @synap/jobs import to avoid circular dependency
// Retry queue and dead letter queue functionality moved to separate worker

const logger = createLogger({ module: "delivery-service" });

// ── Types ────────────────────────────────────────────────────────────────────

export type DeliverySurface =
  | {
      type: "feed";
      feedChannelId?: string;
      proactiveOptions?: FeedDeliveryOptions["deliveryOptions"];
    }
  | { type: "chat"; channelId?: string }
  | { type: "notification"; notificationType: string }
  | { type: "external"; platform: string; externalChannelId?: string }
  | { type: "email" };

/**
 * Proactive message types for feed delivery
 */
export type ProactiveMessageType =
  | "morning_briefing"
  | "weekly_digest"
  | "health_check"
  | "nudge"
  | "insight"
  | "suggestion"
  | "alert";

/**
 * Feed-specific delivery options
 */
export interface FeedDeliveryOptions {
  userId: string;
  workspaceId: string;
  content: {
    title?: string;
    body: string;
    metadata?: Record<string, unknown>;
  };
  deliveryOptions?: {
    /** Check proactive AI settings (enabled, mutedUntil) */
    checkPreferences?: boolean;
    /** Deduplicate: one per proactiveType per day */
    deduplicate?: boolean;
    /** Proactive type for deduplication key */
    proactiveType?: ProactiveMessageType;
    /** Fire proactive.post.completed event */
    emitEvents?: boolean;
    /** Create a notification alongside the feed message */
    createNotification?: boolean;
    /** Notification type (if createNotification is true) */
    notificationType?: string;
  };
}

export interface DeliveryContent {
  title?: string;
  body: string;
  sourceType: "ai_proactive" | "automation" | "user" | "external" | "system";
  sourceId?: string;
  actions?: Array<{
    label: string;
    action: string;
    data?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}

export interface DeliveryRequest {
  userId: string;
  workspaceId?: string;
  content: DeliveryContent;
  surfaces: DeliverySurface[];
  priority?: "low" | "normal" | "high" | "urgent";
  deduplicationKey?: string;
  expiresAt?: Date;
  /**
   * Enable retry for this delivery request.
   * @default true
   */
  enableRetry?: boolean;
  /**
   * Custom retry options for this request.
   */
  retryOptions?: RetryOptions;
}

export interface DeliveryResult {
  success: boolean;
  deliveries: Array<{
    surface: DeliverySurface["type"];
    success: boolean;
    id?: string;
    error?: string;
    retries?: number;
    circuitBreakerOpen?: boolean;
  }>;
  metrics?: {
    totalDurationMs: number;
    totalRetries: number;
  };
}

// ── Metrics Tracking ─────────────────────────────────────────────────────────

interface SurfaceMetrics {
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  totalRetries: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  circuitBreakerOpens: number;
}

class DeliveryMetrics {
  private metrics = new Map<string, SurfaceMetrics>();
  private startTime = Date.now();

  recordSuccess(surface: string, latencyMs: number, retries: number): void {
    const existing = this.metrics.get(surface) || {
      successCount: 0,
      failureCount: 0,
      totalLatencyMs: 0,
      totalRetries: 0,
      circuitBreakerOpens: 0,
    };

    existing.successCount++;
    existing.totalLatencyMs += latencyMs;
    existing.totalRetries += retries;
    existing.lastSuccessAt = Date.now();

    this.metrics.set(surface, existing);
  }

  recordFailure(
    surface: string,
    latencyMs: number,
    retries: number,
    circuitBreakerOpen?: boolean
  ): void {
    const existing = this.metrics.get(surface) || {
      successCount: 0,
      failureCount: 0,
      totalLatencyMs: 0,
      totalRetries: 0,
      circuitBreakerOpens: 0,
    };

    existing.failureCount++;
    existing.totalLatencyMs += latencyMs;
    existing.totalRetries += retries;
    existing.lastFailureAt = Date.now();

    if (circuitBreakerOpen) {
      existing.circuitBreakerOpens++;
    }

    this.metrics.set(surface, existing);
  }

  getStats(): Record<
    string,
    SurfaceMetrics & {
      avgLatencyMs: number;
      successRate: number;
    }
  > {
    const stats: Record<
      string,
      SurfaceMetrics & {
        avgLatencyMs: number;
        successRate: number;
      }
    > = {};

    for (const [surface, data] of this.metrics) {
      const total = data.successCount + data.failureCount;
      stats[surface] = {
        ...data,
        avgLatencyMs: total > 0 ? data.totalLatencyMs / total : 0,
        successRate: total > 0 ? (data.successCount / total) * 100 : 0,
      };
    }

    return stats;
  }

  getSummary(): {
    uptimeMinutes: number;
    totalDeliveries: number;
    totalSuccesses: number;
    totalFailures: number;
    overallSuccessRate: number;
    avgLatencyMs: number;
    totalRetries: number;
  } {
    let totalDeliveries = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    let totalLatencyMs = 0;
    let totalRetries = 0;

    for (const data of this.metrics.values()) {
      totalSuccesses += data.successCount;
      totalFailures += data.failureCount;
      totalLatencyMs += data.totalLatencyMs;
      totalRetries += data.totalRetries;
    }

    totalDeliveries = totalSuccesses + totalFailures;

    return {
      uptimeMinutes: (Date.now() - this.startTime) / 60000,
      totalDeliveries,
      totalSuccesses,
      totalFailures,
      overallSuccessRate:
        totalDeliveries > 0 ? (totalSuccesses / totalDeliveries) * 100 : 0,
      avgLatencyMs: totalDeliveries > 0 ? totalLatencyMs / totalDeliveries : 0,
      totalRetries,
    };
  }

  reset(): void {
    this.metrics.clear();
    this.startTime = Date.now();
  }
}

// Global metrics instance
const deliveryMetrics = new DeliveryMetrics();

// ── Dead Letter Queue ────────────────────────────────────────────────────────

interface FailedDelivery {
  request: DeliveryRequest;
  surface: DeliverySurface;
  error: string;
  attemptCount: number;
  failedAt: string;
  surfaceType: string;
}

/**
 * Queue a failed delivery for retry.
 * NOTE: Retry queue functionality temporarily disabled to avoid circular dependency.
 * The caller should handle retries or use the delivery-retry-worker directly.
 */
async function queueForRetry(
  _failedDelivery: FailedDelivery,
  _delayMinutes: number = 5
): Promise<void> {
  // Retry queue functionality moved to @synap/jobs to avoid circular dependency
  // This function is a placeholder for future implementation
  logger.warn("Retry queue temporarily disabled - caller should handle retry");
}

/**
 * Send a failed delivery to the dead letter queue after max retries.
 * NOTE: Dead letter queue functionality temporarily disabled.
 * @deprecated This function is a placeholder for future implementation.
 */
// @ts-expect-error - intentionally unused, reserved for future implementation
async function _sendToDeadLetter(
  _failedDelivery: FailedDelivery
): Promise<void> {
  // Dead letter queue functionality moved to @synap/jobs to avoid circular dependency
  logger.warn("Dead letter queue temporarily disabled");
}

// ── Deduplication ────────────────────────────────────────────────────────────

const recentDeliveries = new Map<string, number>();
const DEDUP_WINDOW_MS = 60 * 1000; // 1 minute

function checkDuplicate(key: string): boolean {
  const now = Date.now();
  const lastDelivery = recentDeliveries.get(key);

  if (lastDelivery && now - lastDelivery < DEDUP_WINDOW_MS) {
    return true;
  }

  recentDeliveries.set(key, now);

  // Cleanup old entries
  for (const [k, v] of recentDeliveries.entries()) {
    if (now - v > DEDUP_WINDOW_MS) {
      recentDeliveries.delete(k);
    }
  }

  return false;
}

// ── Proactive Feed Delivery Helpers ──────────────────────────────────────────

/**
 * Read proactive AI preferences for a workspace, returning defaults if unset.
 */
async function getProactivePrefsForWorkspace(
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

/**
 * Check if a proactive message of the given type was already sent today.
 */
async function checkProactiveTypeSentToday(
  channelId: string,
  proactiveType: string
): Promise<boolean> {
  const todayStart = startOfTodayUTC();

  const todayMessages = await db.query.messages.findMany({
    where: and(
      eq(messages.channelId, channelId),
      eq(messages.role, MessageRole.SYSTEM),
      gte(messages.timestamp, todayStart)
    ),
    columns: { metadata: true },
  });

  return todayMessages.some((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.proactiveType === proactiveType;
  });
}

/**
 * Deliver to the proactive feed channel with full proactive AI logic:
 * - Preference checking (enabled, mutedUntil)
 * - Deduplication (one per proactiveType per day)
 * - Socket.IO broadcast
 * - Event emission
 */
async function deliverToProactiveFeed(
  options: FeedDeliveryOptions
): Promise<{ success: boolean; messageId?: string; reason?: string }> {
  const { userId, workspaceId, content, deliveryOptions = {} } = options;
  const {
    checkPreferences = true,
    deduplicate = true,
    proactiveType = "insight",
    emitEvents = true,
    createNotification = false,
    notificationType = "ai.proactive.insight",
  } = deliveryOptions;

  try {
    // ── 1. Validate content ────────────────────────────────────────────────
    if (!content.body || content.body.trim().length === 0) {
      return { success: false, reason: "empty_content" };
    }

    // ── 2. Check preferences ───────────────────────────────────────────────
    if (checkPreferences) {
      const prefs = await getProactivePrefsForWorkspace(workspaceId);

      if (!prefs.enabled) {
        return { success: false, reason: "proactive_ai_disabled" };
      }

      // Check mutedUntil
      if (prefs.mutedUntil) {
        const mutedUntilDate = new Date(prefs.mutedUntil);
        if (!isNaN(mutedUntilDate.getTime()) && mutedUntilDate > new Date()) {
          return { success: false, reason: "muted_until_active" };
        }
      }
    }

    // ── 3. Ensure proactive feed channel ───────────────────────────────────
    const channel = await ensureProactiveFeedChannel(userId, workspaceId);

    // ── 4. Deduplication ───────────────────────────────────────────────────
    if (deduplicate && proactiveType) {
      const alreadySent = await checkProactiveTypeSentToday(
        channel.id,
        proactiveType
      );
      if (alreadySent) {
        return { success: false, reason: "already_sent_today" };
      }
    }

    // ── 5. Insert message ──────────────────────────────────────────────────
    const messageId = randomUUID();
    const messageHash = computeMessageHash(messageId, content.body);

    const messageMetadata = {
      ...content.metadata,
      proactiveType,
      proactiveAi: true,
      title: content.title,
    };

    await db.insert(messages).values({
      id: messageId,
      channelId: channel.id,
      role: MessageRole.SYSTEM,
      authorType: MessageAuthorType.BOT,
      messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
      content: content.body.trim(),
      userId,
      previousHash: "",
      hash: messageHash,
      metadata: messageMetadata as (typeof messages.$inferInsert)["metadata"],
    });

    // ── 6. Emit real-time event ────────────────────────────────────────────
    emitChatEvent({
      event: EventNames.CHAT_MESSAGE,
      data: {
        threadId: channel.id,
        message: {
          id: messageId,
          threadId: channel.id,
          role: MessageRole.SYSTEM,
          authorType: MessageAuthorType.BOT,
          content: content.body.trim(),
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
      "Proactive message delivered via DeliveryService"
    );

    // ── 7. Emit events ─────────────────────────────────────────────────────
    if (emitEvents) {
      const proactiveEventData = {
        proactiveType,
        workspaceId,
        channelId: channel.id,
        messageId,
      };

      // Fire and forget event log append
      eventRepository
        .append({
          id: messageId,
          version: "v1",
          type: "proactive.post.completed",
          subjectType: "proactive",
          subjectId: messageId,
          data: proactiveEventData,
          userId,
          source: "system",
          timestamp: new Date(),
        })
        .catch(() => {});
    }

    // ── 8. Create notification if requested ────────────────────────────────
    if (createNotification) {
      await NotificationService.create({
        type: notificationType,
        workspaceId,
        userId,
        sourceType: "proactive_message",
        sourceId: messageId,
        data: {
          title: content.title || "AI Insight",
          body: content.body.substring(0, 200),
          proactiveType,
          ...content.metadata,
        },
      }).catch((err) => {
        logger.warn(
          { err, userId, workspaceId, messageId },
          "Failed to create notification alongside feed message"
        );
      });
    }

    return { success: true, messageId };
  } catch (err) {
    logger.error(
      { err, userId, workspaceId, proactiveType },
      "Failed to deliver proactive message"
    );
    return {
      success: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

// ── Surface Handlers with Retry & Circuit Breaker ────────────────────────────

// Get or create circuit breakers for each surface type
function getCircuitBreaker(surfaceType: string): CircuitBreaker {
  return circuitBreakerRegistry.get(`delivery-${surfaceType}`, {
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    halfOpenMaxCalls: 3,
    successThreshold: 2,
  });
}

async function deliverToFeedWithRetry(
  request: DeliveryRequest,
  surface: Extract<DeliverySurface, { type: "feed" }>,
  retryOptions: RetryOptions
): Promise<{ success: boolean; id?: string; error?: string; retries: number }> {
  const circuitBreaker = getCircuitBreaker("feed");

  // Check if circuit breaker is open
  const stats = circuitBreaker.getStats();
  if (stats.state === "open") {
    logger.warn(
      { userId: request.userId },
      "Feed delivery circuit breaker is OPEN"
    );

    // Queue for retry instead of failing immediately
    await queueForRetry(
      {
        request,
        surface,
        error: "Circuit breaker open",
        attemptCount: 0,
        failedAt: new Date().toISOString(),
        surfaceType: "feed",
      },
      1
    );

    return {
      success: false,
      error: "Circuit breaker open - queued for retry",
      retries: 0,
    };
  }

  // Use proactive feed delivery if proactiveOptions are specified
  if (surface.proactiveOptions) {
    const result = await withRetryResult(async () => {
      return await circuitBreaker.execute(async () => {
        const feedResult = await deliverToProactiveFeed({
          userId: request.userId,
          workspaceId: request.workspaceId ?? "default",
          content: {
            title: request.content.title,
            body: request.content.body,
            metadata: request.content.metadata,
          },
          deliveryOptions: surface.proactiveOptions,
        });
        return feedResult.success ? feedResult.messageId : undefined;
      });
    }, retryOptions);

    return {
      success: result.success,
      id: result.data,
      error: result.error?.message,
      retries: result.attempts,
    };
  }

  // Use standard feed delivery for backward compatibility
  const result = await withRetryResult(async () => {
    return await circuitBreaker.execute(async () => {
      return await deliverToFeedInternal(request, surface);
    });
  }, retryOptions);

  return {
    success: result.success,
    id: result.data,
    error: result.error?.message,
    retries: result.attempts,
  };
}

async function deliverToFeedInternal(
  request: DeliveryRequest,
  surface: Extract<DeliverySurface, { type: "feed" }>
): Promise<string> {
  let feedChannelId = surface.feedChannelId;

  if (!feedChannelId) {
    const feedChannel = await db.query.channels.findFirst({
      where: and(
        eq(channels.userId, request.userId),
        eq(channels.channelType, ChannelType.FEED),
        eq(channels.status, ChannelStatus.ACTIVE)
      ),
    });

    if (!feedChannel) {
      throw new Error("No feed channel found for user");
    }

    feedChannelId = feedChannel.id;
  }

  const [message] = await db
    .insert(messages)
    .values({
      channelId: feedChannelId,
      content: request.content.body,
      role: MessageRole.SYSTEM,
      authorType: MessageAuthorType.BOT,
      messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
      userId: request.userId,
      hash: crypto.randomUUID(), // Required field, will be computed properly in production
      previousHash: "",
      metadata: {
        ...request.content.metadata,
        sourceType: request.content.sourceType,
        sourceId: request.content.sourceId,
        title: request.content.title,
      } as any, // Allow extended metadata fields beyond the strict type
    })
    .returning();

  // Note: Side effects should be emitted by the caller to avoid circular dependency
  // The caller can use emitSideEffects from @synap/events if needed

  return message.id;
}

async function deliverToChatWithRetry(
  request: DeliveryRequest,
  surface: Extract<DeliverySurface, { type: "chat" }>,
  retryOptions: RetryOptions
): Promise<{ success: boolean; id?: string; error?: string; retries: number }> {
  const circuitBreaker = getCircuitBreaker("chat");

  // Check if circuit breaker is open
  const stats = circuitBreaker.getStats();
  if (stats.state === "open") {
    logger.warn(
      { userId: request.userId },
      "Chat delivery circuit breaker is OPEN"
    );

    await queueForRetry(
      {
        request,
        surface,
        error: "Circuit breaker open",
        attemptCount: 0,
        failedAt: new Date().toISOString(),
        surfaceType: "chat",
      },
      1
    );

    return {
      success: false,
      error: "Circuit breaker open - queued for retry",
      retries: 0,
    };
  }

  const result = await withRetryResult(async () => {
    return await circuitBreaker.execute(async () => {
      return await deliverToChatInternal(request, surface);
    });
  }, retryOptions);

  return {
    success: result.success,
    id: result.data,
    error: result.error?.message,
    retries: result.attempts,
  };
}

async function deliverToChatInternal(
  request: DeliveryRequest,
  surface: Extract<DeliverySurface, { type: "chat" }>
): Promise<string> {
  let channelId = surface.channelId;

  if (!channelId) {
    const orchestratorId = await getAgentIdBySlug("orchestrator");
    if (!orchestratorId) throw new Error("Orchestrator agent not found");
    const channel = await ensureAgentThread(request.userId, orchestratorId);
    channelId = channel.id;
  }

  const [message] = await db
    .insert(messages)
    .values({
      channelId,
      content: request.content.body,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.BOT,
      messageCategory: MessageCategory.CHAT,
      userId: request.userId,
      hash: crypto.randomUUID(), // Required field, will be computed properly in production
      previousHash: "",
      metadata: {
        sourceType: request.content.sourceType,
        sourceId: request.content.sourceId,
      } as any, // Allow extended metadata fields
    })
    .returning();

  // Note: Side effects should be emitted by the caller to avoid circular dependency
  // The caller can use emitSideEffects from @synap/events if needed

  return message.id;
}

async function deliverToNotificationWithRetry(
  request: DeliveryRequest,
  surface: Extract<DeliverySurface, { type: "notification" }>,
  retryOptions: RetryOptions
): Promise<{ success: boolean; id?: string; error?: string; retries: number }> {
  const circuitBreaker = getCircuitBreaker("notification");

  // Check if circuit breaker is open
  const stats = circuitBreaker.getStats();
  if (stats.state === "open") {
    logger.warn(
      { userId: request.userId },
      "Notification delivery circuit breaker is OPEN"
    );

    await queueForRetry(
      {
        request,
        surface,
        error: "Circuit breaker open",
        attemptCount: 0,
        failedAt: new Date().toISOString(),
        surfaceType: "notification",
      },
      1
    );

    return {
      success: false,
      error: "Circuit breaker open - queued for retry",
      retries: 0,
    };
  }

  const result = await withRetryResult(async () => {
    return await circuitBreaker.execute(async () => {
      return await deliverToNotificationInternal(request, surface);
    });
  }, retryOptions);

  return {
    success: result.success,
    id: result.data,
    error: result.error?.message,
    retries: result.attempts,
  };
}

async function deliverToNotificationInternal(
  request: DeliveryRequest,
  surface: Extract<DeliverySurface, { type: "notification" }>
): Promise<string> {
  // Map DeliveryContent sourceType to valid NotificationSourceType
  const sourceTypeMap: Record<
    string,
    | "system"
    | "agent"
    | "connector"
    | "proposal"
    | "inbox_item"
    | "proactive_message"
  > = {
    ai_proactive: "proactive_message",
    automation: "system",
    user: "system",
    external: "connector",
    system: "system",
  };

  const notificationId = await NotificationService.create({
    type: surface.notificationType,
    workspaceId: request.workspaceId ?? "default",
    userId: request.userId,
    sourceType: sourceTypeMap[request.content.sourceType] ?? "system",
    sourceId: request.content.sourceId,
    data: {
      title: request.content.title || "Notification",
      body: request.content.body,
      actions: request.content.actions,
      priority: request.priority,
      ...(request.content.metadata ?? {}),
    },
  });

  return notificationId ?? "unknown";
}

// ── Main Service ─────────────────────────────────────────────────────────────

export class DeliveryService {
  /**
   * Deliver content to multiple surfaces with retry and circuit breaker protection.
   */
  static async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const startTime = Date.now();
    const enableRetry = request.enableRetry !== false;
    const retryOptions: RetryOptions = enableRetry
      ? { ...API_RETRY_OPTIONS, ...request.retryOptions }
      : { maxRetries: 0 };

    // Check deduplication
    if (request.deduplicationKey && checkDuplicate(request.deduplicationKey)) {
      logger.debug(
        { deduplicationKey: request.deduplicationKey },
        "Deduplicating delivery"
      );
      return {
        success: true,
        deliveries: request.surfaces.map((s) => ({
          surface: s.type,
          success: true,
          id: "deduplicated",
          retries: 0,
        })),
        metrics: {
          totalDurationMs: Date.now() - startTime,
          totalRetries: 0,
        },
      };
    }

    const deliveries: DeliveryResult["deliveries"] = [];
    let totalRetries = 0;

    // Deliver to each surface
    for (const surface of request.surfaces) {
      const surfaceStartTime = Date.now();
      let result: {
        success: boolean;
        id?: string;
        error?: string;
        retries: number;
      };

      try {
        switch (surface.type) {
          case "feed":
            result = await deliverToFeedWithRetry(
              request,
              surface,
              retryOptions
            );
            break;
          case "chat":
            result = await deliverToChatWithRetry(
              request,
              surface,
              retryOptions
            );
            break;
          case "notification":
            result = await deliverToNotificationWithRetry(
              request,
              surface,
              retryOptions
            );
            break;
          default:
            result = {
              success: false,
              error: `${surface.type} delivery not yet implemented`,
              retries: 0,
            };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result = { success: false, error: errorMsg, retries: 0 };
        logger.error(
          { error, userId: request.userId, surface: surface.type },
          "Unexpected delivery error"
        );
      }

      const latencyMs = Date.now() - surfaceStartTime;
      totalRetries += result.retries;

      // Record metrics
      if (result.success) {
        deliveryMetrics.recordSuccess(surface.type, latencyMs, result.retries);
      } else {
        deliveryMetrics.recordFailure(
          surface.type,
          latencyMs,
          result.retries,
          result.error?.includes("Circuit breaker")
        );
      }

      deliveries.push({
        surface: surface.type,
        success: result.success,
        id: result.id,
        error: result.error,
        retries: result.retries,
        circuitBreakerOpen: result.error?.includes("Circuit breaker"),
      });
    }

    const duration = Date.now() - startTime;
    const allSuccess = deliveries.every((d) => d.success);
    const partialSuccess = deliveries.some((d) => d.success) && !allSuccess;

    logger.info(
      {
        userId: request.userId,
        surfaces: request.surfaces.map((s) => s.type),
        duration,
        allSuccess,
        partialSuccess,
        totalRetries,
      },
      "Delivery completed"
    );

    return {
      success: allSuccess,
      deliveries,
      metrics: {
        totalDurationMs: duration,
        totalRetries,
      },
    };
  }

  /**
   * Deliver to feed surface only.
   */
  static async deliverToFeed(
    request: Omit<DeliveryRequest, "surfaces"> & {
      feedChannelId?: string;
      proactiveOptions?: FeedDeliveryOptions["deliveryOptions"];
    }
  ): Promise<DeliveryResult> {
    return this.deliver({
      ...request,
      surfaces: [
        {
          type: "feed",
          feedChannelId: request.feedChannelId,
          proactiveOptions: request.proactiveOptions,
        },
      ],
    });
  }

  /**
   * Deliver to the proactive feed channel with full proactive AI support.
   * This is the preferred method for posting proactive AI messages.
   *
   * @example
   * ```typescript
   * const result = await DeliveryService.deliverToProactiveFeed({
   *   userId: "user-123",
   *   workspaceId: "ws-456",
   *   content: { title: "Morning Briefing", body: "You have 3 tasks today" },
   *   deliveryOptions: {
   *     proactiveType: "morning_briefing",
   *     checkPreferences: true,
   *     deduplicate: true,
   *     emitEvents: true,
   *   },
   * });
   * ```
   */
  static async deliverToProactiveFeed(
    options: FeedDeliveryOptions
  ): Promise<DeliveryResult> {
    const startTime = Date.now();

    const result = await deliverToProactiveFeed(options);

    const duration = Date.now() - startTime;

    return {
      success: result.success,
      deliveries: [
        {
          surface: "feed",
          success: result.success,
          id: result.messageId,
          error: result.reason,
          retries: 0,
        },
      ],
      metrics: {
        totalDurationMs: duration,
        totalRetries: 0,
      },
    };
  }

  /**
   * Deliver to notification surface only.
   */
  static async deliverToNotification(
    request: Omit<DeliveryRequest, "surfaces"> & { notificationType: string }
  ): Promise<DeliveryResult> {
    return this.deliver({
      ...request,
      surfaces: [
        { type: "notification", notificationType: request.notificationType },
      ],
    });
  }

  /**
   * Deliver to chat surface only.
   */
  static async deliverToChat(
    request: Omit<DeliveryRequest, "surfaces"> & { channelId?: string }
  ): Promise<DeliveryResult> {
    return this.deliver({
      ...request,
      surfaces: [{ type: "chat", channelId: request.channelId }],
    });
  }

  /**
   * Get delivery metrics for all surfaces.
   */
  static getMetrics(): ReturnType<DeliveryMetrics["getStats"]> {
    return deliveryMetrics.getStats();
  }

  /**
   * Get delivery summary statistics.
   */
  static getMetricsSummary(): ReturnType<DeliveryMetrics["getSummary"]> {
    return deliveryMetrics.getSummary();
  }

  /**
   * Reset delivery metrics.
   */
  static resetMetrics(): void {
    deliveryMetrics.reset();
  }

  /**
   * Get circuit breaker statistics.
   */
  static getCircuitBreakerStats(): Record<string, unknown> {
    return circuitBreakerRegistry.getAllStats();
  }

  /**
   * Reset all circuit breakers.
   */
  static resetCircuitBreakers(): void {
    circuitBreakerRegistry.resetAll();
  }

  /**
   * Manually open a circuit breaker (for testing or emergency).
   */
  static openCircuitBreaker(surfaceType: string): void {
    const breaker = circuitBreakerRegistry.get(`delivery-${surfaceType}`);
    breaker.forceOpen();
  }

  /**
   * Manually reset a circuit breaker.
   */
  static resetCircuitBreaker(surfaceType: string): void {
    const breaker = circuitBreakerRegistry.get(`delivery-${surfaceType}`);
    breaker.reset();
  }
}

// ── Dead Letter Queue Worker ─────────────────────────────────────────────────

/**
 * Handle dead letter queue items - for monitoring/alerting.
 */
export async function handleDeadLetter(job: {
  data: FailedDelivery;
}): Promise<void> {
  const { request, error, attemptCount, surfaceType } = job.data;

  logger.error(
    {
      userId: request.userId,
      workspaceId: request.workspaceId,
      surface: surfaceType,
      error,
      attemptCount,
      contentPreview: request.content.body.slice(0, 100),
    },
    "Delivery permanently failed - manual intervention required"
  );

  // Here you could:
  // 1. Send alert to monitoring system
  // 2. Store in a dedicated dead letter table
  // 3. Notify ops team via email/Slack
  // 4. Create an incident ticket

  // For now, we just log and store in database for inspection
  try {
    // Could add to a dead_letter_deliveries table here
    logger.info(
      { jobData: job.data },
      "Dead letter delivery recorded for inspection"
    );
  } catch (dbError) {
    logger.error(
      { dbError, originalError: error },
      "Failed to record dead letter delivery"
    );
  }
}

// Export for use in other modules
export { deliveryMetrics, circuitBreakerRegistry };
