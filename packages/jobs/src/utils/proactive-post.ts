/**
 * Proactive Post Utility (Jobs Package)
 *
 * Routing-aware proactive message delivery for cron workers.
 * The jobs package cannot import @synap/api (circular dep), so routing logic
 * lives here, reading workspace.settings.deliveryPreferences directly from DB.
 *
 * Surfaces:
 *   feed         → proactive feed channel (channelType='feed', feedScope='user')
 *   chat         → personal chat thread (channelType=PERSONAL)
 *   notification → direct insert to notifications table
 *   suppress     → no-op
 *
 * Usage (cron workers):
 *   const result = await routeProactiveMessage({ userId, workspaceId, content, proactiveType });
 */

import { randomUUID, createHash } from "crypto";
import { db, eq, and, gte, eventRepository } from "@synap/database";
import {
  messages,
  workspaces,
  channels,
  notifications,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  NotificationCategory,
  NotificationPriority,
} from "@synap/database/schema";
import type {
  WorkspaceSettings,
  ProactiveAiPreferences,
  Channel,
  DeliveryPreferences,
} from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { EventNames } from "@synap-core/types/events";
import { emitSideEffects } from "@synap/events";

const logger = createLogger({ module: "proactive-post" });

// ── Types ────────────────────────────────────────────────────────────────────

export type ProactiveMessageType =
  | "morning_briefing"
  | "weekly_digest"
  | "health_check"
  | "nudge"
  | "insight"
  | "suggestion"
  | "alert";

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

const PROACTIVE_TITLES: Record<ProactiveMessageType, string> = {
  morning_briefing: "Morning Briefing",
  weekly_digest: "Weekly Digest",
  health_check: "Health Check",
  nudge: "AI Nudge",
  insight: "AI Insight",
  suggestion: "AI Suggestion",
  alert: "AI Alert",
};

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

/** Read delivery preferences for a workspace. */
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

/** Get or create the user's proactive FEED channel (type='feed', feedScope='user'). */
async function ensureProactiveFeedChannel(
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
    })
    .returning();
  return channel;
}

/** Get or create the user's personal thread (type='thread', threadKind='personal'). */
async function ensurePersonalChatChannel(
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
  fetch(`${realtimeUrl}/bridge/emit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

// ── Surface Implementations ──────────────────────────────────────────────────

/**
 * Post to the proactive FEED channel.
 * Deduplicates: one message per proactiveType per day.
 */
async function postToProactiveFeed(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  const { userId, workspaceId, content, proactiveType, metadata } = options;

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

  const messageId = randomUUID();
  const messageHash = createHash("sha256")
    .update(`${messageId}${content}`)
    .digest("hex");

  // Feed items can include per-item actions in metadata
  // (primaryAction + secondaryActions) for client rendering.
  const messageMetadata = { ...metadata, proactiveType, proactiveAi: true };

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

  emitRealtimeEvent({
    event: EventNames.CHAT_MESSAGE,
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

  return { posted: true, messageId };
}

/**
 * Post to the personal CHAT channel.
 * No per-day dedup — chat is a conversation surface, not a feed.
 */
async function postToPersonalChat(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  const { userId, workspaceId, content, proactiveType, metadata } = options;

  const channel = await ensurePersonalChatChannel(userId, workspaceId);
  const messageId = randomUUID();
  const messageHash = createHash("sha256")
    .update(`${messageId}${content}`)
    .digest("hex");

  const messageMetadata = { ...metadata, proactiveType, proactiveAi: true };

  await db.insert(messages).values({
    id: messageId,
    channelId: channel.id,
    role: MessageRole.ASSISTANT,
    authorType: MessageAuthorType.BOT,
    messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
    content: content.trim(),
    userId,
    previousHash: "",
    hash: messageHash,
    metadata: messageMetadata as (typeof messages.$inferInsert)["metadata"],
  });

  emitRealtimeEvent({
    event: EventNames.CHAT_MESSAGE,
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
        hash: messageHash,
        metadata: messageMetadata,
      },
      userId,
    },
    channelId: channel.id,
    userId,
  });

  return { posted: true, messageId };
}

/**
 * Create a notification row for a proactive message.
 * Direct DB insert — no socket emit from the jobs path.
 * The bell updates on next user refresh or via the next socket connection.
 */
async function postProactiveNotification(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  const { userId, workspaceId, content, proactiveType } = options;

  const [row] = await db
    .insert(notifications)
    .values({
      workspaceId,
      userId,
      type: `ai.proactive.${proactiveType}`,
      category: NotificationCategory.AI,
      priority: NotificationPriority.LOW,
      title: PROACTIVE_TITLES[proactiveType],
      body: content.substring(0, 300),
      sourceType: "proactive_message",
    })
    .returning({ id: notifications.id });

  return { posted: !!row, messageId: row?.id };
}

/**
 * Delegate external (Discord / Telegram / …) delivery to the API process via
 * a loopback HTTP call to POST /internal/signal/route.
 *
 * The jobs package cannot import @synap/api (circular dep), so this is the
 * canonical bridge. The endpoint is internal-only (bound to loopback / behind
 * the same process network; no public auth needed — uses BRIDGE_SECRET).
 */
async function postToExternalViaBridge(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  const secret = process.env.BRIDGE_SECRET ?? "";

  try {
    const res = await fetch(`${apiUrl}/internal/signal/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Bridge-Secret": secret } : {}),
      },
      body: JSON.stringify({
        domain: "proactive",
        content: options.content,
        userId: options.userId,
        workspaceId: options.workspaceId,
        proactiveType: options.proactiveType,
        metadata: options.metadata,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text, userId: options.userId },
        "external delivery bridge returned non-OK status"
      );
      return { posted: false, reason: `bridge_http_${res.status}` };
    }

    const body = (await res.json()) as {
      delivered?: boolean;
      messageId?: string;
    };
    return { posted: body.delivered ?? false, messageId: body.messageId };
  } catch (err) {
    logger.warn(
      { err, userId: options.userId, workspaceId: options.workspaceId },
      "external delivery bridge call failed"
    );
    return {
      posted: false,
      reason: err instanceof Error ? err.message : "bridge_error",
    };
  }
}

// ── Main Router ───────────────────────────────────────────────────────────────

/**
 * Route a proactive message to one or more surfaces based on workspace delivery preferences.
 *
 * Reads workspace.settings.deliveryPreferences.proactive — defaults to feed.
 * Fires proactive.post.completed event on success (enables automation triggers).
 *
 * Never throws.
 */
export async function routeProactiveMessage(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  const { userId, workspaceId, content, proactiveType } = options;

  try {
    if (!content || content.trim().length === 0) {
      return { posted: false, reason: "empty_content" };
    }

    // ── Check global proactive AI preferences ─────────────────────────────
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

    // ── Resolve delivery surfaces ─────────────────────────────────────────
    const deliveryPrefs = await getDeliveryPreferences(workspaceId);
    const rule = deliveryPrefs.proactive ?? { surfaces: ["feed"] };

    if (rule.surfaces.includes("suppress")) {
      logger.debug(
        { userId, workspaceId, proactiveType },
        "Proactive message suppressed by delivery preferences"
      );
      return { posted: false, reason: "suppressed" };
    }

    const activeSurfaces = rule.surfaces.filter((s) => s !== "suppress");

    // ── Deliver to each surface concurrently ──────────────────────────────
    const results = await Promise.allSettled(
      activeSurfaces.map((surface): Promise<PostProactiveResult> => {
        // A surface entry is either a bare SignalSurface string ("feed"|"chat"|
        // "notification"|"suppress") or a SurfaceTarget object ({ kind, provider?,
        // channelRef? }). "external" only exists as SurfaceTarget.kind — never as
        // a bare string — so we normalise to kind first.
        const kind = typeof surface === "string" ? surface : surface.kind;
        switch (kind) {
          case "feed":
            return postToProactiveFeed(options);
          case "chat":
            return postToPersonalChat(options);
          case "notification":
            return postProactiveNotification(options);
          case "external":
            // jobs package cannot import @synap/api (circular dep) so external
            // delivery is delegated to the API process via an internal HTTP call
            // to POST /internal/signal/route — the API's routeSignal behind a
            // thin internal-only endpoint (no auth token needed: loopback-only).
            return postToExternalViaBridge(options);
          default:
            // `surfaces` is a stored string[]; an unrecognized surface is a
            // no-op skip rather than a crash (keeps the result type total).
            return Promise.resolve({
              posted: false,
              reason: "unknown_surface",
            });
        }
      })
    );

    const firstSuccess = results.find(
      (r): r is PromiseFulfilledResult<PostProactiveResult> =>
        r.status === "fulfilled" && r.value.posted
    );

    if (!firstSuccess) {
      const firstRejection = results.find((r) => r.status === "rejected");
      const firstSkipped = results.find(
        (r): r is PromiseFulfilledResult<PostProactiveResult> =>
          r.status === "fulfilled" && !r.value.posted
      );
      return {
        posted: false,
        reason:
          firstRejection instanceof Object && "reason" in firstRejection
            ? String((firstRejection as PromiseRejectedResult).reason)
            : (firstSkipped?.value.reason ?? "not_posted"),
      };
    }

    const messageId = firstSuccess.value.messageId;

    logger.info(
      {
        userId,
        workspaceId,
        proactiveType,
        messageId,
        surfaces: activeSurfaces,
      },
      "Proactive message routed"
    );

    // ── Fire event chain ──────────────────────────────────────────────────
    // Enables automation triggers on proactive.post.completed + audit log
    const proactiveEventData = { proactiveType, workspaceId, messageId };

    emitSideEffects({
      subjectType: "proactive",
      action: "post",
      subjectId: messageId ?? randomUUID(),
      userId,
      workspaceId,
      data: proactiveEventData,
    }).catch(() => {});

    eventRepository
      .append({
        id: messageId ?? randomUUID(),
        version: "v1",
        type: "proactive.post.completed",
        subjectType: "proactive",
        subjectId: messageId ?? "unknown",
        data: proactiveEventData,
        userId,
        source: "system",
        timestamp: new Date(),
      })
      .catch(() => {});

    return { posted: true, messageId };
  } catch (err) {
    logger.error(
      { err, userId, workspaceId, proactiveType },
      "Failed to route proactive message"
    );
    return {
      posted: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

/**
 * @deprecated Use routeProactiveMessage() — this always posts to the feed
 * without respecting workspace delivery preferences.
 */
export async function postProactiveMessage(
  options: PostProactiveOptions
): Promise<PostProactiveResult> {
  return routeProactiveMessage(options);
}
