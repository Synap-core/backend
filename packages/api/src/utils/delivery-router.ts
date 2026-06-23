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
 *   feed         → DeliveryService.deliverToProactiveFeed() to the proactive feed channel
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
import { EventNames } from "@synap-core/types/events";
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
  SurfaceTarget,
  DeliveryPreferences,
} from "@synap/database/schema";
import {
  DeliveryService,
  type ProactiveMessageType,
} from "../services/DeliveryService.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { sendExternalMessage } from "../connectors/external-dispatch.js";
import { resolveExternalChannel } from "../services/connectors/inbound-recorder.js";
import { ensureAgentThread, getAgentIdBySlug } from "./personal-channel.js";
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
  /**
   * The AI-agent identity, when this signal is agent-initiated. Threaded to the
   * external-send capability gate (`sendExternalMessage`) so an agent's external
   * delivery is governed (approved+grant → run, else → propose). ABSENT → owner
   * delivery → the gate is skipped (byte-identical to before W3b).
   */
  agentUserId?: string | null;
  /**
   * Per-call override for external delivery target. When set, takes precedence
   * over the workspace-level deliveryPreferences channelRef for the `external`
   * surface. Enables per-playbook / per-automation channel targeting without
   * changing workspace settings.
   *
   * Format: { provider: "discord", channelRef: "<snowflake>" }
   */
  externalOverride?: { provider: string; channelRef: string };
}

/** A surface kind a result can report against (includes `external`). */
export type SurfaceKind = SurfaceTarget["kind"];

export interface SurfaceResult {
  surface: SurfaceKind;
  success: boolean;
  reason?: string;
  messageId?: string;
}

export interface RouteSignalResult {
  /** True if at least one surface delivery succeeded */
  delivered: boolean;
  /** Which surface kinds were targeted */
  surfaces: SurfaceKind[];
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
  const result = await DeliveryService.deliverToProactiveFeed({
    userId: input.userId,
    workspaceId: input.workspaceId,
    content: {
      body: input.content,
      metadata: input.metadata,
    },
    deliveryOptions: {
      proactiveType: input.proactiveType,
      checkPreferences: true,
      deduplicate: true,
      emitEvents: true,
      createNotification: false,
    },
  });

  const feedDelivery = result.deliveries[0];
  return {
    surface: "feed",
    success: result.success,
    reason: feedDelivery?.error,
    messageId: feedDelivery?.id,
  };
}

async function deliverToChat(
  input: RouteSignalInput & { proactiveType: ProactiveMessageType }
): Promise<SurfaceResult> {
  try {
    const { userId, content, proactiveType, metadata } = input;
    const orchestratorId = await getAgentIdBySlug("orchestrator");
    if (!orchestratorId) throw new Error("Orchestrator agent not found");
    const channel = await ensureAgentThread(userId, orchestratorId);
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

/**
 * Deliver a signal to an EXTERNAL connector (Discord / Telegram / …).
 *
 * Resolves the bound EXTERNAL channel for (provider = target.provider,
 * externalId = target.channelRef), then sends through the SAME outbound door as
 * the proposal executor — `sendExternalMessage` → `getMessagingConnector`. Never
 * a parallel send. Missing provider/channelRef or no bound channel → structured
 * skip (logged), never a throw.
 */
async function deliverToExternal(
  input: RouteSignalInput & { proactiveType: ProactiveMessageType },
  target: SurfaceTarget
): Promise<SurfaceResult> {
  // Per-call override wins over the workspace-level target (enables per-playbook routing).
  const provider = input.externalOverride?.provider ?? target.provider;
  const channelRef = input.externalOverride?.channelRef ?? target.channelRef;
  if (!provider || !channelRef) {
    logger.warn(
      { domain: input.domain, provider, channelRef },
      "external delivery skipped: target missing provider/channelRef"
    );
    return {
      surface: "external",
      success: false,
      reason: "missing_provider_or_channel_ref",
    };
  }

  try {
    const boundChannel = await resolveExternalChannel({
      provider,
      externalId: channelRef,
    });

    if (!boundChannel) {
      logger.warn(
        { domain: input.domain, provider, channelRef },
        "external delivery skipped: no bound EXTERNAL channel found"
      );
      return {
        surface: "external",
        success: false,
        reason: "no_bound_channel",
      };
    }

    // Guardrail: AI/proactive output must never land on a client-comms channel.
    // branchPurpose='team' (or null) is the only allowed target for AI signals.
    if (boundChannel.branchPurpose === "client-comms") {
      logger.warn(
        {
          domain: input.domain,
          provider,
          channelRef,
          channelId: boundChannel.id,
        },
        "external delivery blocked: AI proactive output must not go to a client-comms channel"
      );
      return {
        surface: "external",
        success: false,
        reason: "blocked_client_comms_channel",
      };
    }

    // Same outbound door as the proposal executor. Discord ignores accountId
    // (server-managed bot token); sendExternalMessage resolves the connector
    // from the channel's externalSource. Thread the agent identity + workspace so
    // an agent-initiated external delivery is governed by the capability gate (an
    // owner delivery — no agentUserId — skips the gate, byte-identical).
    const { success, messageId, proposed } = await sendExternalMessage({
      threadId: channelRef,
      accountId: "",
      body: input.content,
      userId: input.userId,
      agentUserId: input.agentUserId ?? null,
      workspaceId: input.workspaceId,
    });

    return {
      surface: "external",
      success,
      messageId,
      // A gated agent delivery routed to a proposal is NOT a send failure — it is
      // pending review. Surface a distinct reason so callers don't read it as an
      // error.
      reason: success
        ? undefined
        : proposed
          ? "pending_approval"
          : "connector_send_failed",
    };
  } catch (err) {
    logger.warn(
      { err, domain: input.domain, provider, channelRef },
      "external delivery failed"
    );
    return {
      surface: "external",
      success: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

// ── Surface Handler Registry ──────────────────────────────────────────────────

type ResolvedInput = RouteSignalInput & { proactiveType: ProactiveMessageType };

/**
 * Surface-kind → handler. Mirrors the proposal-executor registry discipline:
 * routing is data-driven, and an unknown kind is a structured skip (handled in
 * `routeSignal`), never a thrown error.
 *
 * `suppress` is short-circuited before dispatch, so it has no handler here.
 */
const SURFACE_HANDLERS: Record<
  string,
  (input: ResolvedInput, target: SurfaceTarget) => Promise<SurfaceResult>
> = {
  feed: (input) => deliverToFeed(input),
  chat: (input) => deliverToChat(input),
  notification: (input) => deliverToNotification(input),
  external: (input, target) => deliverToExternal(input, target),
};

/** Normalize a configured surface (bare string or structured) to a target. */
function toSurfaceTarget(
  surface: SignalSurface | SurfaceTarget
): SurfaceTarget {
  return typeof surface === "string" ? { kind: surface } : surface;
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

    // Normalize bare-string and structured surfaces to a common target shape.
    const targets = rule.surfaces.map(toSurfaceTarget);

    // suppress is a complete no-op
    if (targets.some((t) => t.kind === "suppress")) {
      logger.debug(
        { domain, userId, workspaceId },
        "Signal suppressed by delivery preferences"
      );
      return { delivered: false, surfaces: ["suppress"], results: [] };
    }

    const activeTargets = targets.filter((t) => t.kind !== "suppress");

    if (activeTargets.length === 0) {
      return { delivered: false, surfaces: [], results: [] };
    }

    const resolvedInput: ResolvedInput = { ...input, proactiveType };

    // Dispatch to each target's handler concurrently. Unknown surface kind →
    // structured skip (warn + skipped result), never a throw.
    const results = await Promise.all(
      activeTargets.map((target): Promise<SurfaceResult> => {
        const handler = SURFACE_HANDLERS[target.kind];
        if (!handler) {
          logger.warn(
            { domain, userId, workspaceId, surface: target.kind },
            "Signal delivery skipped: unknown surface kind"
          );
          return Promise.resolve({
            surface: target.kind,
            success: false,
            reason: "unknown_surface_kind",
          });
        }
        return handler(resolvedInput, target);
      })
    );

    const delivered = results.some((r) => r.success);
    const activeSurfaces = activeTargets.map((t) => t.kind);

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
