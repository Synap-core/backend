/**
 * NotificationService
 *
 * Central service for creating and delivering notifications.
 *
 * Usage:
 *   await NotificationService.create({
 *     type: 'proposal.created',
 *     workspaceId, userId,
 *     sourceType: 'proposal', sourceId: proposalId,
 *     data: { proposalType: 'entity.create', description: '...' },
 *   });
 *
 * The service:
 * 1. Looks up the NotificationDef from registry
 * 2. Evaluates title/body templates with data
 * 3. Persists to notifications table
 * 4. Emits notification:new via Socket.IO (real-time bell update)
 * 5. Logs errors non-fatally (never throws)
 */

import {
  db,
  notifications,
  notificationPreferences,
  workspaceMembers,
  and,
  eq,
  isNull,
  eventRepository,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { SERVER_CONVERSATION_EVENTS } from "../realtime/socket-events.js";
import { emitSideEffects } from "@synap/events";
import { getNotificationDef } from "./registry.js";
import { sendExpoPush } from "./expo-push.js";
import { openLink } from "../utils/deep-links.js";
import type { DeliveryChannel, NotificationDef } from "./registry.js";
import type {
  NotificationCategory,
  NotificationPriority,
} from "@synap/database";

const logger = createLogger({ module: "notification-service" });

// ---------------------------------------------------------------------------
// Template interpolation — simple {{variable}} replacement
// ---------------------------------------------------------------------------

function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key];
    return value !== undefined && value !== null ? String(value) : "";
  });
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  type: string;
  workspaceId?: string | null;
  userId: string;

  // Source traceability
  sourceType:
    | "proposal"
    | "connector"
    | "agent"
    | "system"
    | "inbox_item"
    | "proactive_message";
  sourceId?: string;
  workspaceUrl?: string;

  // Template data (fills {{variables}} in title/body)
  data: Record<string, unknown>;

  // Override registry defaults (optional)
  groupKey?: string;
  expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// The shape emitted over Socket.IO for the frontend bell
// ---------------------------------------------------------------------------

interface NotificationPayload {
  id: string;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  icon: string | undefined;
  sourceType: string;
  sourceId: string | undefined;
  workspaceUrl: string | undefined;
  actions: unknown;
  status: "unread";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Channel resolution — the ONE place a notification's delivery channels are
// decided.
// ---------------------------------------------------------------------------

/**
 * Resolve which channels this notification actually goes out on.
 *
 * The vocabulary is NOT new: `notification_preferences.routingRules` has always
 * declared `"in_app" | "os" | "telegram" | "all" | "mute"`, and every registry
 * entry has always declared a `defaultChannels: DeliveryChannel[]`. Only two of
 * those five rule values were ever read (`"mute"`, `"os"`) and `defaultChannels`
 * had ZERO readers anywhere in the repo — so `"all"` and `"in_app"` behaved
 * identically, and the registry's own declared intent was ignored. This reads
 * all of it, and adds no sixth token of its own.
 *
 * `"mute"` is absent here on purpose: it is handled by the caller BEFORE the row
 * is written, because a muted notification is not persisted at all.
 *
 * QUIET HOURS apply to every INTERRUPTIVE channel, not just the socket. Quiet
 * hours mean "persist, don't interrupt" — a push transport that ignored them
 * would make the phone the single loudest channel at 3am, the exact inverse of
 * the setting. So `suppressRealtime` drops both `in_app` and `os`; the row is
 * still written above and is waiting in the bell in the morning.
 */
function resolveChannels(
  def: NotificationDef,
  categoryRule: string | undefined,
  suppressRealtime: boolean
): Set<DeliveryChannel> {
  let channels: Set<DeliveryChannel>;

  switch (categoryRule) {
    case "in_app":
      channels = new Set<DeliveryChannel>(["in_app"]);
      break;
    case "os":
      channels = new Set<DeliveryChannel>(["os"]);
      break;
    case "all":
      channels = new Set<DeliveryChannel>(["in_app", "os"]);
      break;
    case "telegram":
      // Declared in the routingRules vocabulary but NOT implemented. It used to
      // fall through to the ordinary socket emit with no log line at all, so a
      // user who picked Telegram silently got in-app instead and nothing
      // anywhere said so. Still unimplemented — but now it says so, and it
      // falls back to the type's declared defaults rather than pretending.
      logger.warn(
        { type: def.type, category: def.category },
        "routingRules value 'telegram' is not implemented — falling back to the " +
          "notification type's defaultChannels"
      );
      channels = new Set<DeliveryChannel>(def.defaultChannels);
      break;
    default:
      // No rule (or an unrecognized one) → the type's declared defaults.
      channels = new Set<DeliveryChannel>(def.defaultChannels);
      break;
  }

  if (suppressRealtime) {
    channels.delete("in_app");
    channels.delete("os");
  }

  return channels;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const NotificationService = {
  /**
   * Create a notification, persist it, and emit it over Socket.IO.
   * Non-fatal — logs errors but never throws.
   */
  async create(input: CreateNotificationInput): Promise<string | undefined> {
    const def = getNotificationDef(input.type);
    if (!def) {
      logger.warn({ type: input.type }, "Unknown notification type — skipping");
      return undefined;
    }

    const title = interpolate(def.titleTemplate, input.data);
    const body = interpolate(def.bodyTemplate, input.data);

    // Resolve group key if registry specifies groupBy field
    let groupKey: string | undefined = input.groupKey;
    if (!groupKey && def.groupBy && input.workspaceId) {
      const groupVal = input.data[def.groupBy];
      if (groupVal) {
        groupKey = `${input.workspaceId}:${input.type}:${groupVal}`;
      }
    }

    try {
      // ── Routing enforcement ────────────────────────────────────────────
      // Check user preferences: global kill switch, routing rules, quiet hours.
      // routingRules stores category-based rules: { "governance": "mute", "ai": "in_app", ... }
      // If a category is "mute", skip entirely (don't persist, don't emit).
      // Workspace row first, then the user's POD-LEVEL row (workspaceId IS
      // NULL) as the fallback. This used to read `input.workspaceId ? … : null`
      // — so a pod-wide notification (workspaceId === null) resolved NO
      // preferences at all and silently ignored the kill switch, every mute,
      // and quiet hours. That hole is load-bearing now that a channel can ring
      // a phone: `proposal.created` is the type most often raised pod-wide, and
      // it defaults to the `"os"` channel. Without this, the one notification
      // most likely to fire at 3am is the one that could not be quieted.
      const prefs =
        (input.workspaceId
          ? await db.query.notificationPreferences.findFirst({
              where: and(
                eq(notificationPreferences.userId, input.userId),
                eq(notificationPreferences.workspaceId, input.workspaceId)
              ),
            })
          : undefined) ??
        (await db.query.notificationPreferences.findFirst({
          where: and(
            eq(notificationPreferences.userId, input.userId),
            isNull(notificationPreferences.workspaceId)
          ),
        }));

      // Global kill switch — skip everything if notifications are disabled
      if (prefs?.enabled === false) {
        logger.debug(
          { type: input.type, userId: input.userId },
          "Notifications disabled for user — skipping"
        );
        return undefined;
      }

      // Per-category routing rule
      const rules = (prefs?.routingRules ?? {}) as Record<string, string>;
      const categoryRule = rules[def.category] ?? rules[input.type]; // check category first, then specific type
      if (categoryRule === "mute") {
        logger.debug(
          { type: input.type, category: def.category },
          "Notification muted by user preference — skipping"
        );
        return undefined;
      }

      // Quiet hours — suppress real-time emission (still persist to DB for later viewing)
      let suppressRealtime = false;
      if (
        prefs?.quietHoursEnabled &&
        prefs.quietHoursStart &&
        prefs.quietHoursEnd
      ) {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const start = prefs.quietHoursStart;
        const end = prefs.quietHoursEnd;
        // Handle overnight ranges (e.g., 22:00 → 08:00)
        const inQuietHours =
          start <= end
            ? hhmm >= start && hhmm < end
            : hhmm >= start || hhmm < end;
        if (inQuietHours) {
          suppressRealtime = true;
        }
      }

      const [row] = await db
        .insert(notifications)
        .values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          type: input.type,
          category: def.category as NotificationCategory,
          priority: def.priority as NotificationPriority,
          title,
          body,
          icon: def.icon ?? undefined,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? undefined,
          workspaceUrl: input.workspaceUrl ?? undefined,
          actions: def.actions ?? [],
          groupKey: groupKey ?? undefined,
          expiresAt: input.expiresAt ?? undefined,
        })
        .returning({ id: notifications.id });

      if (!row) return undefined;

      // Write to event log for audit trail + cross-pod sync
      eventRepository
        .append({
          id: randomUUID(),
          version: "v1",
          type: "notification.created",
          subjectType: "notification",
          subjectId: row.id,
          data: {
            notificationId: row.id,
            notificationType: input.type,
            category: def.category,
            workspaceId: input.workspaceId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
          userId: input.userId,
          source: "system",
          timestamp: new Date(),
        })
        .catch(() => {}); // non-blocking, non-fatal

      // Trigger automation side-effects for notification.created event type
      emitSideEffects({
        subjectType: "notification",
        action: "created",
        subjectId: row.id,
        userId: input.userId,
        workspaceId: input.workspaceId ?? undefined,
        data: {
          notificationId: row.id,
          notificationType: input.type,
          category: def.category,
        },
      }).catch(() => {}); // non-blocking, non-fatal

      // Emit real-time event to the RECIPIENT's user room
      const payload: NotificationPayload = {
        id: row.id,
        type: input.type,
        category: def.category,
        priority: def.priority,
        title,
        body,
        icon: def.icon ?? undefined,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? undefined,
        workspaceUrl: input.workspaceUrl ?? undefined,
        actions: def.actions ?? [],
        status: "unread",
        createdAt: new Date().toISOString(),
      };

      // ── THE one channel-selection point ──────────────────────────────
      // Fire-and-forget — no channel ever blocks the caller, and the row above
      // is already persisted, so a channel that declines (or fails) only costs
      // the interruption, never the notification.
      const channels = resolveChannels(def, categoryRule, suppressRealtime);

      if (channels.has("in_app")) {
        // Deliver to the RECIPIENT's user room — never the workspace room. The
        // bridge emits once per room key present, so passing `workspaceId` would
        // fan a private notification to every workspace member (disclosure), and
        // gating the emit on `!!input.workspaceId` dropped pod-wide
        // (null-workspace) notifications from realtime entirely — the W0 hole
        // that left pod-wide governance proposals silent in the bell.
        emitChatEvent({
          event: SERVER_CONVERSATION_EVENTS.NOTIFICATION_NEW,
          data: { notification: payload, userId: input.userId },
          userId: input.userId,
        });
      }

      if (channels.has("os")) {
        // Native push. Deliberately NOT awaited — Expo is a third-party HTTP
        // hop and `create()` is called from write paths that must not wait on
        // it. `sendExpoPush` never throws; the `.catch` is belt-and-braces.
        void sendExpoPush({
          userId: input.userId,
          title,
          body,
          data: {
            notificationId: row.id,
            type: input.type,
            category: def.category,
            sourceType: input.sourceType,
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            // A push is addressed to a REGISTERED DEVICE, so the producer knows
            // its audience — this is exactly the case the mobile flavour exists
            // for. `?client=mobile` makes the pod's /open bounce hand the tap to
            // relay (`synap://open/proposal/<id>`) instead of 302-ing to the
            // desktop-only pod-admin review page.
            //
            // Narrowed to `proposal` deliberately: the bare-id `/open/:id` route
            // probes proposal → entity → view → document → channel, and
            // `proposal` is the ONLY `sourceType` in that set. Minting a link
            // for a connector/agent/system source id would bounce to a TYPELESS
            // `synap://open/<id>` no client can route — a dead link is worse
            // than none.
            ...(input.sourceType === "proposal" && input.sourceId
              ? { deepLink: openLink(input.sourceId, { client: "mobile" }) }
              : {}),
          },
        }).catch((err) =>
          logger.warn({ err, notificationId: row.id }, "Push send failed")
        );
      }

      logger.debug(
        {
          notificationId: row.id,
          type: input.type,
          workspaceId: input.workspaceId,
        },
        "Notification created"
      );

      return row.id;
    } catch (err) {
      // Non-fatal — notifications must never break the main flow
      logger.error(
        { err, type: input.type, workspaceId: input.workspaceId },
        "Failed to create notification (non-fatal)"
      );
      return undefined;
    }
  },

  /**
   * Fan-out a workspace-scoped alert to EVERY member of `workspaceId` — N
   * per-recipient rows (the ratified fan-out shape). Reuses `create()` per
   * member, so per-user read/ack/snooze state, routing prefs, quiet hours, and
   * socket delivery all work unchanged (no shared-row rework). Per-member
   * best-effort: one member's failure never blocks the rest. `subjectUserId` (in
   * `data`, optional) is the person the alert is ABOUT — never a recipient
   * filter; every member is notified. Returns the created notification ids.
   */
  async createForWorkspace(
    input: Omit<CreateNotificationInput, "userId"> & { workspaceId: string }
  ): Promise<string[]> {
    const members = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.workspaceId, input.workspaceId),
      columns: { userId: true },
    });
    const ids: string[] = [];
    for (const member of members) {
      const id = await NotificationService.create({
        ...input,
        userId: member.userId,
      }).catch((err) => {
        logger.warn(
          { err, userId: member.userId, type: input.type },
          "createForWorkspace: per-member create failed (continuing)"
        );
        return undefined;
      });
      if (id) ids.push(id);
    }
    return ids;
  },

  /**
   * Convenience wrapper for proposal-created notifications.
   * Called from permission-check.ts after every db.insert(proposals).
   */
  async fromProposal(opts: {
    proposalId: string;
    workspaceId: string;
    userId: string; // recipient (workspace members)
    proposalType: string;
    description?: string;
    agentUserId?: string;
    workspaceUrl?: string;
  }): Promise<void> {
    await NotificationService.create({
      type: "proposal.created",
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      sourceType: "proposal",
      sourceId: opts.proposalId,
      workspaceUrl: opts.workspaceUrl,
      data: {
        proposalType: opts.proposalType,
        description: opts.description ?? opts.proposalType,
        agentUserId: opts.agentUserId ?? "",
      },
      groupKey: opts.agentUserId
        ? `${opts.workspaceId}:proposal.created:${opts.agentUserId}`
        : undefined,
    });
  },

  /**
   * Proposal-created notification for a POD-WIDE proposal (workspaceId === null).
   * A pod-wide proposal has no workspace membership to notify, so its governance
   * attention is routed to the pod owner + pod admins (resolved by the caller).
   * Same type/shape/category ("proposal.created", governance) as
   * `fromProposal` — only the recipients and the null workspace differ. One
   * notification per recipient; the caller passes an already-deduped id list so
   * an owner who is also an admin is not notified twice. `create()` never throws
   * (logs non-fatally), so a per-recipient failure cannot abort the rest.
   */
  async fromPodWideProposal(opts: {
    proposalId: string;
    recipientUserIds: string[];
    proposalType: string;
    description?: string;
    agentUserId?: string;
  }): Promise<void> {
    for (const userId of opts.recipientUserIds) {
      await NotificationService.create({
        type: "proposal.created",
        workspaceId: null,
        userId,
        sourceType: "proposal",
        sourceId: opts.proposalId,
        data: {
          proposalType: opts.proposalType,
          description: opts.description ?? opts.proposalType,
          agentUserId: opts.agentUserId ?? "",
        },
        // Collapse an agent's pod-wide proposals in the bell, mirroring the
        // workspace path's `${workspaceId}:proposal.created:${agentUserId}` key
        // (workspaceId is null here, so the pod is the collapse scope).
        groupKey: opts.agentUserId
          ? `pod:proposal.created:${opts.agentUserId}`
          : undefined,
      });
    }
  },

  /**
   * Convenience wrapper for skill trigger events.
   */
  async fromSkillTrigger(opts: {
    workspaceId: string;
    userId: string;
    skillName: string;
    description?: string;
  }): Promise<void> {
    await NotificationService.create({
      type: "skill.triggered",
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      sourceType: "agent",
      data: {
        skillName: opts.skillName,
        description: opts.description ?? opts.skillName,
      },
    });
  },
};
